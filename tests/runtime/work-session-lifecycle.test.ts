import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import {
  messages,
  managedArtifacts,
  runnerContexts,
  sessionRunnerAttempts,
  sessions,
  sessionTimelineEntries,
  sessionCommands,
  channelUserBindings,
  users,
} from "../../src/data/schema";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";
import { sessionCommandsFor } from "../../src/messaging/session-command-service";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { MessageStore } from "../../src/sessions/message-store";
import { runnerContextFilePath } from "../../src/runners/runner-context-file";
import { SessionTurnStore } from "../../src/sessions/session-turn-store";
import { fixtureObserveFeishuSender, fixtureFeishuSender, fixtureSessionOwnership, fixtureUser } from "../helpers/platform-fixtures";
import { config, setLunaHome } from "../../src/shared";
import { WorkSessionLauncher } from "../../src/work/work-session-launcher";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";

let testHome: string;
let previousHome: string;
let database: DataConnection<typeof lunaSchema>;
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-work-lifecycle-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  // "u1" owns the Agent; the channel sender "u1" in these turns is a human user of that Agent.
  const ownership = fixtureSessionOwnership(database.db, "feishu", "feishu-main", "u1");
  fixtureUser(database.db, ownership.agent_id, "u1");
  fixtureObserveFeishuSender(database.db, "feishu-main", "user-1");
});

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete Bun.env[key];
      delete process.env[key];
    } else {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
  previousEnv.clear();
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("work session lifecycle", () => {
  test("#work creates session that stays active (no explicit close)", async () => {
    const channel = new FakeFeishuChannel("feishu-main");
    const launcher = new WorkSessionLauncher({
      db: database.db,
      channel,
      sessionStore: new SessionStore(database.db),
      messageStore: new MessageStore(database.db),
      inboxStore: new SessionInboxStore(database.db),
      schedule: () => {},
    });

    await launcher.handleWorkCommand({
      id: "msg-1",
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "group-1", kind: "group" },
      sender: fixtureFeishuSender("feishu-main", "user-1"),
      text: "#work 实现登录页面",
      mentions: [],
      addressing: { addressedToBot: true, reason: "mention" },
      rawPayload: {},
    });

    const workSession = database.db.select().from(sessions).where(eq(sessions.kind, "work")).get()!;
    expect(workSession.status).toBe("active");
    expect(workSession.kind).toBe("work");
    expect(workSession.thread_key).toBe("msg-1");
  });

  test("work runner delivers final output with a canonical sender and no identity link", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const delivery = sessionCommandsFor(database.db, () => channel);
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g1", threadId: "t1", rootMessageId: "t1",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => "这不是JSON，是纯文本回复",
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-1", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-1", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-1", channelMessageKey: "msg-1", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "做个功能" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-1", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "做个功能" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    const commands = database.db.select().from(sessionCommands).where(eq(sessionCommands.originId, "turn-1")).all();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ actorUserId: "u1", payload: { content: "这不是JSON，是纯文本回复", purpose: "answer" } });

    // WorkRunner immediately creates a non-empty status card, then updates it
    // with the final result.
    expect(channel.outbound).toHaveLength(2);
    expect(channel.outbound[0]!.statusCardState).toBe("active");
    expect(channel.outbound[0]!.statusCardSteps).toEqual(["工作会话执行已开始。"]);
    const lastOutbound = channel.outbound.at(-1)!;
    expect(lastOutbound.content).toBe("执行完成，答复已提交投递。");
    expect(lastOutbound.replyMode).toBe("update_status_card");
    expect(lastOutbound.statusCardSteps).toEqual(["工作会话执行已开始。"]);

    const attempts = database.db
      .select()
      .from(sessionRunnerAttempts)
      .where(eq(sessionRunnerAttempts.turnId, "turn-1"))
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("parsed");
    expect(attempts[0]!.parsedActionJson).toMatchObject({
      title: "工作会话",
      status: "completed",
      summary: "执行完成，答复已提交投递。",
    });
    await delivery.waitForIdle();
    expect(channel.outbound.filter(row => row.content === "这不是JSON，是纯文本回复")).toHaveLength(1);
    const { finalizeRunnerReply } = await import("../../src/messaging/runner-answer");
    finalizeRunnerReply(database.db, { sessionId: session.id, originId: "turn-1", actorUserId: "u1", text: "这不是JSON，是纯文本回复", allowSilent: false });
    await delivery.waitForIdle();
    expect(channel.outbound.filter(row => row.content === "这不是JSON，是纯文本回复")).toHaveLength(1);
    await delivery.stop();
  });

  test("work runner persists the final card when its provider update fails", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const originalSend = channel.send.bind(channel);
    let sendCount = 0;
    channel.send = async (inbound, operation) => {
      sendCount += 1;
      if (sendCount === 2) {
        throw new Error("The socket connection was closed unexpectedly");
      }
      return originalSend(inbound, operation);
    };
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g1", threadId: "t1",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => "最终正文",
    });

    await runner.executeWorkTurn({
      turn: {
        id: "turn-provider-update-failed",
        sessionId: session.id,
        status: "running",
        startedAt: Date.now(),
      } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-provider-update-failed", sessionId: session.id,
        channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-provider-update-failed",
        channelMessageKey: "msg-provider-update-failed", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "返回结果" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-provider-update-failed", sender_user_id: "u1",
        message_kind: "user_message", content_json: [{ type: "text", text: "返回结果" }],
        raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    const persistedCard = database.db
      .select()
      .from(messages)
      .where(and(
        eq(messages.channelId, "feishu-main"),
        eq(messages.presentationKind, "status_card"),
      ))
      .get();
    expect(persistedCard?.contentJson).toEqual([expect.objectContaining({
      type: "card",
      text: "执行完成，答复已提交投递。",
      payload: expect.objectContaining({ status: "completed" }),
    })]);
  });

  test("work runner attaches status card output to the current turn", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const turnStore = new SessionTurnStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g-turn-output", threadId: "t-turn-output",
    });
    const triggerMessage = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "msg-turn-output",
      senderUserId: "u1",
      role: "user",
      content: [{ type: "text", text: "做个功能" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g-turn-output", kind: "group" },
      sender: { externalId: "u1", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    const triggerEntry = database.db
      .select()
      .from(sessionTimelineEntries)
      .where(and(
        eq(sessionTimelineEntries.sessionId, session.id),
        eq(sessionTimelineEntries.messageId, triggerMessage.id),
      ))
      .get()!;
    const turn = turnStore.createExecutionTurn({
      id: "turn-output",
      sessionId: session.id,
      triggerEntryId: triggerEntry.id,
      reason: "addressed",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => "完成",
    });

    await runner.executeWorkTurn({
      turn: { id: turn.id, sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [triggerMessage],
    }, session);

    const finalCardMessageId = database.db
      .select({ messageId: sessionTimelineEntries.messageId })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(and(
        eq(sessionTimelineEntries.sessionId, session.id),
        eq(messages.presentationKind, "status_card"),
      ))
      .get()?.messageId;
    expect(finalCardMessageId).toBeString();

    const turnEntries = turnStore.listEntries(turn.id);
    expect(turnEntries).toContainEqual(
      expect.objectContaining({
        role: "output",
      }),
    );
    const outputEntryIds = turnEntries
      .filter((entry) => entry.role === "output")
      .map((entry) => entry.entryId);
    const outputTimelineMessages = database.db
      .select({ messageId: sessionTimelineEntries.messageId })
      .from(sessionTimelineEntries)
      .where(and(
        eq(sessionTimelineEntries.sessionId, session.id),
        eq(sessionTimelineEntries.messageId, finalCardMessageId!),
      ))
      .all();
    expect(outputTimelineMessages).toHaveLength(1);
    const outputTimelineEntry = database.db
      .select()
      .from(sessionTimelineEntries)
      .where(and(
        eq(sessionTimelineEntries.sessionId, session.id),
        eq(sessionTimelineEntries.messageId, finalCardMessageId!),
      ))
      .get()!;
    expect(outputEntryIds).toContain(outputTimelineEntry.id);
  });

  test("work runner ignores model-authored final status card fields", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g2", threadId: "t2",
    });

    const oldStructuredPayload = {
      title: "实现功能X",
      status: "blocked",
      steps: [{ name: "分析", status: "done" }, { name: "实现", status: "done" }],
      summary: "完成了功能X",
    };

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => JSON.stringify(oldStructuredPayload),
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-2", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-2", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-2", channelMessageKey: "msg-2", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "做功能X" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-2", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "做功能X" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    const lastOutbound = channel.outbound.at(-1)!;
    expect(lastOutbound.content).toBe("执行完成，答复已提交投递。");
    expect(lastOutbound.statusCard?.title).toBe("工作会话");
    expect(lastOutbound.statusCard?.status).toBe("completed");
    expect(lastOutbound.statusCardSteps).toEqual(["工作会话执行已开始。"]);

    const attempts = database.db
      .select()
      .from(sessionRunnerAttempts)
      .where(eq(sessionRunnerAttempts.turnId, "turn-2"))
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("parsed");
    expect(attempts[0]!.inputPrompt).toContain("做功能X");
    expect(attempts[0]!.rawOutput).toContain("完成了功能X");
    expect(attempts[0]!.parsedActionJson).toMatchObject({
      title: "工作会话",
      status: "completed",
      summary: "执行完成，答复已提交投递。",
    });
  });

  test("work runner updates the in-progress status card with runner steps", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g-progress", threadId: "t-progress",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async ({ reportProgress }) => {
        const activeCardBeforeRunnerSteps = database.db
          .select({ message: messages })
          .from(sessionTimelineEntries)
          .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
          .where(and(
            eq(sessionTimelineEntries.sessionId, session.id),
            eq(messages.presentationKind, "status_card"),
          ))
          .get()?.message;
        expect(activeCardBeforeRunnerSteps?.contentJson).toMatchObject([{
          text: "",
          payload: {
            status: "in_progress",
          },
        }]);
        await reportProgress?.("Read file \"src/main.cpp\"");
        await reportProgress?.("<Bash> g++ hello_work.cpp -o hello_work");
        return "完成";
      },
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-progress", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-progress", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-progress", channelMessageKey: "msg-progress", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "写 hello work c++" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-progress", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "写 hello work c++" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    const emptyProcessingCards = channel.outbound.filter(
      (outbound) =>
        outbound.statusCardState === "active" &&
        outbound.content === "正在处理…" &&
        (outbound.statusCardSteps === undefined || outbound.statusCardSteps.length === 0),
    );
    expect(emptyProcessingCards).toHaveLength(0);

    const progressCards = channel.outbound.filter(
      (outbound) =>
        outbound.statusCardState === "active" &&
        outbound.statusCardSteps !== undefined &&
        outbound.statusCardSteps.length > 0,
    );
    expect(progressCards.every((outbound) => outbound.statusCard !== undefined)).toBe(true);
    expect(progressCards.every((outbound) => outbound.statusCard?.hideHeader === true)).toBe(true);
    expect(progressCards.length).toBeGreaterThanOrEqual(2);
    expect(progressCards.at(0)!.replyMode).toBe("reply_in_thread");
    expect(progressCards.at(0)!.targetMessageId).toBe("t-progress");
    expect(progressCards.at(0)!.threadId).toBe("t-progress");
    expect(progressCards.at(0)!.content).toBe("");
    expect(progressCards.at(0)!.statusCardSteps).toEqual([
      "工作会话执行已开始。",
    ]);
    expect(progressCards.at(-1)!.replyMode).toBe("update_status_card");
    expect(progressCards.at(-1)!.content).toBe("");
    expect(progressCards.at(-1)!.statusCardSteps).toEqual([
      "工作会话执行已开始。",
      "Read file \"src/main.cpp\"",
      "<Bash> g++ hello_work.cpp -o hello_work",
    ]);
    const finalUpdate = channel.outbound.at(-1)!;
    expect(finalUpdate.statusCardState).toBe("terminal");
    expect(finalUpdate.content).toBe("执行完成，答复已提交投递。");
    expect(finalUpdate.statusCard).toMatchObject({
      taskId: session.id,
      title: "工作会话",
      status: "completed",
    });
    expect(finalUpdate.statusCardSteps).toEqual([
      "工作会话执行已开始。",
      "Read file \"src/main.cpp\"",
      "<Bash> g++ hello_work.cpp -o hello_work",
    ]);
  });

  test("work runner updates progress from streamed assistant events", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g-stream", threadId: "t-stream",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      createRunner: () => ({
        type: "mock",
        async *stream() {
          yield {
            id: "assistant-progress-1",
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: "读取 src/main.cpp 完成\n\n<Bash> g++ hello_work.cpp -o hello_work",
            }],
          };
          yield {
            id: "assistant-final",
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: "完成",
            }],
          };
        },
      }),
    } as never);

    await runner.executeWorkTurn({
      turn: { id: "turn-stream-progress", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-stream-progress", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-stream-progress", channelMessageKey: "msg-stream-progress", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "写 hello work c++" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-stream-progress", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "写 hello work c++" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    const progressCards = channel.outbound.filter(
      (outbound) =>
        outbound.statusCardState === "active" &&
        outbound.statusCardSteps !== undefined &&
        outbound.statusCardSteps.length > 0,
    );
    expect(progressCards.at(0)?.replyMode).toBe("reply_in_thread");
    expect(progressCards.at(0)?.targetMessageId).toBe("t-stream");
    expect(progressCards.at(0)?.threadId).toBe("t-stream");
    expect(progressCards.at(-1)?.statusCardSteps).toEqual([
      "工作会话执行已开始。",
      "读取 src/main.cpp 完成\n<Bash> g++ hello_work.cpp -o hello_work",
    ]);
    expect(channel.outbound.at(-1)?.content).toBe("执行完成，答复已提交投递。");
  });

  test("work runner sends through its live service capability before exiting", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    setEnv("LUNA_SERVICE_URL", "http://luna.test:9000/");
    setEnv("LUNA_ACCESS_TOKEN_SECRET", "work-runner-service-secret");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "g-env",
      threadId: "t-env",
      rootMessageId: "t-env",
    });
    const sender = new ChannelDirectoryStore(database.db).upsertIdentity({
      channel: {type: "feishu", id: "feishu-main"},
      identity: {
        externalId: "ou_work_runner_env", kind: "user", displayName: "Work Runner User",
        ...feishuIdentityMetadata({environment: "feishu", appId: "test:feishu:feishu-main"}, {open_id: "ou_work_runner_env"}),
      },
    });
    const member = database.db.select().from(channelUserBindings)
      .where(eq(channelUserBindings.channelIdentityId, sender.id)).get()!;

    let capturedEnv: Record<string, string> | undefined;
    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      createRunner: () => ({
        type: "mock",
        async *stream(_message: never, options: { env?: Record<string, string> }) {
          capturedEnv = options.env;
          const { AccessTokenService } = await import("../../src/server/auth/access-token-service");
          const { RunnerMessageService } = await import("../../src/messaging/runner-message-service");
          const { sessionCommandsFor } = await import("../../src/messaging/session-command-service");
          const claims = new AccessTokenService({db: database.db, signingSecret: "work-runner-service-secret"})
            .verifyBearer(capturedEnv!.LUNA_ACCESS_TOKEN!, {now: Date.now()})!.claims;
          expect(claims.actorUserId).toBe(member.userId);
          const { startTestRunnerJob } = await import("./support/runner-job");
          const finish = startTestRunnerJob(database.db, capturedEnv!.LUNA_INVOCATION_ID!);
          await new RunnerMessageService(database.db, () => channel).send(claims, "answer-1", "Live Work answer", "answer");
          await sessionCommandsFor(database.db, () => channel).waitForIdle();
          expect(channel.outbound.some(row => row.content === "Live Work answer")).toBe(true);
          finish();
          yield {
            id: "assistant-final-env",
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                title: "env",
                status: "blocked",
                summary: "完成",
              }),
            }],
          };
        },
      }),
    } as never);

    await runner.executeWorkTurn({
      turn: { id: "turn-env", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-env", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-env", channelMessageKey: "msg-env", senderIdentityId: sender.id,
        senderUserId: member.userId, role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "写 hello work c++" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-env", sender_identity_id: sender.id,
        sender_user_id: member.userId, message_kind: "user_message",
        content_json: [{ type: "text", text: "写 hello work c++" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    expect(capturedEnv?.LUNA_SERVICE_URL).toBe("http://luna.test:9000");
    expect(capturedEnv?.LUNA_SESSION_ID).toBe(session.id);
    expect(capturedEnv?.LUNA_RUNNER_KIND).toBe("work");
    expect(capturedEnv?.LUNA_RUNNER_CONTEXT_ID).toBeString();
    const accessToken = capturedEnv?.LUNA_ACCESS_TOKEN;
    expect(accessToken).toBeString();
    expect(accessToken?.length).toBeGreaterThan(20);
    expect(channel.outbound.filter(row => row.content === "Live Work answer")).toHaveLength(1);
    expect(channel.outbound.at(-1)?.statusCard?.status).toBe("completed");
    expect(channel.outbound.at(-1)?.content).toBe("执行完成，答复已提交投递。");
    const { workInvocations } = await import("../../src/runners/main-invocation-registry");
    expect(workInvocations(database.db).size).toBe(0);
  });

  test("work runner does not publish or register terminal-only file references", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "g-artifact-preview",
      threadId: "t-artifact-preview",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      createRunner: () => ({
        type: "mock",
        async *stream(_message: never, options: { cwd: string }) {
          const workspacePath = join(options.cwd, "workspace");
          mkdirSync(workspacePath, { recursive: true });
          const imagePath = join(workspacePath, "sample-app-home.png");
          writeFileSync(
            imagePath,
            Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
          );
          yield {
            id: "assistant-final-artifact-preview",
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: `Raw Output\n![sample-app-home](${imagePath})`,
            }],
          };
        },
      }),
    } as never);

    await runner.executeWorkTurn({
      turn: {
        id: "turn-artifact-preview",
        sessionId: session.id,
        status: "running",
        startedAt: Date.now(),
      } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-artifact-preview", sessionId: session.id,
        channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-artifact-preview",
        channelMessageKey: "msg-artifact-preview", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "截图" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-artifact-preview", sender_user_id: "u1",
        message_kind: "user_message",
        content_json: [{ type: "text", text: "截图" }],
        raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    const artifact = database.db
      .select()
      .from(managedArtifacts)
      .where(eq(managedArtifacts.name, "sample-app-home.png"))
      .get();
    expect(artifact).toBeUndefined();
    expect(channel.outbound.at(-1)?.content).not.toContain("sample-app-home");
  });

  test("work runner keeps static runtime instructions in AGENTS.md", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "g-instructions",
      threadId: "t-instructions",
    });

    let capturedPrompt = "";
    let capturedCwd = "";
    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      createRunner: () => ({
        type: "mock",
        async *stream(message: { content: Array<{ text?: string }> }, options: { cwd: string }) {
          capturedPrompt = message.content.map((block) => block.text ?? "").join("\n");
          capturedCwd = options.cwd;
          yield {
            id: "assistant-final-instructions",
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                title: "instructions",
                status: "blocked",
                summary: "完成",
              }),
            }],
          };
        },
      }),
    } as never);

    await runner.executeWorkTurn({
      turn: { id: "turn-instructions", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-instructions", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-instructions", channelMessageKey: "msg-instructions", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "#work 写一个 hello world" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-instructions", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "#work 写一个 hello world" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    expect(capturedPrompt).toContain("## Work Launch Context");
    expect(capturedPrompt).toContain("## Current Turn Messages");
    expect(capturedPrompt).toContain("写一个 hello world");
    expect(capturedPrompt).not.toContain("Work Runner Runtime Prompt");
    expect(capturedPrompt).not.toContain("Do not output anything outside the JSON object");

    const agentsPath = join(capturedCwd, "AGENTS.md");
    const claudePath = join(capturedCwd, "CLAUDE.md");
    expect(existsSync(agentsPath)).toBe(true);
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, "utf-8")).toContain(
      "Work Runner Runtime Prompt",
    );
    expect(readFileSync(claudePath, "utf-8")).not.toContain(
      "@.luna-prompts/work-runner/instructions.md",
    );
    expect(readFileSync(agentsPath, "utf-8")).toContain(
      "Work Runner Runtime Prompt",
    );
    expect(readFileSync(agentsPath, "utf-8")).not.toContain(
      "@.luna-prompts/work-runner/instructions.md",
    );
    expect(readFileSync(agentsPath, "utf-8")).not.toContain(
      "Do not output anything outside the JSON object",
    );
    expect(readFileSync(agentsPath, "utf-8")).toContain("luna memory get <id>");
    expect(readFileSync(agentsPath, "utf-8")).toContain("luna memory add --type persona");
    expect(readFileSync(agentsPath, "utf-8")).toContain(
      "Stable Runner Context",
    );
    expect(readFileSync(agentsPath, "utf-8")).toContain(
      ".luna/runner-context.json",
    );
    expect(readFileSync(agentsPath, "utf-8")).toContain(
      "Per-turn or per-run user input",
    );
  });

  test("work runner preserves inbound thread and raw payload when sending status cards", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const seenInbounds: unknown[] = [];
    const originalSend = channel.send.bind(channel);
    channel.send = async (inbound, operation) => {
      seenInbounds.push(inbound);
      return originalSend(inbound, operation);
    };
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "g-preserve",
      threadId: "om_root_preserve",
      rootMessageId: "om_root_preserve",
    });

    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async () => JSON.stringify({
        title: "preserve inbound",
        status: "blocked",
        steps: [],
        summary: "完成",
      }),
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-preserve", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-preserve", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "sim-preserve", channelMessageKey: "sim-preserve", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "注入测试" }],
        rawPayloadJson: {
          rawPayload: { lunaTestInject: { replyTargetMessageId: "om_root_preserve" } },
        },
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "sim-preserve", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "注入测试" }],
        raw_payload_json: {
          rawPayload: { lunaTestInject: { replyTargetMessageId: "om_root_preserve" } },
        },
        created_at: Date.now(),
      }] as never,
    }, session);

    expect(seenInbounds.at(0)).toMatchObject({
      id: "sim-preserve",
      thread: {
        externalId: "om_root_preserve",
        rootMessageExternalId: "om_root_preserve",
      },
      rawPayload: {
        lunaTestInject: {
          replyTargetMessageId: "om_root_preserve",
        },
      },
    });
  });

  test("work runner reuses provider session and sends only current messages after launch", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g-resume", threadId: "t-resume",
    });
    messageStore.append({
      sessionId: session.id,
      channelMessageKey: "resume-history",
      senderUserId: "u1",
      role: "user",
      content: [{ type: "text", text: "启动前上下文：先做 Python 版本" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g-resume", kind: "group" },
      sender: { externalId: "u1", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    const firstMessage = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "resume-current-1",
      senderUserId: "u1",
      role: "user",
      content: [{ type: "text", text: "第一轮：改成 TypeScript 版本" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g-resume", kind: "group" },
      sender: { externalId: "u1", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });

    const prompts: string[] = [];
    const options: Array<{
      isNewSession: boolean;
      runnerKind?: string;
      runnerSessionId?: string;
    }> = [];
    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      createRunner: () => ({
        type: "mock",
        async *stream(message: { content: Array<{ text?: string }> }, runOptions: {
          isNewSession: boolean;
          runnerKind?: string;
          runnerSessionId?: string;
        }) {
          prompts.push(message.content.map((block) => block.text ?? "").join("\n"));
          options.push(runOptions);
          if (options.length === 1) {
            yield {
              id: "provider-work-session-1",
              session_id: session.id,
              role: "system",
              subtype: "init",
            } as never;
          }
          yield {
            id: `assistant-final-resume-${options.length}`,
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                title: "resume",
                status: "blocked",
                summary: "完成",
              }),
            }],
          };
        },
      }),
    } as never);

    await runner.executeWorkTurn({
      turn: { id: "turn-resume-1", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [firstMessage],
    }, session);

    const storedRunnerContext = database.db
      .select()
      .from(runnerContexts)
      .where(eq(runnerContexts.owner_id, session.id))
      .get();
    expect(storedRunnerContext?.runner_session_id).toBe("provider-work-session-1");

    const secondMessage = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "resume-current-2",
      senderUserId: "u1",
      role: "user",
      content: [{ type: "text", text: "第二轮：只改输出文案" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g-resume", kind: "group" },
      sender: { externalId: "u1", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-resume-2", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [secondMessage],
    }, session);

    expect(options[0]?.isNewSession).toBe(true);
    expect(options[0]?.runnerKind).toBe("work");
    expect(options[0]?.runnerSessionId).toBeUndefined();
    expect(prompts[0]).toContain("## Work Launch Context");
    expect(prompts[0]).toContain("启动前上下文：先做 Python 版本");
    expect(prompts[0]).toContain("## Current Turn Messages");
    expect(prompts[0]).toContain("第一轮：改成 TypeScript 版本");

    expect(options[1]?.isNewSession).toBe(false);
    expect(options[1]?.runnerKind).toBe("work");
    expect(options[1]?.runnerSessionId).toBe("provider-work-session-1");
    expect(prompts[1]).toContain("## Current Turn Messages");
    expect(prompts[1]).toContain("第二轮：只改输出文案");
    expect(prompts[1]).not.toContain("## Session Timeline");
    expect(prompts[1]).not.toContain("## Work Launch Context");
    expect(prompts[1]).not.toContain("启动前上下文：先做 Python 版本");
    expect(prompts[1]).not.toContain("第一轮：改成 TypeScript 版本");
  });

  test("work runner strips mentioned #work command from current turn prompt", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g-mentioned-work", threadId: "t-mentioned-work",
    });

    let capturedPrompt = "";
    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async ({ prompt }) => {
        capturedPrompt = prompt;
        return "完成";
      },
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-mentioned-work", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-mentioned-work", sessionId: session.id, channelType: "feishu", channelId: "feishu-main",
        externalMessageId: "msg-mentioned-work", channelMessageKey: "msg-mentioned-work", senderIdentityId: null,
        senderUserId: "u1", role: "user", messageKind: "user_message",
        contentKind: "text", presentationKind: "plain", providerMessageType: "text",
        contentJson: [{ type: "text", text: "@Luna #work 写一个 hello world" }], rawPayloadJson: {},
        occurredAt: Date.now(), createdAt: Date.now(), session_id: session.id,
        channel_message_key: "msg-mentioned-work", sender_user_id: "u1", message_kind: "user_message",
        content_json: [{ type: "text", text: "@Luna #work 写一个 hello world" }], raw_payload_json: {}, created_at: Date.now(),
      }] as never,
    }, session);

    expect(capturedPrompt).toContain("## Current Turn Messages");
    expect(capturedPrompt).toContain("写一个 hello world");
    expect(capturedPrompt).not.toContain("#work");
    expect(capturedPrompt).not.toContain("@Luna");
  });

  test("work runner prompt carries main-runner-style message envelopes", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu",
      channelId: "feishu-main",
      groupId: "group-envelope",
      threadId: "thread-envelope",
      rootMessageId: "root-envelope",
    });

    let capturedPrompt = "";
    let capturedCwd = "";
    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      createRunner: () => ({
        type: "mock",
        async *stream(message: { content: Array<{ text?: string }> }, options: { cwd: string }) {
          capturedPrompt = message.content.map((block) => block.text ?? "").join("\n");
          capturedCwd = options.cwd;
          yield {
            id: "assistant-final-envelope",
            session_id: session.id,
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                title: "envelope",
                status: "blocked",
                summary: "完成",
              }),
            }],
          };
        },
      }),
    } as never);

    await runner.executeWorkTurn({
      turn: { id: "turn-envelope", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [{
        id: "msg-envelope-row",
        sessionId: session.id,
        channelType: "feishu",
        channelId: "feishu-main",
        externalMessageId: "msg-envelope-channel",
        channelMessageKey: "msg-envelope-channel",
        senderIdentityId: null,
        senderUserId: "ou-envelope",
        role: "user",
        messageKind: "user_message",
        contentKind: "text",
        presentationKind: "plain",
        providerMessageType: "text",
        contentJson: [{ type: "text", text: "@Luna #work 查北京天气" }],
        rawPayloadJson: {
          id: "msg-envelope-channel",
          channel: { type: "feishu", id: "feishu-main" },
          surface: {
            externalId: "group-envelope",
            kind: "group",
            displayName: "Weather Group",
            rawProfile: {
              chat_mode: "group",
              tenant_key: "tenant-envelope",
            },
          },
          thread: {
            externalId: "thread-envelope",
            rootMessageExternalId: "root-envelope",
          },
          sender: {
            externalId: "ou-envelope",
            kind: "user",
            displayName: "示例用户",
          },
          text: "@Luna #work 查北京天气",
          mentions: [],
          addressing: {
            addressedToBot: true,
            reason: "mention",
          },
          rawPayload: {},
        },
        occurredAt: 123456,
        createdAt: 123456,
        session_id: session.id,
        channel_message_key: "msg-envelope-channel",
        sender_user_id: "ou-envelope",
        message_kind: "user_message",
        content_json: [{ type: "text", text: "@Luna #work 查北京天气" }],
        raw_payload_json: {
          id: "msg-envelope-channel",
          channel: { type: "feishu", id: "feishu-main" },
          surface: {
            externalId: "group-envelope",
            kind: "group",
            displayName: "Weather Group",
            rawProfile: {
              chat_mode: "group",
              tenant_key: "tenant-envelope",
            },
          },
          thread: {
            externalId: "thread-envelope",
            rootMessageExternalId: "root-envelope",
          },
          sender: {
            externalId: "ou-envelope",
            kind: "user",
            displayName: "示例用户",
          },
          text: "@Luna #work 查北京天气",
          mentions: [],
          addressing: {
            addressedToBot: true,
            reason: "mention",
          },
          rawPayload: {},
        },
        created_at: 123456,
      }] as never,
    }, session);

    const inputJson = extractWorkTurnInputJson(capturedPrompt);
    expect(inputJson).not.toHaveProperty("workSession");
    expect(inputJson).toMatchObject({
      type: "work_turn",
      sessionId: session.id,
      latestMessageAddressing: {
        addressedToBot: true,
        reason: "mention",
      },
      orderedMessages: [{
        index: 1,
        messageId: "msg-envelope-row",
        channelMessageKey: "msg-envelope-channel",
        role: "user",
        senderUserId: "ou-envelope",
        sender: {
          id: "ou-envelope",
          externalId: "ou-envelope",
          kind: "user",
          displayName: "示例用户",
        },
        contentKind: "text",
        presentationKind: "plain",
        text: "查北京天气",
        createdAt: 123456,
      }],
    });
    const contextFile = JSON.parse(
      readFileSync(runnerContextFilePath(capturedCwd), "utf-8"),
    );
    expect(contextFile).toMatchObject({
      schemaVersion: 1,
      runnerKind: "work",
      owner: { type: "session", id: session.id },
      stableContext: {
        workSession: {
          id: session.id,
          channel: { type: "feishu", id: "feishu-main" },
          surface: {
            kind: "group",
            externalId: "group-envelope",
            displayName: "Weather Group",
          },
          thread: {
            externalId: "thread-envelope",
            rootMessageExternalId: "root-envelope",
          },
          delivery: { replyTarget: "session_thread" },
        },
      },
    });
    expect(JSON.stringify(contextFile)).not.toContain("rawProfile");
  });

  test("work runner launch prompt includes prior session messages for initial context", async () => {
    const { WorkRunner } = await import("../../src/work/work-runner");
    const channel = new FakeFeishuChannel("feishu-main");
    const sessionStore = new SessionStore(database.db);
    const messageStore = new MessageStore(database.db);
    const session = sessionStore.createWorkSession({
      channelType: "feishu", channelId: "feishu-main", groupId: "g3", threadId: "t3",
    });
    messageStore.append({
      sessionId: session.id,
      channelMessageKey: "history-user",
      senderUserId: "u1",
      role: "user",
      content: [{ type: "text", text: "上一轮需求：先做 Python 版本" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g3", kind: "group" },
      sender: { externalId: "u1", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    const historyAssistant = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "history-assistant",
      role: "assistant",
      content: [{ type: "text", text: "上一轮完成：Python 版本已完成" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g3", kind: "group" },
      sender: { externalId: "luna", kind: "bot" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });
    const current = messageStore.append({
      sessionId: session.id,
      channelMessageKey: "current-user",
      senderUserId: "u1",
      role: "user",
      content: [{ type: "text", text: "这轮改成 TypeScript 版本" }],
      channel: { type: "feishu", id: "feishu-main" },
      surface: { externalId: "g3", kind: "group" },
      sender: { externalId: "u1", kind: "user" },
      contentKind: "text",
      presentationKind: "plain",
      providerMessageType: "text",
    });

    let capturedPrompt = "";
    const runner = new WorkRunner({
      db: database.db,
      runnerType: "mock",
      channelForMessage: () => channel,
      runAgent: async ({ prompt }) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          title: "多轮任务",
          status: "blocked",
          steps: [],
          summary: "完成",
        });
      },
    });

    await runner.executeWorkTurn({
      turn: { id: "turn-3", sessionId: session.id, status: "running", startedAt: Date.now() } as never,
      inboxRows: [],
      messageRows: [current],
    }, session);

    expect(capturedPrompt).toContain("## Work Launch Context");
    expect(capturedPrompt).toContain("## Current Turn Messages");
    expect(capturedPrompt).toContain("这轮改成 TypeScript 版本");
    expect(extractWorkTurnInputJson(capturedPrompt)).toMatchObject({
      type: "work_turn",
      launchContextMessages: [
        expect.objectContaining({
          index: 1,
          role: "user",
          channelMessageKey: "history-user",
          senderUserId: "u1",
          text: "上一轮需求：先做 Python 版本",
        }),
        expect.objectContaining({
          index: 2,
          role: "assistant",
          channelMessageKey: "history-assistant",
          senderUserId: historyAssistant.senderUserId,
          text: "上一轮完成：Python 版本已完成",
        }),
      ],
      orderedMessages: [
        expect.objectContaining({
          index: 1,
          role: "user",
          channelMessageKey: "current-user",
          senderUserId: "u1",
          text: "这轮改成 TypeScript 版本",
        }),
      ],
    });
    expect(capturedPrompt).not.toContain('"steps"');
    expect(capturedPrompt).not.toContain("Do not summarize or invent execution steps");
    expect(capturedPrompt).not.toContain("Work Runner Runtime Prompt");
  });
});

function setEnv(key: string, value: string): void {
  if (!previousEnv.has(key)) {
    previousEnv.set(key, Bun.env[key]);
  }
  Bun.env[key] = value;
  process.env[key] = value;
}

function extractWorkTurnInputJson(prompt: string): Record<string, unknown> {
  const match = prompt.match(/```json\n([\s\S]*?)\n```/);
  expect(match?.[1]).toBeString();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

test("a memory maintenance turn runs silently in the Work session's provider context", async () => {
  const { WorkRunner } = await import("../../src/work/work-runner");
  const { RunnerContextStore } = await import("../../src/runners/runner-context-store");
  const channel = new FakeFeishuChannel("feishu-main");
  const session = new SessionStore(database.db).createWorkSession({
    channelType: "feishu", channelId: "feishu-main", groupId: "g-maint", threadId: "t-maint", rootMessageId: "t-maint",
  });
  fixtureUser(database.db, session.agent_id, "u-maint");
  const received: { prompt: string; runnerSessionId: string | undefined; runnerKind: string | undefined }[] = [];
  const runner = new WorkRunner({
    db: database.db, runnerType: "mock", channelForMessage: () => channel,
    createRunner: () => ({
      type: "mock",
      async *stream(message: any, options: any) {
        received.push({ prompt: message.content[0].text, runnerSessionId: options.runnerSessionId, runnerKind: options.runnerKind });
        yield { id: "assistant-final", session_id: session.id, role: "assistant", content: [{ type: "text", text: "LUNA_NOTHING_TO_SEND" }] };
      },
    }),
  } as never);
  const command = { id: "cmd-reflect", actorUserId: "u-maint", instruction: "Memory reflection. Review this conversation." };

  // Nothing was said and no provider context exists: there is nothing to reflect on.
  await runner.executeMaintenanceTurn(session, command);
  expect(received).toEqual([]);

  new MessageStore(database.db).appendOnce({ sessionId: session.id, channelMessageKey: "m-maint", role: "user", senderUserId: "u-maint",
    content: [{ type: "text", text: "帮我实现登录页" }], channel: { type: "feishu", id: "feishu-main" } });
  const contexts = new RunnerContextStore(database.db);
  const contextId = contexts.resolveForSession(session.id, "mock").id;
  // Instructions that changed since the provider session began reset it; the conversation is gone, so the turn is skipped.
  contexts.persistRunnerSessionId(contextId, "provider-work-0");
  await runner.executeMaintenanceTurn(session, command);
  expect(received).toEqual([]);
  contexts.persistRunnerSessionId(contextId, "provider-work-1");
  await runner.executeMaintenanceTurn(session, { ...command, id: "cmd-reflect-2" });

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ runnerSessionId: "provider-work-1", runnerKind: "work" });
  expect(received[0]!.prompt).toStartWith("Memory reflection. Review this conversation.");
  // No status card, progress or reply reaches the thread.
  expect(channel.outbound).toEqual([]);
  expect(database.db.select().from(lunaSchema.messages).where(and(eq(lunaSchema.messages.ownerSessionId, session.id), eq(lunaSchema.messages.role, "assistant"))).all()).toEqual([]);
});
