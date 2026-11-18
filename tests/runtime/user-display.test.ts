import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../src/data/schema";
import { loadDashboardUserRows } from "../../src/dashboard-api/user-display";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import { FeishuMessageChannel } from "../../extensions/channels/feishu";

test("write-time display updates respect source priority after platform conversion", () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "src/data/drizzle" });
  sqlite.exec("PRAGMA foreign_keys=OFF");
  const now = "1";
  db.insert(schema.users).values({ id: "u", agentId: "agent", kind: "human", displayName: "ou_test", createdAt: now, updatedAt: now }).run();
  db.insert(schema.channelIdentities).values({ id: "identity", channelType: "feishu", channelId: "feishu-default", externalId: "ou_test", identityKind: "user", firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now }).run();
  db.insert(schema.channelUserBindings).values({channelIdentityId: "identity", userId: "u", createdAt: Date.now()}).run();
  db.insert(schema.userIdentityLinks).values({ id: "link", agentId: "agent", userId: "u", identityNamespace: "lark", identityKind: "open_id", identityValue: "ou_test", identityScope: "app:one", confidence: "verified", createdAt: now, updatedAt: now }).run();
  for (const [index, label] of ["@旧名字", "@吕嘉宁", "@ou_test", "@unknown", "   "].entries()) {
    db.insert(schema.messageMentions).values({ id: String(index), messageId: "m", mentionKey: String(index), mentionLabel: label, targetIdentityId: "identity", targetExternalId: "ou_test", targetKind: "user", createdAt: index }).run();
  }
  new IdentityDirectory(db).applyMentionDisplayName("identity", "@吕嘉宁");
  expect(loadDashboardUserRows(db, "agent")[0]).toMatchObject({ displayName: "吕嘉宁", displayNameSource: "mention", avatarUrl: null });
  expect(db.select().from(schema.users).get()?.displayName).toBe("吕嘉宁");
  db.delete(schema.messageMentions).run();
  expect(loadDashboardUserRows(db, "agent")[0]?.displayName).toBe("吕嘉宁");
  new IdentityDirectory(db).materializeIdentityClaims({agentId: "agent", kind: "human", displayName: "ou_test", channelIdentityId: "identity", claims: []});
  expect(db.select().from(schema.users).get()?.displayName).toBe("吕嘉宁");
  db.update(schema.users).set({ displayName: "正式姓名", profileSource: "channel" }).where(eq(schema.users.id, "u")).run();
  expect(loadDashboardUserRows(db, "agent")[0]).toMatchObject({ displayName: "正式姓名", displayNameSource: "channel" });
  db.update(schema.users).set({ displayName: "手动姓名", profileSource: "manual" }).run();
  expect(loadDashboardUserRows(db, "agent")[0]).toMatchObject({ displayName: "手动姓名", displayNameSource: "manual" });
  db.update(schema.users).set({ displayName: "ou_test", profileSource: "channel" }).run();
  const directory = new IdentityDirectory(db);
  directory.applyMentionDisplayName("identity", "@新姓名");
  directory.applyMentionDisplayName("identity", "@ou_test");
  expect(db.select().from(schema.users).get()).toMatchObject({displayName: "新姓名", profileSource: "mention"});
  directory.materializeIdentityClaims({agentId: "agent", kind: "human", displayName: "正式更新", channelIdentityId: "identity", claims: []});
  directory.applyMentionDisplayName("identity", "@不能覆盖");
  expect(db.select().from(schema.users).get()).toMatchObject({displayName: "正式更新", profileSource: "channel"});
  db.update(schema.users).set({displayName: "ou_test"}).run();
  db.delete(schema.userIdentityLinks).run();
  expect(loadDashboardUserRows(db, "agent")[0]).toMatchObject({ displayName: "ou_test", displayNameSource: "id" });
  sqlite.close();
});

test("failed Feishu profile lookup retries after five minutes and recovers", async () => {
  const channel = new FeishuMessageChannel("test-feishu", { chatId: "chat-id", appId: "cli_test", appSecret: "test" });
  const internal = channel as any;
  internal._logger = { warn() {}, info() {}, error() {} };
  let calls = 0;
  internal._client = { contact: { v3: { user: { get: async () => {
    calls++;
    if (calls === 1) throw new Error("no user authority error");
    return { data: { user: { name: "吕嘉宁", avatar: { avatar_72: "https://example.test/avatar" } } } };
  } } } } };
  const sender = { sender_id: { open_id: "ou_test" }, sender_type: "user" };
  expect((await internal._resolveFeishuUserProfile(sender)).displayName).toBeUndefined();
  await internal._resolveFeishuUserProfile(sender);
  expect(calls).toBe(1);
  const expiry = internal._userProfileExpiresAt.get("ou_test");
  expect(expiry - Date.now()).toBeGreaterThan(299_000);
  internal._userProfileExpiresAt.set("ou_test", Date.now() - 1);
  expect(await internal._resolveFeishuUserProfile(sender)).toMatchObject({ displayName: "吕嘉宁", avatarUrl: "https://example.test/avatar" });
  expect(calls).toBe(2);
  await internal._resolveFeishuUserProfile(sender);
  expect(calls).toBe(2);
});
