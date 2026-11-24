import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { DEFAULT_SESSION_CONFIG, setLunaHome, type AgentRunner } from "@/shared";
import { AgentSecretCipher } from "@/agent-config";
import { AgentStore } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { AgentSettingsStore } from "@/agents/agent-settings-store";
import { ensureTurnDeltaPack, ContextPackStore } from "@/context";
import { CorrelatedRequestService } from "@/messaging/correlated-request-service";
import { releaseDeferredOutboundCommands } from "@/messaging/outbound-governance";
import {
  SessionCommandService,
  registerSessionCommands,
} from "@/messaging/session-command-service";
import { MainRunner, renderMainRunnerPrompt, type MainRunnerRunInput } from "@/main-runner/main-runner";
import { TaskResultEventPublisher } from "@/main-runner/task-result-events";
import { RunnerContextStore } from "@/runners/runner-context-store";
import { SessionStore } from "@/sessions/session-store";
import { MessageStore } from "@/sessions/message-store";
import { SessionRunnerAttemptStore } from "@/sessions/session-runner-attempt-store";
import { SessionInboundRouter } from "@/sessions/inbound/session-inbound-router";
import { createSessionTriggerExecutor } from "@/sessions/trigger-executor";
import { persistTaskStatusCardMessage } from "@/messaging/notifications/status-card-message-store";
import { TaskSubscriptionStore } from "@/tasks/task-subscription-store";
import type { ReplyChannel } from "@/channels/outbound";
import type { NormalizedInboundMessage } from "@/channels";
import { fixtureFeishuSender, fixtureNamedSession, fixtureObserveFeishuSender } from "../helpers/platform-fixtures";

const NOW = Date.now();

let home: string;
let db: DataConnection<typeof schema>;
let scope: { agentId: string; shadowId: string; ownerUserId: string; botUserId: string };
let aliceUserId: string;
let colleagueUserId: string;
let originGroupSessionId: string;
let directSessionId: string;

function makeReplyChannel(sent: Array<{ content?: string | undefined }> = []): ReplyChannel {
  let msgSeq = 0;
  return {
    async send(inbound, operation) {
      sent.push({ content: operation.content });
      return {
        ...operation,
        id: `om_out_${++msgSeq}`,
        channelId: inbound.channel.id,
      };
    },
  };
}

function makeFakeAgentRunner(
  onInvoke?: (prompt: string, sessionId: string | undefined) => string | void,
): AgentRunner & { prompts: string[]; sessionIds: Array<string | undefined> } {
  const prompts: string[] = [];
  const sessionIds: Array<string | undefined> = [];
  let providerSeq = 0;
  return {
    type: "mock",
    prompts,
    sessionIds,
    async *stream(userMessage, options) {
      const promptText = Array.isArray(userMessage.content)
        ? userMessage.content.map(b => ("text" in b && typeof b.text === "string" ? b.text : "")).join("")
        : String(userMessage.content);
      prompts.push(promptText);
      sessionIds.push(options?.runnerSessionId);
      const custom = onInvoke?.(promptText, options?.runnerSessionId);
      const sid = options?.runnerSessionId ?? `prov_sess_${++providerSeq}`;
      yield {
        id: sid,
        session_id: sid,
        role: "system",
        subtype: "init",
        content: [],
      } as never;
      yield {
        id: `asst_${providerSeq}`,
        session_id: sid,
        role: "assistant",
        final: true,
        content: [{ type: "text", text: custom ?? "收到，已处理。" }],
      } as never;
    },
  };
}

function p2pInbound(id: string, text: string, _createdAt?: number): NormalizedInboundMessage {
  return {
    id,
    channel: { id: "feishu-main", type: "feishu" },
    surface: { externalId: "oc_p2p_owner", kind: "p2p" },
    sender: { ...fixtureFeishuSender("feishu-main", "ou_alice"), displayName: "Alice" },
    text,
    contentBlocks: [{ type: "text", text }],
    mentions: [],
    addressing: { addressedToBot: true, reason: "p2p" },
  };
}

function groupInbound(
  id: string,
  text: string,
  addressed: boolean,
  senderExternalId = "ou_colleague",
  _createdAt?: number,
): NormalizedInboundMessage {
  return {
    id,
    channel: { id: "feishu-main", type: "feishu" },
    surface: { externalId: "oc_group_1", kind: "group" },
    sender: { ...fixtureFeishuSender("feishu-main", senderExternalId), displayName: senderExternalId },
    text,
    contentBlocks: [{ type: "text", text }],
    mentions: addressed
      ? [{ key: "@_bot", label: "@Luna", target: { externalId: "ou_bot", kind: "bot" } }]
      : [],
    addressing: {
      addressedToBot: addressed,
      reason: addressed ? "mention" : "silent_group",
    },
  };
}

function extractHistoryJson(prompt: string): {
  launchSeed?: { kind: string; items: Array<Record<string, unknown>> };
  deltaContext?: {
    kind: string;
    omittedOutOfBandCount?: number;
    items: Array<Record<string, unknown>>;
  };
} | undefined {
  const match = prompt.match(/<history>\n([\s\S]*?)\n<\/history>/);
  if (!match) return undefined;
  return JSON.parse(match[1]!) as ReturnType<typeof extractHistoryJson>;
}

function extractEventsJson(prompt: string): Array<Record<string, unknown>> {
  const match = prompt.match(/<events>\n([\s\S]*?)\n<\/events>/);
  if (!match) return [];
  const raw = match[1]!;
  const splitIdx = raw.indexOf("\n---\n");
  const jsonPart = splitIdx >= 0 ? raw.slice(0, splitIdx) : raw;
  return JSON.parse(jsonPart) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-oob-delta-"));
  setLunaHome(home);
  db = new DataConnection(schema);
  const baseScope = fixtureNamedSession(db.db, "dashboard-seed", "alice");

  // Create a non-default Feishu Shadow and bind `feishu-main` so both group and P2P surfaces share one Shadow.
  const agents = new AgentStore(db.db);
  const feishuShadow = agents.createShadow("alice", baseScope.agentId, { name: "Feishu Shadow" }, "shadow:feishu-main");
  const cipher = AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
  });
  db.db.insert(schema.channelConfigs).values({
    id: "feishu-main",
    agentId: baseScope.agentId,
    type: "feishu",
    name: "Feishu Main",
    appId: "test:feishu:feishu-main",
    secret: cipher.encrypt({ profileId: "feishu-main", revisionId: "v1", key: "app_secret", plaintext: "secret" }),
    updatedAt: 1,
  }).onConflictDoNothing().run();
  new BotBindingStore(db.db).bind("alice", feishuShadow.id, "feishu-main");

  scope = {
    agentId: baseScope.agentId,
    shadowId: feishuShadow.id,
    ownerUserId: baseScope.ownerUserId,
    botUserId: feishuShadow.replyUserId,
  };

  aliceUserId = fixtureObserveFeishuSender(db.db, "feishu-main", "ou_alice");
  colleagueUserId = fixtureObserveFeishuSender(db.db, "feishu-main", "ou_colleague");

  originGroupSessionId = new SessionStore(db.db).resolveByChannelSurface({
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "oc_origin_group",
  }).id;
  directSessionId = new SessionStore(db.db).resolveByChannelSurface({
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "oc_p2p_owner",
  }).id;
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("settled cross-session ask card is injected once into target P2P Main deltaContext with request outcome, and omitted on next turn", async () => {
  const replyChannel = makeReplyChannel();
  const agentRunner = makeFakeAgentRunner();
  const commands = new SessionCommandService({
    db: db.db,
    channelFor: () => replyChannel,
  });
  registerSessionCommands(db.db, commands);

  const mainRunner = new MainRunner({
    runner: agentRunner,
    runnerContextStore: new RunnerContextStore(db.db),
    attemptStore: new SessionRunnerAttemptStore(db.db),
    serviceAuthDb: db.db,
    accessTokenSigningSecret: "test-signing-secret-32-bytes-minimum",
  });
  const router = new SessionInboundRouter({
    db: db.db,
    channel: replyChannel,
    runnerType: "mock",
    mainRunner,
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 5, coalesce_max_wait_ms: 10 },
  });

  // 1. Turn 1 in P2P establishes a resumed provider session (`runner_session_id` != null)
  //    and sends Main's own reply, which must NOT come back as out-of-band delta.
  await router.route(p2pInbound("m_p2p_1", "你好", NOW));
  await router.waitForIdle();
  await commands.waitForIdle();
  expect(agentRunner.prompts).toHaveLength(1);
  expect(extractHistoryJson(agentRunner.prompts[0]!)).toBeUndefined();

  // 2. Group Main sends an approval card to Alice's P2P session via `requests create --options`.
  const reqSvc = new CorrelatedRequestService(db.db, () => replyChannel);
  const askRow = reqSvc.createRequest({
    actor: {
      userId: colleagueUserId,
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: originGroupSessionId,
      currentSessionId: originGroupSessionId,
      originId: "group-turn-1",
    },
    key: "approve-prod-write",
    toAddress: `session:${directSessionId}`,
    goal: "是否同意为支付服务开通生产写权限？",
    contextSummary: "来自支付需求群的部署申请",
    options: ["同意", "拒绝"],
    now: Date.now(),
  });
  await commands.waitForIdle();

  // 3. Alice clicks "同意" on the Feishu card (settles without running P2P Main).
  const cardRes = await reqSvc.handleCardAction({
    channel: { id: "feishu-main", type: "feishu" },
    actionValue: { requestId: askRow.id, option: "同意" },
    operatorIdentity: { externalId: "ou_alice", kind: "user", displayName: "Alice" },
  });
  expect(cardRes?.toast?.type).toBe("success");
  expect(agentRunner.prompts).toHaveLength(1);

  // 4. Alice follows up in P2P: "刚才那个审批是什么背景？"
  await router.route(p2pInbound("m_p2p_2", "刚才那个审批是什么背景？", NOW + 2_000));
  await router.waitForIdle();
  await commands.waitForIdle();

  expect(agentRunner.prompts).toHaveLength(2);
  const turn2History = extractHistoryJson(agentRunner.prompts[1]!);
  expect(turn2History?.launchSeed).toBeUndefined();
  expect(turn2History?.deltaContext?.kind).toBe("turn_delta");
  // Main's own Turn-1 reply is excluded; only the cross-session request card appears.
  expect(turn2History?.deltaContext?.items).toHaveLength(1);
  expect(turn2History?.deltaContext?.items[0]).toMatchObject({
    role: "assistant",
    reason: "out_of_band:cross_session",
    via: "request",
    originSessionId: originGroupSessionId,
    correlationId: askRow.id,
    request: {
      mode: "card",
      status: "done",
      contextSummary: "来自支付需求群的部署申请",
      options: ["同意", "拒绝"],
      selectedOption: "同意",
      resolvedBy: `user:${aliceUserId}`,
    },
  });
  expect(String(turn2History?.deltaContext?.items[0]?.text)).toContain(
    "是否同意为支付服务开通生产写权限？",
  );

  // Also verify Turn 2 attached the entry to `session_turn_entries` as `context`.
  const turn2Entries = db.db
    .select()
    .from(schema.sessionTurnEntries)
    .where(eq(schema.sessionTurnEntries.session_id, directSessionId))
    .all();
  expect(turn2Entries.some(e => e.role === "context")).toBe(true);

  // 5. Turn 3 in P2P with no new external messages must NOT re-inject `<history>.deltaContext`.
  await router.route(p2pInbound("m_p2p_3", "好的知道了", NOW + 3_000));
  await router.waitForIdle();
  await commands.waitForIdle();

  expect(agentRunner.prompts).toHaveLength(3);
  expect(extractHistoryJson(agentRunner.prompts[2]!)).toBeUndefined();
}, 15_000);

test("open request omits duplicate request snapshot in deltaContext when open_request is in <events>, and failed turn retries delivery", async () => {
  const replyChannel = makeReplyChannel();
  let failTurn2 = true;
  const baseRunner = makeFakeAgentRunner();
  const flakyRunner: AgentRunner = {
    type: "mock",
    async *stream(userMessage, options) {
      if (failTurn2 && options?.runnerSessionId) {
        const promptText = Array.isArray(userMessage.content)
          ? userMessage.content.map(b => ("text" in b && typeof b.text === "string" ? b.text : "")).join("")
          : String(userMessage.content);
        baseRunner.prompts.push(promptText);
        throw new Error("provider unreachable before init");
      }
      yield* baseRunner.stream(userMessage, options);
    },
  };

  const commands = new SessionCommandService({
    db: db.db,
    channelFor: () => replyChannel,
  });
  registerSessionCommands(db.db, commands);
  const mainRunner = new MainRunner({
    runner: flakyRunner,
    runnerContextStore: new RunnerContextStore(db.db),
    attemptStore: new SessionRunnerAttemptStore(db.db),
    serviceAuthDb: db.db,
    accessTokenSigningSecret: "test-signing-secret-32-bytes-minimum",
  });
  const router = new SessionInboundRouter({
    db: db.db,
    channel: replyChannel,
    runnerType: "mock",
    mainRunner,
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 5, coalesce_max_wait_ms: 10 },
  });

  // Establish resumed session.
  await router.route(p2pInbound("m_pend_1", "hi", NOW));
  await router.waitForIdle();
  await commands.waitForIdle();

  // Send open card request targeting user:alice.
  const reqSvc = new CorrelatedRequestService(db.db, () => replyChannel);
  const askRow = reqSvc.createRequest({
    actor: {
      userId: colleagueUserId,
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: originGroupSessionId,
      currentSessionId: originGroupSessionId,
      originId: "group-turn-pending",
    },
    key: "ask-pending",
    toAddress: `user:${aliceUserId}`,
    goal: "发布窗口定在今晚 10 点可以吗？",
    options: ["可以", "推迟"],
    now: Date.now(),
  });
  // Ensure target resolved to directSessionId; if `user:alice` resolved to another session, send directly to directSessionId.
  let trackedAsk = askRow;
  if (askRow.targetSessionId !== directSessionId) {
    trackedAsk = reqSvc.createRequest({
      actor: {
        userId: colleagueUserId,
        agentId: scope.agentId,
        shadowId: scope.shadowId,
        sourceSessionId: originGroupSessionId,
        currentSessionId: originGroupSessionId,
        originId: "group-turn-pending-2",
      },
      key: "ask-pending-direct",
      toAddress: `session:${directSessionId}`,
      goal: "发布窗口定在今晚 10 点可以吗？",
      options: ["可以", "推迟"],
      now: Date.now(),
    });
  }
  await commands.waitForIdle();

  // Turn 2 fails before provider init -> Turn 3 must still receive the out-of-band request card!
  await router.route(p2pInbound("m_pend_2", "稍等我看下", NOW + 1_000));
  await router.waitForIdle();
  await commands.waitForIdle();
  expect(baseRunner.prompts).toHaveLength(2);

  // Check that during Turn 2 (while request is open), `open_request` is in `<events>` and
  // delta item carries `correlationId` WITHOUT duplicating `request` options.
  const turn2Events = extractEventsJson(baseRunner.prompts[1]!);
  expect(turn2Events.some(e => e.kind === "open_request" && e.id === trackedAsk.id)).toBe(true);
  const turn2DeltaItem = extractHistoryJson(baseRunner.prompts[1]!)?.deltaContext?.items.find(
    i => i.correlationId === trackedAsk.id,
  );
  expect(turn2DeltaItem).toBeDefined();
  expect(turn2DeltaItem?.request).toBeUndefined();

  // Turn 3 succeeds and still gets the out-of-band card because Turn 2 failed before provider received it.
  failTurn2 = false;
  await router.route(p2pInbound("m_pend_3", "推迟到明天吧", NOW + 2_000));
  await router.waitForIdle();
  await commands.waitForIdle();
  expect(baseRunner.prompts).toHaveLength(3);
  const turn3Delta = extractHistoryJson(baseRunner.prompts[2]!)?.deltaContext;
  expect(turn3Delta?.items.some(i => i.correlationId === trackedAsk.id)).toBe(true);
});

test("deferred quiet-hours message is withheld until released and sent, and status cards are excluded", async () => {
  const replyChannel = makeReplyChannel();
  const agentRunner = makeFakeAgentRunner();
  const commands = new SessionCommandService({
    db: db.db,
    channelFor: () => replyChannel,
  });
  registerSessionCommands(db.db, commands);
  const mainRunner = new MainRunner({
    runner: agentRunner,
    runnerContextStore: new RunnerContextStore(db.db),
    attemptStore: new SessionRunnerAttemptStore(db.db),
    serviceAuthDb: db.db,
    accessTokenSigningSecret: "test-signing-secret-32-bytes-minimum",
  });
  const router = new SessionInboundRouter({
    db: db.db,
    channel: replyChannel,
    runnerType: "mock",
    mainRunner,
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 5, coalesce_max_wait_ms: 10 },
  });

  // Turn 1 establishes resumed session.
  await router.route(p2pInbound("m_qh_1", "在吗", NOW));
  await router.waitForIdle();
  await commands.waitForIdle();

  // Configure 00:00–23:59 quiet hours so proactive cross-session send is deferred.
  new AgentSettingsStore(db.db).save("alice", scope.agentId, {
    proactivity: { quietHours: { start: "00:00", end: "23:59" } },
  });
  const deferredCmd = commands.accept(
    {
      userId: colleagueUserId,
      sourceSessionId: originGroupSessionId,
      originId: "heartbeat:test-shadow:1",
    },
    directSessionId,
    "message.send",
    "deferred-notice",
    { content: "免打扰期间的跨会话通知", purpose: "notification" },
  );
  expect(deferredCmd.status).toBe("deferred");

  // Also persist a Task status card in directSessionId — must NEVER enter deltaContext.
  db.db.insert(schema.tasks).values({
    id: "task-sc-1",
    agent_id: scope.agentId,
    shadow_id: scope.shadowId,
    type: "question",
    title: "巡检任务",
    summary: "正在执行巡检...",
    status: "running",
    created_at: NOW,
    updated_at: NOW,
    last_activity_at: NOW,
  }).run();
  const sub = new TaskSubscriptionStore(db.db).resolve({
    taskId: "task-sc-1",
    sessionId: directSessionId,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "oc_p2p_owner",
    visibility: "full",
  });
  persistTaskStatusCardMessage({
    db: db.db,
    sessionId: directSessionId,
    taskId: "task-sc-1",
    inbound: p2pInbound("m_qh_sc", "status"),
    subscription: sub,
    taskTitle: "巡检任务",
    taskSummary: "步骤 1/3",
    taskStatus: "running",
    channelMessageKey: "om_status_card_1",
  });

  // Turn 2 while command is still `deferred`: neither deferred message nor status card appears.
  await router.route(p2pInbound("m_qh_2", "有什么新消息吗", NOW + 1_000));
  await router.waitForIdle();
  await commands.waitForIdle();
  expect(extractHistoryJson(agentRunner.prompts[1]!)).toBeUndefined();

  // Lift quiet hours, release deferred command, and deliver it (`status = "sent"`).
  new AgentSettingsStore(db.db).save("alice", scope.agentId, {
    proactivity: { quietHours: false },
  });
  releaseDeferredOutboundCommands(db.db, NOW + 86_400_000);
  await commands.tick(NOW + 86_400_000);
  await commands.waitForIdle();
  expect(commands.get(deferredCmd.id)?.status).toBe("sent");

  // Turn 3 now receives the delivered cross-session message, still excluding the status card.
  await router.route(p2pInbound("m_qh_3", "现在呢", NOW + 86_401_000));
  await router.waitForIdle();
  await commands.waitForIdle();
  const turn3Delta = extractHistoryJson(agentRunner.prompts[2]!)?.deltaContext;
  expect(turn3Delta?.items).toHaveLength(1);
  expect(turn3Delta?.items[0]).toMatchObject({
    role: "assistant",
    text: "免打扰期间的跨会话通知",
    reason: "out_of_band:routine",
    via: "routine",
    originSessionId: originGroupSessionId,
  });
});

test("group @mention turn interleaves overheard user chatter and out-of-band assistant messages chronologically", async () => {
  const replyChannel = makeReplyChannel();
  const agentRunner = makeFakeAgentRunner();
  const commands = new SessionCommandService({
    db: db.db,
    channelFor: () => replyChannel,
  });
  registerSessionCommands(db.db, commands);
  const mainRunner = new MainRunner({
    runner: agentRunner,
    runnerContextStore: new RunnerContextStore(db.db),
    attemptStore: new SessionRunnerAttemptStore(db.db),
    serviceAuthDb: db.db,
    accessTokenSigningSecret: "test-signing-secret-32-bytes-minimum",
  });
  const router = new SessionInboundRouter({
    db: db.db,
    channel: replyChannel,
    runnerType: "mock",
    mainRunner,
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 5, coalesce_max_wait_ms: 10 },
  });

  // Turn 1 in group establishes resumed provider session.
  await router.route(groupInbound("m_grp_1", "@Luna 大家好", true, "ou_colleague", NOW));
  await router.waitForIdle();
  await commands.waitForIdle();
  const groupSession = new SessionStore(db.db).resolveByChannelSurface({
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "oc_group_1",
  });
  expect(groupSession).toBeDefined();

  // Overheard chatter #1 from another member ("ou_bob") so it is not treated as activation_followup of "ou_colleague".
  fixtureObserveFeishuSender(db.db, "feishu-main", "ou_bob");
  await router.route(groupInbound("m_grp_oh1", "今天发布还没开始", false, "ou_bob"));
  // Scheduled reminder sent into group after chatter #1
  commands.accept(
    {
      userId: aliceUserId,
      sourceSessionId: groupSession.id,
      originId: "schedule:daily-release:occ-1",
    },
    groupSession.id,
    "message.send",
    "occurrence",
    { content: "【定时提醒】每日构建检查已开始", purpose: "notification" },
  );
  await commands.waitForIdle();
  // Overheard chatter #2 after reminder from "ou_bob"
  await router.route(groupInbound("m_grp_oh2", "刚看到提醒了，我去看看构建状态", false, "ou_bob"));

  // Explicit @Luna activation at T+4000
  await router.route(groupInbound("m_grp_act", "@Luna 帮我汇总一下刚才的情况", true, "ou_colleague", NOW + 4_000));
  await router.waitForIdle();
  await commands.waitForIdle();

  expect(agentRunner.prompts).toHaveLength(2);
  const delta = extractHistoryJson(agentRunner.prompts[1]!)?.deltaContext;
  expect(delta?.kind).toBe("group_activation");
  expect(delta?.items.map(i => ({ role: i.role, text: i.text, via: i.via }))).toEqual([
    { role: "user", text: "今天发布还没开始", via: undefined },
    { role: "assistant", text: "【定时提醒】每日构建检查已开始", via: "schedule" },
    { role: "user", text: "刚看到提醒了，我去看看构建状态", via: undefined },
  ]);
});

test("session_trigger and task_result turns receive unseen out-of-band messages once and skip launchSeed turns", async () => {
  const replyChannel = makeReplyChannel();
  const agentRunner = makeFakeAgentRunner();
  const mainRunner = new MainRunner({
    runner: agentRunner,
    runnerContextStore: new RunnerContextStore(db.db),
    attemptStore: new SessionRunnerAttemptStore(db.db),
    serviceAuthDb: db.db,
    accessTokenSigningSecret: "test-signing-secret-32-bytes-minimum",
  });
  const triggerExec = createSessionTriggerExecutor(
    db.db,
    () => mainRunner,
    () => "mock",
  );
  const commands = new SessionCommandService({
    db: db.db,
    channelFor: () => replyChannel,
    executeTrigger: triggerExec,
  });
  registerSessionCommands(db.db, commands);
  const router = new SessionInboundRouter({
    db: db.db,
    channel: replyChannel,
    runnerType: "mock",
    mainRunner,
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 5, coalesce_max_wait_ms: 10 },
  });

  // Cold session (`runner_session_id === null`) WITH `launchSeed` covering the prior message:
  // `ensureTurnDeltaPack` skips entries already in `launchSeedEntryIds`; without a seed, it surfaces unseen out-of-band messages!
  const coldCtx = new RunnerContextStore(db.db).resolveForSession(directSessionId, "mock");
  expect(coldCtx.runner_session_id).toBeNull();
  const coldCmd = commands.accept(
    { userId: colleagueUserId, sourceSessionId: originGroupSessionId, originId: "cold-send" },
    directSessionId,
    "message.send",
    "cold-1",
    { content: "冷启动前的跨会话消息", purpose: "notification" },
  );
  await commands.waitForIdle();
  const coldEntry = db.db
    .select()
    .from(schema.sessionTimelineEntries)
    .where(eq(schema.sessionTimelineEntries.messageId, coldCmd.messageId!))
    .get()!;
  expect(
    ensureTurnDeltaPack({
      db: db.db,
      sessionId: directSessionId,
      invocationId: "cold-inv-with-seed",
      runnerContext: coldCtx,
      turnFlavor: "user_messages",
      launchSeedEntryIds: new Set([coldEntry.id]),
    }),
  ).toBeUndefined();

  // Turn 1 (first user_messages turn with no relaunch seed) surfaces `cold-1` once and marks it delivered!
  await router.route(p2pInbound("m_trig_1", "开始会话", NOW));
  await router.waitForIdle();
  await commands.waitForIdle();
  expect(agentRunner.prompts).toHaveLength(1);
  expect(
    extractHistoryJson(agentRunner.prompts[0]!)?.deltaContext?.items.map(i => i.text),
  ).toEqual(["冷启动前的跨会话消息"]);

  // Send out-of-band message #1 before a `session.invoke` trigger turn.
  commands.accept(
    { userId: colleagueUserId, sourceSessionId: originGroupSessionId, originId: "oob-before-trigger" },
    directSessionId,
    "message.send",
    "oob-1",
    { content: "触发轮之前的外部通知", purpose: "notification" },
  );
  await commands.waitForIdle();

  const invokeCmd = commands.accept(
    { userId: colleagueUserId, sourceSessionId: originGroupSessionId, originId: "handoff-1" },
    directSessionId,
    "session.invoke",
    "handoff-key",
    { content: "请跟进刚才的通知" },
  );
  await commands.waitForIdle();
  expect(commands.get(invokeCmd.id)?.status).toBe("completed");
  expect(agentRunner.prompts).toHaveLength(2);
  const triggerDelta = extractHistoryJson(agentRunner.prompts[1]!)?.deltaContext;
  expect(triggerDelta?.items.map(i => i.text)).toEqual(["触发轮之前的外部通知"]);

  // Send out-of-band message #2 before a `task_result` turn; message #1 must NOT reappear!
  commands.accept(
    { userId: aliceUserId, sourceSessionId: directSessionId, originId: "schedule-failure:occ-9" },
    directSessionId,
    "message.send",
    "notify-owner",
    { content: "定时任务执行异常：日报汇总", purpose: "notification" },
  );
  await commands.waitForIdle();

  db.db.insert(schema.tasks).values({
    id: "task-res-1",
    agent_id: scope.agentId,
    shadow_id: scope.shadowId,
    creator_user_id: aliceUserId,
    type: "question",
    title: "查询指标",
    summary: "指标正常",
    status: "completed",
    created_at: NOW,
    updated_at: NOW,
    last_activity_at: NOW,
  }).run();
  db.db.insert(schema.taskRuns).values({
    id: "run-res-1",
    task_id: "task-res-1",
    run_index: 1,
    reason: "initial",
    status: "completed",
    input_snapshot: {},
    runner_type: "mock",
    started_at: NOW,
    finished_at: NOW + 100,
  }).run();
  const sub = new TaskSubscriptionStore(db.db).resolve({
    taskId: "task-res-1",
    sessionId: directSessionId,
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: "oc_p2p_owner",
    visibility: "full",
  });

  const publisher = new TaskResultEventPublisher({
    db: db.db,
    runnerType: "mock",
    mainRunner,
    channelForSubscription: () => replyChannel,
  });
  await publisher.publish({
    taskId: "task-res-1",
    taskRunId: "run-res-1",
    runIndex: 1,
    status: "completed",
    title: "查询指标",
    summary: "指标正常",
    userVisibleReport: "各项核心指标正常。",
    evidenceSummary: [],
    artifactIds: [],
    nextActions: [],
  });
  await commands.waitForIdle();

  expect(agentRunner.prompts).toHaveLength(3);
  const taskResDelta = extractHistoryJson(agentRunner.prompts[2]!)?.deltaContext;
  expect(taskResDelta?.items).toHaveLength(1);
  expect(taskResDelta?.items[0]).toMatchObject({
    role: "assistant",
    text: "定时任务执行异常：日报汇总",
    reason: "out_of_band:schedule",
    via: "schedule",
  });

  // Subsequent user message turn sees neither #1 nor #2 again.
  await router.route(p2pInbound("m_trig_after", "收到", NOW + 10_000));
  await router.waitForIdle();
  await commands.waitForIdle();
  expect(agentRunner.prompts).toHaveLength(4);
  expect(extractHistoryJson(agentRunner.prompts[3]!)).toBeUndefined();
});

test("enforces count (10) and character budgets with omittedOutOfBandCount and legacy fallback inference", async () => {
  const replyChannel = makeReplyChannel();
  const commands = new SessionCommandService({
    db: db.db,
    channelFor: () => replyChannel,
  });
  registerSessionCommands(db.db, commands);

  // Relax outbound rate limits so we can send >10 cross-session messages in the test.
  new AgentSettingsStore(db.db).save("alice", scope.agentId, {
    proactivity: { outboundPerSessionPerHour: 0, outboundPerRecipientPerDay: 0, outboundDedupWindowMs: 0 },
  });

  const ctxStore = new RunnerContextStore(db.db);
  const ctx = ctxStore.resolveForSession(directSessionId, "mock");
  ctxStore.persistRunnerSessionId(ctx.id, "prov_budget_1");
  const resumedCtx = ctxStore.resolveForSession(directSessionId, "mock");

  // Insert 12 cross-session messages, stripping `authoredBy` on the last one to verify legacy fallback.
  for (let i = 1; i <= 12; i++) {
    const cmd = commands.accept(
      {
        userId: colleagueUserId,
        sourceSessionId: originGroupSessionId,
        originId: `bulk-origin-${i}`,
      },
      directSessionId,
      "message.send",
      `bulk-${i}`,
      { content: `外部通知 #${i} ` + "内容".repeat(100), purpose: "notification" },
    );
    if (i === 12) {
      const legacyPayload = { ...cmd.payload };
      delete legacyPayload.authoredBy;
      db.db
        .update(schema.sessionCommands)
        .set({ payload: legacyPayload })
        .where(eq(schema.sessionCommands.id, cmd.id))
        .run();
    }
  }
  await commands.waitForIdle();

  // Also insert a legacy runner-authored message without `authoredBy` (linked to a sessionTurn in directSessionId) -> must be excluded.
  db.db.insert(schema.sessionTurns).values({
    id: "legacy-runner-turn",
    session_id: directSessionId,
    turn_kind: "execution",
    status: "completed",
    runner_invoked: true,
    reason: "p2p",
    started_at: NOW,
    completed_at: NOW + 10,
    created_at: NOW,
    updated_at: NOW + 10,
  }).run();
  const legacySelfCmd = commands.accept(
    {
      userId: aliceUserId,
      sourceSessionId: directSessionId,
      originId: "legacy-runner-turn",
    },
    directSessionId,
    "message.send",
    "service-final-answer",
    { content: "旧版本轮最终回复", purpose: "answer", authoredBy: "runner" },
  );
  const strippedSelfPayload = { ...legacySelfCmd.payload };
  delete strippedSelfPayload.authoredBy;
  db.db
    .update(schema.sessionCommands)
    .set({ payload: strippedSelfPayload })
    .where(eq(schema.sessionCommands.id, legacySelfCmd.id))
    .run();
  await commands.waitForIdle();

  // Also append a non-command assistant message -> must be excluded.
  new MessageStore(db.db).appendOnce({
    sessionId: directSessionId,
    channelMessageKey: "manual-import-assistant",
    role: "assistant",
    content: [{ type: "text", text: "导入的历史机器人消息" }],
    channel: { type: "feishu", id: "feishu-main" },
    senderUserId: scope.botUserId,
  });

  const packId = ensureTurnDeltaPack({
    db: db.db,
    sessionId: directSessionId,
    invocationId: "budget-turn-1",
    runnerContext: resumedCtx,
    turnFlavor: "user_messages",
  });
  expect(packId).toBeDefined();

  const packRow = db.db
    .select()
    .from(schema.contextPacks)
    .where(eq(schema.contextPacks.id, packId!))
    .get()!;
  const items = new ContextPackStore(db.db).listItemsForPack(packId!);
  expect(items).toHaveLength(10);
  expect((packRow.metadataJson as { omittedOutOfBandCount?: number })?.omittedOutOfBandCount).toBe(2);

  // Render prompt and verify `omittedOutOfBandCount` appears in `<history>.deltaContext` and item #12 (legacy) was classified as cross_session.
  const { MainRunnerContextBuilder } = await import("@/main-runner/context-builder");
  const context = new MainRunnerContextBuilder(db.db).buildForSession(directSessionId, {
    includeLaunchSeed: false,
    deltaContextPackIds: [packId!],
  });
  const sampleInbound = p2pInbound("m1", "汇总", NOW);
  const prompt = renderMainRunnerPrompt(
    {
      type: "user_messages",
      messages: [{
        index: 1,
        messageId: "m1",
        role: "user",
        text: "汇总",
        createdAt: NOW,
        sender: sampleInbound.sender,
        senderUserId: aliceUserId,
        rawMessage: sampleInbound,
      } as never],
      latestMessage: sampleInbound,
      context,
    },
    { db: db.db },
  );
  const history = extractHistoryJson(prompt);
  expect(history?.deltaContext?.omittedOutOfBandCount).toBe(2);
  expect(history?.deltaContext?.items[0]?.text).toContain("外部通知 #3");
  expect(history?.deltaContext?.items[9]).toMatchObject({
    reason: "out_of_band:cross_session",
    via: "message",
  });
  expect(history?.deltaContext?.items[9]?.text).toContain("外部通知 #12");
});
