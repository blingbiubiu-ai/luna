import { eq } from "drizzle-orm";
import { fixturePlatformAdmin, fixtureSessionOwnership } from "../../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as SQLiteDatabase } from "bun:sqlite";

import { DataConnection, type DrizzleDB } from "../../../src/data";
import * as lunaSchema from "../../../src/data/schema";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress } from "./main-command-harness";
import { HonoServer } from "../../../src/server/server";
import type { InboundChannelMessage } from "../../../src/sessions/types";
import { config, setLunaHome, type SessionConfig } from "../../../src/shared";
import { normalizedInboundFromDirectCallForTest } from "../../../src/work/direct-call-inbound-adapter";
import { createDeterministicMainRunner } from "../test-main-runner";

const sessionConfig = {
  coalesce_idle_ms: 1,
  coalesce_max_wait_ms: 25,
  max_batch_size: 8,
  max_task_actions_per_batch: 3,
  processing_notice_after_ms: 1500,
  stale_claim_ms: 120000,
  turn_warn_after_ms: 120000,
  max_queue_depth: 50,
  activation_context_window_ms: 300000,
  activation_context_max_messages: 12,
  activation_context_max_chars: 6000,
  activation_context_recent_unprocessed_messages: 10,
  activation_context_max_cc_reporters: 1,
  group_bot_aliases: [],
  group_activation_followup_window_ms: 300000,
  group_activation_followup_senders: "requester_and_reporters",
  group_activation_followup_max_messages: 8,
  group_activation_followup_recent_messages: 3,
  group_activation_followup_interrupt_on_other_user: true,
} satisfies SessionConfig;

const TEST_ACCESS_TOKEN_SECRET = "runtime-harness-access-token-secret";
const owner = "local-dashboard-user";
const TEST_DASHBOARD_TOKEN = "runtime-harness-dashboard-token";

export interface RuntimeHarness {
  readonly db: DrizzleDB<typeof lunaSchema>;
  readonly emitFeishuMessage: (input: FeishuInboundInput) => Promise<void>;
  readonly waitForIdle: () => Promise<void>;
  readonly fetchJson: <T>(
    path: string,
  ) => Promise<T>;
  readonly countRows: (tableName: string) => number;
  readonly close: () => Promise<void>;
}

export interface FeishuInboundInput {
  readonly messageId: string;
  readonly senderOpenId: string;
  readonly senderProfile?: {
    readonly openId?: string;
    readonly unionId?: string;
    readonly userId?: string;
    readonly tenantKey?: string;
    readonly displayName?: string;
    readonly avatarUrl?: string;
  };
  readonly text: string;
  readonly mentions?: readonly FeishuMentionInput[];
}

export interface FeishuMentionInput {
  readonly key: string;
  readonly id: {
    readonly open_id?: string;
    readonly user_id?: string;
    readonly union_id?: string;
  };
  readonly name?: string;
  readonly mentioned_type?: string;
}

export async function createRuntimeHarnessForTest(): Promise<RuntimeHarness> {
  const testHome = mkdtempSync(join(tmpdir(), "luna-runtime-harness-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  const previousAccessTokenSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
  const previousBunAccessTokenSecret = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
  const previousDashboardToken = process.env.LUNA_DASHBOARD_TOKEN;
  const previousBunDashboardToken = Bun.env.LUNA_DASHBOARD_TOKEN;
  process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
  Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
  process.env.LUNA_DASHBOARD_TOKEN = TEST_DASHBOARD_TOKEN;
  Bun.env.LUNA_DASHBOARD_TOKEN = TEST_DASHBOARD_TOKEN;
  const previousHome = config.paths.home;
  setLunaHome(testHome);

  const database = new DataConnection(lunaSchema);
  const channel = new BaseFakeFeishuChannel("feishu-main");
  fixtureSessionOwnership(database.db, "feishu", channel.id, owner);
  fixturePlatformAdmin(database.db, owner);
  const ingress = new LunaMessageIngress({
    db: database.db,
    runnerType: "mock",
    mainRunner: createDeterministicMainRunner(database.db),
    sessionConfig,
  });
  const server = new HonoServer({ db: database.db });
  await ingress.registerChannel(channel);
  const dashboardCookie = await loginHarnessDashboard(server, TEST_DASHBOARD_TOKEN);

  return {
    db: database.db,
    emitFeishuMessage: async (input) => {
      const message = normalizedInboundFromDirectCallForTest(feishuMessage(input, channel.id), {
        environment: "feishu", appId: `test:feishu:${channel.id}`,
      });
      await channel.emitNormalizedInbound(message);
    },
    waitForIdle: () => ingress.waitForIdle(),
    fetchJson: async <T>(
      path: string,
    ): Promise<T> => {
      const response = await server.app.fetch(
        new Request(`http://luna.test${path}`, {
          headers: { cookie: dashboardCookie },
        }),
      );
      if (!response.ok) {
        throw new Error(
          `Harness fetch ${path} failed with ${response.status}: ${await response.text()}`,
        );
      }
      return (await response.json()) as T;
    },
    countRows: (tableName) =>
      sqlite(database)
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM "${tableName.replaceAll("\"", "\"\"")}"`,
        )
        .get()?.count ?? 0,
    close: async () => {
      await ingress.stop().catch(() => undefined);
      await server.stop().catch(() => undefined);
      database.close();
      setLunaHome(previousHome);
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousAccessTokenSecret);
      restoreBunEnv("LUNA_ACCESS_TOKEN_SECRET", previousBunAccessTokenSecret);
      restoreEnv("LUNA_DASHBOARD_TOKEN", previousDashboardToken);
      restoreBunEnv("LUNA_DASHBOARD_TOKEN", previousBunDashboardToken);
      rmSync(testHome, { recursive: true, force: true });
    },
  };
}

async function loginHarnessDashboard(
  server: HonoServer,
  token: string,
): Promise<string> {
  const response = await server.app.fetch(
    new Request("http://luna.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  if (!response.ok) {
    throw new Error(
      `Harness dashboard login failed with ${response.status}: ${await response.text()}`,
    );
  }
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Harness dashboard login did not return a session cookie");
  }
  return cookie;
}

function feishuMessage(
  input: FeishuInboundInput,
  channelId: string,
): InboundChannelMessage {
  return {
    id: input.messageId,
    channelType: "feishu",
    channelId,
    groupId: "group-identity",
    rootMessageId: input.messageId,
    senderUserId: input.senderOpenId,
    text: input.text,
    chatType: "group",
    addressing: { addressedToBot: true, reason: "mention" },
    senderProfile: {
      externalUserId: input.senderProfile?.openId ?? input.senderOpenId,
      openId: input.senderProfile?.openId ?? input.senderOpenId,
      ...(input.senderProfile?.userId !== undefined
        ? { userId: input.senderProfile.userId }
        : {}),
      ...(input.senderProfile?.unionId !== undefined
        ? { unionId: input.senderProfile.unionId }
        : {}),
      ...(input.senderProfile?.tenantKey !== undefined
        ? { tenantKey: input.senderProfile.tenantKey }
        : {}),
      ...(input.senderProfile?.displayName !== undefined
        ? { displayName: input.senderProfile.displayName }
        : {}),
      ...(input.senderProfile?.avatarUrl !== undefined
        ? { avatarUrl: input.senderProfile.avatarUrl }
        : {}),
    },
    mentions: input.mentions?.map((mention) => ({
      key: mention.key,
      ...(mention.name !== undefined ? { name: mention.name } : {}),
      ...(mention.id.open_id !== undefined
        ? { openId: mention.id.open_id }
        : {}),
      ...(mention.id.user_id !== undefined
        ? { userId: mention.id.user_id }
        : {}),
      ...(mention.id.union_id !== undefined
        ? { unionId: mention.id.union_id }
        : {}),
      ...(mention.mentioned_type !== undefined
        ? { mentionedType: mention.mentioned_type }
        : {}),
    })),
  };
}

function sqlite(
  database: DataConnection<typeof lunaSchema>,
): SQLiteDatabase {
  return (database as unknown as {
    readonly _sqlite: SQLiteDatabase;
  })._sqlite;
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
