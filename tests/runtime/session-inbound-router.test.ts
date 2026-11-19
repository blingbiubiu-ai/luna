import {fixtureTaskOwnership, fixtureUser} from "../helpers/platform-fixtures";
import {fixtureSessionOwnership} from "../helpers/platform-fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TaskRunStore } from "../../src/tasks/task-run-store";
import { TaskRunNotificationService } from "../../src/tasks/task-run-notification-service";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import { TaskSubscriptionStore } from "../../src/tasks/task-subscription-store";
import { ContextPackStore } from "../../src/context";
import { SessionQueue } from "../../src/sessions/session-queue";
import {
  MAIN_RUNNER_RAW_OUTPUT_LIMIT_BYTES,
  SessionRunnerAttemptStore,
} from "../../src/sessions/session-runner-attempt-store";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionTimelineReader } from "../../src/sessions/session-timeline-reader";
import type { InboundChannelMessage } from "../../src/sessions/types";
import type { NormalizedInboundMessage } from "../../src/channels";
import { DataConnection } from "../../src/data";
import {
  tasks,
  channelIdentities,
  channelSurfaces,
  sessionInbox,
  sessionTimelineEntries,
  messageMentions,
  sessionTurnEntries,
  sessionTurns,
  sessions,
  messages,
  runnerContexts,
} from "../../src/data/schema";
import * as lunaSchema from "../../src/data/schema";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { TestMainPlan } from "./support/main-command-plan";
import type {
  AgentRunOptions,
  AgentRunner,
  AssistantMessage,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from "../../src/shared";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { FakeFeishuChannel as BaseFakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress as BaseLunaMessageIngress } from "./support/main-command-harness";
import { ArtifactStore } from "../../src/timeline/artifact-store";
import type { SessionConfig } from "../../src/shared";
import { setLunaHome } from "../../src/shared";
import { normalizedInboundFromDirectCallForTest } from "./support/direct-call-inbound-adapter";
import { SessionInboundRouter as BaseSessionInboundRouter } from "./support/main-command-harness";

let testHome: string;
let database: DataConnection<typeof lunaSchema>;

function runnerForAdmittedRequester(runner: MainRunner): MainRunner {
  return { async run(input: MainRunnerRunInput) {
    if (input.input.type === "user_messages") {
      const requester = input.input.requesterUserId ?? input.input.messages.at(-1)?.senderUserId;
      const session = new SessionStore(database.db).getById(input.input.context.sessionId);
      if (requester && session && requester !== "fixture-owner") {
      }
    }
    return runner.run(input);
  }} as MainRunner;
}

class SessionInboundRouter extends BaseSessionInboundRouter {
  constructor(options: ConstructorParameters<typeof BaseSessionInboundRouter>[0]) {
    super(options.mainRunner ? {...options, mainRunner: runnerForAdmittedRequester(options.mainRunner)} : options);
  }

  async routeDirectInboundForTest(message: InboundChannelMessage): Promise<void> {
    return await this.route(normalizedInboundFromDirectCallForTest(message));
  }
}

class LunaMessageIngress extends BaseLunaMessageIngress {
  constructor(options: ConstructorParameters<typeof BaseLunaMessageIngress>[0]) {
    super(options.mainRunner ? {...options, mainRunner: runnerForAdmittedRequester(options.mainRunner)} : options);
  }
}

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

function createTaskRunSupervisorForTest(
  channel: FakeFeishuChannel,
): TaskRunSupervisor {
  const runNotifications = new TaskRunNotificationService({
    db: database.db,
    channelForNotification: () => channel,
  });
  return new TaskRunSupervisor({
    db: database.db,
    runnerType: "mock",
    runNotifications,
  });
}

function normalizeInboundForFakeFeishuTest(
  message: NormalizedInboundMessage | InboundChannelMessage,
): NormalizedInboundMessage {
  return "channel" in message
    ? message
    : normalizedInboundFromDirectCallForTest(message);
}

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

const batchingSessionConfig = {
  ...fastSessionConfig,
  coalesce_idle_ms: 50,
  coalesce_max_wait_ms: 250,
} satisfies SessionConfig;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-session-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main");
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("session inbound router", () => {
  test("same session messages are serialized into turns", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new DynamicMainRunner((call) => {
      if (call.input.type !== "user_messages") {
        throw new Error("expected user_messages input");
      }
      const coveredMessageIds = call.input.messages.map(
        (message) => message.messageId,
      );
      return {
        operation: "commands.batch",
        reply: {
          title: "批量消息处理完成",
          content: "已合并处理两条连续消息。",
          coveredMessageIds,
        },
        taskActions: [],
        reason: "same sender idle batch",
      } satisfies TestMainPlan;
    });
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: batchingSessionConfig,
    });
    const first = fakeInbound({
      id: "m_queue_batch_first",
      text: "did 写错了",
    });
    const second = fakeInbound({
      id: "m_queue_batch_second",
      text: "改成 4453477614363128",
    });

    const firstRoute = router.routeDirectInboundForTest(first);
    const secondRoute = router.routeDirectInboundForTest(second);
    await Promise.all([firstRoute, secondRoute]);
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.input).toMatchObject({
      type: "user_messages",
      messages: [
        {
          channelMessageKey: first.id,
          text: first.text,
          rawMessage: {
            id: first.id,
            channel: { type: "feishu", id: "feishu-main" },
            surface: { externalId: "group-alpha", kind: "group" },
            sender: { externalId: "user-1", kind: "user" },
            text: first.text,
          },
        },
        {
          channelMessageKey: second.id,
          text: second.text,
          rawMessage: {
            id: second.id,
            channel: { type: "feishu", id: "feishu-main" },
            surface: { externalId: "group-alpha", kind: "group" },
            sender: { externalId: "user-1", kind: "user" },
            text: second.text,
          },
        },
      ],
      latestMessage: {
        id: second.id,
        channel: { type: "feishu", id: "feishu-main" },
        surface: { externalId: "group-alpha", kind: "group" },
        sender: { externalId: "user-1", kind: "user" },
        text: second.text,
      },
    });
    expect(database.db.select().from(messages).where(eq(messages.role, "user")).all())
      .toHaveLength(2);
    expect(database.db.select().from(sessionInbox).all()).toMatchObject([
      { status: "completed" },
      { status: "completed" },
    ]);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([
      { status: "completed" },
    ]);
  });

  test("#steer aborts an active ordinary session turn without executing it as input", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    let firstTurnSignal: AbortSignal | undefined;
    const firstTurnStarted = deferred<void>();
    const firstTurnMayFinish = deferred<void>();
    const runner = new DynamicMainRunner(async (call) => {
      if (runner.calls.length === 1) {
        firstTurnSignal = call.signal;
        firstTurnStarted.resolve();
        await firstTurnMayFinish.promise;
        return {
          operation: "message.send",
          reply: "不应该发送的旧回复",
          reason: "interrupted ordinary turn",
        } satisfies TestMainPlan;
      }
      return {
        operation: "message.send",
        reply: "下一条真正消息已处理",
        reason: "next pending ordinary turn",
      } satisfies TestMainPlan;
    });
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(fakeInbound({
      id: "ordinary-steer-active-1",
      text: "先处理一个长请求",
      threadId: "ordinary-steer-thread-1",
      rootMessageId: "ordinary-steer-root-1",
    }));
    await firstTurnStarted.promise;
    await router.routeDirectInboundForTest(fakeInbound({
      id: "ordinary-steer-next-1",
      text: "下一条真正消息",
      threadId: "ordinary-steer-thread-1",
      rootMessageId: "ordinary-steer-root-1",
    }));
    await router.routeDirectInboundForTest(fakeInbound({
      id: "ordinary-steer-control-1",
      text: "#steer",
      threadId: "ordinary-steer-thread-1",
      rootMessageId: "ordinary-steer-root-1",
    }));
    firstTurnMayFinish.resolve();
    await router.waitForIdle();

    expect(firstTurnSignal?.aborted).toBe(true);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.input).toMatchObject({
      type: "user_messages",
      messages: [{ channelMessageKey: "ordinary-steer-next-1" }],
    });
    expect(channel.outbound).not.toContainEqual(
      expect.objectContaining({ content: "不应该发送的旧回复" }),
    );
    expect(channel.outbound).toContainEqual(
      expect.objectContaining({ content: "下一条真正消息已处理" }),
    );

    const steerMessage = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "ordinary-steer-control-1"))
      .get();
    expect(steerMessage).toBeDefined();
    expect(database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.message_id, steerMessage!.id))
      .all()).toHaveLength(0);
    expect(database.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.reason, "steer_control"))
      .all()).toHaveLength(1);
  });

  test("session turns persist the exact Main Runner prompt", async () => {
    const runner = new DynamicMainRunner((call) => {
      if (call.input.type !== "user_messages") {
        throw new Error("expected user_messages input");
      }
      return {
        operation: "message.send",
        reply: "广州明天有雨。",
        reason: "answer weather request",
      } satisfies TestMainPlan;
    });
    const router = new SessionInboundRouter({
      db: database.db,
      channel: new FakeFeishuChannel("feishu-main"),
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(fakeInbound({
      id: "m_prompt_weather",
      text: "广州明天天气怎么样",
    }));
    await router.waitForIdle();

    const turn = database.db.select().from(sessionTurns).get();
    expect(turn?.materialized_prompt).toContain("<messages>\n");
    expect(turn?.materialized_prompt).toContain("广州明天天气怎么样");
    expect(turn?.materialized_prompt).not.toContain("Allowed Action Contract");
  });

  test("backlogged same-sender messages drain by max wait without idle gap", async () => {
    const firstTurnStarted = deferred<void>();
    const releaseFirstTurn = deferred<TestMainPlan>();
    const runner = new DynamicMainRunner(async (call) => {
      if (call.input.type !== "user_messages") {
        throw new Error("expected user_messages input");
      }
      if (runner.calls.length === 1) {
        firstTurnStarted.resolve();
        return await releaseFirstTurn.promise;
      }
      return {
        operation: "commands.batch",
        reply: {
          title: "批量消息处理完成",
          content: "已合并处理积压消息。",
          coveredMessageIds: call.input.messages.map((message) => message.messageId),
        },
        taskActions: [],
        reason: "same sender backlog batch",
      } satisfies TestMainPlan;
    });
    const router = new SessionInboundRouter({
      db: database.db,
      channel: new FakeFeishuChannel("feishu-main"),
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: {
        ...fastSessionConfig,
        coalesce_idle_ms: 20,
        coalesce_max_wait_ms: 1000,
      },
    });

    await router.routeDirectInboundForTest(fakeInbound({ id: "m_backlog_first", text: "先处理这个" }));
    await firstTurnStarted.promise;
    await router.routeDirectInboundForTest(
      fakeInbound({ id: "m_backlog_second", text: "今天天气怎么样" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await router.routeDirectInboundForTest(fakeInbound({ id: "m_backlog_third", text: "我在广州" }));

    releaseFirstTurn.resolve({
      operation: "message.send",
      reply: "第一轮完成。",
      reason: "release blocking turn",
    });
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.input).toMatchObject({
      type: "user_messages",
      messages: [
        { channelMessageKey: "m_backlog_second", text: "今天天气怎么样" },
        { channelMessageKey: "m_backlog_third", text: "我在广州" },
      ],
    });
    expect(database.db.select().from(sessionTurns).all()).toHaveLength(2);
  });

  test("task runner dispatch does not block next session turn", async () => {
    let releaseTaskRun!: () => void;
    const taskRunStarted = deferred<void>();
    const taskRunRelease = new Promise<void>((resolve) => {
      releaseTaskRun = resolve;
    });
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "task.create",
        taskType: "task",
        title: "播放失败排查",
        summary: "用户反馈播放失败，did=4453477614363128",
        facts: ["did=4453477614363128"],
        dispatchReply: "已开始排查，请关注状态卡片。",
        reason: "investigation request",
      },
      {
        operation: "message.send",
        reply: "已收到第二条消息。",
        reason: "ordinary follow-up",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      taskRunSupervisor: new TaskRunSupervisor({
        db: database.db,
        runnerType: "mock",
        executeRun: async (input) => {
          taskRunStarted.resolve();
          await taskRunRelease;
          return fakeTaskRunResult(input);
        },
      }),
      sessionConfig: fastSessionConfig,
    });

    await router.routeDirectInboundForTest(
      fakeInbound({
        id: "m_queue_task_first",
        text: "播放失败，did=4453477614363128",
      }),
    );
    await taskRunStarted.promise;

    await router.routeDirectInboundForTest(
      fakeInbound({
        id: "m_queue_task_second",
        text: "另外帮我解释下这个字段",
      }),
    );
    await waitUntil(() => runner.calls.length >= 2);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.input).toMatchObject({
      type: "user_messages",
      messages: [{ channelMessageKey: "m_queue_task_second" }],
    });

    releaseTaskRun();
    await router.waitForIdle();
  });

  test("ingress stop waits for active session queue turn", async () => {
    class BlockingMainRunner {
      readonly calls: MainRunnerRunInput[] = [];
      readonly started = deferred<void>();
      readonly release = deferred<TestMainPlan>();

      async run(input: MainRunnerRunInput): Promise<TestMainPlan> {
        this.calls.push(input);
        this.started.resolve();
        return await this.release.promise;
      }

      asMainRunner(): MainRunner {
        return this as unknown as MainRunner;
      }
    }

    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new BlockingMainRunner();
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await ingress.registerChannel(channel);

    await channel.emitInbound(
      fakeInbound({
        id: "m_ingress_stop_waits_for_queue",
        text: "hello while stopping",
      }),
    );
    await runner.started.promise;

    let stopped = false;
    const stopPromise = ingress.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    runner.release.resolve({
      operation: "message.send",
      reply: "停止前完成回复。",
      reason: "stop drains active turn",
    });
    await stopPromise;

    expect(stopped).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([
      { status: "completed" },
    ]);
  });

  test("ingress stop drains all queue workers before surfacing worker errors", async () => {
    const firstWorkerStarted = deferred<void>();
    const secondWorkerStarted = deferred<void>();
    const releaseSecondWorker = deferred<void>();
    let workerCount = 0;
    const queue = new SessionQueue({
      db: database.db,
      config: fastSessionConfig,
      executeTurn: async () => undefined,
    });
    (
      queue as unknown as {
        _runSessionWorker: (sessionId: string) => Promise<void>;
      }
    )._runSessionWorker = async () => {
      workerCount += 1;
      if (workerCount === 1) {
        firstWorkerStarted.resolve();
        throw new Error("first queue worker failed unexpectedly");
      }
      secondWorkerStarted.resolve();
      await releaseSecondWorker.promise;
    };
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: new ScriptedMainRunner([]).asMainRunner(),
      sessionQueue: queue,
    });
    await ingress.registerChannel(channel);

    await channel.emitInbound(
      fakeInbound({
        id: "m_ingress_stop_failed_worker",
        text: "first session",
      }),
    );
    await firstWorkerStarted.promise;
    await channel.emitInbound(
      fakeInbound({
        id: "m_ingress_stop_blocked_worker",
        text: "second session",
        threadId: "thread-stop-blocked-worker",
        rootMessageId: "root-stop-blocked-worker",
      }),
    );
    await secondWorkerStarted.promise;

    let stopSettled = false;
    const stopPromise = ingress.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseSecondWorker.resolve();
    await expect(stopPromise).rejects.toThrow(AggregateError);
    expect(stopSettled).toBe(true);
  });

  test("ingress stop drains queue even when channel stop fails", async () => {
    class FailingStopChannel extends FakeFeishuChannel {
      async stop(): Promise<void> {
        throw new Error("channel stop failed");
      }
    }

    const workerStarted = deferred<void>();
    const releaseWorker = deferred<void>();
    const queue = new SessionQueue({
      db: database.db,
      config: fastSessionConfig,
      executeTurn: async () => undefined,
    });
    (
      queue as unknown as {
        _runSessionWorker: (sessionId: string) => Promise<void>;
      }
    )._runSessionWorker = async () => {
      workerStarted.resolve();
      await releaseWorker.promise;
    };
    const channel = new FailingStopChannel("feishu-main");
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: new ScriptedMainRunner([]).asMainRunner(),
      sessionQueue: queue,
    });
    await ingress.registerChannel(channel);

    await channel.emitInbound(
      fakeInbound({
        id: "m_ingress_stop_channel_failure_waits_for_queue",
        text: "blocked queue worker",
      }),
    );
    await workerStarted.promise;

    let stopSettled = false;
    const stopPromise = ingress.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseWorker.resolve();
    await expect(stopPromise).rejects.toThrow(AggregateError);
    expect(stopSettled).toBe(true);
  });

  test("ordinary message routes through Main Runner without creating Task", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "message.send",
        reply: "这是普通回答。",
        reason: "ordinary session",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      runTask: () => {
        throw new Error("ordinary message should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_chat",
      text: "这个接口是什么意思",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    const canonicalUserId = database.db.select().from(messages)
      .where(eq(messages.externalMessageId, inbound.id)).get()?.senderUserId;
    expect(canonicalUserId).toBeString();
    expect(runner.calls[0]?.input).toMatchObject({
      type: "user_messages",
      messages: [
        {
          messageId: expect.any(String),
          channelMessageKey: inbound.id,
          senderUserId: canonicalUserId,
          text: inbound.text,
          rawMessage: {
            id: inbound.id,
            channel: { type: "feishu", id: "feishu-main" },
            surface: { externalId: "group-alpha", kind: "group" },
            sender: { externalId: inbound.senderUserId, kind: "user" },
            text: inbound.text,
          },
        },
      ],
      latestMessage: {
        id: inbound.id,
        channel: { type: "feishu", id: "feishu-main" },
        surface: { externalId: "group-alpha", kind: "group" },
        sender: { externalId: inbound.senderUserId, kind: "user" },
        text: inbound.text,
      },
    });
    expect(runner.calls[0]?.runnerContext).toMatchObject({
      owner_type: "session",
      owner_id: sessionRows[0]?.id,
      runner_type: "mock",
    });
    expect(database.db.select().from(tasks).all()).toHaveLength(0);
    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]).toMatchObject({
      replyMode: "channel_message",
      content: "这是普通回答。",
    });
  });

  test("ordinary thread message replies in the existing thread", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "message.send",
        reply: "这是 thread 内普通回答。",
        reason: "ordinary session in thread",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      runTask: () => {
        throw new Error("ordinary thread message should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_thread_chat",
      text: "hello in thread",
      rootMessageId: "root-thread-message",
      threadId: "thread-alpha",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(database.db.select().from(tasks).all()).toHaveLength(0);
    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]).toMatchObject({
      replyMode: "reply_in_thread",
      targetMessageId: "root-thread-message",
      content: "这是 thread 内普通回答。",
    });
  });

  test("clarification command replies in the current conversation", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "session.clarify",
        reply: "请补充 uid 和发生时间。",
        pendingIntent: "task",
        missingFields: ["uid", "time window"],
        collectedFacts: ["播放页异常"],
        reason: "missing investigation fields",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      runTask: () => {
        throw new Error("clarification should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_clarification",
      text: "播放页异常，帮我排查",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(database.db.select().from(tasks).all()).toHaveLength(0);
    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]).toMatchObject({
      replyMode: "channel_message",
      content: "请补充 uid 和发生时间。",
    });
  });

  test("task status reply stays in the current conversation without scheduling task work", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "message.status",
        taskId: "task-router-status",
        reply: "当前还在排查中。",
        reason: "user asked for task progress",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      runTask: () => {
        throw new Error("task status reply should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_task_status",
      text: "这个 task 有结论了吗？",
    });
    const session = new SessionStore(database.db).resolveByChannelSurface({
      channelType: inbound.channelType,
      channelId: inbound.channelId,
      ...(inbound.groupId !== undefined ? { groupId: inbound.groupId } : {}),
      ...(inbound.rootMessageId !== undefined
        ? { rootMessageId: inbound.rootMessageId }
        : {}),
    });
    seedTaskForSession({
      taskId: "task-router-status",
      sessionId: session.id,
      title: "播放页异常",
      summary: "用户反馈播放页异常",
      status: "new",
    });
    new TaskSubscriptionStore(database.db).resolve({
      taskId: "task-router-status",
      sessionId: session.id,
      channelType: inbound.channelType,
      channelId: inbound.channelId,
      ...(inbound.groupId !== undefined ? { groupId: inbound.groupId } : {}),
      ...(inbound.rootMessageId !== undefined
        ? { rootMessageId: inbound.rootMessageId }
        : {}),
      visibility: "full",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]).toMatchObject({
      replyMode: "channel_message",
      content: "当前还在排查中。",
    });
  });

  test("Main Runner failure records a failed turn without synthesizing a reply", async () => {
    class ThrowingMainRunner {
      async run(): Promise<never> {
        throw new Error("configured model is unavailable");
      }

      asMainRunner(): MainRunner {
        return this as unknown as MainRunner;
      }
    }

    const channel = new FakeFeishuChannel("feishu-main");
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new ThrowingMainRunner().asMainRunner(),
      runTask: () => {
        throw new Error("fallback should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_failure",
      text: "hi",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(database.db.select().from(tasks).all()).toHaveLength(0);
    expect(channel.outbound).toHaveLength(0);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([{status: "failed"}]);
  });

  test("Main Runner stores primary runner attempt input and output", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const agentRunner = new StreamScriptedAgentRunner([
      "LUNA_NOTHING_TO_SEND",
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: agentRunner,
        runnerContextStore: new RunnerContextStore(database.db),
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
      runTask: () => {
        throw new Error("message.send should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_attempt_valid",
      text: "hello luna",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(channel.outbound).toHaveLength(0);
    const attempts = database.db
      .select()
      .from(lunaSchema.sessionRunnerAttempts)
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptKind: "primary",
      attemptIndex: 0,
      status: "parsed",
      inputPrompt: expect.stringContaining("<messages>\n"),
      rawOutput: "LUNA_NOTHING_TO_SEND",
      rawOutputTruncated: false,
      parsedActionJson: expect.objectContaining({ status: "completed", followupReleased: false }),
      parseErrorJson: null,
    });
  });

  test("stale Main Runner instruction fingerprint forces a fresh launch with launchSeed replay", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const seededRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new ScriptedMainRunner([
        {
          operation: "message.send",
          reply: "first reply",
          reason: "seed first launch",
        },
      ]).asMainRunner(),
    });

    await seededRouter.routeDirectInboundForTest(
      fakeInbound({
        id: "m_stale_fingerprint_seed",
        text: "第一轮上下文，请记住这个需求",
      }),
    );
    await seededRouter.waitForIdle();

    const sessionRow = database.db.select().from(sessions).get();
    expect(sessionRow).toBeDefined();
    if (sessionRow === undefined) {
      throw new Error("Expected seeded session to exist");
    }
    const runnerContextStore = new RunnerContextStore(database.db);
    const initialRunnerContext = runnerContextStore.resolveForSession(
      sessionRow.id,
      "mock",
    );
    const contextPackStore = new ContextPackStore(database.db);
    expect(contextPackStore.listPacksForOwner("session", sessionRow.id)).toEqual(
      [],
    );

    database.db
      .update(runnerContexts)
      .set({
        runner_session_id: "provider-session-stale",
        instruction_fingerprint: "stale-fingerprint",
      })
      .where(eq(runnerContexts.id, initialRunnerContext.id))
      .run();

    const agentRunner = new StreamScriptedAgentRunner([
      "LUNA_NOTHING_TO_SEND",
    ]);
    const replayRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: agentRunner,
        runnerContextStore,
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
    });

    await replayRouter.routeDirectInboundForTest(
      fakeInbound({
        id: "m_stale_fingerprint_replay",
        text: "继续处理第二轮",
      }),
    );
    await replayRouter.waitForIdle();

    expect(agentRunner.calls).toHaveLength(1);
    expect(agentRunner.calls[0]?.options).toMatchObject({
      isNewSession: true,
    });
    expect(agentRunner.calls[0]?.options.runnerSessionId).toBeUndefined();
    const renderedPrompt = textFromUserMessage(agentRunner.calls[0]!.userMessage);
    const turnInput = extractMainRunnerTurnInputJson(renderedPrompt);
    expect(turnInput.context.launchSeed?.items.map((item) => item.text)).toEqual([
      "第一轮上下文，请记住这个需求",
      "first reply",
    ]);
    expect(turnInput.context.launchSeed?.items.map((item) => item.text)).not
      .toContain("继续处理第二轮");
    expect(turnInput.orderedMessages.map((message) => message.text)).toEqual([
      "继续处理第二轮",
    ]);
    const replayTurnId = turnIdForExternalMessage(
      "m_stale_fingerprint_replay",
    );
    expect(
      contextPackStore
        .listPacksForOwner("session", sessionRow.id)
        .filter((pack) => pack.kind === "session_launch"),
    ).toMatchObject([
      {
        createdForInvocationId: replayTurnId,
        selectionStrategy: "deterministic_window",
        triggerMessageId: messageIdForExternalMessage(
          "m_stale_fingerprint_replay",
        ),
      },
    ]);

    const persistedRunnerContext = runnerContextStore.resolveForSession(
      sessionRow.id,
      "mock",
    );
    // Without a Worker the session fingerprint is fixed: instruction content never forces a fresh launch.
    expect(persistedRunnerContext.instruction_fingerprint).toBe("local-runner-session");
    expect(persistedRunnerContext.instruction_fingerprint).not.toBe(
      "stale-fingerprint",
    );
  });

  test("stale Main Runner resume state rebuilds context and replays launchSeed on fresh launch", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const seededRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new ScriptedMainRunner([
        {
          operation: "message.send",
          reply: "first reply",
          reason: "seed first launch",
        },
      ]).asMainRunner(),
    });

    await seededRouter.routeDirectInboundForTest(
      fakeInbound({
        id: "m_stale_resume_seed",
        text: "第一轮上下文，请记住这个需求",
      }),
    );
    await seededRouter.waitForIdle();

    const sessionRow = database.db.select().from(sessions).get();
    expect(sessionRow).toBeDefined();
    if (sessionRow === undefined) {
      throw new Error("Expected seeded session to exist");
    }

    const runnerContextStore = new RunnerContextStore(database.db);
    const initialRunnerContext = runnerContextStore.resolveForSession(
      sessionRow.id,
      "mock",
    );
    const contextPackStore = new ContextPackStore(database.db);
    expect(contextPackStore.listPacksForOwner("session", sessionRow.id)).toEqual(
      [],
    );

    database.db
      .update(runnerContexts)
      .set({
        runner_session_id: "provider-session-stale",
      })
      .where(eq(runnerContexts.id, initialRunnerContext.id))
      .run();

    const agentRunner = new StaleResumeAgentRunner(
      "LUNA_NOTHING_TO_SEND",
    );
    const replayRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: agentRunner,
        runnerContextStore,
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
    });

    await replayRouter.routeDirectInboundForTest(
      fakeInbound({
        id: "m_stale_resume_replay",
        text: "继续处理第二轮",
      }),
    );
    await replayRouter.waitForIdle();

    expect(agentRunner.calls).toHaveLength(2);
    expect(agentRunner.calls[0]?.options).toMatchObject({
      isNewSession: false,
      runnerSessionId: "provider-session-stale",
    });
    expect(agentRunner.calls[1]?.options).toMatchObject({
      isNewSession: true,
    });
    expect(agentRunner.calls[1]?.options.runnerSessionId).toBeUndefined();
    const renderedPrompt = textFromUserMessage(agentRunner.calls[1]!.userMessage);
    const turnInput = extractMainRunnerTurnInputJson(renderedPrompt);
    expect(turnInput.context.launchSeed?.items.map((item) => item.text)).toEqual([
      "第一轮上下文，请记住这个需求",
      "first reply",
    ]);
    expect(turnInput.context.launchSeed?.items.map((item) => item.text)).not
      .toContain("继续处理第二轮");
    expect(turnInput.orderedMessages.map((message) => message.text)).toEqual([
      "继续处理第二轮",
    ]);
    const replayTurnId = turnIdForExternalMessage("m_stale_resume_replay");
    expect(
      contextPackStore
        .listPacksForOwner("session", sessionRow.id)
        .filter((pack) => pack.kind === "session_launch"),
    ).toMatchObject([
      {
        createdForInvocationId: replayTurnId,
        selectionStrategy: "deterministic_window",
        triggerMessageId: messageIdForExternalMessage(
          "m_stale_resume_replay",
        ),
      },
    ]);

    const persistedRunnerContext = runnerContextStore.resolveForSession(
      sessionRow.id,
      "mock",
    );
    expect(persistedRunnerContext.runner_session_id).toBe("runner-session-2");

    database.db
      .update(runnerContexts)
      .set({ runner_session_id: "provider-session-stale-again" })
      .where(eq(runnerContexts.id, persistedRunnerContext.id))
      .run();
    const secondRecoveryRunner = new StaleResumeAgentRunner(
      "LUNA_NOTHING_TO_SEND",
    );
    const secondReplayRouter = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: secondRecoveryRunner,
        runnerContextStore,
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
    });

    await secondReplayRouter.routeDirectInboundForTest(
      fakeInbound({
        id: "m_stale_resume_replay_again",
        text: "第三轮要使用第二轮的新信息",
      }),
    );
    await secondReplayRouter.waitForIdle();

    expect(secondRecoveryRunner.calls).toHaveLength(2);
    const secondReplayInput = extractMainRunnerTurnInputJson(
      textFromUserMessage(secondRecoveryRunner.calls[1]!.userMessage),
    );
    expect(
      secondReplayInput.context.launchSeed?.items.map((item) => item.text),
    ).toEqual([
      "第一轮上下文，请记住这个需求",
      "first reply",
      "继续处理第二轮",
    ]);
    expect(
      secondReplayInput.context.launchSeed?.items.map((item) => item.text),
    ).not.toContain("第三轮要使用第二轮的新信息");
    const secondReplayTurnId = turnIdForExternalMessage(
      "m_stale_resume_replay_again",
    );
    expect(
      contextPackStore
        .listPacksForOwner("session", sessionRow.id)
        .filter((pack) => pack.kind === "session_launch")
        .map((pack) => pack.createdForInvocationId),
    ).toEqual([replayTurnId, secondReplayTurnId]);
  });

  test("Main Runner records runner failure without repair attempt", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const agentRunner = new ThrowingAgentRunner("provider unavailable");
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: agentRunner,
        runnerContextStore: new RunnerContextStore(database.db),
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
    });
    const inbound = fakeInbound({
      id: "m_main_runner_attempt_runner_failed",
      text: "hi",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(channel.outbound).toHaveLength(0);
    const attempts = database.db
      .select()
      .from(lunaSchema.sessionRunnerAttempts)
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptKind: "primary",
      status: "runner_failed",
      rawOutput: "",
      rawOutputTruncated: false,
      parseErrorJson: expect.objectContaining({
        message: "provider unavailable",
      }),
    });
  });

  test("Main Runner leaves transient retry ownership to the Agent runner", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const agentRunner = new FlakyAgentRunner([
      new Error("Container error: Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)"),
      "LUNA_NOTHING_TO_SEND",
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: agentRunner,
        runnerContextStore: new RunnerContextStore(database.db),
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
      runTask: () => {
        throw new Error("message.send should not schedule task work");
      },
    });
    const inbound = fakeInbound({
      id: "m_main_runner_attempt_transient_retry",
      text: "zai",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(channel.outbound).toHaveLength(0);
    expect(agentRunner.calls).toHaveLength(1);
    const attempts = database.db
      .select()
      .from(lunaSchema.sessionRunnerAttempts)
      .orderBy(lunaSchema.sessionRunnerAttempts.attemptIndex)
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptKind: "primary",
      attemptIndex: 0,
      status: "runner_failed",
      parseErrorJson: expect.objectContaining({
        message: expect.stringContaining("response.failed"),
      }),
    });
  });

  test("Main Runner truncates oversized raw output", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const oversizedOutput = "x".repeat(MAIN_RUNNER_RAW_OUTPUT_LIMIT_BYTES + 64);
    const agentRunner = new StreamScriptedAgentRunner([
      oversizedOutput,
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new MainRunner({
        runner: agentRunner,
        runnerContextStore: new RunnerContextStore(database.db),
        attemptStore: new SessionRunnerAttemptStore(database.db),
        serviceAuthDb: database.db,
        accessTokenSigningSecret: "test-secret",
      }),
    });
    const inbound = fakeInbound({
      id: "m_main_runner_attempt_truncated",
      text: "hi",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(channel.outbound).toHaveLength(0);
    const attempts = database.db
      .select()
      .from(lunaSchema.sessionRunnerAttempts)
      .orderBy(lunaSchema.sessionRunnerAttempts.attemptIndex)
      .all();
    expect(attempts[0]).toMatchObject({
      attemptKind: "primary",
      status: "runner_failed",
      rawOutputTruncated: true,
    });
    expect(new TextEncoder().encode(attempts[0]!.rawOutput ?? "").byteLength)
      .toBeLessThanOrEqual(MAIN_RUNNER_RAW_OUTPUT_LIMIT_BYTES);
  });

  test("silent group message records skipped turn without invoking Main Runner", async () => {
    class ThrowingMainRunner {
      async run(): Promise<never> {
        throw new Error("silent group message must not invoke Main Runner");
      }

      asMainRunner(): MainRunner {
        return this as unknown as MainRunner;
      }
    }

    const channel = new FakeFeishuChannel("feishu-main");
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: new ThrowingMainRunner().asMainRunner(),
      sessionConfig: fastSessionConfig,
    });

    await router.route({
      id: "m_silent_group_skip_turn",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-alpha", kind: "group" },
      sender: { externalId: "user-1", kind: "user" },
      text: "旁路聊天内容",
      mentions: [],
      addressing: { addressedToBot: false, reason: "silent_group" },
      rawPayload: { testPayload: true },
    });
    await router.waitForIdle();

    expect(database.db.select().from(sessionInbox).all()).toHaveLength(0);
    expect(database.db.select().from(sessionTurns).all()).toMatchObject([
      {
        turn_kind: "skip",
        status: "skipped",
        runner_invoked: false,
        reason: "silent_group",
      },
    ]);
    expect(database.db.select().from(sessionTurnEntries).all()).toMatchObject([
      { role: "skipped" },
    ]);
    expect(channel.outbound).toHaveLength(0);
  });

  test("redelivered queued message is not enqueued or executed twice", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "message.send",
        reply: "只处理一次。",
        reason: "queued duplicate",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
    });
    const inbound = fakeInbound({
      id: "m_main_runner_selected_replay",
      text: "播放页异常，uid=79845296216",
    });
    await router.routeDirectInboundForTest(inbound);
    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(database.db.select().from(sessionInbox).all()).toHaveLength(1);
    expect(database.db.select().from(sessionTurns).all()).toHaveLength(1);
    expect(channel.outbound).toHaveLength(1);
  });

  test("async queue dispatches Task update restart without rerunning Main Runner", async () => {
    class ThrowAfterFirstStatusCardCreateChannel extends FakeFeishuChannel {
      throwsRemaining = 1;

      override async send(
        inbound: Parameters<FakeFeishuChannel["send"]>[0],
        operation: Parameters<FakeFeishuChannel["send"]>[1],
      ): ReturnType<FakeFeishuChannel["send"]> {
        const outbound = await super.send(inbound, operation);
        if (
          operation.replyMode === "reply_in_thread" &&
          operation.statusCardState === "active" &&
          operation.idempotencyKey?.startsWith("[\"task-run-notification\"") === true &&
          this.throwsRemaining > 0
        ) {
          this.throwsRemaining -= 1;
          throw new Error("local persistence failed after status card create");
        }
        return outbound;
      }
    }

    const channel = new ThrowAfterFirstStatusCardCreateChannel("feishu-main");
    const action = {
      operation: "task.update",
      taskId: "task-router-restart-replay",
      updateSummary: "补充 logid=abc",
      dispatchReply: "已重新开始排查，请关注最新状态卡片。",
      reason: "main runner selected stopped task restart",
    } as const;
    const runner = new ScriptedMainRunner([
      action,
      {
        operation: "message.status",
        taskId: "task-router-restart-replay",
        reply: "wrong replay path",
        reason: "main runner should not rerun on redelivery",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      taskRunSupervisor: createTaskRunSupervisorForTest(channel),
    });
    const inbound = fakeInbound({
      id: "m_router_restart_replay",
      text: "补充 logid=abc",
    });
    const session = new SessionStore(database.db).resolveByChannelSurface({
      channelType: inbound.channelType,
      channelId: inbound.channelId,
      ...(inbound.groupId !== undefined ? { groupId: inbound.groupId } : {}),
      ...(inbound.rootMessageId !== undefined
        ? { rootMessageId: inbound.rootMessageId }
        : {}),
    });
    seedTaskForSession({
      taskId: action.taskId,
      sessionId: session.id,
      title: "reader 接口 502",
      summary: "用户反馈 reader 接口 502",
      status: "completed",
    });
    const subscriptionStore = new TaskSubscriptionStore(database.db);
    subscriptionStore.resolve({
      taskId: action.taskId,
      sessionId: session.id,
      channelType: inbound.channelType,
      channelId: inbound.channelId,
      ...(inbound.groupId !== undefined ? { groupId: inbound.groupId } : {}),
      ...(inbound.rootMessageId !== undefined
        ? { rootMessageId: inbound.rootMessageId }
        : {}),
      visibility: "full",
    });

    await router.routeDirectInboundForTest(inbound);
    await router.waitForIdle();
    expect(database.db.select().from(tasks).get()?.status).toBe("completed");
    expect(subscriptionStore.listForTask(action.taskId)).toHaveLength(1);

    expect(runner.calls).toHaveLength(1);
    expect(new TaskRunStore(database.db).listRunsForTask(action.taskId))
      .toMatchObject([
        {
          reason: "restart",
          status: "completed",
          // A run started by a Main command is identified by that command, not by a message.
          inputSnapshot: expect.objectContaining({ operation: "task.update", operationId: expect.any(String) }),
        },
      ]);
    const statusOutbounds = channel.outbound.filter(
      (row) => row.replyMode !== "update_status_card" && row.idempotencyKey?.startsWith("[\"task-run-notification\"") === true,
    );
    expect(statusOutbounds).toHaveLength(1);
    expect(statusOutbounds[0]).toMatchObject({
      replyMode: "channel_message",
      statusCardState: "active",
      statusCard: {
        status: "running",
        taskId: action.taskId,
      },
    });
  });

  test("task dispatch runs through a domain command without runner decisions", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "task.create",
        taskType: "task",
        title: "播放页异常",
        summary: "用户反馈播放页异常",
        facts: ["uid=79845296216"],
        dispatchReply: "已开始排查，请关注状态卡片。",
        reason: "main runner selected task dispatch",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      taskRunSupervisor: createTaskRunSupervisorForTest(channel),
    });

    await router.routeDirectInboundForTest(
      fakeInbound({
        id: "m_main_runner_dispatch",
        text: "这里有异常，uid=79845296216",
      }),
    );
    await router.waitForIdle();

    const taskRows = database.db.select().from(tasks).all();
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({
      type: "task",
      title: "播放页异常",
      summary: "用户反馈播放页异常",
    });
    expect(channel.outbound).toContainEqual(expect.objectContaining({
      content: "已开始排查，请关注状态卡片。",
      replyMode: "channel_message",
    }));
    expect(new TaskRunStore(database.db).listRunsForTask(taskRows[0]!.id))
      .toMatchObject([{ reason: "initial", status: "completed" }]);
  });

  test("root ordinary message creates session and session runner context", async () => {
    const channel = new FakeFeishuChannel("feishu-main", [
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        rootMessageId: "message-root-1",
        senderUserId: "user-1",
        text: "hello luna",
      },
    ]);
    const ingress = createIngress([
      {
        operation: "message.send",
        reply: "hello",
        reason: "ordinary",
      },
    ]);
    await ingress.registerChannel(channel);

    await ingress.start();
    await ingress.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);

    const visibleRows = database.db
      .select()
      .from(messages)
      .all()
      .filter((row) => row.role === "user" || isVisibleAssistant(row.rawPayloadJson));
    expect(visibleRows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const visibleTimelineRows = database.db
      .select()
      .from(sessionTimelineEntries)
      .all()
      .filter((entry) => visibleRows.some((row) => row.id === entry.messageId));
    expect(
      visibleTimelineRows.every(
        (entry) => entry.sessionId === sessionRows[0]?.id,
      ),
    ).toBe(true);

    const runnerRows = database.db.select().from(runnerContexts).all();
    expect(runnerRows).toHaveLength(1);
    expect(runnerRows[0]).toMatchObject({
      owner_type: "session",
      owner_id: sessionRows[0]?.id,
      runner_type: "mock",
    });
  });

  test("normalized webhook fake adapter routes through ingress and creates a session", async () => {
    fixtureSessionOwnership(database.db, "webhook", "webhook-main");
    const channel = new FakeFeishuChannel("webhook-main", [], {
      type: "webhook",
    });
    const runner = new ScriptedMainRunner([
      {
        operation: "message.send",
        reply: "webhook received",
        reason: "webhook session",
      },
    ]);
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    await ingress.registerChannel(channel);

    await channel.emitNormalizedInbound(
      fakeNormalizedInbound({
        id: "webhook-message-1",
        channelType: "webhook",
        channelId: "webhook-main",
        surfaceExternalId: "source-1",
        surfaceKind: "webhook",
        senderExternalId: "webhook-sender-1",
        text: "deploy webhook event",
      }),
    );
    await ingress.waitForIdle();

    expect(database.db.select().from(sessions).all()).toMatchObject([
      {
        channel_type: "webhook",
        channel_id: "webhook-main",
        group_id: "source-1",
      },
    ]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.input).toMatchObject({
      type: "user_messages",
      messages: [
        {
          channelMessageKey: "webhook-message-1",
          senderUserId: "webhook-sender-1",
          text: "deploy webhook event",
          rawMessage: {
            id: "webhook-message-1",
            channel: {
              type: "webhook",
              id: "webhook-main",
            },
            surface: {
              externalId: "source-1",
              kind: "webhook",
            },
            sender: {
              externalId: "webhook-sender-1",
              kind: "user",
            },
            text: "deploy webhook event",
          },
        },
      ],
      latestMessage: {
        id: "webhook-message-1",
        channel: {
          type: "webhook",
          id: "webhook-main",
        },
        surface: {
          externalId: "source-1",
          kind: "webhook",
        },
        sender: {
          externalId: "webhook-sender-1",
          kind: "user",
        },
        text: "deploy webhook event",
      },
    });
    expect(channel.outbound).toHaveLength(1);
    expect(channel.outbound[0]).toMatchObject({
      channelId: "webhook-main",
      content: "webhook received",
    });
  });

  test("normalized rich inbound bridge preserves provider ids and mention metadata", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = createIngress([
      {
        operation: "message.send",
        reply: "rich message received",
        reason: "ordinary",
      },
    ]);
    await ingress.registerChannel(channel);

    await channel.emitNormalizedInbound({
      id: "normalized-rich-message-1",
      channel: {
        type: "feishu",
        id: "feishu-main",
      },
      surface: {
        externalId: "oc_rich_chat",
        kind: "group",
        displayName: "Rich Chat",
        avatarUrl: "https://avatar.example/chat.png",
        providerIds: {
          tenant_key: "tenant-chat",
        },
        rawProfile: {
          chat_id: "oc_rich_chat",
          tenant_key: "tenant-chat",
        },
      },
      sender: {
        externalId: "ou_sender_rich",
        kind: "user",
        displayName: "Rich Sender",
        avatarUrl: "https://avatar.example/sender.png",
        providerIds: {
          open_id: "ou_sender_rich",
          user_id: "user_sender_rich",
          union_id: "on_sender_rich",
          tenant_key: "tenant-sender",
        },
        rawProfile: {
          open_id: "ou_sender_rich",
          tenant_key: "tenant-sender",
        },
      },
      text: "@_bot please check",
      mentions: [
        {
          key: "@_bot",
          label: "@Luna",
          target: {
            externalId: "ou_bot_rich",
            kind: "bot",
            displayName: "Luna",
            providerIds: {
              open_id: "ou_bot_rich",
              user_id: "user_bot_rich",
              union_id: "on_bot_rich",
              tenant_key: "tenant-bot",
            },
            rawProfile: {
              open_id: "ou_bot_rich",
              tenant_key: "tenant-bot",
            },
          },
          rawMention: {
            key: "@_bot",
            tenant_key: "tenant-bot",
          },
        },
      ],
      addressing: {
        addressedToBot: true,
        reason: "mention",
      },
      rawPayload: {
        event: "rich-normalized",
      },
    });
    await ingress.waitForIdle();

    const messageRow = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "normalized-rich-message-1"))
      .get();
    expect(messageTextContent(messageRow?.contentJson)).toBe(
      "@Luna please check",
    );
    expect(
      (messageRow?.rawPayloadJson as { readonly text?: string } | undefined)
        ?.text,
    ).toBe("@Luna please check");

    expect(database.db.select().from(channelIdentities).all()).toContainEqual(
      expect.objectContaining({
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "ou_sender_rich",
        providerIdsJson:
          '{"open_id":"ou_sender_rich","user_id":"user_sender_rich","union_id":"on_sender_rich","tenant_key":"tenant-sender"}',
      }),
    );
    expect(database.db.select().from(channelIdentities).all()).toContainEqual(
      expect.objectContaining({
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "ou_bot_rich",
        providerIdsJson:
          '{"open_id":"ou_bot_rich","user_id":"user_bot_rich","union_id":"on_bot_rich","tenant_key":"tenant-bot"}',
      }),
    );
    expect(database.db.select().from(channelSurfaces).all()).toContainEqual(
      expect.objectContaining({
        channelType: "feishu",
        channelId: "feishu-main",
        externalId: "oc_rich_chat",
        providerIdsJson: '{"tenant_key":"tenant-chat"}',
      }),
    );
    expect(database.db.select().from(messageMentions).all()).toContainEqual(
      expect.objectContaining({
        messageId: messageRow?.id,
        mentionKey: "@_bot",
        mentionLabel: "@Luna",
        targetExternalId: "ou_bot_rich",
        targetKind: "bot",
        targetIdentityId: expect.any(String),
      }),
    );
  });

  test("recovered turns do not derive inbound facts from raw payload", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const runner = new ScriptedMainRunner([
      {
        operation: "completion",
        reason: "raw payload replay check",
      },
    ]);
    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      mainRunner: runner.asMainRunner(),
      sessionConfig: fastSessionConfig,
    });
    const now = Date.now();
    database.db.insert(lunaSchema.users).values({
      id: "stored-user", agentId: fixtureSessionOwnership(database.db,"feishu","stored-channel").agent_id,
      kind: "human", displayName: "Stored User", status: "active",
      createdAt: String(now), updatedAt: String(now),
    }).run();

    database.db
      .insert(sessions)
      .values({
        id: "session-raw-payload-replay",
        surface_key: "feishu:stored-surface",
        channel_type: "feishu",
        channel_id: "stored-channel",
        group_id: "stored-group",
        root_message_key: "stored-root",
        thread_key: null,
        title: "Raw payload replay",
        status: "active",
        created_by_user_id: "stored-user",
        created_at: now,
        updated_at: now,
        last_activity_at: now, ...fixtureSessionOwnership(database.db,"feishu","stored-channel")})
      .run();
    database.db
      .insert(messages)
      .values({
        id: "message-raw-payload-replay",
        agentId:fixtureSessionOwnership(database.db,"feishu","stored-channel").agent_id,
        shadowId:fixtureSessionOwnership(database.db,"feishu","stored-channel").shadow_id,
        bindingId:fixtureSessionOwnership(database.db,"feishu","stored-channel").binding_id,
        channelType: "feishu",
        channelId: "stored-channel",
        externalMessageId: "stored-message",
        senderUserId: "stored-user",
        senderIdentityId: null,
        role: "user",
        contentKind: "text",
        presentationKind: "plain",
        providerMessageType: "text",
        contentJson: [{ type: "text", text: "内部正文优先" }],
        rawPayloadJson: {
          id: "raw-message",
          channelType: "feishu",
          channelId: "raw-channel",
          groupId: "raw-group",
          rootMessageId: "raw-root",
          senderUserId: "raw-user",
          text: "raw payload text",
        },
        occurredAt: now,
        createdAt: now,
      })
      .run();
    database.db
      .insert(sessionTimelineEntries)
      .values({
        id: "entry-raw-payload-replay",
        sessionId: "session-raw-payload-replay",
        messageId: "message-raw-payload-replay",
        entryKind: "message",
        createdAt: now,
      })
      .run();
    database.db
      .insert(sessionInbox)
      .values({
        id: "inbox-raw-payload-replay",
        session_id: "session-raw-payload-replay",
        entry_id: "entry-raw-payload-replay",
        message_id: "message-raw-payload-replay",
        sender_identity_id: null,
        received_at: now,
        status: "pending",
        turn_id: null,
        claimed_at: null,
        completed_at: null,
        error: null,
        created_at: now,
        updated_at: now,
      })
      .run();

    await router.recoverPending();
    await router.waitForIdle();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.input).toMatchObject({
      type: "user_messages",
      messages: [
        {
          channelMessageKey: "stored-message",
          senderUserId: "stored-user",
          text: "内部正文优先",
          rawMessage: {
            id: "stored-message",
            channel: { type: "feishu", id: "stored-channel" },
            surface: { externalId: "unknown", kind: "unknown" },
            sender: { externalId: "stored-user", kind: "unknown" },
            text: "内部正文优先",
          },
        },
      ],
      latestMessage: {
        id: "stored-message",
        channel: { type: "feishu", id: "stored-channel" },
        surface: { externalId: "unknown", kind: "unknown" },
        sender: { externalId: "stored-user", kind: "unknown" },
        text: "内部正文优先",
      },
    });
    const recoveredInput = runner.calls[0]?.input;
    expect(recoveredInput?.type).toBe("user_messages");
    if (recoveredInput?.type !== "user_messages") {
      throw new Error("expected recovered input to be user_messages");
    }
    expect(recoveredInput.latestMessage.channel.id).not.toBe("raw-channel");
    expect(recoveredInput.latestMessage.id).not.toBe("raw-message");
  });

  test("canonicalized duplicate messages keep source structured mentions", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = createIngress();
    await ingress.registerChannel(channel);

    await channel.emitInbound({
      id: "message-duplicate-mention",
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      rootMessageId: "message-root-1",
      senderUserId: "user-1",
      text: "root copy arrives first",
    });
    await channel.emitInbound({
      id: "message-duplicate-mention",
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      threadId: "thread-1",
      senderUserId: "user-2",
      text: "@_alex continue from thread",
      mentions: [
        {
          key: "@_alex",
          name: "Alex",
          openId: "ou_alex_duplicate",
          mentionedType: "user",
        },
      ],
    });
    await ingress.waitForIdle();

    const canonicalRows = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "message-duplicate-mention"))
      .all();
    expect(canonicalRows).toHaveLength(1);

    const mentionRows = database.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, canonicalRows[0]!.id))
      .all();
    expect(mentionRows).toContainEqual(
      expect.objectContaining({
        mentionKey: "@_alex",
        mentionLabel: "@Alex",
        targetExternalId: "ou_alex_duplicate",
        targetKind: "user",
        targetIdentityId: expect.any(String),
      }),
    );
  });

  test("thread reply reuses existing session", async () => {
    const channel = new FakeFeishuChannel("feishu-main", [
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        rootMessageId: "message-root-1",
        senderUserId: "user-1",
        text: "start a thread",
      },
      {
        id: "message-thread-2",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        rootMessageId: "message-root-1",
        senderUserId: "user-2",
        text: "continue the same thread",
      },
    ]);
    const ingress = createIngress();
    await ingress.registerChannel(channel);

    await ingress.start();
    await ingress.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);

    const timeline = new SessionTimelineReader(database.db);
    expect(
      timeline
        .listForSession(sessionRows[0]!.id)
        .filter((item) => item.message.role === "user")
        .map((item) => item.message.externalMessageId),
    ).toEqual(["message-root-1", "message-thread-2"]);
  });

  test("group root message is referenced by matching thread reply session", async () => {
    const channel = new FakeFeishuChannel("feishu-main", [
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        rootMessageId: "message-root-1",
        senderUserId: "user-1",
        text: "root before thread exists",
      },
      {
        id: "message-thread-2",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        rootMessageId: "message-root-1",
        senderUserId: "user-2",
        text: "reply after thread exists",
      },
    ]);
    const ingress = createIngress();
    await ingress.registerChannel(channel);

    await ingress.start();
    await ingress.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    const rootSession = sessionRows.find((row) => row.thread_key === null);
    const threadSession = sessionRows.find((row) => row.thread_key === "thread-1");
    expect(rootSession).toMatchObject({
      thread_key: null,
      root_message_key: null,
    });
    expect(threadSession).toMatchObject({
      thread_key: "thread-1",
      root_message_key: "message-root-1",
    });

    const timeline = new SessionTimelineReader(database.db);
    expect(timeline.listForSession(rootSession!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "message-root-1" }),
        }),
      ]),
    );
    expect(timeline.listForSession(threadSession!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "reference" }),
          message: expect.objectContaining({ externalMessageId: "message-root-1" }),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "message-thread-2" }),
        }),
      ]),
    );
  });

  test("thread-only reply reuses root and thread session", async () => {
    const channel = new FakeFeishuChannel("feishu-main", [
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        rootMessageId: "message-root-1",
        senderUserId: "user-1",
        text: "root in a thread",
      },
      {
        id: "message-thread-2",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        senderUserId: "user-2",
        text: "thread-only reply",
      },
    ]);
    const ingress = createIngress();
    await ingress.registerChannel(channel);

    await ingress.start();
    await ingress.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toMatchObject({
      root_message_key: "message-root-1",
      thread_key: "thread-1",
    });
  });

  test("root and thread message reuses thread-only session", async () => {
    const channel = new FakeFeishuChannel("feishu-main", [
      {
        id: "message-thread-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        senderUserId: "user-1",
        text: "thread-only first",
      },
      {
        id: "message-root-2",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        rootMessageId: "message-root-1",
        senderUserId: "user-2",
        text: "root arrives later",
      },
    ]);
    const ingress = createIngress();
    await ingress.registerChannel(channel);

    await ingress.start();
    await ingress.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toMatchObject({
      root_message_key: "message-root-1",
      thread_key: "thread-1",
    });
  });

  test("fake channel awaits subscribed inbound handler failures", async () => {
    const channel = new FakeFeishuChannel("feishu-main", [
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        rootMessageId: "message-root-1",
        senderUserId: "user-1",
        text: "hello luna",
      },
    ]);
    channel.subscribeInbound(async () => {
      throw new Error("handler failed");
    });

    await expect(channel.start()).rejects.toThrow("handler failed");
  });

  test("ingress stops started channels when later channel startup fails", async () => {
    fixtureSessionOwnership(database.db, "feishu", "feishu-started");
    fixtureSessionOwnership(database.db, "feishu", "feishu-failing");
    class StoppableFakeFeishuChannel extends FakeFeishuChannel {
      stopped = false;

      async stop(): Promise<void> {
        this.stopped = true;
      }
    }

    class FailingFakeFeishuChannel extends FakeFeishuChannel {
      override async start(): Promise<void> {
        throw new Error("channel startup failed");
      }
    }

    const startedChannel = new StoppableFakeFeishuChannel("feishu-started");
    const failingChannel = new FailingFakeFeishuChannel("feishu-failing");
    const ingress = createIngress();
    await ingress.registerChannel(startedChannel);
    await ingress.registerChannel(failingChannel);

    await expect(ingress.start()).rejects.toThrow("channel startup failed");
    expect(startedChannel.stopped).toBe(true);
  });

  test("ingress stops failing channel when startup partially initializes", async () => {
    fixtureSessionOwnership(database.db, "feishu", "feishu-partial");
    class PartiallyFailingFakeFeishuChannel extends FakeFeishuChannel {
      started = false;
      stopped = false;

      override async start(): Promise<void> {
        this.started = true;
        throw new Error("partial startup failed");
      }

      async stop(): Promise<void> {
        this.stopped = true;
      }
    }

    const failingChannel = new PartiallyFailingFakeFeishuChannel(
      "feishu-partial",
    );
    const ingress = createIngress();
    await ingress.registerChannel(failingChannel);

    await expect(ingress.start()).rejects.toThrow("partial startup failed");
    expect(failingChannel.started).toBe(true);
    expect(failingChannel.stopped).toBe(true);
  });

  test("failed channel subscription does not leave channel registered", async () => {
    fixtureSessionOwnership(database.db, "feishu", "feishu-throwing");
    class ThrowingSubscribeFakeFeishuChannel extends FakeFeishuChannel {
      started = false;

      override async subscribeInbound(): Promise<void> {
        throw new Error("subscription failed");
      }

      override async start(): Promise<void> {
        this.started = true;
      }
    }

    const channel = new ThrowingSubscribeFakeFeishuChannel("feishu-throwing");
    const ingress = createIngress();

    await expect(ingress.registerChannel(channel)).rejects.toThrow(
      "subscription failed",
    );
    await ingress.start();
    expect(channel.started).toBe(false);

    const retryChannel = new FakeFeishuChannel("feishu-throwing", [
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-throwing",
        groupId: "group-alpha",
        rootMessageId: "message-root-1",
        senderUserId: "user-1",
        text: "retry registration",
      },
    ]);
    await ingress.registerChannel(retryChannel);
    await ingress.start();
    await ingress.waitForIdle();
    expect(retryChannel.outbound).toHaveLength(1);
  });

  test("session surfaces persist a unique surface key", async () => {
    const store = new SessionStore(database.db);
    const input = {
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-alpha",
      rootMessageId: "message-root-1",
    } as const;

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => store.resolveByChannelSurface(input)),
      Promise.resolve().then(() => store.resolveByChannelSurface(input)),
    ]);

    expect(first.id).toBe(second.id);

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toHaveProperty("surface_key");
    expect(sessionRows[0]).toMatchObject({
      thread_key: null,
      root_message_key: null,
      surface_key: JSON.stringify([
        "v2",
        first.binding_id,
        "feishu",
        "feishu-main",
        "group-alpha",
        "channel",
        "rootless",
      ]),
    });

    const sqlite = new SQLiteDatabase(join(testHome, "data", "luna.db"), {
      readonly: true,
    });
    try {
      const indexes = sqlite
        .query<{ name: string; unique: number }, []>(
          "PRAGMA index_list(sessions)",
        )
        .all()
        .filter((row) => row.unique === 1)
        .map((row) => row.name);
      expect(indexes).toContain("sessions_surface_key_unique");
    } finally {
      sqlite.close();
    }
  });

  test("thread surface records thread and root aliases", async () => {
    const store = new SessionStore(database.db);

    const [rootAndThread, threadOnly] = await Promise.all([
      Promise.resolve().then(() =>
        store.resolveByChannelSurface({
          channelType: "feishu",
          channelId: "feishu-main",
          groupId: "group-alpha",
          threadId: "thread-1",
          rootMessageId: "message-root-1",
        }),
      ),
      Promise.resolve().then(() =>
        store.resolveByChannelSurface({
          channelType: "feishu",
          channelId: "feishu-main",
          groupId: "group-alpha",
          threadId: "thread-1",
        }),
      ),
    ]);

    expect(rootAndThread.id).toBe(threadOnly.id);

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toMatchObject({
      root_message_key: "message-root-1",
      thread_key: "thread-1",
    });

    const sqlite = new SQLiteDatabase(join(testHome, "data", "luna.db"), {
      readonly: true,
    });
    try {
      const aliasCount = sqlite
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM session_surface_aliases",
        )
        .get();
      expect(aliasCount?.count).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("matching root messages stay owned by root when thread metadata appears", async () => {
    const inboundMessages = [
      {
        id: "message-thread-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        senderUserId: "user-1",
        text: "thread-only first",
      },
      {
        id: "message-root-1",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        rootMessageId: "message-root-1",
        senderUserId: "user-2",
        text: "root-only second",
      },
      {
        id: "message-root-thread-3",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        rootMessageId: "message-root-1",
        senderUserId: "user-3",
        text: "root and thread together",
      },
      {
        id: "message-thread-4",
        channelType: "feishu",
        channelId: "feishu-main",
        groupId: "group-alpha",
        threadId: "thread-1",
        senderUserId: "user-4",
        text: "thread-only after canonicalization",
      },
    ] as const;
    const channel = new FakeFeishuChannel("feishu-main");
    const ingress = createIngress();
    await ingress.registerChannel(channel);

    await channel.emitInbound(inboundMessages[0]);
    await channel.emitInbound(inboundMessages[1]);
    await ingress.waitForIdle();

    const splitSessionRows = database.db
      .select()
      .from(sessions)
      .all();
    expect(splitSessionRows).toHaveLength(2);
    const sourceSessionId = splitSessionRows.find(
      (row) => row.thread_key === "thread-1",
    )?.id;
    const groupSessionId = splitSessionRows.find(
      (row) => row.thread_key === null,
    )?.id;
    expect(sourceSessionId).toBeDefined();
    expect(groupSessionId).toBeDefined();

    await channel.emitInbound(inboundMessages[2]);
    await channel.emitInbound(inboundMessages[3]);
    await ingress.waitForIdle();

    const sessionRows = database.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(2);
    const threadSession = sessionRows.find(
      (row) => row.thread_key === "thread-1",
    );
    const groupSession = sessionRows.find(
      (row) => row.id === groupSessionId,
    );
    expect(threadSession).toMatchObject({
      root_message_key: "message-root-1",
      thread_key: "thread-1",
    });
    expect(groupSession).toMatchObject({
      root_message_key: null,
      thread_key: null,
    });

    const timeline = new SessionTimelineReader(database.db);
    expect(timeline.listForSession(groupSession!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "message-root-1" }),
        }),
      ]),
    );
    expect(timeline.listForSession(threadSession!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "reference" }),
          message: expect.objectContaining({ externalMessageId: "message-root-1" }),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "message-thread-1" }),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({
            externalMessageId: "message-root-thread-3",
          }),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ entryKind: "message" }),
          message: expect.objectContaining({ externalMessageId: "message-thread-4" }),
        }),
      ]),
    );

    const runnerRows = database.db.select().from(runnerContexts).all();
    expect(runnerRows).toHaveLength(2);
    expect(new Set(runnerRows.map((row) => row.owner_id))).toEqual(
      new Set(sessionRows.map((row) => row.id)),
    );

    const sqlite = new SQLiteDatabase(join(testHome, "data", "luna.db"), {
      readonly: true,
    });
    try {
      const aliasRows = sqlite
        .query<{ session_id: string }, []>(
          "SELECT session_id FROM session_surface_aliases",
        )
        .all();
      expect(aliasRows).toHaveLength(3);
      expect(threadSession).toBeDefined();
      expect(aliasRows.map((row) => row.session_id)).toContain(
        threadSession!.id,
      );
    } finally {
      sqlite.close();
    }
  });

  test("session merge moves session-owned context packs to canonical session", () => {
    database.db
      .insert(sessions)
      .values([
        {
          id: "session_merge_source",
          surface_key: "feishu:session-merge-source",
          channel_type: "feishu",
          channel_id: "feishu-main",
          group_id: "group-alpha",
          thread_key: "thread-merge",
          root_message_key: null,
          title: "source",
          created_at: 1000,
          updated_at: 1000, ...fixtureSessionOwnership(database.db,"feishu","feishu-main")},
        {
          id: "session_merge_canonical",
          surface_key: "feishu:session-merge-canonical",
          channel_type: "feishu",
          channel_id: "feishu-main",
          group_id: "group-alpha",
          thread_key: "thread-merge",
          root_message_key: "root-merge",
          title: "canonical",
          created_at: 900,
          updated_at: 900, ...fixtureSessionOwnership(database.db,"feishu","feishu-main")},
      ])
      .run();
    const message = new MessageStore(database.db).append({
      sessionId: "session_merge_source", senderUserId: "fixture-owner", role: "user", content: {text: "context"},
    });
    const entry = database.db.select().from(sessionTimelineEntries).where(eq(sessionTimelineEntries.messageId, message.id)).get()!;
    const contextPackStore = new ContextPackStore(database.db);
    const pack = contextPackStore.createPack({
      ownerType: "session",
      ownerId: "session_merge_source",
      kind: "group_activation",
      selectionStrategy: "deterministic_window",
      triggerEntryId: entry.id,
      triggerMessageId: message.id,
    });
    contextPackStore.addItems(pack.id, [
      {
        itemKind: "timeline_entry",
        itemId: entry.id,
        sourceSessionId: "session_merge_source",
        sourceEntryId: entry.id,
        sourceMessageId: message.id,
        role: "delta_context",
        reason: "group activation context",
      },
    ]);

    (
      new SessionStore(database.db) as unknown as {
        _mergeSessionIntoCanonical: (
          db: typeof database.db,
          sourceSessionId: string,
          canonicalSessionId: string,
        ) => void;
      }
    )._mergeSessionIntoCanonical(
      database.db,
      "session_merge_source",
      "session_merge_canonical",
    );

    expect(
      contextPackStore.listPacksForOwner("session", "session_merge_source"),
    ).toEqual([]);
    const canonicalPacks = contextPackStore.listPacksForOwner(
      "session",
      "session_merge_canonical",
    );
    expect(canonicalPacks).toEqual([
      expect.objectContaining({
        id: pack.id,
        ownerType: "session",
        ownerId: "session_merge_canonical",
        kind: "group_activation",
      }),
    ]);
    expect(contextPackStore.listItemsForPack(pack.id)).toEqual([
      expect.objectContaining({
        sourceSessionId: "session_merge_canonical",
        sourceEntryId: entry.id,
        sourceMessageId: message.id,
      }),
    ]);
  });

  test("current runtime rejects task1 database without compatibility migration", async () => {
    database.close();
    rmSync(join(testHome, "data"), { recursive: true, force: true });
    mkdirSync(join(testHome, "data"), { recursive: true });
    _createTask1LunaDatabase(join(testHome, "data", "luna.db"));

    expect(() => new DataConnection(lunaSchema)).toThrow(
      "database_baseline_mismatch",
    );
  });
});

function createIngress(
  actions: readonly TestMainPlan[] = [
    {
      operation: "message.send",
      reply: "Luna received your message.",
      reason: "ordinary",
    },
  ],
): LunaMessageIngress {
  return new LunaMessageIngress({
    db: database.db,
    runnerType: "mock",
    mainRunner: new ScriptedMainRunner(actions).asMainRunner(),
    sessionConfig: fastSessionConfig,
  });
}

function fakeInbound(input: {
  readonly id: string;
  readonly text: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly senderUserId?: string;
}): InboundChannelMessage {
  return {
    id: input.id,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "group-alpha",
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    rootMessageId: input.rootMessageId ?? input.id,
    senderUserId: input.senderUserId ?? "user-1",
    text: input.text,
  };
}

function fakeNormalizedInbound(input: {
  readonly id: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly surfaceExternalId: string;
  readonly surfaceKind: NormalizedInboundMessage["surface"]["kind"];
  readonly senderExternalId: string;
  readonly text: string;
}): NormalizedInboundMessage {
  return {
    id: input.id,
    channel: {
      type: input.channelType,
      id: input.channelId,
    },
    surface: {
      externalId: input.surfaceExternalId,
      kind: input.surfaceKind,
    },
    sender: {
      externalId: input.senderExternalId,
      kind: "user",
    },
    text: input.text,
    mentions: [],
    addressing: {
      addressedToBot: true,
      reason: "p2p",
    },
    rawPayload: {
      testPayload: true,
    },
  };
}

function messageTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return "";
      }
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function textFromUserMessage(message: UserMessage): string {
  return messageTextContent(message.content);
}

function extractMainRunnerTurnInputJson(prompt: string): {
  readonly context: {
    readonly launchSeed?: {
      readonly items: readonly { readonly text: string }[];
    };
  };
  readonly orderedMessages: readonly { readonly text: string }[];
} {
  const block = (tag: string) => prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];
  const messages = block("messages");
  expect(messages).toBeString();
  const history = block("history");
  return {
    context: { launchSeed: history ? JSON.parse(history).launchSeed : undefined },
    orderedMessages: JSON.parse(messages!).items,
  } as {
    readonly context: {
      readonly launchSeed?: {
        readonly items: readonly { readonly text: string }[];
      };
    };
    readonly orderedMessages: readonly { readonly text: string }[];
  };
}

function turnIdForExternalMessage(externalMessageId: string): string {
  const messageId = messageIdForExternalMessage(externalMessageId);
  const inboxRow = database.db
    .select()
    .from(sessionInbox)
    .where(eq(sessionInbox.message_id, messageId))
    .get();
  expect(inboxRow?.turn_id).toBeString();
  return inboxRow!.turn_id!;
}

function messageIdForExternalMessage(externalMessageId: string): string {
  const message = database.db
    .select()
    .from(messages)
    .where(eq(messages.externalMessageId, externalMessageId))
    .get();
  expect(message).toBeDefined();
  return message!.id;
}

class ScriptedMainRunner {
  readonly calls: MainRunnerRunInput[] = [];
  private _nextAction = 0;

  constructor(private readonly _actions: readonly TestMainPlan[]) {}

  async run(input: MainRunnerRunInput): Promise<TestMainPlan> {
    this.calls.push(input);
    const action = this._actions[this._nextAction] ?? this._actions.at(-1);
    this._nextAction += 1;
    if (action === undefined) {
      throw new Error("ScriptedMainRunner has no action to return.");
    }
    return action;
  }

  asMainRunner(): MainRunner {
    return this as unknown as MainRunner;
  }
}

class StreamScriptedAgentRunner implements AgentRunner {
  readonly type = "mock";
  readonly calls: Array<{
    readonly userMessage: UserMessage;
    readonly options: AgentRunOptions;
  }> = [];
  private _nextOutput = 0;

  constructor(private readonly _outputs: readonly string[]) {}

  async *stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    this.calls.push({ userMessage, options });
    yield {
      id: `runner-session-${this.calls.length}`,
      session_id: userMessage.session_id,
      role: "system" as const,
      subtype: "init" as const,
    };
    const text = this._outputs[this._nextOutput] ?? this._outputs.at(-1);
    this._nextOutput += 1;
    if (text === undefined) {
      throw new Error("StreamScriptedAgentRunner has no output to return.");
    }
    yield {
      id: `assistant-${this.calls.length}`,
      session_id: userMessage.session_id,
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
    };
  }
}

class StaleResumeAgentRunner implements AgentRunner {
  readonly type = "mock";
  readonly calls: Array<{
    readonly userMessage: UserMessage;
    readonly options: AgentRunOptions;
  }> = [];
  private _attempt = 0;

  constructor(private readonly _recoveryOutput: string) {}

  async *stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    this.calls.push({ userMessage, options });
    this._attempt += 1;
    if (this._attempt === 1) {
      options.invalidateRunnerSession?.();
      return;
    }
    yield {
      id: `runner-session-${this.calls.length}`,
      session_id: userMessage.session_id,
      role: "system" as const,
      subtype: "init" as const,
    };
    yield {
      id: `assistant-${this.calls.length}`,
      session_id: userMessage.session_id,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: this._recoveryOutput }],
    };
  }
}

class ThrowingAgentRunner implements AgentRunner {
  readonly type = "mock";

  constructor(private readonly _message: string) {}

  async *stream(): AsyncIterableIterator<
    SystemMessage | AssistantMessage | ToolMessage
  > {
    throw new Error(this._message);
  }
}

class FlakyAgentRunner implements AgentRunner {
  readonly type = "mock";
  readonly calls: Array<{
    readonly userMessage: UserMessage;
    readonly options: AgentRunOptions;
  }> = [];
  private _nextResult = 0;

  constructor(private readonly _results: readonly (string | Error)[]) {}

  async *stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage> {
    this.calls.push({ userMessage, options });
    const result = this._results[this._nextResult] ?? this._results.at(-1);
    this._nextResult += 1;
    if (result === undefined) {
      throw new Error("FlakyAgentRunner has no result to return.");
    }
    if (result instanceof Error) {
      throw result;
    }
    yield {
      id: `runner-session-${this.calls.length}`,
      session_id: userMessage.session_id,
      role: "system" as const,
      subtype: "init" as const,
    };
    yield {
      id: `assistant-${this.calls.length}`,
      session_id: userMessage.session_id,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: result }],
    };
  }
}

class DynamicMainRunner {
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seedTaskForSession(input: {
  readonly taskId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: string;
}): void {
  const now = Date.now();
  const ownership = fixtureTaskOwnership(database.db, input.sessionId);
  // The creator is a user of the task's Agent.
  fixtureUser(database.db, ownership.agent_id, "user-1");
  database.db
    .insert(tasks)
    .values({
      id: input.taskId,
      type: "task",
      status: input.status,
      priority: "medium",
      severity: null,
      title: input.title,
      summary: input.summary,
      creator_user_id: "user-1",
      context_json: {
        latestUserMessage: input.summary,
        knownFacts: [],
        pendingQuestions: [],
      },
      created_at: now,
      updated_at: now,
      last_activity_at: now, ...ownership})
    .run();
}

function isVisibleAssistant(rawPayload: unknown): boolean {
  return rawPayloadMatches(rawPayload, { deliveryStatus: "sent" });
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

function _createTask1LunaDatabase(dbPath: string): void {
  const sqlite = new SQLiteDatabase(dbPath, { create: true });
  try {
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run(`
      CREATE TABLE __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    sqlite
      .query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("task1-0010-already-applied", 1773500100000);
    sqlite.run(`
      CREATE TABLE sessions (
        id text PRIMARY KEY NOT NULL,
        channel_type text NOT NULL,
        channel_id text NOT NULL,
        group_id text,
        thread_id text,
        root_message_id text,
        title text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `);
    sqlite.run(`
      CREATE TABLE messages (
        id text PRIMARY KEY NOT NULL,
        session_id text NOT NULL,
        channel_message_key text,
        sender_user_id text,
        role text NOT NULL,
        content text NOT NULL,
        raw_payload_json text,
        created_at integer NOT NULL
      )
    `);
    sqlite.run(`
      CREATE TABLE work_contexts (
        id text PRIMARY KEY NOT NULL,
        kind text NOT NULL,
        workflow text NOT NULL,
        session_id text,
        task_id text,
        status text NOT NULL,
        runner_context_id text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `);
    sqlite.run(`
      CREATE TABLE runner_contexts (
        id text PRIMARY KEY NOT NULL,
        owner_type text NOT NULL,
        owner_id text NOT NULL,
        runner_type text NOT NULL,
        runner_session_id text,
        instruction_fingerprint text,
        runner_root_path text NOT NULL,
        last_run_id text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `);
    sqlite.run(`
      CREATE TABLE tasks (
        id text PRIMARY KEY NOT NULL,
        work_context_id text,
        queue_key text NOT NULL,
        type text NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        payload text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `);
    sqlite.run(`
      CREATE TABLE scheduled_tasks (
        id text PRIMARY KEY NOT NULL,
        work_context_id text,
        instruction text NOT NULL,
        schedule text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `);
    sqlite
      .query(
        `INSERT INTO sessions (
          id,
          channel_type,
          channel_id,
          group_id,
          thread_id,
          root_message_id,
          title,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-old-1",
        "feishu",
        "feishu-main",
        "group-alpha",
        null,
        "message-root-1",
        null,
        1,
        1,
      );
  } finally {
    sqlite.close();
  }
}

test("failed redelivery invokes Main without creating tasks", async () => {
  const channel = new FakeFeishuChannel("feishu-main");
  let calls = 0;
  const mainRunner = {async run() {
    calls++;
    if (calls === 1) throw new Error("provider unavailable");
    return {status: "completed", followupReleased: false};
  }} as unknown as MainRunner;
  const router = new SessionInboundRouter({db: database.db, channel, runnerType: "mock", mainRunner, sessionConfig: fastSessionConfig});
  const inbound = fakeInbound({id: "historical-action-redelivery", text: "process this"});
  await router.routeDirectInboundForTest(inbound);
  await router.waitForIdle();
  const message = database.db.select().from(messages).where(eq(messages.externalMessageId, inbound.id)).get()!;
  const inbox = database.db.select().from(sessionInbox).get()!;
  expect(inbox.status).toBe("failed");
  await router.routeDirectInboundForTest(inbound);
  await router.waitForIdle();
  expect(calls).toBe(2);
  expect(database.db.select().from(tasks).all()).toEqual([]);
  expect(channel.outbound).toEqual([]);
  expect(database.db.select().from(sessionInbox).get()?.status).toBe("completed");
});
