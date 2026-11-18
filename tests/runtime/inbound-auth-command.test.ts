import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import {
  channelAuthTokens,
  messages,
  sessionInbox,
} from "../../src/data/schema";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress } from "../../src/messaging/gateway/luna-message-ingress";
import type { InboundChannelMessage } from "../../src/sessions/types";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { AccountLinkService } from "../../src/identity/account-link";
import { config, setLunaHome } from "../../src/shared";
import { normalizedInboundFromDirectCallForTest } from "../../src/work/direct-call-inbound-adapter";

describe("inbound auth command", () => {
  let home: string, previousHome: string;
  let connection: DataConnection<typeof schema>;
  let previousAccessSecret: string | undefined;
  let previousBunAccessSecret: string | undefined;
  let agentId: string;

  beforeEach(() => {
    previousHome = config.paths.home;
    home = mkdtempSync(join(tmpdir(), "luna-inbound-auth-command-"));
    mkdirSync(join(home, "data"), { recursive: true });
    previousAccessSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
    previousBunAccessSecret = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    process.env.LUNA_ACCESS_TOKEN_SECRET = "inbound-auth-command-secret";
    Bun.env.LUNA_ACCESS_TOKEN_SECRET = "inbound-auth-command-secret";
    setLunaHome(home);
    connection = new DataConnection(schema);
    agentId = fixtureSessionOwnership(connection.db, "feishu", "feishu-main").agent_id;
  });

  afterEach(() => {
    connection.close();
    setLunaHome(previousHome);
    restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousAccessSecret);
    restoreBunEnv("LUNA_ACCESS_TOKEN_SECRET", previousBunAccessSecret);
    rmSync(home, { recursive: true, force: true });
  });

  test("private #auth issues a one-time channel login token without entering the Luna queue", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = new LunaMessageIngress({
      db: connection.db,
      runnerType: "mock",
    });
    await ingress.registerChannel(channel);

    // #auth signs in an account, so the chat identity must first be linked to one by the Agent owner.
    await channel.emitNormalizedInbound(
      normalizedInboundFromDirectCallForTest(feishuInbound({
        id: "msg-link-private",
        chatType: "p2p",
        groupId: undefined,
        text: "#link",
      })),
    );
    await ingress.waitForIdle();
    const linkToken = channel.outbound[0]?.content.split("\n")[2] ?? "";
    new AccountLinkService(connection.db).link("fixture-owner", agentId, linkToken);
    channel.outbound.length = 0;

    await channel.emitNormalizedInbound(
      normalizedInboundFromDirectCallForTest(feishuInbound({
        id: "msg-auth-private",
        chatType: "p2p",
        groupId: undefined,
        text: "#auth",
      })),
    );
    await ingress.waitForIdle();

    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]?.replyMode).toBe("direct_message");
    expect(channel.outbound[0]?.content).toContain("One-time login token");
    expect(connection.db.select({ purpose: channelAuthTokens.purpose }).from(channelAuthTokens).all())
      .toEqual([{ purpose: "account_link" }, { purpose: "cli_login" }]);
    expect(connection.db.select().from(messages).all()).toHaveLength(0);
    expect(connection.db.select().from(sessionInbox).all()).toHaveLength(0);
  });

  test("group #auth without bot mention stays silent and bypasses the Luna queue", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = new LunaMessageIngress({
      db: connection.db,
      runnerType: "mock",
    });
    await ingress.registerChannel(channel);

    await channel.emitNormalizedInbound(
      normalizedInboundFromDirectCallForTest(feishuInbound({
        id: "msg-auth-group",
        chatType: "group",
        groupId: "group-auth",
        text: "#auth",
        addressedToBot: false,
      })),
    );
    await ingress.waitForIdle();

    expect(channel.outbound).toHaveLength(0);
    expect(connection.db.select().from(channelAuthTokens).all()).toHaveLength(0);
    expect(connection.db.select().from(messages).all()).toHaveLength(0);
    expect(connection.db.select().from(sessionInbox).all()).toHaveLength(0);
  });

  test("group #auth with bot mention is rejected and still bypasses the Luna queue", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = new LunaMessageIngress({
      db: connection.db,
      runnerType: "mock",
    });
    await ingress.registerChannel(channel);

    await channel.emitNormalizedInbound(
      normalizedInboundFromDirectCallForTest(feishuInbound({
        id: "msg-auth-group-mentioned",
        chatType: "group",
        groupId: "group-auth",
        text: "@Luna #auth",
        addressedToBot: true,
      })),
    );
    await ingress.waitForIdle();

    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]?.content).toContain("Please send #auth in a private chat");
    expect(connection.db.select().from(channelAuthTokens).all()).toHaveLength(0);
    expect(connection.db.select().from(messages).all()).toHaveLength(0);
    expect(connection.db.select().from(sessionInbox).all()).toHaveLength(0);
  });
});

function feishuInbound(input: {
  readonly id: string;
  readonly chatType: "p2p" | "group";
  readonly groupId: string | undefined;
  readonly text: string;
  readonly addressedToBot?: boolean;
}): InboundChannelMessage {
  return {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    senderUserId: "ou_auth_user",
    text: input.text,
    chatType: input.chatType,
    addressing: {
      addressedToBot: input.addressedToBot ?? true,
      reason: input.chatType === "p2p"
        ? "p2p"
        : input.addressedToBot === false
          ? "silent_group"
          : "mention",
    },
    senderProfile: {
      externalUserId: "ou_auth_user",
      openId: "ou_auth_user",
      unionId: "on_auth_user",
      tenantKey: "tenant_auth",
      displayName: "Auth User",
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function restoreBunEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete Bun.env[key];
    return;
  }
  Bun.env[key] = value;
}
