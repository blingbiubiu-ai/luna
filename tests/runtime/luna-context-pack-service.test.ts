import { fixtureAccount, fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { NormalizedInboundMessage } from "../../src/channels";
import { DataConnection, type DrizzleDB } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { TestMainPlan } from "./support/main-command-plan";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress } from "./support/main-command-harness";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { HonoServer } from "../../src/server";
import { config, reloadConfig, setLunaHome, type SessionConfig } from "../../src/shared";
import type { InboundChannelMessage } from "../../src/sessions/types";
import { normalizedInboundFromDirectCallForTest } from "../../src/work/direct-call-inbound-adapter";

const TEST_ACCESS_TOKEN_SECRET = "luna-context-pack-service-secret";

let testHome: string;
let previousHome: string;
let agentId: string;
let ownerId: string;
let database: DataConnection<typeof lunaSchema>;
let honoServer: HonoServer;
let dashboardApiToken: string;
let previousAccessTokenSecret: string | undefined;
let previousBunAccessTokenSecret: string | undefined;

const fastSessionConfig = {
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

beforeEach(async () => {
  previousAccessTokenSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
  previousBunAccessTokenSecret = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
  process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
  Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;

  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-context-pack-service-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  writeRuntimeConfig(testHome);
  setLunaHome(testHome);
  reloadConfig();
  database = new DataConnection(lunaSchema);
  honoServer = new HonoServer({ db: database.db });
  dashboardApiToken = issueDashboardApiToken(database.db);
});

afterEach(async () => {
  try {
    await honoServer?.stop();
  } finally {
    try {
      database?.close();
    } catch {
      // The test uses the Hono app without starting the HTTP listener.
    }
    setLunaHome(previousHome);
    rmSync(testHome, { recursive: true, force: true });
    restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousAccessTokenSecret);
    restoreBunEnv("LUNA_ACCESS_TOKEN_SECRET", previousBunAccessTokenSecret);
  }
});

describe("Luna context pack service acceptance", () => {
  test("Dashboard API reads task launch context produced through FakeFeishu ingress", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner(() => ({
      operation: "task.create",
      taskType: "task",
      title: "修复播放失败",
      summary: "用户要求创建修复任务并跟进播放失败。",
      facts: ["用户反馈播放失败 did=4453477614363128。"],
      dispatchReply: "已创建任务，会在这里同步关键进展。",
      reason: "service acceptance task launch",
    }));
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await ingress.registerChannel(channel);

    await channel.emitInbound(groupInbound({
      id: "m_service_task_launch",
      text: "@Luna 帮我建个修复任务，播放失败 did=4453477614363128",
      senderUserId: "requester-user",
      addressing: { addressedToBot: true, reason: "mention" },
    }));
    await ingress.waitForIdle();

    const tasksResponse = await requestApi("/api/tasks");
    expect(tasksResponse.status).toBe(200);
    const taskList = await tasksResponse.json() as DashboardTask[];
    expect(taskList).toHaveLength(1);
    const [task] = taskList;
    const taskPackIds = task!.contextPacks.map((pack) => pack.id);
    const taskLaunchPack = task!.contextPacks.find(
      (pack) => pack.kind === "task_launch",
    );
    expect(taskLaunchPack).toBeDefined();
    expect(taskLaunchPack?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "source",
        messagePreview:
          "@Luna 帮我建个修复任务，播放失败 did=4453477614363128",
      }),
    ]));
    expect(task!.runs[0]?.materializedPrompt).toContain("<launch_context>");
    expect(task!.runs[0]?.materializedPrompt).toContain(
      "播放失败 did=4453477614363128",
    );
    expect(task!.runs[0]?.contextPacks.map((pack) => pack.id)).toEqual(
      expect.arrayContaining(taskPackIds),
    );

    const sessionsResponse = await requestApi("/api/sessions");
    expect(sessionsResponse.status).toBe(200);
    const sessions = await sessionsResponse.json() as DashboardSession[];
    expect(
      sessions.some((session) =>
        session.linkedTasks.some((linked) => linked.id === task!.id)
      ),
    ).toBe(true);

    const taskDetailResponse = await requestApi(`/api/tasks/${task!.id}`);
    expect(taskDetailResponse.status).toBe(200);
    const taskDetail = await taskDetailResponse.json() as DashboardTask;
    expect(taskDetail.contextPacks.map((pack) => pack.id)).toEqual(
      expect.arrayContaining(taskPackIds),
    );
    expect(JSON.stringify(taskDetail)).toContain("task_launch");
    expect(JSON.stringify(taskDetail)).toContain("materializedPrompt");
  });
});

class FakeFeishuChannel extends BaseFakeFeishuChannel {
  constructor(
    id: string,
    inbound: readonly (NormalizedInboundMessage | InboundChannelMessage)[] = [],
    options?: ConstructorParameters<typeof BaseFakeFeishuChannel>[2],
  ) {
    super(id, inbound.map(normalizeInboundForFakeFeishuTest), options);
  }

  async emitInbound(message: InboundChannelMessage): Promise<void> {
    await this.emitNormalizedInbound(normalizeInboundForFakeFeishuTest(message));
  }
}

class ScriptedMainRunner {
  readonly calls: MainRunnerRunInput[] = [];

  constructor(
    private readonly _handler: (
      input: MainRunnerRunInput,
    ) => TestMainPlan | Promise<TestMainPlan>,
  ) {}

  async run(input: MainRunnerRunInput): Promise<TestMainPlan> {
    this.calls.push(input);
    return await this._handler(input);
  }

  asMainRunner(): MainRunner {
    return this as unknown as MainRunner;
  }
}

function normalizeInboundForFakeFeishuTest(
  message: NormalizedInboundMessage | InboundChannelMessage,
): NormalizedInboundMessage {
  return "channel" in message
    ? message
    : normalizedInboundFromDirectCallForTest(message);
}

function groupInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly senderUserId?: string;
  readonly addressing?: InboundChannelMessage["addressing"];
}): InboundChannelMessage {
  const message: InboundChannelMessage = {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "group-alpha",
    rootMessageId: input.id,
    senderUserId: input.senderUserId ?? "user-1",
    text: input.text,
    chatType: "group",
    addressing: input.addressing ?? {
      addressedToBot: false,
      reason: "silent_group",
    },
  };
  const db = database.db;
  const inbound = normalizedInboundFromDirectCallForTest(message);
  return message;
}

async function requestApi(path: string): Promise<Response> {
  return await honoServer.app.fetch(
    new Request(`http://luna.test${path}${path === "/api/tasks" || path === "/api/sessions" ? `?agentId=${agentId}` : ""}`, {
      headers: { authorization: `Bearer ${dashboardApiToken}` },
    }),
  );
}

function issueDashboardApiToken(db: DrizzleDB): string {
  ownerId = fixtureAccount(db, "dashboard-api-test-account").id;
  ({agent_id: agentId} = fixtureSessionOwnership(db, "feishu", "feishu-main", ownerId));
  return new AccessTokenService({
    db,
    signingSecret: TEST_ACCESS_TOKEN_SECRET,
  }).issueToken({
    accountId: ownerId,
    name: "Context pack service API test token",
    source: "cli",
    role: "user",
    ttlMs: 60 * 60 * 1000,
    now: Date.now(),
  }).token;
}

function writeRuntimeConfig(home: string): void {
  writeFileSync(
    join(home, "config.yaml"),
    [
      "messaging:",
      "  default_channel_id: fake",
      "  channels: []",
      "session:",
      "  coalesce_idle_ms: 1",
      "  coalesce_max_wait_ms: 25",
      "  max_batch_size: 8",
      "  max_task_actions_per_batch: 3",
      "  processing_notice_after_ms: 1500",
      "  stale_claim_ms: 120000",
      "  turn_warn_after_ms: 120000",
      "  max_queue_depth: 50",
      "  activation_context_window_ms: 300000",
      "  activation_context_max_messages: 12",
      "  activation_context_max_chars: 6000",
      "  activation_context_recent_unprocessed_messages: 10",
      "  activation_context_max_cc_reporters: 1",
      "  group_bot_aliases: []",
      "  group_activation_followup_window_ms: 300000",
      "  group_activation_followup_senders: requester_and_reporters",
      "  group_activation_followup_max_messages: 8",
      "  group_activation_followup_recent_messages: 3",
      "  group_activation_followup_interrupt_on_other_user: true",
      "",
    ].join("\n"),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function restoreBunEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete Bun.env[name];
  } else {
    Bun.env[name] = value;
  }
}

interface DashboardContextPack {
  readonly id: string;
  readonly kind: string;
  readonly items: readonly {
    readonly role: string;
    readonly messagePreview: string | null;
  }[];
}

interface DashboardTask {
  readonly id: string;
  readonly contextPacks: readonly DashboardContextPack[];
  readonly runs: readonly {
    readonly materializedPrompt: string | null;
    readonly contextPacks: readonly DashboardContextPack[];
  }[];
}

interface DashboardSession {
  readonly id: string;
  readonly linkedTasks: readonly {
    readonly id: string;
  }[];
}
