import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { NormalizedInboundMessage } from "../../src/channels";
import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import {
  messages,
  sessions,
  sessionInbox,
  sessionTimelineEntries,
  sessionTurns,
} from "../../src/data/schema";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionQueue } from "../../src/sessions/session-queue";
import { config, setLunaHome, type SessionConfig } from "../../src/shared";
import { WorkSessionLauncher } from "../../src/work/work-session-launcher";
import { WorkRunner } from "../../src/work/work-runner";
import { SessionTurnProcessor, SessionInboundRouter } from "../../src/sessions/inbound/session-inbound-router";
import type { OutboundChannelOperation } from "../../src/channels/outbound";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { InboundCommandRouter } from "../../src/messaging/gateway/inbound-command-router";

import { fixtureObserveFeishuSender, fixtureFeishuSender, fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

const sessionConfig: SessionConfig = {
  coalesce_idle_ms: 1, coalesce_max_wait_ms: 25, max_batch_size: 8,
  stale_claim_ms: 120000,
  activation_context_window_ms: 300000, activation_context_max_messages: 12,
  activation_context_max_chars: 6000, activation_context_recent_unprocessed_messages: 10,
  group_bot_aliases: [],
  group_activation_followup_window_ms: 300000,
  group_activation_followup_senders: "requester_and_reporters",
  group_activation_followup_max_messages: 8,
  group_activation_followup_recent_messages: 3,
  group_activation_followup_interrupt_on_other_user: true,
} as SessionConfig;

class ProcessingReactionFakeFeishuChannel extends FakeFeishuChannel {
  readonly processingMessageIds = new Set<string>();

  override async beginProcessing(inbound: NormalizedInboundMessage): Promise<void> {
    this.processingMessageIds.add(inbound.id);
  }

  override async completeProcessing(inbound: NormalizedInboundMessage): Promise<void> {
    this.processingMessageIds.delete(inbound.id);
  }

  override async send(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation> {
    try {
      return await super.send(inbound, operation);
    } finally {
      this.processingMessageIds.delete(inbound.id);
    }
  }
}

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-work-e2e-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  const owner = "work-fixture-owner";
  fixtureSessionOwnership(database.db, "feishu", "feishu-main", owner);
  for (const sender of ["user-e2e", "user-reaction", "user-steer", "user-work"]) {
    fixtureObserveFeishuSender(database.db, "feishu-main", sender);
  }
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("work session end-to-end", () => {
  test("coalesced work-session messages clear every processing reaction", async () => {
    const channel = new ProcessingReactionFakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);
    let runAgentCalls = 0;
    const workRunner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => {
        runAgentCalls += 1;
        return "完成";
      },
    });
    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: {
        startInitialRun: () => {},
        restartTaskRun: () => {},
        waitForIdle: async () => {},
      } as never,
    });
    const queue = new SessionQueue({
      db: database.db,
      config: {
        ...sessionConfig,
        coalesce_idle_ms: 50,
        coalesce_max_wait_ms: 100,
      },
      executeTurn: (input, signal) => processor.execute(input, signal),
    });
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore,
      messageStore,
      inboxStore,
      schedule: (id) => queue.schedule(id),
    });

    await launcher.handleWorkCommand({
      id: "msg-reaction-root",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-reaction", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-reaction"),
      text: "#work 开始",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });
    await queue.waitForIdle();

    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      sessionQueue: queue,
    });
    const routeFollowup = (id: string, text: string) => router.route({
      id,
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-reaction", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-reaction"),
      text,
      thread: {
        externalId: "msg-reaction-root",
        rootMessageExternalId: "msg-reaction-root",
      },
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });
    await Promise.all([
      routeFollowup("msg-reaction-first", "第一条"),
      routeFollowup("msg-reaction-second", "第二条"),
    ]);
    await queue.waitForIdle();

    expect(runAgentCalls).toBe(2);
    expect([...channel.processingMessageIds]).toEqual([]);
  });

  test("inbound command router lets #steer continue to the session inbound router", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const router = new InboundCommandRouter({
      db: database.db,
      channel,
    });

    const handled = await router.handle({
      id: "msg-steer-command-router-1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-steer", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-steer"),
      text: "#steer 改成 TypeScript",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });

    expect(handled).toBe(false);
    expect(channel.outbound).not.toContainEqual(
      expect.objectContaining({
        content: "Unknown system command: #steer",
      }),
    );
  });

  test("inbound command router handles mentioned group #work", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    let scheduled: string | undefined;
    const router = new InboundCommandRouter({
      db: database.db,
      channel,
      schedule: (sessionId) => {
        scheduled = sessionId;
      },
    });

    const handled = await router.handle({
      id: "msg-mentioned-work-command-router-1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-work", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-work"),
      text: "@Luna #work 改成 TypeScript",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });

    expect(handled).toBe(true);
    const workSession = database.db
      .select()
      .from(sessions)
      .where(eq(sessions.kind, "work"))
      .get();
    expect(workSession).toBeDefined();
    expect(scheduled).toBe(workSession!.id);
    expect(channel.outbound).toHaveLength(0);
  });

  test("#work → work session → turn → work runner → status card", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);

    const workRunner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => "已完成 Hello World 函数",
    });

    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: { startInitialRun: () => {}, restartTaskRun: () => {}, waitForIdle: async () => {} } as never,
    });

    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: (input, signal) => processor.execute(input, signal),
    });

    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore,
      messageStore,
      inboxStore,
      schedule: (id) => queue.schedule(id),
    });

    // Step 1: #work creates work session
    await launcher.handleWorkCommand({
      id: "msg-e2e-1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-e2e", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-e2e"),
      text: "#work 帮我写一个 hello world 函数",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });

    // Step 2: wait for turn to complete
    await queue.waitForIdle();

    // Step 3: verify outbound messages
    // Expected: WorkRunner creates a non-empty status card immediately, then
    // updates the same card with the final result.
    expect(channel.outbound.length).toBeGreaterThanOrEqual(2);

    const statusCardOperations = channel.outbound.filter(
      (o) =>
        o.replyMode === "reply_in_thread" ||
        o.replyMode === "channel_message" ||
        o.replyMode === "update_status_card",
    );
    const emptyProcessingCards = statusCardOperations.filter(
      (o) =>
        o.statusCardState === "active" &&
        o.content === "正在处理…" &&
        (o.statusCardSteps === undefined || o.statusCardSteps.length === 0),
    );
    expect(emptyProcessingCards).toHaveLength(0);

    const cardsWithSteps = statusCardOperations.filter(
      (o) => o.statusCardSteps !== undefined && o.statusCardSteps.length > 0,
    );
    expect(cardsWithSteps).toHaveLength(2);
    expect(cardsWithSteps[0]!.statusCardState).toBe("active");
    expect(cardsWithSteps[0]!.replyMode).toBe("reply_in_thread");
    expect(cardsWithSteps[0]!.targetMessageId).toBe("msg-e2e-1");
    expect(cardsWithSteps[0]!.threadId).toBe("msg-e2e-1");
    expect(cardsWithSteps[0]!.rootMessageId).toBe("msg-e2e-1");
    expect(cardsWithSteps[0]!.statusCardSteps).toEqual(["工作会话执行已开始。"]);

    const finalCard = statusCardOperations.at(-1)!;
    expect(finalCard.replyMode).toBe("update_status_card");
    expect(finalCard.targetMessageId).toBeDefined();
    expect(finalCard.content).toBe("执行完成，答复已提交投递。");
    expect(finalCard.statusCardSteps).toEqual(["工作会话执行已开始。"]);

    const workSession = database.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.kind, "work"))
      .get();
    expect(workSession).toBeDefined();
    const rootSession = database.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.kind, "main"))
      .get();
    expect(rootSession).toBeDefined();

    const persistedCards = database.db
      .select({ message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(and(
        eq(sessionTimelineEntries.sessionId, workSession!.id),
        eq(messages.role, "assistant"),
        eq(messages.presentationKind, "status_card"),
      ))
      .orderBy(messages.occurredAt)
      .all()
      .map((row) => row.message);

    expect(persistedCards).toHaveLength(1);
    const persistedFinalCard = persistedCards[0];
    expect(persistedFinalCard).toBeDefined();
    expect(persistedFinalCard!.contentKind).toBe("card");
    expect(persistedFinalCard!.providerMessageType).toBe("interactive");
    expect(persistedFinalCard!.contentJson).toEqual([{
      type: "card",
      cardKind: "status_card",
      presentationKind: "status_card",
      title: "工作会话",
      text: "执行完成，答复已提交投递。",
      steps: ["工作会话执行已开始。"],
      payload: {
        status: "completed",
        steps: [{ name: "工作会话执行已开始。", status: "done" }],
      },
    }]);
    expect(database.db
      .select()
      .from(sessionTimelineEntries)
      .where(eq(sessionTimelineEntries.messageId, persistedFinalCard!.id))
      .all()
      .map((entry) => ({
        sessionId: entry.sessionId,
        entryKind: entry.entryKind,
      }))).toEqual(expect.arrayContaining([
        { sessionId: workSession!.id, entryKind: "message" },
      { sessionId: rootSession!.id, entryKind: "reference" },
    ]));
  });

  test("#work mention anchors group follow-up messages in the work thread", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);
    let runAgentCalls = 0;

    const workRunner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => {
        runAgentCalls += 1;
        return runAgentCalls === 1 ? "先查广州" : "改查北京";
      },
    });

    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: { startInitialRun: () => {}, restartTaskRun: () => {}, waitForIdle: async () => {} } as never,
    });
    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: (input, signal) => processor.execute(input, signal),
    });
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore,
      messageStore,
      inboxStore,
      schedule: (id) => queue.schedule(id),
    });

    await launcher.handleWorkCommand({
      id: "msg-work-followup-root",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-work-followup", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-work"),
      text: "#work @Luna 查广州天气",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });
    await queue.waitForIdle();

    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      sessionQueue: queue,
    });
    await router.route({
      id: "msg-work-followup-1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-work-followup", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-work"),
      text: "查北京的",
      thread: {
        externalId: "msg-work-followup-root",
        rootMessageExternalId: "msg-work-followup-root",
        parentMessageExternalId: "msg-work-followup-root",
      },
      mentions: [],
      addressing: { addressedToBot: false, reason: "silent_group" },
      rawPayload: {},
    });
    await queue.waitForIdle();

    expect(runAgentCalls).toBe(2);
    expect(channel.outbound).toContainEqual(
      expect.objectContaining({
        content: "执行完成，答复已提交投递。",
      }),
    );

    const followupMessage = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "msg-work-followup-1"))
      .get();
    expect(followupMessage).toBeDefined();
    expect(followupMessage!.rawPayloadJson).toMatchObject({
      addressing: {
        addressedToBot: true,
        reason: "activation_followup",
      },
      activationFollowup: {
        sessionSourceMessageId: "msg-work-followup-root",
        followupCount: 0,
      },
    });

    const followupInbox = database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.message_id, followupMessage!.id))
      .get();
    expect(followupInbox).toBeDefined();
    const followupTurn = database.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.id, followupInbox!.turn_id!))
      .get();
    expect(followupTurn).toMatchObject({
      turn_kind: "execution",
      runner_invoked: true,
    });
  });

  test("#steer aborts active work turn", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);

    let runAgentCalled = false;
    const workRunner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async ({ signal }) => {
        runAgentCalled = true;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return "{}";
      },
    });

    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: { startInitialRun: () => {}, restartTaskRun: () => {}, waitForIdle: async () => {} } as never,
    });

    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: (input, signal) => processor.execute(input, signal),
    });

    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore,
      messageStore,
      inboxStore,
      schedule: (id) => queue.schedule(id),
    });

    // Create work session and start turn
    await launcher.handleWorkCommand({
      id: "msg-steer-1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-steer", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-steer"),
      text: "#work 长时间任务",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });

    // Wait for turn to start
    await new Promise((r) => setTimeout(r, 50));
    expect(runAgentCalled).toBe(true);

    // Abort

    // Find the work session and abort it
    const { eq } = await import("drizzle-orm");
    const { sessions } = await import("../../src/data/schema");
    const workSession = database.db.select().from(sessions).where(eq(sessions.kind, "work")).get()!;
    queue.abort(workSession.id);

    await queue.waitForIdle().catch(() => {});

    // Should have a cancelled status card
    const cancelledCards = channel.outbound.filter(
      (o) => o.content === "已通过 #steer 取消",
    );
    expect(cancelledCards.length).toBe(1);
  });

  test("#steer is a control message and lets the next pending work turn run", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const inboxStore = new SessionInboxStore(database.db);

    let runAgentCalls = 0;
    let firstTurnStarted!: () => void;
    const firstTurnStartedPromise = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });
    const workRunner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async ({ signal }) => {
        runAgentCalls += 1;
        if (runAgentCalls > 1) {
          return "下一条真正需求已执行";
        }
        firstTurnStarted();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return "{}";
      },
    });

    const processor = new SessionTurnProcessor({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      workRunner,
      mainRunner: { run: async () => ({ action: { action: "no_reply" } }) } as never,
      taskRunSupervisor: { startInitialRun: () => {}, restartTaskRun: () => {}, waitForIdle: async () => {} } as never,
    });

    const queue = new SessionQueue({
      db: database.db,
      config: sessionConfig,
      executeTurn: (input, signal) => processor.execute(input, signal),
    });

    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore,
      messageStore,
      inboxStore,
      schedule: (id) => queue.schedule(id),
    });
    await launcher.handleWorkCommand({
      id: "msg-steer-control-root",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-steer-control", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-steer"),
      text: "#work 长时间任务",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });
    await firstTurnStartedPromise;

    const router = new SessionInboundRouter({
      db: database.db,
      channel,
      runnerType: "mock",
      sessionQueue: queue,
    });
    await router.route({
      id: "msg-steer-control-next",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-steer-control", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-steer"),
      text: "下一条真正需求",
      thread: {
        externalId: "msg-steer-control-root",
        rootMessageExternalId: "msg-steer-control-root",
      },
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });
    const steer: NormalizedInboundMessage = {
      id: "msg-steer-control-2",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-steer-control", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-steer"),
      text: "#steer 改成 TypeScript",
      thread: {
        externalId: "msg-steer-control-root",
        rootMessageExternalId: "msg-steer-control-root",
      },
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    };

    expect(channel.outbound.some(operation => operation.content === "已通过 #steer 取消")).toBe(false);
    await router.route(steer);

    await queue.waitForIdle();

    expect(runAgentCalls).toBe(2);
    expect(channel.outbound).toContainEqual(
      expect.objectContaining({
        content: "执行完成，答复已提交投递。",
      }),
    );
    expect(channel.outbound).not.toContainEqual(
      expect.objectContaining({
        content: "不应通过 #steer 产生新状态卡",
      }),
    );

    const steerMessage = database.db
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, "msg-steer-control-2"))
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
      .where(and(
        eq(sessionTurns.session_id, database.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.kind, "work"))
          .get()!.id),
        eq(sessionTurns.reason, "steer_control"),
      ))
      .all()).toHaveLength(1);
  });
});
