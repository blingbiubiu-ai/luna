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
import { resolveLunaAddress } from "@/messaging/luna-address";
import { releaseDeferredOutboundCommands } from "@/messaging/outbound-governance";
import {
  SessionCommandService,
  registerSessionCommands,
} from "@/messaging/session-command-service";
import { SessionStore } from "@/sessions/session-store";
import { SessionTimelineEventStore } from "@/sessions/session-timeline-event-store";
import { InvocationStore } from "@/runners/invocation-store";
import { encodeInvocation } from "@/runners/invocation-codec";
import { mainInvocations } from "@/runners/main-invocation-registry";
import { RunnerContextStore } from "@/runners/runner-context-store";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { createRunnerMessageRoutes } from "@/server/routes/runner-messages";
import { createRunnerRequestRoutes } from "@/server/routes/runner-requests";
import { fixtureNamedSession, fixtureUser } from "../helpers/platform-fixtures";
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

test("unified Luna addresses resolve self, current, and session:<id> while enforcing Shadow scope", () => {
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
});

test("ask resolves via text answer or card button callback (idempotent) and routes request_result back to origin", async () => {
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

  // 1. Create card-backed ask from group-session to ownerDirectSessionId.
  const askRes = await app.request("/api/runner/asks", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "confirm-duty-1" },
    body: JSON.stringify({
      to: `session:${ownerDirectSessionId}`,
      question: "同事希望每天巡检指标看板，是否同意接入？",
      context: "来自项目群的委托",
      options: ["同意", "拒绝"],
    }),
  });
  expect(askRes.status).toBe(201);
  const createdAsk = (await askRes.json()) as { requestId: string; status: string };
  expect(createdAsk.status).toBe("pending");

  // Pending asks are visible on target session.
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);
  expect(reqSvc.pendingAsksForTurn(ownerDirectSessionId).map(r => r.id)).toContain(
    createdAsk.requestId,
  );

  // 2. Simulate Feishu card button click ("同意").
  const cardRes = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: createdAsk.requestId, option: "同意" },
    operatorIdentity: { externalId: "ou_owner", kind: "user", displayName: "Alice" },
  });
  expect(cardRes?.toast?.type).toBe("success");
  expect(cardRes?.updatedMarkdown).toContain("同意");

  // Repeat click is idempotent and does not re-queue.
  const repeatRes = await reqSvc.handleCardAction({
    channel: { id: "ch-1", type: "feishu" },
    actionValue: { requestId: createdAsk.requestId, option: "同意" },
    operatorIdentity: { externalId: "ou_owner", kind: "user", displayName: "Alice" },
  });
  expect(repeatRes?.toast?.type).toBe("info");

  const settled = db.db
    .select()
    .from(schema.correlatedRequests)
    .where(eq(schema.correlatedRequests.id, createdAsk.requestId))
    .get()!;
  expect(settled.status).toBe("answered");
  expect(settled.returnCommandId).toBeTruthy();

  const returnCmd = commands.get(settled.returnCommandId!)!;
  expect(returnCmd.sessionId).toBe("group-session");
  expect((returnCmd.payload as { requestResult?: { status: string } }).requestResult?.status).toBe(
    "answered",
  );

  // 3. Create a text-answered ask and resolve via Runner endpoint.
  const askRes2 = await app.request("/api/runner/asks", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "confirm-duty-2" },
    body: JSON.stringify({
      to: `session:${ownerDirectSessionId}`,
      question: "巡检时间定在早上 9 点还是 10 点？",
    }),
  });
  const createdAsk2 = (await askRes2.json()) as { requestId: string };
  activeClaims = ownerClaims;
  const ansRes = await app.request(`/api/runner/asks/${encodeURIComponent(createdAsk2.requestId)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "早上 9 点" }),
  });
  expect(ansRes.status).toBe(200);
});

test("overdue pending ask is expired by routine and handoff returns done/declined result to origin", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);
  const reqSvc = new CorrelatedRequestService(db.db, () => undefined);

  // 1. Overdue ask expires and wakes origin session.
  const askRow = reqSvc.createAsk({
    actor: {
      userId: "user:alice",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: "group-session",
      currentSessionId: "group-session",
      originId: "turn-ask-exp",
    },
    key: "exp-1",
    toAddress: `session:${ownerDirectSessionId}`,
    question: "请问是否继续？",
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
      .where(eq(schema.correlatedRequests.id, askRow.id))
      .get()?.status,
  ).toBe("expired");

  // 2. Handoff from Heartbeat session to group-session settles automatically on target turn completion.
  const selfAddr = resolveLunaAddress(
    db.db,
    { agentId: scope.agentId, shadowId: scope.shadowId },
    "self",
  );
  const { command: handoffCmd, request: handoffReq } = reqSvc.createHandoff({
    actor: {
      userId: "user:alice",
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      sourceSessionId: selfAddr.sessionId,
      currentSessionId: selfAddr.sessionId,
      originId: `${SELF_ROUTINE_ORIGINS.heartbeat}${scope.shadowId}:${NOW}`,
    },
    key: "hb-followup-1",
    targetSessionId: "group-session",
    targetAddress: "session:group-session",
    instruction: "跟进昨日未完成的构建失败问题",
    now: NOW,
  });

  // Target session Main sends a message during `handoffCmd.id` turn, then trigger settles.
  commands.accept(
    {
      userId: "user:alice",
      sourceSessionId: "group-session",
      originId: handoffCmd.id,
    },
    "group-session",
    "message.send",
    "followup-msg",
    { content: "提醒一下：昨日构建失败问题还需要确认修复进度。", purpose: "notification" },
  );
  reqSvc.settleHandoffFromTrigger(handoffCmd, "completed");

  const settledHandoff = db.db
    .select()
    .from(schema.correlatedRequests)
    .where(eq(schema.correlatedRequests.id, handoffReq.id))
    .get()!;
  expect(settledHandoff.status).toBe("done");
  expect(settledHandoff.returnCommandId).toBeTruthy();
  expect(commands.get(settledHandoff.returnCommandId!)?.sessionId).toBe(selfAddr.sessionId);
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
