import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { setLunaHome } from "../../src/shared";
import { AgentStore } from "../../src/agents/agent-store";
import { AccountLinkService } from "../../src/identity/account-link";
import { AccountStore, SUPER_ADMIN_ACCOUNT_ID } from "../../src/identity/account-store";
import { cleanDisplayName } from "../../src/identity/display-name";
import { recordShadowBotIdentity } from "../../src/identity/shadow-bot";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";
import { ensureDashboardAccount, LOCAL_ACCOUNT_NAME } from "../../src/server/auth";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>, agentId: string, shadowId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-name-sync-")); setLunaHome(home);
  connection = new DataConnection(schema);
  const ownership = fixtureSessionOwnership(connection.db, "feishu", "feishu-main");
  agentId = ownership.agent_id; shadowId = ownership.shadow_id;
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });

const db = () => connection.db;
const user = (id: string) => db().select().from(schema.users).where(eq(schema.users.id, id)).get()!;
const shadow = () => new AgentStore(db()).shadow(shadowId);

/** A Feishu sender asks for a link token, as `#link` does. */
function linkToken(name: string): string {
  const identity = { externalId: "ou_owner", kind: "user" as const, displayName: name,
    ...feishuIdentityMetadata({ environment: "feishu", appId: "test:feishu:feishu-main" }, { open_id: "ou_owner" }) };
  const stored = new ChannelDirectoryStore(db()).upsertIdentity({ channel: { type: "feishu", id: "feishu-main" }, identity, agentId });
  const userId = db().select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, stored.id)).get()!.userId;
  return new AccountLinkService(db()).issue({ userId, channelType: "feishu", channelId: "feishu-main", channelIdentityId: stored.id });
}

test("invisible characters around names are removed", () => {
  expect(cleanDisplayName(" Monkey King‌ ")).toBe("Monkey King");
  expect(cleanDisplayName("﻿​")).toBeUndefined();
  expect(cleanDisplayName("A‍B")).toBe("A‍B");
});

test("linking gives the owner the chat name and replaces only a placeholder account name", () => {
  const owner = new AgentStore(db()).ownerUserId(agentId);
  db().update(schema.accounts).set({ displayName: LOCAL_ACCOUNT_NAME }).where(eq(schema.accounts.id, "fixture-owner")).run();
  new AccountLinkService(db()).link("fixture-owner", agentId, linkToken("王华杰‌"));
  expect(user(owner)).toMatchObject({ displayName: "王华杰", profileSource: "channel" });
  expect(new AccountStore(db()).get("fixture-owner")?.displayName).toBe("王华杰");
  // A later local sign-in, which only knows the placeholder, keeps the stored name.
  expect(new AccountStore(db()).ensure({ id: "fixture-owner", name: LOCAL_ACCOUNT_NAME, placeholderName: true }).displayName).toBe("王华杰");
});

test("linking keeps names someone chose", () => {
  const owner = new AgentStore(db()).ownerUserId(agentId);
  db().update(schema.users).set({ displayName: "老板", profileSource: "manual" }).where(eq(schema.users.id, owner)).run();
  db().update(schema.accounts).set({ displayName: "Wang" }).where(eq(schema.accounts.id, "fixture-owner")).run();
  new AccountLinkService(db()).link("fixture-owner", agentId, linkToken("王华杰"));
  expect(user(owner).displayName).toBe("老板");
  expect(new AccountStore(db()).get("fixture-owner")?.displayName).toBe("Wang");
});

test("linking on the built-in super-admin account updates the Agent owner user but keeps local-dashboard-user's fixed system identity", () => {
  const superAdminScope = fixtureSessionOwnership(db(), "feishu", "feishu-super", SUPER_ADMIN_ACCOUNT_ID);
  ensureDashboardAccount(db(), {
    id: SUPER_ADMIN_ACCOUNT_ID,
    name: "被污染的昵称",
    provider: "local-token",
    avatarUrl: "https://avatar.example/bad.png",
  });
  expect(new AccountStore(db()).get(SUPER_ADMIN_ACCOUNT_ID)).toMatchObject({
    displayName: LOCAL_ACCOUNT_NAME,
    avatarUrl: null,
  });

  const senderIdentity = {
    externalId: "ou_super_owner",
    kind: "user" as const,
    displayName: "王华杰",
    avatarUrl: "https://avatar.example/whj.png",
    ...feishuIdentityMetadata({ environment: "feishu", appId: "test:feishu:feishu-super" }, { open_id: "ou_super_owner" }),
  };
  const stored = new ChannelDirectoryStore(db()).upsertIdentity({
    channel: { type: "feishu", id: "feishu-super" },
    identity: senderIdentity,
    agentId: superAdminScope.agent_id,
  });
  const senderUserId = db()
    .select()
    .from(schema.channelUserBindings)
    .where(eq(schema.channelUserBindings.channelIdentityId, stored.id))
    .get()!.userId;
  const token = new AccountLinkService(db()).issue({
    userId: senderUserId,
    channelType: "feishu",
    channelId: "feishu-super",
    channelIdentityId: stored.id,
  });

  new AccountLinkService(db()).link(SUPER_ADMIN_ACCOUNT_ID, superAdminScope.agent_id, token);
  const superOwnerUserId = new AgentStore(db()).ownerUserId(superAdminScope.agent_id);
  expect(user(superOwnerUserId)).toMatchObject({ displayName: "王华杰", profileSource: "channel" });
  expect(new AccountStore(db()).get(SUPER_ADMIN_ACCOUNT_ID)).toMatchObject({
    displayName: LOCAL_ACCOUNT_NAME,
    avatarUrl: null,
  });
});

test("a bot-bound Shadow follows its bot's name until the owner names it, and again once the name is cleared", () => {
  const bot = (displayName: string) => recordShadowBotIdentity(db(), "feishu-main", { externalId: "ou_bot", kind: "bot", displayName });
  const agents = new AgentStore(db());
  expect(shadow().name).toBe("feishu-main");
  bot("Monkey King\u200c");
  expect(shadow().name).toBe("Monkey King");
  expect(user(shadow().replyUserId)).toMatchObject({ displayName: "Monkey King", profileSource: "channel" });
  bot("Monkey Kong");
  expect(shadow().name).toBe("Monkey Kong");
  agents.renameShadow("fixture-owner", { agentId, shadowId }, { name: "齐天大圣" });
  expect(user(shadow().replyUserId).profileSource).toBe("manual");
  bot("Monkey Queen");
  expect(shadow().name).toBe("齐天大圣");
  // Clearing the name hands it back to the bot, which is called "Monkey Queen" by now.
  agents.renameShadow("fixture-owner", { agentId, shadowId }, { name: "  " });
  expect(shadow().name).toBe("Monkey Queen");
  expect(user(shadow().replyUserId)).toMatchObject({ displayName: "Monkey Queen", profileSource: "channel" });
});

test("a bot-bound Shadow's user shows its bot's avatar, even after the owner names it", () => {
  const bot = (avatarUrl?: string) => recordShadowBotIdentity(db(), "feishu-main", { externalId: "ou_bot", kind: "bot", displayName: "Monkey King", ...(avatarUrl ? { avatarUrl } : {}) });
  bot("https://avatar.example/one.png");
  expect(user(shadow().replyUserId).avatarUrl).toBe("https://avatar.example/one.png");
  new AgentStore(db()).renameShadow("fixture-owner", { agentId, shadowId }, { name: "齐天大圣" });
  bot("https://avatar.example/two.png");
  expect(user(shadow().replyUserId).avatarUrl).toBe("https://avatar.example/two.png");
  // A profile without an avatar, or with a non-web one, keeps the last avatar.
  bot(); bot("javascript:alert(1)");
  expect(user(shadow().replyUserId).avatarUrl).toBe("https://avatar.example/two.png");
});

test("a Shadow without a bot cannot follow one", () => {
  const agents = new AgentStore(db());
  const plain = agents.createShadow("fixture-owner", agentId, { name: "无机器人" }, "no-bot");
  expect(() => agents.renameShadow("fixture-owner", { agentId, shadowId: plain.id }, { name: "" })).toThrow("shadow_bot_name_unknown");
});

test("an @ updates the bot's Shadow; a person follows the name their messages carry; a name set in Luna stays", async () => {
  const { IdentityDirectory } = await import("../../src/identity/identity-directory");
  const botIdentity = new ChannelDirectoryStore(db()).upsertIdentity({ channel: { type: "feishu", id: "feishu-main" },
    identity: { externalId: "ou_bot", kind: "bot", displayName: "Monkey King" }, agentId });
  recordShadowBotIdentity(db(), "feishu-main", { externalId: "ou_bot", kind: "bot", displayName: "Monkey King" });
  const directory = new IdentityDirectory(db());
  directory.applyMentionDisplayName(botIdentity.id, "@Monkey Kong");
  expect(shadow().name).toBe("Monkey Kong");

  const person = { externalId: "ou_zhang", kind: "user" as const, displayName: "张三",
    ...feishuIdentityMetadata({ environment: "feishu", appId: "test:feishu:feishu-main" }, { open_id: "ou_zhang" }) };
  const stored = new ChannelDirectoryStore(db()).upsertIdentity({ channel: { type: "feishu", id: "feishu-main" }, identity: person, agentId });
  const zhang = db().select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, stored.id)).get()!.userId;
  expect(user(zhang).displayName).toBe("张三");
  // An @ label, which may be a group nickname, does not override the person's own profile name...
  directory.applyMentionDisplayName(stored.id, "小张");
  expect(user(zhang).displayName).toBe("张三");
  // ...but the name their next message carries does.
  new ChannelDirectoryStore(db()).upsertIdentity({ channel: { type: "feishu", id: "feishu-main" }, identity: { ...person, displayName: "张三丰\u200b" }, agentId });
  expect(user(zhang).displayName).toBe("张三丰");
  db().update(schema.users).set({ displayName: "老张", profileSource: "manual" }).where(eq(schema.users.id, zhang)).run();
  directory.applyMentionDisplayName(stored.id, "张三");
  expect(user(zhang).displayName).toBe("老张");
});

test("a channel is called what its bot is called, even after the owner names the Shadow", async () => {
  const { IdentityDirectory } = await import("../../src/identity/identity-directory");
  const channelName = () => db().select({ name: schema.channelConfigs.name }).from(schema.channelConfigs).where(eq(schema.channelConfigs.id, "feishu-main")).get()!.name;
  expect(channelName()).toBe("feishu-main");
  recordShadowBotIdentity(db(), "feishu-main", { externalId: "ou_bot", kind: "bot", displayName: "桑果‌" });
  expect(channelName()).toBe("桑果");
  new AgentStore(db()).renameShadow("fixture-owner", { agentId, shadowId }, { name: "齐天大圣" });
  recordShadowBotIdentity(db(), "feishu-main", { externalId: "ou_bot", kind: "bot", displayName: "悟空" });
  expect(channelName()).toBe("悟空");
  expect(shadow().name).toBe("齐天大圣");
  const bot = db().select().from(schema.channelIdentities).where(eq(schema.channelIdentities.externalId, "ou_bot")).get()!;
  new IdentityDirectory(db()).applyMentionDisplayName(bot.id, "@美猴王");
  expect(channelName()).toBe("美猴王");
});
