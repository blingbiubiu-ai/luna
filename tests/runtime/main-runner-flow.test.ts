import { AgentMemoryStore } from "../../src/agents/agent-memory-store";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureOwnerUserId, fixtureSessionOwnership} from "../helpers/platform-fixtures";
import { AgentLifecycleStore } from "../../src/agents/agent-lifecycle-store";
import type { MainRunnerCompletion } from "../../src/main-runner/types";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  ContextPackStore,
  type AppendTaskSourceItemInput,
} from "../../src/context";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import { TaskRunNotificationService } from "../../src/tasks/task-run-notification-service";
import { TaskRunStore } from "../../src/tasks/task-run-store";
import { TaskSubscriptionStore } from "../../src/tasks/task-subscription-store";
import type { TaskStatus } from "../../src/tasks/types";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { SessionTimelineReader } from "../../src/sessions/session-timeline-reader";
import { SessionTimelineStore } from "../../src/sessions/session-timeline-store";
import { SessionTurnStore } from "../../src/sessions/session-turn-store";
import type { InboundChannelMessage } from "../../src/sessions/types";
import type { ChannelAdapter, NormalizedInboundMessage } from "../../src/channels";
import { DataConnection } from "../../src/data";
import type { DrizzleDB } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import { TaskResultEventPublisher } from "../../src/main-runner/task-result-events";
import { MainRunnerContextBuilder } from "../../src/main-runner/context-builder";
import { SessionTimelineTools } from "../../src/main-runner/session-timeline-tools";
import { SessionStateStore } from "../../src/main-runner/session-state-store";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import type {
  MainRunnerInput,
  MainRunnerSessionContext,
} from "../../src/main-runner/types";
import {
  buildTaskRunPromptForRunner,
  executeTaskRun,
  resolveRequestedIdentityForTaskRun,
  type ExecuteTaskRunInput,
} from "../../src/kernel/task-run-handler";
import { artifactizeRunnerOutputLocalFileReferences } from "../../src/artifacts/runner-output-artifactizer";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress as BaseLunaMessageIngress } from "../../src/messaging/gateway/luna-message-ingress";
import { normalizedInboundFromDirectCallForTest } from "./support/direct-call-inbound-adapter";
import { SessionTurnProcessor } from "../../src/sessions/inbound/session-inbound-router";
import { TaskEngine } from "../../src/tasks/task-engine";
import { ArtifactStore } from "../../src/timeline/artifact-store";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { runnerContextFilePath } from "../../src/runners/runner-context-file";
import type { AgentRunner, UserMessage } from "../../src/shared";
import { setLunaHome } from "../../src/shared";

let testHome: string;
let database: DataConnection<typeof lunaSchema>;

const TEST_ACCESS_TOKEN_SECRET = "main-runner-flow-access-token-secret";

function appendTaskSourceContextItem(
  db: DrizzleDB,
  input: AppendTaskSourceItemInput,
): void {
  new ContextPackStore(db).appendTaskSourceItem(input);
}

function fakeTaskRunResult(input: { readonly taskId: string }): {
  readonly finalReportArtifactId: string;
} {
  const artifact = new ArtifactStore(database.db).create({
    taskId: input.taskId,
    type: "report",
    name: "final-report.md",
    mimeType: "text/markdown",
    content: "# Fake task report",
  });
  return { finalReportArtifactId: artifact.id };
}

function selectTaskSourceContextItems(db: DrizzleDB) {
  return new ContextPackStore(db).listTaskSourceItems();
}

/** A requester inside the Agent that owns the `feishu-main` test sessions. */
function materializeTestRequester(displayName: string) {
  return new IdentityDirectory(database.db).materializeIdentityClaims({
    agentId: fixtureSessionOwnership(database.db, "feishu", "feishu-main").agent_id,
    kind: "human",
    displayName,
    claims: [
      {
        namespace: "local",
        kind: "local_id",
        value: displayName,
        scope: "",
        confidence: "manual",
      },
    ],
  });
}

function seedMainSession(id: string, requesterId?: string): void {
  const db = database.db;
  const ownership = fixtureSessionOwnership(db, "feishu", "feishu-main");
  db.insert(lunaSchema.sessions).values({id, channel_type: "feishu", channel_id: "feishu-main", created_by_user_id: requesterId,
    created_at: Date.now(), updated_at: Date.now(), ...ownership}).run();
}

function contextPackTexts(
  context: MainRunnerSessionContext | undefined,
): readonly string[] {
  return [
    ...(context?.launchSeed?.items ?? []),
    ...(context?.deltaContext?.items ?? []),
  ].map((item) => item.text);
}

class LunaMessageIngress extends BaseLunaMessageIngress {
  async handleInboundMessageForTest(
    channel: ChannelAdapter,
    message: NormalizedInboundMessage | InboundChannelMessage,
  ): Promise<void> {
    return await super.handleInboundMessageForTest(
      channel,
      normalizeInboundForExecutorTest(message),
    );
  }
}

class FakeFeishuChannel extends BaseFakeFeishuChannel {
  constructor(
    id: string,
    inbound: readonly (NormalizedInboundMessage | InboundChannelMessage)[] = [],
    options?: ConstructorParameters<typeof BaseFakeFeishuChannel>[2],
  ) {
    super(id, inbound.map(normalizeInboundForExecutorTest), options);
  }

  async emitInbound(message: InboundChannelMessage): Promise<void> {
    await this.emitNormalizedInbound(normalizeInboundForExecutorTest(message));
  }

  async deliver(
    message: NormalizedInboundMessage | InboundChannelMessage,
  ): Promise<void> {
    await super.deliver(normalizeInboundForExecutorTest(message));
  }
}

function createTaskRunSupervisorForTest(
  channel: FakeFeishuChannel,
  options: Omit<
    ConstructorParameters<typeof TaskRunSupervisor>[0],
    "db" | "runnerType" | "runNotifications"
  > = {},
): TaskRunSupervisor {
  const runNotifications = new TaskRunNotificationService({
    db: database.db,
    channelForNotification: () => channel,
  });
  return new TaskRunSupervisor({
    db: database.db,
    runnerType: "mock",
    runNotifications,
    ...options,
  });
}

function normalizeInboundForExecutorTest(
  message: NormalizedInboundMessage | InboundChannelMessage,
): NormalizedInboundMessage {
  return "channel" in message
    ? message
    : normalizedInboundFromDirectCallForTest(message);
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-main-runner-flow-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main");
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

test("Task result event retains failure for Main recovery without publishing Task output", async () => {
  const { taskId, sessionId } =
    seedTaskResultSubscription({
      taskId: "task-result-fallback",
      title: "播放页失败",
      summary: "用户反馈播放页失败",
      rootMessageId: "root-task-result-fallback",
      statusMessageId: "status-card-task-result-fallback",
    });
  const channel = new FakeFeishuChannel("feishu-main");
  const failingRunner = {
    async run(): Promise<MainRunnerCompletion> {
      throw new Error("main runner unavailable");
    },
  };
  const run = new TaskRunStore(database.db).createRun({
    taskId,
    reason: "initial",
    inputSnapshot: { text: "播放页失败" },
    runnerType: "mock",
  });
  new TaskRunStore(database.db).markFailed(run.id, {
    error: "main runner unavailable",
  });

  await expect(new TaskResultEventPublisher({
    db: database.db,
    runnerType: "mock",
    mainRunner: failingRunner,
    channelForSubscription: () => channel,
  }).publish({
    taskId,
    taskRunId: run.id,
    runIndex: run.runIndex,
    status: "failed",
    title: "播放页失败",
    summary: "用户反馈播放页失败",
    conclusion: "短结论不应替代完整报告",
    evidenceSummary: ["runner.failed"],
    userVisibleReport:
      "Task runner failed: main runner unavailable\n\n完整报告正文。",
    artifactIds: [],
    nextActions: [],
  })).rejects.toThrow("main runner unavailable");

  expect(channel.outbound).toHaveLength(0);
  expect(taskFinalNotificationRows(taskId)).toHaveLength(0);
  expect(database.db.select().from(lunaSchema.notificationAttempts).all()).toMatchObject([
    { action: "publish_task_result", status: "failed", task_id: taskId },
  ]);
});

test("Task result event skips stale Task Run results after a newer run exists", async () => {
  const { taskId } = seedTaskResultSubscription({
    taskId: "task-result-stale-run",
    title: "播放页多轮完成",
    summary: "用户反馈播放页多轮完成",
  });
  const store = new TaskRunStore(database.db);
  const oldRun = store.createRun({
    taskId,
    reason: "initial",
    inputSnapshot: { text: "old" },
    runnerType: "mock",
  });
  store.markCompleted(oldRun.id, { finalReportArtifactId: "old-report" });
  const newerRun = store.createRun({
    taskId,
    reason: "restart",
    inputSnapshot: { text: "new" },
    runnerType: "mock",
  });
  store.markCompleted(newerRun.id, { finalReportArtifactId: "new-report" });
  const channel = new FakeFeishuChannel("feishu-main");

  await new TaskResultEventPublisher({
    db: database.db,
    runnerType: "mock",
    mainRunner: { async run() { throw new Error("Stale result must not invoke Main"); } },
    channelForSubscription: () => channel,
  }).publish({
    taskId,
    taskRunId: oldRun.id,
    runIndex: oldRun.runIndex,
    status: "completed",
    title: "播放页多轮完成",
    summary: "用户反馈播放页多轮完成",
    evidenceSummary: ["old evidence"],
    userVisibleReport: "旧报告不应发送",
    artifactIds: ["old-report"],
    nextActions: [],
  });

  expect(channel.outbound).toHaveLength(0);
  expect(database.db.select().from(lunaSchema.notificationAttempts).all())
    .toHaveLength(0);
});

test("Task result event skips results without a Task Run id", async () => {
  const { taskId } = seedTaskResultSubscription({
    taskId: "task-result-missing-run-id",
    title: "播放页缺少运行 ID",
    summary: "用户反馈播放页缺少运行 ID",
  });
  const channel = new FakeFeishuChannel("feishu-main");

  await new TaskResultEventPublisher({
    db: database.db,
    runnerType: "mock",
    mainRunner: {
      async run(): Promise<MainRunnerCompletion> {
        throw new Error("task result without taskRunId should not reach Main Runner");
      },
    },
    channelForSubscription: () => channel,
  }).publish({
    taskId,
    status: "failed",
    title: "播放页缺少运行 ID",
    summary: "用户反馈播放页缺少运行 ID",
    evidenceSummary: ["missing taskRunId"],
    userVisibleReport: "这个缺少 taskRunId 的 result 不应发送",
    artifactIds: [],
    nextActions: [],
  } as unknown as Parameters<TaskResultEventPublisher["publish"]>[0]);

  expect(channel.outbound).toHaveLength(0);
  expect(database.db.select().from(lunaSchema.notificationAttempts).all())
    .toHaveLength(0);
});

test("Task result event skips mismatched Task Run status payloads", async () => {
  const { taskId } = seedTaskResultSubscription({
    taskId: "task-result-status-mismatch",
    title: "播放页状态错配",
    summary: "用户反馈播放页状态错配",
  });
  const store = new TaskRunStore(database.db);
  const run = store.createRun({
    taskId,
    reason: "initial",
    inputSnapshot: { text: "run" },
    runnerType: "mock",
  });
  store.markCompleted(run.id, { finalReportArtifactId: "completed-report" });
  const channel = new FakeFeishuChannel("feishu-main");

  await new TaskResultEventPublisher({
    db: database.db,
    runnerType: "mock",
    mainRunner: {
      async run(): Promise<MainRunnerCompletion> {
        throw new Error("mismatched task run status should not reach Main Runner");
      },
    },
    channelForSubscription: () => channel,
  }).publish({
    taskId,
    taskRunId: run.id,
    runIndex: run.runIndex,
    status: "failed",
    title: "播放页状态错配",
    summary: "用户反馈播放页状态错配",
    evidenceSummary: ["stale failed payload"],
    userVisibleReport: "这个 failed payload 不应发送",
    artifactIds: [],
    nextActions: [],
  });

  expect(channel.outbound).toHaveLength(0);
  expect(database.db.select().from(lunaSchema.notificationAttempts).all())
    .toHaveLength(0);
});

test("Task result event skips mismatched Task Run index payloads", async () => {
  const { taskId } = seedTaskResultSubscription({
    taskId: "task-result-run-index-mismatch",
    title: "播放页轮次错配",
    summary: "用户反馈播放页轮次错配",
  });
  const store = new TaskRunStore(database.db);
  const run = store.createRun({
    taskId,
    reason: "initial",
    inputSnapshot: { text: "run" },
    runnerType: "mock",
  });
  store.markCompleted(run.id, { finalReportArtifactId: "completed-report" });
  const channel = new FakeFeishuChannel("feishu-main");

  await new TaskResultEventPublisher({
    db: database.db,
    runnerType: "mock",
    mainRunner: {
      async run(): Promise<MainRunnerCompletion> {
        throw new Error("mismatched task run index should not reach Main Runner");
      },
    },
    channelForSubscription: () => channel,
  }).publish({
    taskId,
    taskRunId: run.id,
    runIndex: run.runIndex + 1,
    status: "completed",
    title: "播放页轮次错配",
    summary: "用户反馈播放页轮次错配",
    evidenceSummary: ["wrong run index"],
    userVisibleReport: "这个 runIndex 错配 payload 不应发送",
    artifactIds: ["completed-report"],
    nextActions: [],
  });

  expect(channel.outbound).toHaveLength(0);
  expect(database.db.select().from(lunaSchema.notificationAttempts).all())
    .toHaveLength(0);
});

test("builds context with clarification without implicit recent messages", () => {
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: "session-1",
      surface_key: "feishu:chat-1",
      channel_type: "feishu",
      channel_id: "chat-1",
      group_id: null,
      thread_key: null,
      root_message_key: null,
      title: "播放页竖屏",
      created_at: 1000,
      updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","chat-1")})
    .run();
  const messageStore = new MessageStore(database.db);
  messageStore.append({
    sessionId: "session-1",
    channelMessageKey: "channel-message-1",
    senderUserId: "user-1",
    role: "user",
    content: [{ type: "text", text: "播放页竖屏" }],
    channel: { type: "feishu", id: "chat-1" },
    sender: { externalId: "user-1", kind: "user" },
    createdAt: 1001,
  });
  messageStore.append({
    sessionId: "session-1",
    channelMessageKey: "channel-message-2",
    role: "assistant",
    senderUserId: fixtureSessionOwnership(database.db,"feishu","chat-1").bot_user_id,
    content: [{ type: "text", text: "请补充 uid" }],
    channel: { type: "feishu", id: "chat-1" },
    createdAt: 1002,
  });

  const clarification = {
    pendingIntent: "task" as const,
    missingFields: ["uid"],
    collectedFacts: ["播放页竖屏"],
    lastReply: "请补充 uid",
    reason: "need user identifier",
  };
  new SessionStateStore(database.db).saveClarification(
    "session-1",
    clarification,
  );

  const context = new MainRunnerContextBuilder(database.db).buildForSession(
    "session-1",
  );

  expect(context).toMatchObject({
    sessionId: "session-1",
    clarification,
    candidateOpenTasks: [],
  });
  expect((context as { readonly recentMessages?: unknown }).recentMessages).toBeUndefined();
  expect(context.launchSeed).toBeUndefined();
  expect(context.deltaContext).toBeUndefined();
});

test("builds context from timeline message and reference entries", () => {
  database.db
    .insert(lunaSchema.sessions)
    .values([
      {
        id: "session-root-image-context",
        surface_key: "feishu:chat-image-root",
        channel_type: "feishu",
        channel_id: "chat-image-root",
        group_id: "group-image-context",
        thread_key: null,
        root_message_key: null,
        title: "root image context",
        created_at: 1000,
        updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","chat-image-root")},
      {
        id: "session-thread-image-context",
        surface_key: "feishu:chat-image-root:thread-image-context",
        channel_type: "feishu",
        channel_id: "chat-image-root",
        group_id: "group-image-context",
        thread_key: "thread-image-context",
        root_message_key: "channel-root-image",
        title: "thread image context",
        created_at: 1000,
        updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","chat-image-root")},
    ])
    .run();
  const messageStore = new MessageStore(database.db);
  const timelineStore = new SessionTimelineStore(database.db);
  const rootMessage = messageStore.append({
    sessionId: "session-root-image-context",
    channelMessageKey: "channel-root-image",
    senderUserId: "user-1",
    role: "user",
    content: [
      { type: "text", text: "收到这张图" },
      { type: "image", url: "artifact:root-image", alt: "root image" },
    ],
    channel: { type: "feishu", id: "chat-image-root" },
    sender: { externalId: "user-1", kind: "user" },
    createdAt: 1001,
  });
  timelineStore.appendReference({
    sessionId: "session-thread-image-context",
    messageId: rootMessage.id,
  });
  messageStore.append({
    sessionId: "session-thread-image-context",
    channelMessageKey: "channel-thread-question",
    senderUserId: "user-1",
    role: "user",
    content: [{ type: "text", text: "看看这张图，有色情信息吗" }],
    channel: { type: "feishu", id: "chat-image-root" },
    sender: { externalId: "user-1", kind: "user" },
    createdAt: 1002,
  });

  const context = new MainRunnerContextBuilder(database.db).buildForSession(
    "session-thread-image-context",
  );

  expect((context as { readonly recentMessages?: unknown }).recentMessages).toBeUndefined();
  expect(context.launchSeed).toBeUndefined();
  expect(context.deltaContext).toBeUndefined();
  const timelineTools = new SessionTimelineTools(database.db, {
    allowedSessionIds: ["session-thread-image-context"],
  });
  expect(() =>
    new SessionTimelineTools(database.db).readSessionTimeline({
      sessionId: "session-thread-image-context",
    }),
  ).toThrow("not authorized");
  expect(
    timelineTools.readSessionTimeline({
      sessionId: "session-thread-image-context",
      limit: 2,
    }).entries,
  ).toEqual([
    expect.objectContaining({
      entryKind: "reference",
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          url: "artifact:root-image",
        }),
      ]),
    }),
    expect.objectContaining({ entryKind: "message" }),
  ]);
});

test("builds Main Runner launch seed and delta context from context packs", () => {
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: "session-context-pack-root",
      surface_key: "feishu:context-pack-root",
      channel_type: "feishu",
      channel_id: "context-pack-builder",
      group_id: "group-context-pack-builder",
      thread_key: null,
      root_message_key: null,
      title: "context pack root",
      created_at: 900,
      updated_at: 900, ...fixtureSessionOwnership(database.db,"feishu","context-pack-builder")})
    .run();
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: "session-context-pack-builder",
      surface_key: "feishu:context-pack-builder",
      channel_type: "feishu",
      channel_id: "context-pack-builder",
      group_id: "group-context-pack-builder",
      thread_key: null,
      root_message_key: null,
      title: "context pack builder",
      created_at: 1000,
      updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","context-pack-builder")})
    .run();
  const messageStore = new MessageStore(database.db);
  const timelineReader = new SessionTimelineReader(database.db);
  const seedMessage = messageStore.append({
    sessionId: "session-context-pack-root",
    channelMessageKey: "channel-seed-context",
    senderUserId: "user-1",
    role: "user",
    content: [{ type: "text", text: "我在广州" }],
    channel: { type: "feishu", id: "context-pack-builder" },
    sender: { externalId: "user-1", kind: "user" },
    createdAt: 1001,
  });
  const deltaMessage = messageStore.append({
    sessionId: "session-context-pack-builder",
    channelMessageKey: "channel-delta-context",
    senderUserId: "user-2",
    role: "user",
    content: [{ type: "text", text: "天气失败，did=123" }],
    channel: { type: "feishu", id: "context-pack-builder" },
    sender: { externalId: "user-2", kind: "user" },
    createdAt: 1002,
  });
  messageStore.append({
    sessionId: "session-context-pack-builder",
    channelMessageKey: "channel-not-in-pack",
    senderUserId: "user-3",
    role: "user",
    content: [{ type: "text", text: "不应该隐式进入 runner context" }],
    channel: { type: "feishu", id: "context-pack-builder" },
    sender: { externalId: "user-3", kind: "user" },
    createdAt: 1003,
  });
  new SessionTimelineStore(database.db).appendReference({
    sessionId: "session-context-pack-builder",
    messageId: seedMessage.id,
  });
  const rootEntries = timelineReader.listForSession("session-context-pack-root");
  const entries = timelineReader.listForSession("session-context-pack-builder");
  const sourceSeedEntry = rootEntries.find((item) => item.message.id === seedMessage.id)?.entry;
  const seedEntry = entries.find((item) => item.message.id === seedMessage.id)?.entry;
  const deltaEntry = entries.find((item) => item.message.id === deltaMessage.id)?.entry;
  if (
    sourceSeedEntry === undefined ||
    seedEntry === undefined ||
    deltaEntry === undefined
  ) {
    throw new Error("Expected seed and delta timeline entries.");
  }
  const contextPackStore = new ContextPackStore(database.db);
  const launchPack = contextPackStore.createPack({
    ownerType: "session",
    ownerId: "session-context-pack-builder",
    kind: "thread_launch",
    selectionStrategy: "deterministic_window",
    triggerEntryId: seedEntry.id,
    triggerMessageId: seedMessage.id,
    metadataJson: { sourceDecisionId: "decision-context-pack-builder" },
  });
  contextPackStore.addItems(launchPack.id, [
    {
      itemKind: "timeline_entry",
      itemId: seedEntry.id,
      sourceSessionId: "session-context-pack-root",
      sourceEntryId: sourceSeedEntry.id,
      sourceMessageId: seedMessage.id,
      role: "seed",
      reason: "thread launch context",
    },
  ]);
  const deltaPack = contextPackStore.createPack({
    ownerType: "session",
    ownerId: "session-context-pack-builder",
    kind: "group_activation",
    selectionStrategy: "deterministic_window",
    triggerEntryId: deltaEntry.id,
    triggerMessageId: deltaMessage.id,
  });
  contextPackStore.addItems(deltaPack.id, [
    {
      itemKind: "timeline_entry",
      itemId: deltaEntry.id,
      sourceSessionId: "session-context-pack-builder",
      sourceEntryId: deltaEntry.id,
      sourceMessageId: deltaMessage.id,
      role: "delta_context",
      reason: "group activation context",
    },
  ]);

  const build = new MainRunnerContextBuilder(database.db)
    .buildForSessionWithEntries("session-context-pack-builder");
  const context = build.context as typeof build.context & {
    readonly recentMessages?: unknown;
    readonly launchSeed?: unknown;
    readonly deltaContext?: unknown;
  };

  expect(context.recentMessages).toBeUndefined();
  expect(context.launchSeed).toMatchObject({
    packId: launchPack.id,
    items: [
      {
        role: "seed",
        entryId: seedEntry.id,
        messageId: seedMessage.id,
        source: "reference",
        text: "我在广州",
      },
    ],
  });
  expect(context.deltaContext).toMatchObject({
    packId: deltaPack.id,
    items: [
      {
        role: "delta_context",
        entryId: deltaEntry.id,
        messageId: deltaMessage.id,
        source: "message",
        text: "天气失败，did=123",
      },
    ],
  });
  expect(build.contextEntryIds).toEqual([seedEntry.id, deltaEntry.id]);

  const relaunchPack = contextPackStore.createPack({
    ownerType: "session",
    ownerId: "session-context-pack-builder",
    kind: "session_launch",
    selectionStrategy: "deterministic_window",
    triggerEntryId: deltaEntry.id,
    triggerMessageId: deltaMessage.id,
    createdForInvocationId: "turn-context-pack-relaunch",
  });
  contextPackStore.addItems(relaunchPack.id, [
    {
      itemKind: "timeline_entry",
      itemId: deltaEntry.id,
      sourceSessionId: "session-context-pack-builder",
      sourceEntryId: deltaEntry.id,
      sourceMessageId: deltaMessage.id,
      role: "seed",
      reason: "session relaunch recent context",
    },
  ]);

  expect(
    new MainRunnerContextBuilder(database.db).buildForSession(
      "session-context-pack-builder",
    ).launchSeed,
  ).toMatchObject({
    packId: relaunchPack.id,
    kind: "session_launch",
    items: [{ text: "天气失败，did=123" }],
  });
});

test("builds context with stored local image markdown paths", () => {
  const relativeImagePath = "workspace/uploads/images/direct.jpeg";
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: "session-image-context",
      surface_key: "feishu:chat-image-context",
      channel_type: "feishu",
      channel_id: "chat-image-context",
      group_id: null,
      thread_key: null,
      root_message_key: null,
      title: "image context",
      created_at: 1000,
      updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","chat-image-context")})
    .run();
  new MessageStore(database.db).append({
    sessionId: "session-image-context",
    channelMessageKey: "channel-image-context",
    senderUserId: "user-1",
    role: "user",
    content: [
      {
        type: "text",
        text: `![image](${relativeImagePath})\n这个图片`,
      },
    ],
    channel: { type: "feishu", id: "chat-image-context" },
    sender: { externalId: "user-1", kind: "user" },
    createdAt: 1001,
  });

  const context = new MainRunnerContextBuilder(database.db).buildForSession(
    "session-image-context",
  );

  expect((context as { readonly recentMessages?: unknown }).recentMessages).toBeUndefined();
  expect(context.launchSeed).toBeUndefined();
  expect(context.deltaContext).toBeUndefined();
});

test("passes artifact image markdown through Task Runner prompt", async () => {
  const prompt = buildTaskRunPromptForRunner(
    {
      taskType: "question",
      title: "判断图片",
      summary: "判断图片内容",
      reason: "initial",
      pendingText: "![image](artifact:task-direct-image)\n这张图片有色情内容吗",
      facts: ["图片来自用户上传。"],
      assumptions: [],
    },
    join(testHome, "tasks", "task-image-runner", "workspace"),
  );

  expect(prompt).toContain("artifact:task-direct-image");
});

test("Task Runner restart and task update supplements require current-run requester identity", () => {
  const originalCreatorIdentity = {
    provider: "feishu" as const,
    externalUserId: "ou_original_creator",
    tenantKey: "tenant-1",
  };

  expect(() =>
    resolveRequestedIdentityForTaskRun({
      reason: "restart",
      inputSnapshot: {
        operation: "task.update",
        updateSummary: "second user correction",
      },
      taskContext: { requestedByIdentity: originalCreatorIdentity },
    }),
  ).toThrow("Task Run restart or task update requires current requester identity");

  expect(() =>
    resolveRequestedIdentityForTaskRun({
      reason: "initial",
      inputSnapshot: {
        operation: "task.update",
        updateSummary: "second user supplement",
      },
      taskContext: { requestedByIdentity: originalCreatorIdentity },
    }),
  ).toThrow("Task Run restart or task update requires current requester identity");

  expect(() =>
    resolveRequestedIdentityForTaskRun({
      reason: "restart",
      inputSnapshot: {
        operation: "task.update",
        requestedByIdentity: { provider: "feishu" },
      },
      taskContext: { requestedByIdentity: originalCreatorIdentity },
    }),
  ).toThrow("valid requestedByIdentity");

  expect(
    resolveRequestedIdentityForTaskRun({
      reason: "initial",
      inputSnapshot: { pendingText: "initial creator-owned run" },
      taskContext: { requestedByIdentity: originalCreatorIdentity },
    }),
  ).toEqual(originalCreatorIdentity);
});

test("artifactizes runner output local file references", () => {
  const runnerWorkspacePath = join(
    testHome,
    "sessions",
    "session-fact",
    "workspace",
  );
  const imagePath = join(runnerWorkspacePath, "fact-direct.jpeg");
  const legacyPath = join(runnerWorkspacePath, "attachments", "legacy.jpeg");
  const reportPath = join(runnerWorkspacePath, "yellow-content-check-report.md");
  mkdirSync(join(runnerWorkspacePath, "attachments"), { recursive: true });
  writeFileSync(imagePath, "fact-image-bytes");
  writeFileSync(legacyPath, "legacy-image-bytes");
  writeFileSync(reportPath, "# report\n");
  const registeredFiles: Array<{
    readonly name: string;
    readonly content: string;
  }> = [];

  const artifactizedText = artifactizeRunnerOutputLocalFileReferences({
    text: [
      `图片路径：${imagePath}`,
      "相对路径：workspace/fact-direct.jpeg",
      "容器路径：/workspace/fact-direct.jpeg",
      "旧别名：attachments/legacy.jpeg",
      "报告：[检测报告](workspace/yellow-content-check-report.md)",
    ].join("\n"),
    runnerWorkspacePath,
    register: (file) => {
      registeredFiles.push({
        name: file.name,
        content: new TextDecoder().decode(file.content),
      });
      return `artifact:${file.name}`;
    },
  });

  expect(artifactizedText).toBe(
    [
      "图片路径：artifact:fact-direct.jpeg",
      "相对路径：artifact:fact-direct.jpeg",
      "容器路径：artifact:fact-direct.jpeg",
      "旧别名：attachments/legacy.jpeg",
      "报告：[检测报告](artifact:yellow-content-check-report.md)",
    ].join("\n"),
  );
  expect(registeredFiles).toEqual([
    { name: "fact-direct.jpeg", content: "fact-image-bytes" },
    { name: "fact-direct.jpeg", content: "fact-image-bytes" },
    { name: "fact-direct.jpeg", content: "fact-image-bytes" },
    { name: "yellow-content-check-report.md", content: "# report\n" },
  ]);
});

test("does not artifactize a runner output file symlink that escapes the workspace", () => {
  const runnerWorkspacePath = join(
    testHome,
    "sessions",
    "session-symlink-file",
    "workspace",
  );
  const outsidePath = join(testHome, "outside-secret.txt");
  const symlinkPath = join(runnerWorkspacePath, "leak.txt");
  mkdirSync(runnerWorkspacePath, { recursive: true });
  writeFileSync(outsidePath, "outside secret");
  symlinkSync(outsidePath, symlinkPath);
  let registerCalls = 0;
  const text = "workspace/leak.txt";

  const artifactizedText = artifactizeRunnerOutputLocalFileReferences({
    text,
    runnerWorkspacePath,
    register: (file) => {
      registerCalls += 1;
      return `artifact:${file.name}`;
    },
  });

  expect(artifactizedText).toBe(text);
  expect(registerCalls).toBe(0);
});

test("does not artifactize a runner output path through a directory symlink that escapes the workspace", () => {
  const runnerWorkspacePath = join(
    testHome,
    "sessions",
    "session-symlink-directory",
    "workspace",
  );
  const outsideDirectoryPath = join(testHome, "outside-directory");
  mkdirSync(runnerWorkspacePath, { recursive: true });
  mkdirSync(outsideDirectoryPath, { recursive: true });
  writeFileSync(join(outsideDirectoryPath, "secret.txt"), "outside secret");
  symlinkSync(outsideDirectoryPath, join(runnerWorkspacePath, "linked"));
  let registerCalls = 0;
  const text = "workspace/linked/secret.txt";

  const artifactizedText = artifactizeRunnerOutputLocalFileReferences({
    text,
    runnerWorkspacePath,
    register: (file) => {
      registerCalls += 1;
      return `artifact:${file.name}`;
    },
  });

  expect(artifactizedText).toBe(text);
  expect(registerCalls).toBe(0);
});

test("does not artifactize a runner output path that is not a regular file", () => {
  const runnerWorkspacePath = join(
    testHome,
    "sessions",
    "session-output-directory",
    "workspace",
  );
  mkdirSync(join(runnerWorkspacePath, "report.txt"), { recursive: true });
  let registerCalls = 0;
  const text = "workspace/report.txt";

  const artifactizedText = artifactizeRunnerOutputLocalFileReferences({
    text,
    runnerWorkspacePath,
    register: (file) => {
      registerCalls += 1;
      return `artifact:${file.name}`;
    },
  });

  expect(artifactizedText).toBe(text);
  expect(registerCalls).toBe(0);
});

test("snapshots runner output before its path can be replaced at registration", () => {
  const runnerWorkspacePath = join(
    testHome,
    "sessions",
    "session-output-snapshot",
    "workspace",
  );
  const outputDirectoryPath = join(runnerWorkspacePath, "generated");
  const movedOutputDirectoryPath = join(runnerWorkspacePath, "generated-safe");
  const outsideDirectoryPath = join(testHome, "outside-snapshot-directory");
  mkdirSync(outputDirectoryPath, { recursive: true });
  mkdirSync(outsideDirectoryPath, { recursive: true });
  writeFileSync(join(outputDirectoryPath, "report.txt"), "safe bytes");
  writeFileSync(join(outsideDirectoryPath, "report.txt"), "outside bytes");
  let registeredContent = "";

  artifactizeRunnerOutputLocalFileReferences({
    text: "workspace/generated/report.txt",
    runnerWorkspacePath,
    register: (file) => {
      renameSync(outputDirectoryPath, movedOutputDirectoryPath);
      symlinkSync(outsideDirectoryPath, outputDirectoryPath);
      registeredContent = new TextDecoder().decode(file.content);
      return `artifact:${file.name}`;
    },
  });

  expect(registeredContent).toBe("safe bytes");
  expect(registeredContent).not.toBe("outside bytes");
});

test("builds Task Runner prompt with artifact refs in task facts", () => {
  const runnerWorkspacePath = join(testHome, "tasks", "task-fact", "workspace");

  const prompt = buildTaskRunPromptForRunner(
    {
      taskType: "question",
      title: "判断图片",
      summary: "用户提供图片 artifact:fact-prompt-image",
      reason: "initial",
      pendingText: "",
      facts: ["图片路径：artifact:fact-prompt-image"],
      assumptions: [],
    },
    runnerWorkspacePath,
  );

  expect(prompt).not.toContain(testHome);
  expect(prompt).toContain("图片路径：artifact:fact-prompt-image");
  expect(prompt).toContain("用户提供图片 artifact:fact-prompt-image");
});

test("does not build implicit recent context when timeline exceeds old recent limit", () => {
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: "session-marker-window",
      surface_key: "feishu:chat-marker-window",
      channel_type: "feishu",
      channel_id: "chat-marker-window",
      group_id: null,
      thread_key: null,
      root_message_key: null,
      title: "marker window",
      created_at: 1000,
      updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","chat-marker-window")})
    .run();
  const messageStore = new MessageStore(database.db);
  for (const index of Array.from({ length: 13 }, (_, itemIndex) => itemIndex)) {
    messageStore.append({
      sessionId: "session-marker-window",
      channelMessageKey: `visible-channel-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `visible ${index + 1}` }],
      channel: { type: "feishu", id: "chat-marker-window" },
      ...(index % 2 === 0
        ? {
            senderUserId: "user-1",
            sender: { externalId: "user-1", kind: "user" as const },
          }
        : { senderUserId: fixtureSessionOwnership(database.db,"feishu","chat-marker-window").bot_user_id }),
      createdAt: 1001 + index,
    });
  }

  const context = new MainRunnerContextBuilder(database.db).buildForSession(
    "session-marker-window",
  );

  expect((context as { readonly recentMessages?: unknown }).recentMessages).toBeUndefined();
  expect(context.launchSeed).toBeUndefined();
  expect(context.deltaContext).toBeUndefined();
});

test("builds context with deduped candidate tasks ordered by task activity", () => {
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: "session-1",
      surface_key: "feishu:chat-1",
      channel_type: "feishu",
      channel_id: "chat-1",
      group_id: null,
      thread_key: null,
      root_message_key: null,
      title: "播放页竖屏",
      created_at: 1000,
      updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","chat-1")})
    .run();
  database.db
    .insert(lunaSchema.tasks)
    .values([
      {
        id: "task-1",
        type: "task",
        status: "running",
        priority: "medium",
        severity: null,
        title: "Task 1",
        summary: "First task",
        creator_user_id: null,
        context_json: null,
        created_at: 1000,
        updated_at: 2000,
        last_activity_at: 2000, ...fixtureTaskOwnership(database.db,"session-1")},
      {
        id: "task-2",
        type: "task",
        status: "new",
        priority: "medium",
        severity: null,
        title: "Task 2",
        summary: "Second task",
        creator_user_id: null,
        context_json: null,
        created_at: 1000,
        updated_at: 1000,
        last_activity_at: 1000, ...fixtureTaskOwnership(database.db,"session-1")},
    ])
    .run();
  database.db
    .insert(lunaSchema.taskRuns)
    .values({
      id: "task-run-1",
      task_id: "task-1",
      run_index: 1,
      status: "completed",
      reason: "initial",
      input_snapshot: {},
      materialized_prompt: null,
      runner_type: "mock",
      runner_context_id: null,
      source_message_id: null,
      started_at: 1990,
      finished_at: 2000,
      cancel_reason: null,
      error: null,
      final_report_artifact_id: null,
    })
    .run();
  database.db
    .insert(lunaSchema.taskSubscriptions)
    .values([
      {
        id: "subscription-1",
        task_id: "task-1",
        session_id: "session-1",
        channel_type: "feishu",
        channel_id: "chat-1",
        group_id: null,
        thread_key: null,
        root_message_key: null,
        surface_key: "feishu:chat-1:one",
        visibility: "full",
        notification_level: "major_updates",
        created_at: 1001,
        updated_at: 1001,
      },
      {
        id: "subscription-2",
        task_id: "task-1",
        session_id: "session-1",
        channel_type: "feishu",
        channel_id: "chat-1",
        group_id: null,
        thread_key: null,
        root_message_key: null,
        surface_key: "feishu:chat-1:two",
        visibility: "full",
        notification_level: "major_updates",
        created_at: 1002,
        updated_at: 1002,
      },
      {
        id: "subscription-3",
        task_id: "task-2",
        session_id: "session-1",
        channel_type: "feishu",
        channel_id: "chat-1",
        group_id: null,
        thread_key: null,
        root_message_key: null,
        surface_key: "feishu:chat-1:three",
        visibility: "full",
        notification_level: "major_updates",
        created_at: 1003,
        updated_at: 1003,
      },
    ])
    .run();

  const context = new MainRunnerContextBuilder(database.db).buildForSession(
    "session-1",
  );

  expect(
    context.candidateOpenTasks.map((candidate) => candidate.taskId),
  ).toEqual(["task-1", "task-2"]);
  expect(
    context.candidateOpenTasks.map((candidate) => candidate.status),
  ).toEqual(["completed", "new"]);
});

test("Main Runner accepts sentinel completion and injects runtime context", async () => {
  class FakeAgentRunner implements AgentRunner {
    readonly type = "fake";
    receivedMessage: UserMessage | undefined;
    receivedOptions: Parameters<AgentRunner["stream"]>[1] | undefined;

    async *stream(
      userMessage: UserMessage,
      options: Parameters<AgentRunner["stream"]>[1],
    ): ReturnType<AgentRunner["stream"]> {
      this.receivedMessage = userMessage;
      this.receivedOptions = options;
      yield {
        id: "assistant-message-1",
        session_id: userMessage.session_id,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "LUNA_NOTHING_TO_SEND",
          },
        ],
      };
    }
  }

  const runner = new FakeAgentRunner();
  const requester = materializeTestRequester("main-runner-structured-action");
  seedMainSession("session-1", requester.id);
  const runnerContext = new RunnerContextStore(database.db).resolveForSession("session-1", "fake");
  new AgentMemoryStore(database.db).add(
    {agentId: runnerContext.agent_id, kind: "owner", trusted: true, userId: null, shadowId: null},
    {type: "project", title: "发布冻结", description: "2026-11-20 前冻结发布", body: "memory body is fetched on demand", core: true},
  );
  const pack = new ContextPackStore(database.db).createPack({ownerType: "session", ownerId: "session-1", kind: "session_launch", selectionStrategy: "manual"});
  const baseMessage = fakeNormalizedInbound({
      id: "incoming-message-1",
      text: "hello",
      surfaceExternalId: "chat-1",
    });
  const message = {
    ...baseMessage,
    sender: {
      ...baseMessage.sender,
      requesterIdentity: {
        provider: "local",
        externalUserId: requester.id,
        canonicalUserId: requester.id,
      },
    },
    senderUserId: "user-1",
  };
  const input = {
    type: "user_messages",
    requesterUserId: requester.id,
    messages: [
      {
        messageId: message.id,
        channelMessageKey: message.id,
        role: "user" as const,
        senderUserId: message.sender.externalId,
        sender: {
          id: message.sender.externalId,
          externalId: message.sender.externalId,
          kind: message.sender.kind,
          displayName: message.sender.displayName ?? message.sender.externalId,
        },
        text: message.text,
        createdAt: 1000,
        rawMessage: message,
      },
    ],
    latestMessage: message,
    context: {
      sessionId: "session-1",
      launchSeed: {
        packId: pack.id,
        kind: "session_launch",
        selectionStrategy: "manual",
        items: [
          {
            contextItemId: "context-item-test-seed",
            role: "seed",
            messageRole: "user",
            text: "播放页竖屏",
            entryId: "entry-test-seed",
            messageId: "message-test-seed",
            sourceEntryId: "entry-test-seed",
            sourceMessageId: "message-test-seed",
            sourceSessionId: "session-1",
            reason: "test launch context",
            displayOrder: 0,
          },
        ],
      },
      clarification: {
        pendingIntent: "task",
        missingFields: ["uid"],
        collectedFacts: ["播放页竖屏"],
      },
      candidateOpenTasks: [],
    },
  } satisfies MainRunnerInput;

  const result = await new MainRunner({
    runner,
    serviceAuthDb: database.db,
    accessTokenSigningSecret: TEST_ACCESS_TOKEN_SECRET,
    serviceAuthNow: 1000,
  }).run({
    input,
    runnerContext,
  });

  expect(result).toEqual({ status: "completed", followupReleased: false });
  expect(runner.receivedOptions).toMatchObject({
    cwd: runnerContext.runner_root_path,
    isNewSession: true,
    env: {
      LUNA_RUNNER_KIND: "main",
      LUNA_RUNNER_CONTEXT_ID: runnerContext.id,
      LUNA_SESSION_ID: "session-1",
    },
  });
  const contextFile = JSON.parse(
    readFileSync(runnerContextFilePath(runnerContext.runner_root_path), "utf-8"),
  );
  expect(contextFile).toMatchObject({
    schemaVersion: 1,
    runnerKind: "main",
    owner: { type: "session", id: "session-1" },
    stableContext: {
      session: {
        id: "session-1",
        kind: "ordinary",
        channel: { type: "feishu", id: "feishu-main" },
        surface: { kind: "group", externalId: "chat-1" },
      },
    },
  });
  const prompt = runner.receivedMessage?.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  expect(prompt).toContain("launchSeed");
  expect(prompt).toContain("clarification");
  expect(prompt).toContain("播放页竖屏");
  expect(prompt).toContain("uid");
  expect(prompt).toContain("<messages>\n");
  expect(prompt).toContain("<memory>\n## Agent memory: always in effect");
  expect(prompt).toContain("(project) 发布冻结: 2026-11-20 前冻结发布");
  expect(prompt).not.toContain("memory body is fetched on demand");
  expect(prompt).not.toContain("Allowed Action Contract");
  expect(prompt).toContain("<history>\n");
  expect(prompt).not.toContain("JSON Input");
  expect(prompt).not.toContain("# Luna Main Runner Prompt");
  expect(prompt).not.toContain(
    "The current user turn is provided as `user_messages`",
  );
  expect(prompt).not.toContain(
    "`boundTask` and `candidateOpenTasks` are candidates only",
  );
  expect(prompt).not.toContain(
    "Do not dispatch a Task for a message that contains no actionable new information",
  );
  expect(prompt).not.toContain("{{ACTION_CONTRACT_JSON}}");
  expect(prompt).not.toContain("{{INPUT_JSON}}");

  const claudeMdPath = join(runnerContext.runner_root_path, "CLAUDE.md");
  expect(existsSync(claudeMdPath)).toBe(true);
  expect(readFileSync(claudeMdPath, "utf-8")).toContain(
    "<role>\nYou are the session-level dispatcher",
  );
  expect(readFileSync(claudeMdPath, "utf-8")).not.toContain(
    "@.luna-prompts/main-runner/instructions.md",
  );
  expect(existsSync(join(runnerContext.runner_root_path, ".luna-prompts"))).toBe(false);
});

test("Main Runner service env does not use Feishu external id as local fallback without open_id", async () => {
  class FakeAgentRunner implements AgentRunner {
    readonly type = "fake";
    receivedOptions: Parameters<AgentRunner["stream"]>[1] | undefined;

    async *stream(
      userMessage: UserMessage,
      options: Parameters<AgentRunner["stream"]>[1],
    ): ReturnType<AgentRunner["stream"]> {
      this.receivedOptions = options;
      yield {
        id: "assistant-message-missing-open-id",
        session_id: userMessage.session_id,
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "reply_normal",
              reply: "missing open id",
              reason: "test",
            }),
          },
        ],
      };
    }
  }

  const runner = new FakeAgentRunner();
  seedMainSession("session-missing-open-id");
  const runnerContext = new RunnerContextStore(database.db).resolveForSession("session-missing-open-id", "fake");
  const latestMessage = {
    ...fakeNormalizedInbound({
      id: "incoming-missing-open-id",
      text: "hello",
      surfaceExternalId: "chat-missing-open-id",
      senderExternalId: "ou_missing_open_id",
    }),
    sender: {
      externalId: "ou_missing_open_id",
      kind: "user" as const,
      displayName: "Missing Open Id",
      requiresExplicitRequesterIdentity: true,
    },
  };

  await expect(new MainRunner({
    runner,
    serviceAuthDb: database.db,
    accessTokenSigningSecret: TEST_ACCESS_TOKEN_SECRET,
    serviceAuthNow: 1000,
  }).run({
    input: {
      type: "user_messages",
      requesterUserId: "ou_missing_open_id",
      messages: [
        {
          messageId: latestMessage.id,
          channelMessageKey: latestMessage.id,
          role: "user" as const,
          senderUserId: latestMessage.sender.externalId,
          sender: {
            id: latestMessage.sender.externalId,
            externalId: latestMessage.sender.externalId,
            kind: latestMessage.sender.kind,
            displayName: latestMessage.sender.displayName,
          },
          text: latestMessage.text,
          createdAt: 1000,
          rawMessage: latestMessage,
        },
      ],
      latestMessage,
      context: {
        sessionId: "session-missing-open-id",
        candidateOpenTasks: [],
      },
    },
    runnerContext,
  })).rejects.toThrow("Luna runner access token requires requestedByUserId.");
  expect(runner.receivedOptions).toBeUndefined();
});

test("Main Runner prompts are managed as Markdown assets", () => {
  expect(
    existsSync(
      join(import.meta.dir, "../../src/prompts/main/role.md"),
    ),
  ).toBe(true);
  // Turn input carries data only; its rules live in the instruction files.
  expect(
    existsSync(
      join(import.meta.dir, "../../src/prompts/main-runner/user-turn-template.md"),
    ),
  ).toBe(false);
});

test("Main Runner persists provider session id from system init and resumes next run", async () => {
  class SessionInitAgentRunner implements AgentRunner {
    readonly type = "fake";
    readonly receivedOptions: Parameters<AgentRunner["stream"]>[1][] = [];

    async *stream(
      userMessage: UserMessage,
      options: Parameters<AgentRunner["stream"]>[1],
    ): ReturnType<AgentRunner["stream"]> {
      this.receivedOptions.push(options);
      if (this.receivedOptions.length === 1) {
        yield {
          id: "provider-session-1",
          session_id: userMessage.session_id,
          role: "system",
          subtype: "init",
        };
      }
      yield {
        id: `assistant-message-${this.receivedOptions.length}`,
        session_id: userMessage.session_id,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "LUNA_NOTHING_TO_SEND",
          },
        ],
      };
    }
  }

  const runner = new SessionInitAgentRunner();
  const requester = materializeTestRequester("main-runner-provider-session");
  seedMainSession("session-main-runner-session", requester.id);
  const runnerContextStore = new RunnerContextStore(database.db);
  const runnerContext = runnerContextStore.resolveForSession(
    "session-main-runner-session",
    "fake",
  );
  const baseMessage = fakeNormalizedInbound({
      id: "incoming-message-session",
      text: "hello",
      surfaceExternalId: "chat-1",
    });
  const message = {
    ...baseMessage,
    sender: {
      ...baseMessage.sender,
      requesterIdentity: {
        provider: "local",
        externalUserId: requester.id,
        canonicalUserId: requester.id,
      },
    },
    senderUserId: "user-1",
  };
  const input = {
    type: "user_messages",
    requesterUserId: requester.id,
    messages: [
      {
        messageId: message.id,
        channelMessageKey: message.id,
        role: "user" as const,
        senderUserId: message.sender.externalId,
        sender: {
          id: message.sender.externalId,
          externalId: message.sender.externalId,
          kind: message.sender.kind,
          displayName: message.sender.displayName ?? message.sender.externalId,
        },
        text: message.text,
        createdAt: 1000,
        rawMessage: message,
      },
    ],
    latestMessage: message,
    context: {
      sessionId: "session-main-runner-session",
      candidateOpenTasks: [],
    },
  } satisfies MainRunnerInput;
  const mainRunner = new MainRunner({
    runner,
    runnerContextStore,
    serviceAuthDb: database.db,
    accessTokenSigningSecret: TEST_ACCESS_TOKEN_SECRET,
    serviceAuthNow: 1000,
  });

  await mainRunner.run({ input, runnerContext });
  const persistedContext = runnerContextStore.resolveForSession(
    "session-main-runner-session",
    "fake",
  );
  await mainRunner.run({ input, runnerContext: persistedContext });

  expect(persistedContext.runner_session_id).toBe("provider-session-1");
  expect(runner.receivedOptions[0]).toMatchObject({
      cwd: runnerContext.runner_root_path,
      isNewSession: true,
      env: {
        LUNA_RUNNER_KIND: "main",
        LUNA_RUNNER_CONTEXT_ID: runnerContext.id,
        LUNA_SESSION_ID: "session-main-runner-session",
      },
    });
  expect(runner.receivedOptions[1]).toMatchObject({
      cwd: runnerContext.runner_root_path,
      isNewSession: false,
      runnerSessionId: "provider-session-1",
      env: {
        LUNA_RUNNER_KIND: "main",
        LUNA_RUNNER_CONTEXT_ID: runnerContext.id,
        LUNA_SESSION_ID: "session-main-runner-session",
      },
    });
});

function fakeInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly rootMessageId?: string;
  readonly threadId?: string;
  readonly senderUserId?: string;
  readonly senderProfile?: InboundChannelMessage["senderProfile"];
  readonly groupId?: string;
  readonly chatType?: "group" | "p2p";
}): InboundChannelMessage {
  return {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: input.groupId ?? "group-alpha",
    rootMessageId: input.rootMessageId ?? input.id,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.chatType !== undefined ? { chatType: input.chatType } : {}),
    senderUserId: input.senderUserId ?? "user-1",
    senderProfile: input.senderProfile ?? {
      externalUserId: input.senderUserId ?? "user-1",
      openId: input.senderUserId ?? "user-1",
    },
    text: input.text,
  };
}

function fakeNormalizedInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly rawText?: string;
  readonly senderExternalId?: string;
  readonly senderDisplayName?: string;
  readonly surfaceExternalId?: string;
  readonly rootMessageId?: string;
  readonly mentions?: NormalizedInboundMessage["mentions"];
}): NormalizedInboundMessage {
  return {
    id: input.id,
    channel: { type: "feishu", id: "feishu-main" },
    surface: {
      externalId: input.surfaceExternalId ?? "group-alpha",
      kind: "group",
      displayName: "Alpha Group",
    },
    thread: {
      externalId: input.rootMessageId ?? input.id,
      rootMessageExternalId: input.rootMessageId ?? input.id,
    },
    sender: {
      externalId: input.senderExternalId ?? "user-1",
      kind: "user",
      ...(input.senderDisplayName !== undefined
        ? { displayName: input.senderDisplayName }
        : {}),
      providerIds: { open_id: input.senderExternalId ?? "user-1" },
    },
    text: input.text,
    mentions: input.mentions ?? [],
    addressing: { addressedToBot: true, reason: "mention" },
    rawPayload: {
      message: {
        message_id: input.id,
        chat_id: input.surfaceExternalId ?? "group-alpha",
        content: JSON.stringify({ text: input.rawText ?? input.text }),
      },
    },
  };
}

class RecordingCompletionChannel extends FakeFeishuChannel {
  readonly completedProcessingIds: string[] = [];

  override async completeProcessing(
    inbound: NormalizedInboundMessage,
  ): Promise<void> {
    this.completedProcessingIds.push(inbound.id);
  }
}

class ObservingReplyChannel extends FakeFeishuChannel {
  constructor(private readonly _beforeSend: () => void) {
    super("feishu-main");
  }

  override async send(
    inbound: Parameters<FakeFeishuChannel["send"]>[0],
    operation: Parameters<FakeFeishuChannel["send"]>[1],
  ) {
    this._beforeSend();
    return await super.send(inbound, operation);
  }
}

class FailingSendChannel extends FakeFeishuChannel {
  constructor() {
    super("feishu-main");
  }

  override async send(): Promise<never> {
    throw new Error("send failed");
  }
}

class FailingBatchSummaryChannel extends FakeFeishuChannel {
  constructor() {
    super("feishu-main");
  }

  override async send(
    inbound: Parameters<FakeFeishuChannel["send"]>[0],
    operation: Parameters<FakeFeishuChannel["send"]>[1],
  ) {
    if (operation.batchSummaryCard !== undefined) {
      throw new Error("batch summary send failed");
    }
    return await super.send(inbound, operation);
  }
}

class FailingSecondTaskNotificationChannel extends FakeFeishuChannel {
  private _taskNotificationCount = 0;

  constructor() {
    super("feishu-main");
  }

  override async send(
    inbound: Parameters<FakeFeishuChannel["send"]>[0],
    operation: Parameters<FakeFeishuChannel["send"]>[1],
  ) {
    if (operation.idempotencyKey?.startsWith('["task-run-notification"') === true) {
      this._taskNotificationCount += 1;
      if (this._taskNotificationCount === 2) {
        throw new Error("second task status card failed");
      }
    }
    return await super.send(inbound, operation);
  }
}

function rawPayloadMatches(
  rawPayload: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (rawPayload === null || typeof rawPayload !== "object") {
    return false;
  }
  return Object.entries(expected).every(([key, value]) => {
    return (rawPayload as Record<string, unknown>)[key] === value;
  });
}

function visibleAssistantTexts(): string[] {
  return database.db
    .select()
    .from(lunaSchema.messages)
    .all()
    .filter((row) => row.role === "assistant")
    .flatMap((row) => messageTextContent(row.contentJson));
}

function taskFinalNotificationRows(taskId: string) {
  return database.db
    .select()
    .from(lunaSchema.messages)
    .all()
    .filter((row) =>
      rawPayloadMatches(row.rawPayloadJson, {
        origin: "task_final_notification",
        sourceTaskId: taskId,
      }),
    );
}

function messageTextContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      return [part.text];
    }
    return [];
  });
}

function taskNotificationOutbounds(channel: FakeFeishuChannel) {
  return channel.outbound.filter(
    (row) => row.idempotencyKey?.startsWith("[\"task-run-notification\"") === true,
  );
}

function seedInboundMessage(inbound: InboundChannelMessage): {
  readonly sessionId: string;
  readonly messageRowId: string;
  readonly inbound: NormalizedInboundMessage;
} {
  const normalizedInbound = normalizedInboundFromDirectCallForTest(inbound);
  const session = new SessionResolver(new SessionStore(database.db))
    .resolveFromNormalizedInbound(normalizedInbound);
  const sessionId = session.id;
  const result = new MessageStore(database.db).appendOnce({
    sessionId,
    channelMessageKey: inbound.id,
    senderUserId: inbound.senderUserId,
    role: "user",
    content: [{ type: "text", text: inbound.text }],
    inbound: normalizedInbound,
    channel: normalizedInbound.channel,
    surface: normalizedInbound.surface,
    sender: normalizedInbound.sender,
    createdAt: Date.now(),
  });
  return { sessionId, messageRowId: result.row.id, inbound: normalizedInbound };
}

function seedTaskLinkedToMessage(input: {
  readonly taskId: string;
  readonly sessionId: string;
  readonly messageRowId: string;
  readonly title: string;
  readonly summary: string;
}): void {
  const now = Date.now();
  database.db
    .insert(lunaSchema.tasks)
    .values({
      id: input.taskId,
      type: "task",
      status: "new",
      priority: "medium",
      severity: null,
      title: input.title,
      summary: input.summary,
      creator_user_id: null,
      context_json: {
        latestUserMessage: input.summary,
        knownFacts: [],
        pendingQuestions: [],
      },
      created_at: now,
      updated_at: now,
      last_activity_at: now, ...fixtureTaskOwnership(database.db,input.sessionId)})
    .run();
  appendTaskSourceContextItem(database.db, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    messageId: input.messageRowId,
    userId: "user-1",
    createdAt: now,
  });
}

function seedTaskLinkedToInboundMessage(input: {
  readonly sessionId: string;
  readonly messageRowId: string;
  readonly inbound: InboundChannelMessage;
  readonly status: TaskStatus;
  readonly title: string;
  readonly summary: string;
}): void {
  seedTaskLinkedToMessage({
    taskId: `task-${input.messageRowId}`,
    sessionId: input.sessionId,
    messageRowId: input.messageRowId,
    title: input.title,
    summary: input.summary,
  });
  database.db
    .update(lunaSchema.tasks)
    .set({
      status: input.status,
      creator_user_id: input.inbound.senderUserId ?? null,
    })
    .where(eq(lunaSchema.tasks.id, `task-${input.messageRowId}`))
    .run();
}

function seedTaskResultSubscription(input: {
  readonly taskId: string;
  readonly title: string;
  readonly summary: string;
  readonly rootMessageId?: string;
  readonly threadId?: string;
  readonly statusMessageId?: string;
}): {
  readonly taskId: string;
  readonly sessionId: string;
  readonly rootMessageId: string;
  readonly threadId: string | null;
  readonly statusMessageId: string;
} {
  const now = Date.now();
  const sessionId = `session-${input.taskId}`;
  const rootMessageId = input.rootMessageId ?? `status-${input.taskId}`;
  const threadId = input.threadId ?? null;
  const statusMessageId = input.statusMessageId ?? `status-${input.taskId}`;
  database.db
    .insert(lunaSchema.sessions)
    .values({
      id: sessionId,
      surface_key: `feishu:feishu-main:group-alpha:${input.taskId}`,
      channel_type: "feishu",
      channel_id: "feishu-main",
      group_id: "group-alpha",
      thread_key: threadId,
      root_message_key: rootMessageId,
      title: input.title,
      created_at: now,
      updated_at: now, ...fixtureSessionOwnership(database.db,"feishu","feishu-main")})
    .run();
  database.db
    .insert(lunaSchema.tasks)
    .values({
      id: input.taskId,
      type: "task",
      status: "completed",
      priority: "medium",
      severity: null,
      title: input.title,
      summary: input.summary,
      creator_user_id: fixtureOwnerUserId("fixture-owner"),
      context_json: null,
      created_at: now,
      updated_at: now,
      last_activity_at: now, ...fixtureTaskOwnership(database.db,sessionId)})
    .run();
  database.db
    .insert(lunaSchema.taskSubscriptions)
    .values({
      id: `subscription-${input.taskId}`,
      task_id: input.taskId,
      session_id: sessionId,
      channel_type: "feishu",
      channel_id: "feishu-main",
      group_id: "group-alpha",
      thread_key: threadId,
      root_message_key: rootMessageId,
      surface_key: `feishu:feishu-main:group-alpha:${input.taskId}`,
      visibility: "full",
      notification_level: "major_updates",
      created_at: now,
      updated_at: now,
    })
    .run();
  return {
    taskId: input.taskId,
    sessionId,
    rootMessageId,
    threadId,
    statusMessageId,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitUntilAborted(input: ExecuteTaskRunInput): Promise<void> {
  if (input.signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    input.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}


test("Task result command delivery completes pending notification without invoking Main twice", async () => {
  const { taskId, sessionId } = seedTaskResultSubscription({
    taskId: "task-command-recovery", title: "Command result", summary: "Internal report",
    rootMessageId: "root-command", statusMessageId: "status-command",
  });
  const user = materializeTestRequester("command-result-user");
  const channel = new FakeFeishuChannel("feishu-main");
  const { sessionCommandsFor } = await import("../../src/messaging/session-command-service");
  const { taskResultMessageOrigin } = await import("../../src/runners/main-invocation-registry");
  const commands = sessionCommandsFor(database.db, () => channel);
  const store = new TaskRunStore(database.db);
  const run = store.createRun({taskId, reason: "initial", inputSnapshot: {text: "test"}, runnerType: "mock"});
  store.markCompleted(run.id, {finalReportArtifactId: "report-command"});
  const result = {taskId, taskRunId: run.id, runIndex: run.runIndex, status: "completed" as const,
    title: "Command result", summary: "Internal report", userVisibleReport: "Task internal output",
    evidenceSummary: [], artifactIds: [], nextActions: []};
  let calls = 0;
  const publisher = new TaskResultEventPublisher({ db: database.db, runnerType: "mock", channelForSubscription: () => channel,
    mainRunner: { async run() {
      calls++;
      commands.accept({userId: user.id, sourceSessionId: sessionId, originId: taskResultMessageOrigin(run.id,sessionId)},
        sessionId, "message.send", "result-1", {content: "Main explanation", purpose: "answer"});
      return {status: "completed", followupReleased: false};
    } },
  });
  await publisher.publish(result);
  expect(channel.outbound).toHaveLength(0);
  await commands.waitForIdle();
  await publisher.recoverPending();
  await publisher.publish(result);
  expect(calls).toBe(1);
  expect(channel.outbound.map(row => row.content)).toEqual(["Main explanation"]);
  expect(database.db.select().from(lunaSchema.notificationAttempts).all()).toMatchObject([{status: "sent"}]);
});

test("Task result recovery reserves independent session lanes without waiting for the first Runner", async () => {
  const { enqueueTaskResult } = await import("../../src/tasks/task-result-outbox");
  const channel = new FakeFeishuChannel("feishu-main");
  const gate = deferred<void>();
  const entered: string[] = [];
  for (const suffix of ["a", "b"]) {
    const { taskId } = seedTaskResultSubscription({ taskId: `parallel-recovery-${suffix}`, title: suffix, summary: suffix, rootMessageId: `root-${suffix}`, statusMessageId: `status-${suffix}` });
    const runs = new TaskRunStore(database.db);
    const run = runs.createRun({ taskId, reason: "initial", inputSnapshot: {}, runnerType: "mock" });
    runs.markFailed(run.id, { error: "test failure" });
    const subscription = new TaskSubscriptionStore(database.db).listForTask(taskId)[0]!;
    enqueueTaskResult(database.db, { taskId, taskRunId: run.id, status: "failed", title: suffix, summary: suffix, evidenceSummary: [], userVisibleReport: suffix, artifactIds: [], nextActions: [] }, subscription);
  }
  const publisher = new TaskResultEventPublisher({ db: database.db, runnerType: "mock", channelForSubscription: () => channel,
    mainRunner: { async run(input) { entered.push(input.input.context.sessionId); await gate.promise; throw new Error("deliberate recovery test failure"); } },
  });
  const recovery = publisher.recoverPending();
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(entered).toHaveLength(2);
    expect(new Set(entered).size).toBe(2);
  } finally { gate.resolve(); await recovery; }
});

test("cancelled task-result trigger cannot be replayed by legacy notification recovery", async () => {
  const { taskId } = seedTaskResultSubscription({ taskId: "cancelled-result-recovery", title: "cancelled", summary: "cancelled", rootMessageId: "cancelled-result-root", statusMessageId: "cancelled-result-status" });
  const runs = new TaskRunStore(database.db);
  const run = runs.createRun({ taskId, reason: "initial", inputSnapshot: {}, runnerType: "mock" });
  runs.markFailed(run.id, { error: "failed" });
  let calls = 0;
  const publisher = new TaskResultEventPublisher({ db: database.db, runnerType: "mock", channelForSubscription: () => new FakeFeishuChannel("feishu-main"),
    mainRunner: { async run() { calls++; throw new Error("interrupted"); } },
  });
  await expect(publisher.publish({ taskId, taskRunId: run.id, status: "failed", title: "failed", summary: "failed", evidenceSummary: [], userVisibleReport: "failed", artifactIds: [], nextActions: [] })).rejects.toThrow("interrupted");
  database.db.update(lunaSchema.sessionTriggers).set({ status: "cancelled" }).run();
  expect(database.db.select().from(lunaSchema.notificationAttempts).all()).toHaveLength(1);
  await publisher.recoverPending();
  expect(calls).toBe(1);
});

test("results that settle during Shadow disable cannot be replayed after restoration", async () => {
  const { taskId, sessionId } = seedTaskResultSubscription({taskId: "disabled-result", title: "Late result", summary: "Late result"});
  const db = database.db;
  const session = new SessionStore(db).getById(sessionId)!;
  const lifecycle = new AgentLifecycleStore(db);
  const target = {agentId: session.agent_id, shadowId: session.shadow_id};
  const runs = new TaskRunStore(db);
  const run = runs.createRun({taskId, reason: "initial", inputSnapshot: {}, runnerType: "mock"});
  const disabled = lifecycle.request("fixture-owner", target, "disabled", "disable-result");
  runs.markFailed(run.id, {error: "cancelled by scope"});
  const channel = new FakeFeishuChannel("feishu-main");
  let calls = 0;
  const publisher = new TaskResultEventPublisher({db, runnerType: "mock", channelForSubscription: () => channel,
    mainRunner: {async run() {calls++; throw Error("Result must not invoke Main");}},
  });
  const result = {taskId, taskRunId: run.id, status: "failed" as const, title: "Late result", summary: "Late result",
    userVisibleReport: "Late result", evidenceSummary: [], artifactIds: [], nextActions: []};
  await publisher.publish(result);
  expect(db.select().from(lunaSchema.sessionTriggers).get()).toMatchObject({status: "cancelled", error: "shadow_disabled"});
  db.update(lunaSchema.agentLifecycleJobs).set({status: "completed", completedAt: Date.now()}).where(eq(lunaSchema.agentLifecycleJobs.id, disabled.id)).run();
  lifecycle.request("fixture-owner", target, "active", "resume-result");
  expect(await publisher.recoverPending()).toBe(0);
  await publisher.publish(result);
  expect(db.select().from(lunaSchema.sessionTriggers).get()?.status).toBe("cancelled");
  expect(db.select().from(lunaSchema.notificationAttempts).all()).toHaveLength(0);
  expect(calls).toBe(0);
  expect(channel.outbound).toEqual([]);
});

test("a Main failure after Shadow disable cannot make its task result retryable", async () => {
  const {taskId, sessionId} = seedTaskResultSubscription({taskId: "running-result", title: "Result", summary: "Result"});
  const db = database.db;
  const session = new SessionStore(db).getById(sessionId)!;
  const runs = new TaskRunStore(db);
  const run = runs.createRun({taskId, reason: "initial", inputSnapshot: {}, runnerType: "mock"});
  runs.markFailed(run.id, {error: "Task failed"});
  const entered = deferred<void>();
  const cancelled = deferred<void>();
  const publisher = new TaskResultEventPublisher({db, runnerType: "mock", channelForSubscription: () => new FakeFeishuChannel("feishu-main"),
    mainRunner: {async run() {entered.resolve(); await cancelled.promise; throw Error("Main was cancelled");}},
  });
  const publication = publisher.publish({taskId, taskRunId: run.id, status: "failed", title: "Result", summary: "Result",
    userVisibleReport: "Result", evidenceSummary: [], artifactIds: [], nextActions: []});
  await entered.promise;
  try {
    new AgentLifecycleStore(db).request("fixture-owner", {agentId: session.agent_id, shadowId: session.shadow_id}, "disabled", "disable-running-result");
  } finally {
    cancelled.resolve();
  }
  await expect(publication).rejects.toThrow("Main was cancelled");
  expect(db.select().from(lunaSchema.sessionTriggers).get()).toMatchObject({status: "cancelled", error: "scope_disabled"});
  expect(await publisher.recoverPending()).toBe(0);
});

for (const scenario of [
  { name: "already-sent reply with repeated terminal prose completes", surface: "p2p", status: "sent", output: "已开始检查。\n\nLUNA_NOTHING_TO_SEND", expected: true },
  { name: "terminal prose cannot replace a missing reply", surface: "p2p", status: undefined, output: "已开始检查。\nLUNA_NOTHING_TO_SEND", expected: false, error: "Missing or mixed final reply" },
  { name: "existing answer suppresses redundant terminal text", surface: "p2p", status: "sent", output: "answer LUNA_NOTHING_TO_SEND", expected: true },
  { name: "private sentinel without reply fails", surface: "p2p", status: undefined, expected: false },
  { name: "group follow-up may remain silent", surface: "group", status: undefined, expected: true },
  ...["sent", "pending", "running", "unknown"].map(status => ({ name: `private ${status} reply is not replayed`, surface: "p2p", status, expected: true })),
  { name: "failed reply does not count as completion", surface: "p2p", status: "failed", expected: false },
  { name: "another session send is not a private reply", surface: "p2p", status: "sent", otherTarget: true, expected: false },
  { name: "another turn reply does not cover current input", surface: "p2p", status: "sent", otherOrigin: true, expected: false },
]) {
  test(scenario.name, async () => {
    const requester = materializeTestRequester("reply-check");
    seedMainSession("reply-session", requester.id);
    const contextStore = new RunnerContextStore(database.db);
    const runnerContext = contextStore.resolveForSession("reply-session", "fake");
    const base = fakeNormalizedInbound({ id: "short-input", text: "1\n2", surfaceExternalId: "private-chat" });
    const message: NormalizedInboundMessage = { ...base,
      surface: { ...base.surface, kind: scenario.surface as "p2p" | "group" },
      addressing: { addressedToBot: true, reason: scenario.surface === "p2p" ? "p2p" : "activation_followup" },
      sender: { ...base.sender, requesterIdentity: { provider: "local", externalUserId: requester.id, canonicalUserId: requester.id } },
    };
    let calls = 0;
    const runner: AgentRunner = { type: "fake", async *stream(userMessage) {
      calls++;
      if (scenario.status) database.db.insert(lunaSchema.sessionCommands).values({
        id: "reply-command", kind: "message.send", sourceSessionId: "reply-session", sessionId: "otherTarget" in scenario ? "other-session" : "reply-session",
        actorUserId: requester.id, originId: "otherOrigin" in scenario ? "older-turn" : "current-turn",
        dedupeKey: "reply-key", payload: { content: "收到，请问需要什么帮助？", purpose: "answer" },
        status: scenario.status, correlationId: "reply-command", availableAt: 1000, createdAt: 1000, updatedAt: 1000,
      }).run();
      yield { id: "final", session_id: userMessage.session_id, role: "assistant", content: [{type: "text", text: "output" in scenario ? scenario.output! : "LUNA_NOTHING_TO_SEND"}] };
    } };
    const result = new MainRunner({ runner, serviceAuthDb: database.db, accessTokenSigningSecret: TEST_ACCESS_TOKEN_SECRET }).run({
      turnId: "current-turn", runnerContext,
      input: { type: "user_messages", requesterUserId: requester.id, latestMessage: message, messages: [],
        context: { sessionId: "reply-session", candidateOpenTasks: [] } },
    });
    if (scenario.expected) expect(await result).toEqual({ status: "completed", followupReleased: false });
    else await expect(result).rejects.toThrow("error" in scenario ? scenario.error! : "without an answer");
    expect(calls).toBe(1);
  });
}

function silentTaskResultCase(taskId: string, inputSnapshot: Record<string, unknown>) {
  const { sessionId } = seedTaskResultSubscription({ taskId, title: "Check", summary: "Internal report" });
  const store = new TaskRunStore(database.db);
  const run = store.createRun({ taskId, reason: "initial", inputSnapshot, runnerType: "mock" });
  store.markCompleted(run.id, { finalReportArtifactId: `report-${taskId}` });
  const result = { taskId, taskRunId: run.id, runIndex: run.runIndex, status: "completed" as const,
    title: "Check", summary: "Internal report", userVisibleReport: "Nothing changed", evidenceSummary: [], artifactIds: [], nextActions: [] };
  const channel = new FakeFeishuChannel("feishu-main");
  let calls = 0;
  let duringMain: () => void = () => {};
  const publisher = new TaskResultEventPublisher({ db: database.db, runnerType: "mock", channelForSubscription: () => channel,
    mainRunner: { async run() { calls++; duringMain(); return { status: "completed", followupReleased: false }; } } });
  const attempts = () => database.db.select().from(lunaSchema.notificationAttempts).all()
    .filter(row => row.task_id === taskId && row.action === "publish_task_result");
  return { sessionId, run, result, channel, publisher, attempts, calls: () => calls, onMain: (fn: () => void) => { duringMain = fn; } };
}

test("a quiet run's result may end without a reply and is not delivered again", async () => {
  const c = silentTaskResultCase("task-quiet-check", { quiet: true });
  await c.publisher.publish(c.result);
  expect(c.channel.outbound).toHaveLength(0);
  expect(c.attempts()).toMatchObject([{ status: "skipped" }]);
  await c.publisher.recoverPending();
  await c.publisher.publish(c.result);
  expect(c.calls()).toBe(1);
});

test("a result may end without a reply when Main already sent the Task on in that turn", async () => {
  const c = silentTaskResultCase("task-answered-by-main", {});
  const { taskResultMessageOrigin } = await import("../../src/runners/main-invocation-registry");
  c.onMain(() => {
    const now = Date.now();
    database.db.insert(lunaSchema.runnerOperations).values({ id: "op-answer", sessionId: c.sessionId,
      originId: taskResultMessageOrigin(c.run.id, c.sessionId), requestId: "answer-1",
      request: { kind: "task.update", payload: { taskId: "task-answered-by-main", updateSummary: "Target 1.2" } } as never,
      context: {} as never, status: "applied", result: null, createdAt: now, updatedAt: now }).run();
  });
  await c.publisher.publish(c.result);
  expect(c.channel.outbound).toHaveLength(0);
  expect(c.attempts()).toMatchObject([{ status: "skipped" }]);
});

test("an ordinary result still needs a reply, and another Task's command does not excuse it", async () => {
  const c = silentTaskResultCase("task-needs-reply", {});
  const { taskResultMessageOrigin } = await import("../../src/runners/main-invocation-registry");
  c.onMain(() => {
    const now = Date.now();
    database.db.insert(lunaSchema.runnerOperations).values({ id: "op-other", sessionId: c.sessionId,
      originId: taskResultMessageOrigin(c.run.id, c.sessionId), requestId: "other-1",
      request: { kind: "task.update", payload: { taskId: "some-other-task", updateSummary: "Unrelated" } } as never,
      context: {} as never, status: "applied", result: null, createdAt: now, updatedAt: now }).run();
  });
  await expect(c.publisher.publish(c.result)).rejects.toThrow("without submitting the task result");
  expect(c.attempts()).toMatchObject([{ status: "failed" }]);
});
