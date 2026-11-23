import { fixtureOwnerUserId, fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { NormalizedInboundMessage } from "../../src/channels";
import type { DrizzleDB } from "../../src/data";
import {
  contextPackItems,
  contextPacks,
  messages,
  runnerContextSeedRecords,
  sessionInbox,
  sessionCommands,
  sessions,
  sessionTimelineEntries,
  taskRuns,
  tasks,
} from "../../src/data/schema";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { TestMainPlan } from "./support/main-command-plan";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress as BaseLunaMessageIngress } from "./support/main-command-harness";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { config, reloadConfig, setLunaHome, type SessionConfig } from "../../src/shared";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionTimelineStore } from "../../src/sessions/session-timeline-store";
import type {
  InboundChannelMessage,
  MessageContentBlock,
} from "../../src/sessions/types";
import { normalizedInboundFromDirectCallForTest } from "./support/direct-call-inbound-adapter";

const TEST_ACCESS_TOKEN_SECRET = "luna-context-pack-flow-secret";

let testHome: string;
let previousHome: string;
let agentId: string;
let ownerId: string;
let kernel: RuntimeKernel;
let dashboardApiToken: string;
let previousAccessTokenSecret: string | undefined;
let previousBunAccessTokenSecret: string | undefined;

const fastSessionConfig = {
  coalesce_idle_ms: 1,
  coalesce_max_wait_ms: 25,
  max_batch_size: 8,
  stale_claim_ms: 120000,
  activation_context_window_ms: 300000,
  activation_context_max_messages: 12,
  activation_context_max_chars: 6000,
  activation_context_recent_unprocessed_messages: 10,
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
  testHome = mkdtempSync(join(tmpdir(), "luna-context-pack-flow-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  writeRuntimeConfig(testHome);
  setLunaHome(testHome);
  reloadConfig();

  kernel = await freshKernel();
  dashboardApiToken = issueDashboardApiToken(kernel.database.db);
});

afterEach(async () => {
  try {
    await kernel?.stop();
  } finally {
    try {
      kernel?.database.close();
    } catch {
      // A started kernel closes its database in stop(); flow tests use the app
      // without starting the HTTP server.
    }
    setLunaHome(previousHome);
    rmSync(testHome, { recursive: true, force: true });
    restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousAccessTokenSecret);
    restoreBunEnv("LUNA_ACCESS_TOKEN_SECRET", previousBunAccessTokenSecret);
  }
});

describe("Luna context pack FakeFeishu flow", () => {
  test("group activation persists delta context and exposes the same pack through sessions API", async () => {
    const runner = new ScriptedMainRunner(() => ({
      operation: "message.send",
      reply: "收到，我会结合群聊上下文处理。",
      reason: "test addressed group activation",
    }));
    const ingress = new LunaMessageIngress({
      db: kernel.database.db,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
    });
    const channel = new FakeFeishuChannel("feishu-main");
    await ingress.registerChannel(channel);

    await emitAndDrain(ingress, channel, groupInbound({
      id: "m_group_silent_context",
      text: "播放失败，did=4453477614363128",
      senderUserId: "reporter-user",
    }));
    await emitAndDrain(ingress, channel, groupInbound({
      id: "m_group_addressed",
      text: "@Luna 帮忙处理一下",
      senderUserId: "requester-user",
      addressing: { addressedToBot: true, reason: "mention" },
    }));

    expect(kernel.database.db.select().from(messages).all()).toHaveLength(3);
    expect(kernel.database.db.select().from(sessionInbox).all()).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    const call = userMessagesCall(runner, "m_group_addressed");
    expect(call.activationContextMessages).toBeUndefined();
    expect(call.context.deltaContext?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "播放失败，did=4453477614363128",
          role: "delta_context",
        }),
      ]),
    );

    const pack = packByKind(kernel.database.db, "group_activation");
    expect(pack).toMatchObject({
      ownerType: "session",
      kind: "group_activation",
      selectionStrategy: "deterministic_window",
      triggerMessageId: call.messages[0]?.messageId,
    });
    expect(itemsForPack(kernel.database.db, pack.id)).toEqual([
      expect.objectContaining({
        role: "delta_context",
        reason: "group activation context",
      }),
    ]);

    const sessionsResponse = await getJson<DashboardSession[]>("/api/sessions");
    const session = sessionsResponse.find((row) => row.id === pack.ownerId);
    expect(session?.launchContextPacks.map((item) => item.id)).not.toContain(
      pack.id,
    );
    expect(session?.contextPacks.map((item) => item.id)).toContain(pack.id);
    expect(session?.contextPacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pack.id,
          kind: "group_activation",
          items: expect.arrayContaining([
            expect.objectContaining({
              role: "delta_context",
              messagePreview: "播放失败，did=4453477614363128",
            }),
          ]),
        }),
      ]),
    );

    const timeline = await getJson<DashboardSessionTimelineItem[]>(
      `/api/sessions/${pack.ownerId}/timeline`,
    );
    const turnItem = timeline.find((item) => item.type === "turn");
    expect(turnItem).toBeDefined();
    if (turnItem?.type !== "turn") {
      throw new Error("expected turn timeline item");
    }
    expect(turnItem.messages).toHaveLength(1);
    expect(kernel.database.db.select().from(sessionCommands).all()).toMatchObject([{kind: "message.send", payload: {content: "收到，我会结合群聊上下文处理。"}}]);
    expect(turnItem.turn.materializedPrompt).toContain(
      "<events>\n",
    );
    expect(turnItem.turn.materializedPrompt).toContain("@Luna 帮忙处理一下");
  });

  test("thread launch projects reference timeline entries and exposes launch context through sessions API", async () => {
    const runner = new ScriptedMainRunner(() => ({
      operation: "message.send",
      reply: "收到，我会看这个 thread。",
      reason: "test thread launch",
    }));
    const ingress = new LunaMessageIngress({
      db: kernel.database.db,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
    });
    const channel = new FakeFeishuChannel("feishu-main");
    await ingress.registerChannel(channel);

    await emitAndDrain(ingress, channel, groupInbound({
      id: "m_thread_root",
      text: "主消息：视频打不开",
      senderUserId: "reporter-user",
    }));
    await emitAndDrain(ingress, channel, groupInbound({
      id: "m_thread_reply",
      text: "@Luna 处理这个 thread",
      threadId: "thread-context-pack",
      rootMessageId: "m_thread_root",
      senderUserId: "requester-user",
      addressing: { addressedToBot: true, reason: "mention" },
    }));

    const call = userMessagesCall(runner, "m_thread_reply");
    expect(call.context.launchSeed?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "主消息：视频打不开",
          role: "seed",
        }),
      ]),
    );
    const pack = packByKind(kernel.database.db, "thread_launch");
    const seedRecords = kernel.database.db
      .select()
      .from(runnerContextSeedRecords)
      .where(eq(runnerContextSeedRecords.ownerId, pack.ownerId))
      .all();
    expect(seedRecords).toEqual([
      expect.objectContaining({
        ownerType: "session",
        seedContextPackId: pack.id,
      }),
    ]);
    const threadSession = kernel.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, pack.ownerId))
      .get();
    expect(threadSession).toMatchObject({
      thread_key: "thread-context-pack",
      root_message_key: "m_thread_root",
    });
    expect(
      kernel.database.db
        .select()
        .from(sessionTimelineEntries)
        .where(eq(sessionTimelineEntries.sessionId, pack.ownerId))
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryKind: "reference" }),
        expect.objectContaining({ entryKind: "message" }),
      ]),
    );

    const sessionsResponse = await getJson<DashboardSession[]>("/api/sessions");
    const apiThread = sessionsResponse.find((row) => row.id === pack.ownerId);
    expect(apiThread?.launchContextPacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pack.id,
          kind: "thread_launch",
          items: expect.arrayContaining([
            expect.objectContaining({
              role: "seed",
              messagePreview: "主消息：视频打不开",
            }),
          ]),
        }),
      ]),
    );
  });

  test("sessions API orders reference messages by message occurrence time", async () => {
    const now = Date.now();
    kernel.database.db
      .insert(sessions)
      .values([
        contextSessionRow({
          id: "api-session-root",
          surfaceKey: "feishu:main:group:api-root",
          title: "Root",
          now,
        }),
        contextSessionRow({
          id: "api-session-thread",
          surfaceKey: "feishu:main:group:api-thread",
          title: "Thread",
          now,
          parentSessionId: "api-session-root",
          rootMessageKey: "api-message-newer",
          threadKey: "api-message-newer",
        }),
      ])
      .run();
    const store = new MessageStore(kernel.database.db);
    const older = store.appendOnce({
      sessionId: "api-session-root",
      channelMessageKey: "api-message-older",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "feishu-main" },
      content: { text: "older context" },
      rawPayload: { message_type: "text", audit: "api-message-older" },
      createdAt: now + 10,
    });
    const newer = store.appendOnce({
      sessionId: "api-session-root",
      channelMessageKey: "api-message-newer",
      senderUserId: "user-1",
      role: "user",
      channel: { type: "feishu", id: "feishu-main" },
      content: { text: "newer anchor" },
      rawPayload: { message_type: "text", audit: "api-message-newer" },
      createdAt: now + 30,
    });
    const timeline = new SessionTimelineStore(kernel.database.db);
    timeline.appendReference({
      sessionId: "api-session-thread",
      messageId: newer.row.id,
    });
    timeline.appendReference({
      sessionId: "api-session-thread",
      messageId: older.row.id,
    });

    const messagesResponse = await getJson<Array<{ channel_message_key: string | null }>>(
      "/api/sessions/api-session-thread/messages",
    );
    expect(messagesResponse.map((message) => message.channel_message_key)).toEqual([
      "api-message-older",
      "api-message-newer",
    ]);
  });

  test("task launch materializes source context and exposes the same pack through tasks API", async () => {
    const runner = new ScriptedMainRunner(() => ({
      operation: "task.create",
      taskType: "task",
      title: "修复播放失败",
      summary: "用户要求创建修复任务并跟进播放失败。",
      facts: ["用户反馈播放失败 did=4453477614363128。"],
      assumptions: ["目标是当前 Luna runtime 测试任务。"],
      dispatchReply: "已创建任务，会在这里同步关键进展。",
      reason: "test task launch context pack",
    }));
    const ingress = new LunaMessageIngress({
      db: kernel.database.db,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const channel = new FakeFeishuChannel("feishu-main");
    await ingress.registerChannel(channel);

    await emitAndDrain(ingress, channel, groupInbound({
      id: "m_task_prior_context",
      text: "补充上下文：只影响 Android 端，还有一张截图。",
      senderUserId: "reporter-user",
    }));
    await emitNormalizedAndDrain(ingress, channel, groupNormalized({
      id: "m_task_prior_image",
      text: "补充截图如下",
      senderUserId: "reporter-user",
      contentBlocks: [
        { type: "text", text: "补充截图如下" },
        { type: "image", url: "workspace/uploads/images/android-playback.png" },
      ],
    }));
    await emitAndDrain(ingress, channel, groupInbound({
      id: "m_task_launch",
      text: "@Luna 帮我建个修复任务，播放失败 did=4453477614363128",
      senderUserId: "requester-user",
      addressing: { addressedToBot: true, reason: "mention" },
    }));

    const [task] = kernel.database.db.select().from(tasks).all();
    expect(task).toMatchObject({
      type: "task",
      title: "修复播放失败",
    });
    const pack = packByKind(kernel.database.db, "task_launch");
    expect(pack).toMatchObject({
      ownerType: "task",
      ownerId: task!.id,
      kind: "task_launch",
      selectionStrategy: "source_turn",
    });
    expect(itemsForPack(kernel.database.db, pack.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "source",
          reason: "task source message",
        }),
      ]),
    );
    const [run] = kernel.database.db.select().from(taskRuns).all();
    const materializedPrompt = run?.materialized_prompt ?? "";
    expect(materializedPrompt).toContain("<launch_context>");
    expect(materializedPrompt).toContain('"role":"source"');
    expect(materializedPrompt).toContain("播放失败 did=4453477614363128");
    expect(materializedPrompt).toContain("只影响 Android 端");
    const launchContext = materializedPrompt.slice(materializedPrompt.indexOf("<launch_context>"));
    expect(launchContext.indexOf("只影响 Android 端")).toBeLessThan(launchContext.indexOf("播放失败 did=4453477614363128"));
    expect(materializedPrompt).toContain(
      "![image](workspace/uploads/images/android-playback.png)",
    );
    expect(
      kernel.database.db
        .select()
        .from(runnerContextSeedRecords)
        .where(eq(runnerContextSeedRecords.ownerId, task!.id))
        .all(),
    ).toEqual([
      expect.objectContaining({
        ownerType: "task",
        seedContextPackId: pack.id,
      }),
    ]);

    const taskDetail = await getJson<DashboardTask>(`/api/tasks/${task!.id}`);
    expect(taskDetail.contextPacks.map((item) => item.id)).toContain(pack.id);
    expect(taskDetail.runs[0]?.materializedPrompt).toContain("<launch_context>");
    expect(taskDetail.runs[0]?.contextPacks.map((item) => item.id)).toContain(
      pack.id,
    );
    expect(taskDetail.runContextSummaries[0]?.seedContextPackIds).toContain(
      pack.id,
    );

    const taskList = await getJson<DashboardTask[]>("/api/tasks");
    expect(taskList[0]?.contextPacks.map((item) => item.id)).toContain(pack.id);
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

  async deliver(
    message: NormalizedInboundMessage | InboundChannelMessage,
  ): Promise<void> {
    await super.deliver(normalizeInboundForFakeFeishuTest(message));
  }
}

class LunaMessageIngress extends BaseLunaMessageIngress {
  constructor(
    options: ConstructorParameters<typeof BaseLunaMessageIngress>[0],
  ) {
    super({
      ...options,
      sessionConfig: options.sessionConfig ?? fastSessionConfig,
    });
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

async function emitAndDrain(
  ingress: LunaMessageIngress,
  channel: FakeFeishuChannel,
  message: InboundChannelMessage,
): Promise<void> {
  await channel.emitInbound(message);
  await ingress.waitForIdle();
}

async function emitNormalizedAndDrain(
  ingress: LunaMessageIngress,
  channel: FakeFeishuChannel,
  message: NormalizedInboundMessage,
): Promise<void> {
  await channel.emitNormalizedInbound(message);
  await ingress.waitForIdle();
}

function groupInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly senderUserId?: string;
  readonly addressing?: InboundChannelMessage["addressing"];
}): InboundChannelMessage {
  const message: InboundChannelMessage = {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "group-alpha",
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    rootMessageId: input.rootMessageId ?? input.id,
    senderUserId: input.senderUserId ?? "user-1",
    text: input.text,
    chatType: "group",
    addressing: input.addressing ?? {
      addressedToBot: false,
      reason: "silent_group",
    },
  };
  const db = kernel.database.db;
  const inbound = normalizedInboundFromDirectCallForTest(message);
  return message;
}

function groupNormalized(input: {
  readonly id: string;
  readonly text: string;
  readonly contentBlocks: readonly MessageContentBlock[];
  readonly senderUserId?: string;
}): NormalizedInboundMessage {
  return {
    ...normalizedInboundFromDirectCallForTest(groupInbound({
      id: input.id,
      text: input.text,
      ...(input.senderUserId !== undefined
        ? { senderUserId: input.senderUserId }
        : {}),
    })),
    contentBlocks: input.contentBlocks,
  };
}

function userMessagesCall(
  runner: ScriptedMainRunner,
  channelMessageKey: string,
): Extract<MainRunnerRunInput["input"], { type: "user_messages" }> {
  const call = runner.calls.find(
    (item) =>
      item.input.type === "user_messages" &&
      item.input.latestMessage.id === channelMessageKey,
  );
  if (call === undefined || call.input.type !== "user_messages") {
    throw new Error(`No user_messages call for ${channelMessageKey}.`);
  }
  return call.input;
}

function packByKind(db: DrizzleDB, kind: string) {
  const pack = db
    .select()
    .from(contextPacks)
    .where(eq(contextPacks.kind, kind))
    .get();
  if (pack === undefined) {
    throw new Error(`No context pack found for kind ${kind}.`);
  }
  return pack;
}

function itemsForPack(db: DrizzleDB, packId: string) {
  return db
    .select()
    .from(contextPackItems)
    .where(eq(contextPackItems.contextPackId, packId))
    .all();
}

function contextSessionRow(input: {
  readonly id: string;
  readonly surfaceKey: string;
  readonly title: string;
  readonly now: number;
  readonly rootMessageKey?: string | null;
  readonly threadKey?: string | null;
  readonly parentSessionId?: string | null;
}): typeof sessions.$inferInsert {
  return {
    ...fixtureSessionOwnership(kernel.database.db, "feishu", "feishu-main", ownerId),
    id: input.id,
    surface_key: input.surfaceKey,
    channel_type: "feishu",
    channel_id: "feishu-main",
    group_id: "group-1",
    root_message_key: input.rootMessageKey ?? null,
    thread_key: input.threadKey ?? null,
    parent_session_id: input.parentSessionId ?? null,
    title: input.title,
    status: "active",
    created_by_user_id: fixtureOwnerUserId(ownerId),
    created_at: input.now,
    updated_at: input.now,
    last_activity_at: input.now,
  };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await kernel.honoServer.app.fetch(
    new Request(`http://luna.test${path}${path === "/api/tasks" || path === "/api/sessions" ? `?agentId=${agentId}` : ""}`, {
      headers: { authorization: `Bearer ${dashboardApiToken}` },
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function issueDashboardApiToken(db: DrizzleDB): string {
  // The Dashboard API is called with the owner account's personal token.
  ownerId = "dashboard-api-test-user";
  ({agent_id: agentId} = fixtureSessionOwnership(db, "feishu", "feishu-main", ownerId));
  return new AccessTokenService({
    db,
    signingSecret: TEST_ACCESS_TOKEN_SECRET,
  }).issueToken({
    accountId: ownerId,
    name: "Context pack dashboard API test token",
    source: "cli",
    role: "user",
    ttlMs: 60 * 60 * 1000,
    now: Date.now(),
  }).token;
}

async function freshKernel(): Promise<RuntimeKernel> {
  const kernelModule = await import("../../src/kernel/index");
  kernelModule.kernel.prepareForRuntimeStart();
  return kernelModule.kernel;
}

function writeRuntimeConfig(home: string): void {
  writeFileSync(join(home, "config.yaml"), "{}\n");
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

type RuntimeKernel = typeof import("../../src/kernel/index").kernel;

interface DashboardContextPack {
  readonly id: string;
  readonly kind: string;
  readonly items: readonly DashboardContextPackItem[];
}

interface DashboardContextPackItem {
  readonly role: string;
  readonly messagePreview: string | null;
}

interface DashboardSession {
  readonly id: string;
  readonly contextPacks: readonly DashboardContextPack[];
  readonly launchContextPacks: readonly DashboardContextPack[];
}

type DashboardSessionTimelineItem =
  | {
      readonly type: "message";
      readonly message: unknown;
    }
  | {
      readonly type: "turn";
      readonly turn: {
        readonly id: string;
        readonly materializedPrompt: string | null;
      };
      readonly messages: readonly unknown[];
    };

interface DashboardTask {
  readonly id: string;
  readonly contextPacks: readonly DashboardContextPack[];
  readonly runContextSummaries: readonly {
    readonly seedContextPackIds: readonly string[];
  }[];
  readonly runs: readonly {
    readonly materializedPrompt: string | null;
    readonly contextPacks: readonly DashboardContextPack[];
  }[];
}
