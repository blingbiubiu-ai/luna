import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { AgentSettingsStore } from "@/agents/agent-settings-store";
import { runSelfRoutine, SELF_ROUTINE_ORIGINS } from "@/agents/self-routines";
import {
  CorrelatedRequestService,
  createCorrelatedRequestExpiryRoutine,
} from "@/messaging/correlated-request-service";
import { parseTaskAddress, resolveLunaAddress } from "@/messaging/luna-address";
import { releaseDeferredOutboundCommands } from "@/messaging/outbound-governance";
import {
  SessionCommandService,
  registerSessionCommands,
} from "@/messaging/session-command-service";
import { SessionStore } from "@/sessions/session-store";
import { MessageStore } from "@/sessions/message-store";
import { SessionTimelineEventStore } from "@/sessions/session-timeline-event-store";
import { buildMainCapabilities } from "@/runners/capabilities";
import { InvocationStore } from "@/runners/invocation-store";
import { encodeInvocation } from "@/runners/invocation-codec";
import { mainInvocations } from "@/runners/main-invocation-registry";
import { RunnerOperationService } from "@/runners/operation-service";
import { RunnerContextStore } from "@/runners/runner-context-store";
import { TaskInboxStore } from "@/tasks/task-inbox-store";
import { TaskReportService } from "@/tasks/task-report-service";
import { TaskRunStore } from "@/tasks/task-run-store";
import { TaskRunSupervisor } from "@/tasks/task-run-supervisor";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { createRunnerMessageRoutes } from "@/server/routes/runner-messages";
import { createRunnerRequestRoutes } from "@/server/routes/runner-requests";
import {
  fixtureNamedSession,
  fixtureTaskOwnership,
  fixtureUser,
} from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

let home: string;
let db: DataConnection<typeof schema>;
let scope: ReturnType<typeof fixtureNamedSession>;
let ownerDirectSessionId: string;
let seq = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-stage2-proactive-"));
  setLunaHome(home);
  db = new DataConnection(schema);
  scope = fixtureNamedSession(db.db, "group-session", "alice");
  fixtureUser(db.db, scope.agentId, "colleague");
  ownerDirectSessionId = new SessionStore(db.db).createLocalSession("user:alice", {
    agentId: scope.agentId,
    shadowId: scope.shadowId,
  }).id;
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function mintClaims(
  sessionId: string,
  actorUserId = "user:alice",
  originId = `turn-${++seq}`,
): LunaAccessTokenClaims {
  const ctx = new RunnerContextStore(db.db).resolveForSession(sessionId, "codex");
  const invocationId = `inv-${++seq}`;
  const controller = new AbortController();
  const store = new InvocationStore(db.db);
  controller.signal.addEventListener("abort", () => store.revoke(invocationId, "cancelled"));
  mainInvocations(db.db).set(invocationId, {
    invocationId,
    turnId: originId,
    runnerContext: ctx,
    signal: controller.signal,
    input: {
      type: "session_trigger",
      triggerId: "trig-1",
      instruction: "run",
      correlationId: "corr-1",
      hops: 3,
      sourceSessionId: sessionId,
      requesterUserId: actorUserId,
      artifactRefs: [],
      context: { sessionId, candidateOpenTasks: [] },
    },
  });
  const claims: LunaAccessTokenClaims = {
    tokenId: `tok-${seq}`,
    actorUserId,
    source: "runner",
    role: "runner",
    runnerKind: "main",
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    sessionId,
    runnerJobId: ctx.id,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  db.db.insert(schema.accessTokens).values({
    id: claims.tokenId,
    agentId: claims.agentId,
    tokenHash: `hash-${seq}`,
    userId: actorUserId,
    source: "runner",
    name: "test",
    role: "runner",
    issuedAt: 1,
    expiresAt: claims.expiresAt,
    createdAt: 1,
    metadataJson: { invocationId },
  }).run();
  registerTestRunnerJob(
    db.db,
    invocationId,
    claims,
    encodeInvocation("main", mainInvocations(db.db).get(invocationId)!),
    originId,
  );
  return claims;
}

test("unified Luna addresses resolve self, current, session:<id>, main (Task), and task:<id> while enforcing Shadow scope", () => {
  const selfAddr = resolveLunaAddress(
    db.db,
    { agentId: scope.agentId, shadowId: scope.shadowId, currentSessionId: "group-session" },
    "self",
  );
  expect(selfAddr.kind).toBe("self");
  expect(
    db.db.select().from(schema.sessions).where(eq(schema.sessions.id, selfAddr.sessionId)).get()?.title,
  ).toBe("心跳");

  const currentAddr = resolveLunaAddress(
    db.db,
    { agentId: scope.agentId, shadowId: scope.shadowId, currentSessionId: "group-session" },
    "current",
  );
  expect(currentAddr.sessionId).toBe("group-session");

  const sessionAddr = resolveLunaAddress(
    db.db,
    { agentId: scope.agentId, shadowId: scope.shadowId },
    `session:${ownerDirectSessionId}`,
  );
  expect(sessionAddr.sessionId).toBe(ownerDirectSessionId);

  db.db.insert(schema.tasks).values({
    id: "task-addr-1",
    type: "task",
    title: "Address test",
    summary: "Verify main address",
    status: "running",
    primary_session_id: "group-session",
    created_at: 1,
    updated_at: 1,
    last_activity_at: 1,
    ...fixtureTaskOwnership(db.db, "group-session"),
  }).run();
  const mainAddr = resolveLunaAddress(
    db.db,
    { agentId: scope.agentId, shadowId: scope.shadowId, taskId: "task-addr-1" },
    "main",
  );
  expect(mainAddr).toMatchObject({ kind: "main", sessionId: "group-session" });
  expect(parseTaskAddress("task:task-addr-1")).toBe("task-addr-1");
});

test("unified requests support card callbacks (idempotent, 2h default expiry) and multi-turn delegate progress/settlement without post-done mutation", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);

  const groupClaims = mintClaims("group-session", "colleague");
  const ownerClaims = mintClaims(ownerDirectSessionId, "user:alice");

  let activeClaims = groupClaims;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("lunaAccessTokenClaims" as never, activeClaims as never);
    await next();
  });
  app.route("/api/runner", createRunnerMessageRoutes({ db: db.db, channelFor: () => undefined }));
  app.route("/api/runner", createRunnerRequestRoutes({ db: db.db, channelFor: () => undefined }));

  // 1. Create card-backed request from group-session to ownerDirectSessionId.
  const beforeCreate = Date.now();
  const cardReqRes = await app.request("/api/runner/requests", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "confirm-duty-1" },
    body: JSON.stringify({
      to: `session:${ownerDirectSessionId}`,
      goal: "同事希望每天巡检指标看板，是否同意接入？",
      context: "来自项目群的委托",
      options: ["同意", "拒绝"],
    }),
  });
  expect(cardReqRes.status).toBe(201);
  const createdCard = (await cardReqRes.json()) as {
    requestId: string;
    mode: string;
    status: string;
    expiresAt: number;
  };
  expect(createdCard.mode).toBe("card");
  expect(createdCard.status).toBe("open");
  // Default window is 2 hours (7,200,000 ms).
  expect(createdCard.expiresAt).toBeGreaterThanOrEqual(beforeCreate + 2 * 60 * 60 * 1000 - 5_000);

  // Open requests are visible on target session.
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);
  expect(reqSvc.openRequestsForTurn(ownerDirectSessionId).map(r => r.id)).toContain(
    createdCard.requestId,
  );

  // 2. Simulate Feishu card button click ("同意").
  const cardRes = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: createdCard.requestId, option: "同意" },
    operatorIdentity: { externalId: "ou_owner", kind: "user", displayName: "Alice" },
  });
  expect(cardRes?.toast?.type).toBe("success");
  expect(cardRes?.updatedMarkdown).toContain("同意");

  // Repeat click is idempotent and does not re-queue.
  const repeatRes = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: createdCard.requestId, option: "同意" },
    operatorIdentity: { externalId: "ou_owner", kind: "user", displayName: "Alice" },
  });
  expect(repeatRes?.toast?.type).toBe("info");

  const settled = db.db
    .select()
    .from(schema.correlatedRequests)
    .where(eq(schema.correlatedRequests.id, createdCard.requestId))
    .get()!;
  expect(settled.status).toBe("done");
  expect(settled.returnCommandId).toBeTruthy();

  const returnCmd = commands.get(settled.returnCommandId!)!;
  expect(returnCmd.sessionId).toBe("group-session");
  expect((returnCmd.payload as { requestUpdate?: { status: string } }).requestUpdate?.status).toBe(
    "done",
  );

  // 3. Multi-turn delegate request: stays open until explicitly settled via `/update`, supports progress + messages, and rejects post-done updates.
  activeClaims = groupClaims;
  const delRes = await app.request("/api/runner/requests", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "delegate-window-1" },
    body: JSON.stringify({
      to: `session:${ownerDirectSessionId}`,
      goal: "请确认巡检窗口定在早上 9 点还是 10 点，并告知原因",
      expiresInMs: 3 * 60 * 60 * 1000,
    }),
  });
  expect(delRes.status).toBe(201);
  const createdDel = (await delRes.json()) as { requestId: string; mode: string; status: string };
  expect(createdDel.mode).toBe("delegate");
  expect(createdDel.status).toBe("open");

  // Origin sends a mid-flight supplemental message on the open request.
  const msgRes = await app.request(
    `/api/runner/requests/${encodeURIComponent(createdDel.requestId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "del-msg-1" },
      body: JSON.stringify({ message: "补充：周三有例会，9 点可能冲突" }),
    },
  );
  expect(msgRes.status).toBe(202);

  // Target Main posts non-terminal progress (`in_progress`) first.
  activeClaims = ownerClaims;
  const progRes = await app.request(
    `/api/runner/requests/${encodeURIComponent(createdDel.requestId)}/update`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "del-prog-1" },
      body: JSON.stringify({ action: "progress", summary: "已询问日历安排，等待确认" }),
    },
  );
  expect(progRes.status).toBe(200);
  expect(reqSvc.openRequestsForTurn(ownerDirectSessionId).map(r => r.id)).toContain(
    createdDel.requestId,
  );

  // Target Main settles the request (`done`).
  const doneRes = await app.request(
    `/api/runner/requests/${encodeURIComponent(createdDel.requestId)}/update`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "del-done-1" },
      body: JSON.stringify({ action: "done", summary: "定在早上 10 点，避开周三例会" }),
    },
  );
  expect(doneRes.status).toBe(200);
  expect(reqSvc.openRequestsForTurn(ownerDirectSessionId).map(r => r.id)).not.toContain(
    createdDel.requestId,
  );

  // Post-settlement mutation is rejected (`409`); follow-ups use `say --via-main` with zero correlated_requests ticket!
  const postDoneRes = await app.request(
    `/api/runner/requests/${encodeURIComponent(createdDel.requestId)}/update`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "del-late-1" },
      body: JSON.stringify({ action: "done", summary: "想再改回 9 点" }),
    },
  );
  expect(postDoneRes.status).toBe(409);

  const reqCountBeforeSay = db.db.select().from(schema.correlatedRequests).all().length;
  const viaMainRes = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "post-done-followup" },
    body: JSON.stringify({
      to: "session:group-session",
      viaMain: true,
      content: [{ type: "text", text: "补充通知：周五特殊窗口临时改为 9:30" }],
    }),
  });
  expect(viaMainRes.status).toBe(202);
  const viaMainJson = (await viaMainRes.json()) as { commandId: string };
  expect(commands.get(viaMainJson.commandId)?.kind).toBe("session.invoke");
  expect(db.db.select().from(schema.correlatedRequests).all().length).toBe(reqCountBeforeSay);
});

test("overdue open or in_progress request is expired by routine and wakes origin session", () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);

  const reqRow = reqSvc.createRequest({
    actor: {
      userId: "user:alice",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: "group-session",
      currentSessionId: "group-session",
      originId: "turn-req-exp",
    },
    key: "exp-1",
    toAddress: `session:${ownerDirectSessionId}`,
    goal: "请问是否继续？",
    expiresInMs: 60_000,
    now: NOW,
  });
  const [expiredCmdId] = runSelfRoutine(
    { db: db.db, commands, now: NOW + 120_000 },
    createCorrelatedRequestExpiryRoutine(),
  );
  expect(expiredCmdId).toBeDefined();
  expect(
    db.db
      .select()
      .from(schema.correlatedRequests)
      .where(eq(schema.correlatedRequests.id, reqRow.id))
      .get()?.status,
  ).toBe("expired");
});

test("outbound governance throttles duplicate/excess proactive sends, defers during quiet hours, and never throttles passive replies", () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  new PlatformSettingsStore(db.db).patch(
    {
      general: { timezone: "UTC" },
      proactivity: {
        outboundPerSessionPerHour: 2,
        outboundDedupWindowMs: 24 * 60 * MIN,
      },
    },
    "alice",
  );

  const hbOrigin = `${SELF_ROUTINE_ORIGINS.heartbeat}${scope.shadowId}:1`;

  // 1st proactive message succeeds.
  const m1 = commands.accept(
    { userId: "user:alice", sourceSessionId: "group-session", originId: hbOrigin },
    "group-session",
    "message.send",
    "p1",
    { content: "发现指标波动", purpose: "notification" },
  );
  expect(m1.status).toBe("pending");

  // Identical content with a different key within 24h is rejected by deduplication.
  expect(() =>
    commands.accept(
      { userId: "user:alice", sourceSessionId: "group-session", originId: hbOrigin },
      "group-session",
      "message.send",
      "p1-dup",
      { content: "发现指标波动", purpose: "notification" },
    ),
  ).toThrow("Duplicate proactive message");

  // 2nd distinct proactive message succeeds (reaches hourly limit of 2).
  commands.accept(
    { userId: "user:alice", sourceSessionId: "group-session", originId: hbOrigin },
    "group-session",
    "message.send",
    "p2",
    { content: "第二条不同提醒", purpose: "notification" },
  );

  // 3rd distinct proactive message exceeds session hourly limit (2).
  expect(() =>
    commands.accept(
      { userId: "user:alice", sourceSessionId: "group-session", originId: hbOrigin },
      "group-session",
      "message.send",
      "p3",
      { content: "第三条超限提醒", purpose: "notification" },
    ),
  ).toThrow("Session hourly proactive message limit");

  // Timeline recorded throttle internal events.
  const events = new SessionTimelineEventStore(db.db).listForSession("group-session");
  expect(events.some(e => e.controlKind === "outbound_throttled")).toBe(true);

  // Passive user-addressed turn reply is NEVER throttled even when proactive limit is exhausted!
  db.db.insert(schema.sessionTurns).values({
    id: "addressed-turn-1",
    session_id: "group-session",
    turn_kind: "execution",
    status: "running",
    runner_invoked: true,
    reason: "addressed",
    started_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  }).run();
  const passiveReply = commands.accept(
    { userId: "user:alice", sourceSessionId: "group-session", originId: "addressed-turn-1" },
    "group-session",
    "message.send",
    "ans-1",
    { content: "这是被动回复，不受主动限流影响", purpose: "answer" },
  );
  expect(passiveReply.status).toBe("pending");

  // Quiet hours: configure a nearly 24-hour quiet window covering current UTC clock so proactive send enters `deferred`.
  const curUtcHour = new Date().getUTCHours();
  const startHh = String(curUtcHour).padStart(2, "0") + ":00";
  const endHh = String((curUtcHour + 2) % 24).padStart(2, "0") + ":00";
  new AgentSettingsStore(db.db).save("alice", scope.agentId, {
    proactivity: {
      outboundPerSessionPerHour: 10,
      quietHours: { start: startHh, end: endHh },
    },
  });

  const deferredCmd = commands.accept(
    { userId: "user:alice", sourceSessionId: ownerDirectSessionId, originId: hbOrigin },
    ownerDirectSessionId,
    "message.send",
    "quiet-1",
    { content: "夜间提醒", purpose: "notification" },
  );
  expect(deferredCmd.status).toBe("deferred");
  expect(deferredCmd.availableAt).toBeGreaterThan(Date.now());

  // Once wall-clock reaches `deferredCmd.availableAt`, `releaseDeferredOutboundCommands` promotes it to `pending`.
  expect(releaseDeferredOutboundCommands(db.db, deferredCmd.availableAt + 1)).toBe(1);
  expect(commands.get(deferredCmd.id)?.status).toBe("pending");
});

test("owner-targeted approval request resolves `--to owner` server-side, rejects non-owner updates/clicks, preserves non-owner actor on expiry, and links original sourceMessageIds", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);

  // 1. Capabilities advertise `addressScope.allowOwner` without exposing raw owner UUID.
  const caps = buildMainCapabilities(
    db.db,
    {
      type: "session_trigger",
      triggerId: "trig-cap",
      sourceSessionId: "group-session",
      requesterUserId: "colleague",
      instruction: "check",
      artifactRefs: [],
      correlationId: "corr-1",
      hops: 1,
      context: { sessionId: "group-session", candidateOpenTasks: [] },
    },
    { agentId: scope.agentId, shadowId: scope.shadowId, actorUserId: "colleague" },
  );
  expect(caps.addressScope.allowOwner).toBe(true);
  expect("ownerUserId" in caps.identity).toBe(false);

  // 2. Group member (`colleague`) posts a request message in `group-session`.
  const groupMsg = new MessageStore(db.db).appendOnce({
    sessionId: "group-session",
    channelMessageKey: "om_colleague_req",
    role: "user",
    senderUserId: "colleague",
    channel: { id: "luna-dashboard", type: "dashboard" },
    content: [{ type: "text", text: "帮我排查一下线上告警并出报告" }],
  }).row;

  // 3. Main sends an approval card to `--to owner`.
  const approvalReq = reqSvc.createRequest({
    actor: {
      userId: "colleague",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: "group-session",
      currentSessionId: "group-session",
      originId: "turn-colleague-1",
    },
    key: "owner-approval-1",
    toAddress: "owner",
    goal: "群成员 colleague 请求排查线上告警，是否执行？",
    contextSummary: `sourceMessageId=${groupMsg.id}`,
    options: ["同意执行", "同意（后续免审）", "暂不处理"],
    expiresInMs: 3_600_000,
    now: NOW,
  });
  expect(approvalReq.targetUserId).toBe("user:alice");
  expect(approvalReq.targetAddress).toBe("user:user:alice");

  // Direct `updateRequest` by a non-target user is rejected with 403 `request_forbidden`!
  expect(() =>
    reqSvc.updateRequest({
      requestId: approvalReq.id,
      action: "done",
      summary: "同意执行",
      selectedOption: "同意执行",
      resolvedByUserId: "colleague",
      source: "runner",
      expectedShadowId: scope.shadowId,
      expectedTargetSessionId: approvalReq.targetSessionId,
    }),
  ).toThrow("targets another user");

  // Overdue request originated by `colleague` keeps `colleague` as return `actorUserId` (does NOT escalate to owner)!
  reqSvc.createRequest({
    actor: {
      userId: "colleague",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: "group-session",
      currentSessionId: "group-session",
      originId: "turn-colleague-exp",
    },
    key: "owner-approval-exp",
    toAddress: "owner",
    goal: "是否批准？",
    expiresInMs: 60_000,
    now: NOW,
  });
  const [expiredCmdId] = runSelfRoutine(
    { db: db.db, commands, now: NOW + 120_000 },
    createCorrelatedRequestExpiryRoutine(),
  );
  expect(expiredCmdId).toBeTruthy();
  expect(commands.get(expiredCmdId!)?.actorUserId).toBe("colleague");

  // Bind Feishu identities for `colleague` (`ou_colleague`) and `user:alice` (`ou_alice`) to test card operator guard.
  db.db.insert(schema.userIdentityLinks)
    .values([
      {
        id: "link_colleague",
        agentId: scope.agentId,
        userId: "colleague",
        identityNamespace: "feishu",
        identityKind: "open_id",
        identityValue: "ou_colleague",
        identityScope: "app:test",
        confidence: "verified",
        createdAt: "1",
        updatedAt: "1",
      },
      {
        id: "link_owner",
        agentId: scope.agentId,
        userId: "user:alice",
        identityNamespace: "feishu",
        identityKind: "open_id",
        identityValue: "ou_alice",
        identityScope: "app:test",
        confidence: "verified",
        createdAt: "1",
        updatedAt: "1",
      },
    ])
    .run();

  // Non-owner clicking the card is rejected!
  const rejectedClick = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: approvalReq.id, option: "同意执行" },
    operatorIdentity: { externalId: "ou_colleague", kind: "user", displayName: "Colleague" },
  });
  expect(rejectedClick?.toast?.type).toBe("warning");

  // Unbound stranger (`userId === null`) clicking the card is also rejected!
  const strangerClick = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: approvalReq.id, option: "同意执行" },
    operatorIdentity: { externalId: "ou_stranger", kind: "user", displayName: "Stranger" },
  });
  expect(strangerClick?.toast?.type).toBe("warning");

  // Owner clicking the card succeeds and queues `request_update` back to `group-session` with owner actor, role, and `settledCard`.
  const ownerClick = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: approvalReq.id, option: "同意执行" },
    operatorIdentity: { externalId: "ou_alice", kind: "user", displayName: "Alice" },
  });
  expect(ownerClick?.toast?.type).toBe("success");
  expect(ownerClick?.settledCard).toMatchObject({
    selectedOption: "同意执行",
    isNegative: false,
  });

  const settled = db.db
    .select()
    .from(schema.correlatedRequests)
    .where(eq(schema.correlatedRequests.id, approvalReq.id))
    .get()!;
  expect(settled.returnCommandId).toBeTruthy();
  const approvedReturnCmd = commands.get(settled.returnCommandId!)!;
  expect(approvedReturnCmd.actorUserId).toBe("user:alice");
  expect(
    (approvedReturnCmd.payload as { requestUpdate?: { resolvedByRole?: string } })
      .requestUpdate?.resolvedByRole,
  ).toBe("owner");

  // 4. In the `request_update` (`session_trigger`) turn on `group-session`, Main dispatches `task.create`
  // referencing `groupMsg.id` — preserving `colleague` as requester and rejecting foreign message IDs!
  const triggerClaims = mintClaims("group-session", "user:alice", `request-result:${approvalReq.id}`);
  const supervisor = new TaskRunSupervisor({
    db: db.db,
    runnerType: "mock",
    executeRun: async () => ({ kind: "completed", finalReportArtifactId: "art_1" }),
  });
  const opSvc = new RunnerOperationService(db.db, supervisor);

  const taskReceipt = await opSvc.execute(triggerClaims, "task.create", "approved-task-1", {
    title: "排查线上告警",
    summary: "Owner 已同意执行",
    facts: ["来自群聊请求"],
    sourceMessageIds: [groupMsg.id],
    sendStatusCard: false,
  });
  expect(taskReceipt.status).toBe("applied");
  await supervisor.waitForIdle();

  const createdTask = db.db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskReceipt.taskIds[0]!))
    .get()!;
  expect(createdTask.creator_user_id).toBe("colleague");
  expect(createdTask.source_message_id).toBe(groupMsg.id);

  // Foreign message ID not in `group-session` timeline is still rejected!
  const otherMsg = new MessageStore(db.db).appendOnce({
    sessionId: ownerDirectSessionId,
    channelMessageKey: "om_private_other",
    role: "user",
    senderUserId: "user:alice",
    channel: { id: "luna-dashboard", type: "dashboard" },
    content: [{ type: "text", text: "private" }],
  }).row;
  await expect(
    opSvc.execute(triggerClaims, "task.create", "foreign-msg-attempt", {
      title: "越权引用消息",
      summary: "不应允许",
      facts: [],
      sourceMessageIds: [otherMsg.id],
      sendStatusCard: false,
    }),
  ).rejects.toThrow("must belong to this session");
});

test("heartbeatApprovalRequired requires --via-main on Heartbeat say and blocks non-owner outbound until owner approves card", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);

  const selfAddr = resolveLunaAddress(
    db.db,
    { agentId: scope.agentId, shadowId: scope.shadowId },
    "self",
  );
  const hbOrigin = `${SELF_ROUTINE_ORIGINS.heartbeat}${scope.shadowId}:${NOW}`;

  // 1. Default `heartbeatApprovalRequired` is `true`: non-owner request from Heartbeat is blocked!
  expect(() =>
    reqSvc.createRequest({
      actor: {
        userId: "user:alice",
        agentId: scope.agentId,
        shadowId: scope.shadowId,
        sourceSessionId: selfAddr.sessionId,
        currentSessionId: selfAddr.sessionId,
        originId: hbOrigin,
      },
      key: "unapproved-group-req",
      toAddress: "session:group-session",
      goal: "昨日告警解决了吗？",
      now: NOW,
    }),
  ).toThrow("requires owner approval first");

  // 2. Sending an approval card `--to owner` from Heartbeat IS allowed!
  const rejectedAsk = reqSvc.createRequest({
    actor: {
      userId: "user:alice",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: selfAddr.sessionId,
      currentSessionId: selfAddr.sessionId,
      originId: hbOrigin,
    },
    key: "hb-owner-ask-reject",
    toAddress: "owner",
    goal: "准备在群里跟进昨日告警，是否发送？",
    options: ["同意跟进", "暂不发送"],
    now: NOW,
  });
  const { request: rejectedReq } = reqSvc.updateRequest({
    requestId: rejectedAsk.id,
    action: "done",
    summary: "暂不发送",
    selectedOption: "暂不发送",
    resolvedByUserId: "user:alice",
    source: "dashboard",
    now: NOW + 1_000,
  });

  // Negative verdict ("暂不发送") STILL blocks group request in the return turn (`originId = returnCommandId`)!
  expect(() =>
    reqSvc.createRequest({
      actor: {
        userId: "user:alice",
        agentId: scope.agentId,
        shadowId: scope.shadowId,
        sourceSessionId: selfAddr.sessionId,
        currentSessionId: selfAddr.sessionId,
        originId: rejectedReq.returnCommandId!,
      },
      key: "after-reject-hb",
      toAddress: "session:group-session",
      goal: "跟进昨日告警",
      now: NOW + 2_000,
    }),
  ).toThrow("requires owner approval first");

  // 3. Positive owner approval unlocks `say --via-main` AND `requests create` in the return turn on Heartbeat `self` session!
  const approvedAsk = reqSvc.createRequest({
    actor: {
      userId: "user:alice",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: selfAddr.sessionId,
      currentSessionId: selfAddr.sessionId,
      originId: hbOrigin,
    },
    key: "hb-owner-ask-approve",
    toAddress: "owner",
    goal: "准备在群里跟进构建修复进度，是否发送？",
    options: ["同意跟进", "暂不发送"],
    now: NOW + 3_000,
  });
  const { request: answeredReq } = reqSvc.updateRequest({
    requestId: approvedAsk.id,
    action: "done",
    summary: "同意跟进",
    selectedOption: "同意跟进",
    resolvedByUserId: "user:alice",
    source: "dashboard",
    now: NOW + 4_000,
  });

  // Capabilities on `request_update` turn in Heartbeat `self` session advertise `say --via-main` and `requests`.
  const hbReturnCaps = buildMainCapabilities(
    db.db,
    {
      type: "session_trigger",
      triggerId: answeredReq.returnCommandId!,
      sourceSessionId: selfAddr.sessionId,
      requesterUserId: "user:alice",
      instruction: "result",
      artifactRefs: [],
      correlationId: approvedAsk.id,
      hops: 2,
      context: { sessionId: selfAddr.sessionId, candidateOpenTasks: [] },
    },
    { agentId: scope.agentId, shadowId: scope.shadowId, actorUserId: "user:alice" },
  );
  expect(hbReturnCaps.turn.terminalOutputMode).toBe("ignored");
  expect(hbReturnCaps.addressScope.allowCurrent).toBe(false);
  expect(hbReturnCaps.commands).toContain("say --via-main");
  expect(hbReturnCaps.commands).toContain("ask | ask message|cancel|get|list");
  expect(hbReturnCaps.outboundGovernance?.heartbeatApprovalRequired).toBe(true);

  const hbClaims = mintClaims(selfAddr.sessionId, "user:alice", answeredReq.returnCommandId!);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("lunaAccessTokenClaims" as never, hbClaims as never);
    await next();
  });
  app.route("/api/runner", createRunnerMessageRoutes({ db: db.db, channelFor: () => undefined }));

  // Heartbeat calling `/api/runner/messages` WITHOUT `viaMain: true` is rejected (`403 heartbeat_via_main_required`)!
  const directSay = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "hb-direct-bad" },
    body: JSON.stringify({
      to: "session:group-session",
      content: [{ type: "text", text: "直接发言不应允许" }],
    }),
  });
  expect(directSay.status).toBe(403);

  // Heartbeat calling `/api/runner/messages` WITH `viaMain: true` after owner approval succeeds (`202`)!
  const approvedSay = await app.request("/api/runner/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "hb-via-main-ok" },
    body: JSON.stringify({
      to: "session:group-session",
      viaMain: true,
      content: [{ type: "text", text: "请跟进昨日构建修复进度" }],
    }),
  });
  expect(approvedSay.status).toBe(202);

  // Heartbeat `self` session is still forbidden from calling `task.create` directly!
  const opSvc = new RunnerOperationService(
    db.db,
    new TaskRunSupervisor({
      db: db.db,
      runnerType: "mock",
      executeRun: async () => ({ kind: "completed", finalReportArtifactId: "art_hb" }),
    }),
  );
  await expect(
    opSvc.execute(hbClaims, "task.create", "hb-rogue-task", {
      title: "不应由心跳直接创建的任务",
      summary: "禁止",
      facts: [],
      sessionId: "group-session",
      sendStatusCard: false,
    }),
  ).rejects.toThrow("Heartbeat self session cannot create or mutate Tasks");
});

test("Task Runner -> Main request supports fast-path (--wait) and slow-path (Task enters waiting and auto-resumes when Main settles)", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);
  const reportSvc = new TaskReportService(db.db, async () => {});

  db.db.insert(schema.tasks).values({
    id: "task-q-1",
    type: "task",
    title: "Migration task",
    summary: "Run schema migration",
    status: "new",
    primary_session_id: "group-session",
    created_at: 1,
    updated_at: 1,
    last_activity_at: 1,
    ...fixtureTaskOwnership(db.db, "group-session"),
  }).run();

  let runCounter = 0;
  let slowRequestId = "";
  const supervisor = new TaskRunSupervisor({
    db: db.db,
    runnerType: "mock",
    executeRun: async input => {
      runCounter++;
      const invId = `task-inv-${runCounter}`;
      const claims: LunaAccessTokenClaims = {
        tokenId: `task-tok-${runCounter}`,
        actorUserId: "user:alice",
        source: "runner",
        role: "runner",
        runnerKind: "task",
        agentId: scope.agentId,
        shadowId: scope.shadowId,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        runnerJobId: input.runnerContext!.id,
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
      };
      db.db.insert(schema.accessTokens).values({
        id: claims.tokenId,
        agentId: claims.agentId,
        tokenHash: `task-hash-${runCounter}`,
        userId: "user:alice",
        source: "runner",
        name: "task",
        role: "runner",
        issuedAt: 1,
        expiresAt: claims.expiresAt,
        createdAt: 1,
        metadataJson: { invocationId: invId },
      }).run();
      const finish = registerTestRunnerJob(
        db.db,
        invId,
        claims,
        {
          version: 1,
          kind: "task",
          input: {
            taskId: input.taskId,
            taskRunId: input.taskRunId,
            runnerContextId: input.runnerContext!.id,
          },
        },
        input.taskRunId,
      );

      try {
        if (runCounter === 1) {
          // 1. Fast-path: Task asks Main and Main settles within `waitForRequest` window!
          const fastReq = reqSvc.createRequest({
            actor: {
              userId: "user:alice",
              agentId: scope.agentId,
              shadowId: scope.shadowId,
              sourceSessionId: "group-session",
              currentSessionId: "group-session",
              originId: input.taskRunId,
              taskId: input.taskId,
              taskRunId: input.taskRunId,
            },
            key: "fast-q",
            toAddress: "main",
            goal: "目标库名称是什么？",
            now: Date.now(),
          });
          setTimeout(() => {
            reqSvc.updateRequest({
              requestId: fastReq.id,
              action: "done",
              summary: "orders_v2",
              resolvedByUserId: "user:alice",
              source: "runner",
            });
          }, 15);
          const fastView = await reqSvc.waitForRequest({
            shadowId: scope.shadowId,
            requestId: fastReq.id,
            timeoutMs: 2_000,
            consumerTask: {
              taskId: input.taskId,
              runnerContextId: input.runnerContext!.id,
              runId: input.taskRunId,
            },
          });
          expect(fastView.request.status).toBe("done");
          expect(
            (fastView.request.resultJson as { summary?: string } | null)?.summary,
          ).toBe("orders_v2");

          // 2. Slow-path: Task opens a second Request to Main that needs human confirmation, and exits cleanly!
          const slowReq = reqSvc.createRequest({
            actor: {
              userId: "user:alice",
              agentId: scope.agentId,
              shadowId: scope.shadowId,
              sourceSessionId: "group-session",
              currentSessionId: "group-session",
              originId: input.taskRunId,
              taskId: input.taskId,
              taskRunId: input.taskRunId,
            },
            key: "slow-q",
            toAddress: "main",
            goal: "是否允许执行 DROP COLUMN legacy_flag？",
            now: Date.now(),
          });
          slowRequestId = slowReq.id;
          return { kind: "waiting", pauseReason: `Waiting on open Request ${slowReq.id}` };
        }

        // Run 2 (auto-resumed when Main settled `slowRequestId`!): verify inbox received `request_update`, consume it, and submit final report!
        const inboxEvents = new TaskInboxStore(db.db).consumePending({
          taskId: input.taskId,
          runnerContextId: input.runnerContext!.id,
          runId: input.taskRunId,
        });
        expect(inboxEvents).toHaveLength(1);
        expect(inboxEvents[0]?.kind).toBe("request_update");
        expect(inboxEvents[0]?.content).toContain("允许执行");

        const receipt = reportSvc.submit(claims, "final", "Migration orders_v2 completed");
        return { kind: "completed", finalReportArtifactId: receipt.reportArtifactId };
      } finally {
        finish();
      }
    },
  });

  supervisor.startInitialRun({ taskId: "task-q-1", inputSnapshot: {} });
  await supervisor.waitForIdle();

  // After Run 1 exits with an open Request, Task & Run 1 are suspended in `waiting`!
  expect(runCounter).toBe(1);
  expect(
    db.db.select().from(schema.tasks).where(eq(schema.tasks.id, "task-q-1")).get()?.status,
  ).toBe("waiting");
  expect(new TaskRunStore(db.db).listRunsForTask("task-q-1")[0]?.status).toBe("waiting");

  // Main settles `slowRequestId` -> `CorrelatedRequestService` appends `request_update` to `task_inbox_events` AND auto-resumes `task-q-1`!
  reqSvc.updateRequest({
    requestId: slowRequestId,
    action: "done",
    summary: "允许执行，已完成备份",
    resolvedByUserId: "user:alice",
    source: "runner",
  });
  await supervisor.waitForIdle();

  expect(runCounter).toBe(2);
  expect(
    db.db.select().from(schema.tasks).where(eq(schema.tasks.id, "task-q-1")).get()?.status,
  ).toBe("completed");
  expect(new TaskRunStore(db.db).listRunsForTask("task-q-1").at(-1)?.status).toBe("completed");
});

test("group confirmation cards with `--actor` lock card clicks and replies to the designated human user", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);

  const actor = {
    userId: "user:alice",
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    sourceSessionId: "group-session",
    currentSessionId: "group-session",
    originId: "turn-group-card-lock",
  };

  // `--actor` on a group/session request without `--options` is rejected.
  expect(() =>
    reqSvc.createRequest({
      actor,
      key: "group-delegate-actor",
      toAddress: "current",
      targetActor: "user:colleague",
      goal: "请确认接口",
      now: NOW,
    }),
  ).toThrow("requires --options");

  // `--actor` conflicting with direct `--to user:<id>` is rejected.
  expect(() =>
    reqSvc.createRequest({
      actor,
      key: "mismatch-actor",
      toAddress: "owner",
      targetActor: "user:colleague",
      goal: "是否批准？",
      options: ["同意", "拒绝"],
      now: NOW,
    }),
  ).toThrow("conflicts with direct user target");

  // Invalid actor kinds (session/group or unknown user) are rejected.
  expect(() =>
    reqSvc.createRequest({
      actor,
      key: "invalid-session-actor",
      toAddress: "current",
      targetActor: "session:group-session",
      goal: "请确认",
      options: ["确认", "取消"],
      now: NOW,
    }),
  ).toThrow("--actor must be 'owner' or 'user:<luna-user-id>'");
  expect(() =>
    reqSvc.createRequest({
      actor,
      key: "missing-user-actor",
      toAddress: "current",
      targetActor: "user:ou_nonexistent",
      goal: "请确认",
      options: ["确认", "取消"],
      now: NOW,
    }),
  ).toThrow("Actor user not found");

  // Group card locked to `user:colleague` via `--actor`.
  const lockedCard = reqSvc.createRequest({
    actor,
    key: "group-locked-colleague",
    toAddress: "current",
    targetActor: "user:colleague",
    goal: "请确认新接口字段是否符合预期？",
    options: ["符合预期", "需调整"],
    now: NOW,
  });
  expect(lockedCard.targetSessionId).toBe("group-session");
  expect(lockedCard.targetUserId).toBe("colleague");

  // Also verify `--actor owner` resolves to canonical owner user ID on a group card.
  const ownerLockedCard = reqSvc.createRequest({
    actor,
    key: "group-locked-owner",
    toAddress: "current",
    targetActor: "owner",
    goal: "请确认方案切换",
    options: ["同意", "暂缓"],
    now: NOW,
  });
  expect(ownerLockedCard.targetUserId).toBe("user:alice");

  db.db.insert(schema.userIdentityLinks)
    .values([
      {
        id: "link_colleague_lock",
        agentId: scope.agentId,
        userId: "colleague",
        identityNamespace: "feishu",
        identityKind: "open_id",
        identityValue: "ou_colleague_lock",
        identityScope: "app:test",
        confidence: "verified",
        createdAt: "1",
        updatedAt: "1",
      },
      {
        id: "link_alice_lock",
        agentId: scope.agentId,
        userId: "user:alice",
        identityNamespace: "feishu",
        identityKind: "open_id",
        identityValue: "ou_alice_lock",
        identityScope: "app:test",
        confidence: "verified",
        createdAt: "1",
        updatedAt: "1",
      },
    ])
    .run();

  // Owner (`user:alice`) cannot click or settle a group card locked to `colleague`!
  const wrongClick = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: lockedCard.id, option: "符合预期" },
    operatorIdentity: { externalId: "ou_alice_lock", kind: "user", displayName: "Alice" },
  });
  expect(wrongClick?.toast?.type).toBe("warning");
  expect(wrongClick?.toast?.content).toContain("该确认仅限指定负责人");
  expect(
    db.db.select().from(schema.correlatedRequests).where(eq(schema.correlatedRequests.id, lockedCard.id)).get()?.status,
  ).toBe("open");

  expect(() =>
    reqSvc.updateRequest({
      requestId: lockedCard.id,
      action: "done",
      summary: "符合预期",
      selectedOption: "符合预期",
      resolvedByUserId: "user:alice",
      source: "runner",
      expectedShadowId: scope.shadowId,
      expectedTargetSessionId: "group-session",
    }),
  ).toThrow("targets another user");

  // Designated `colleague` clicking the group card settles it cleanly!
  const validClick = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: lockedCard.id, option: "符合预期" },
    operatorIdentity: { externalId: "ou_colleague_lock", kind: "user", displayName: "Colleague" },
  });
  expect(validClick?.toast?.type).toBe("success");
  expect(
    db.db.select().from(schema.correlatedRequests).where(eq(schema.correlatedRequests.id, lockedCard.id)).get()?.status,
  ).toBe("done");
});
