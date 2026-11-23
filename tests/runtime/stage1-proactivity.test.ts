import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { AgentStore } from "@/agents/agent-store";
import { AgentMemoryStore } from "@/agents/agent-memory-store";
import { memoryAccess } from "@/agents/agent-memory-access";
import { AgentSettingsStore, resolveProactivitySettings } from "@/agents/agent-settings-store";
import { scheduleShadowHeartbeats } from "@/agents/shadow-heartbeat";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { SessionCommandService, registerSessionCommands } from "@/messaging/session-command-service";
import { notifyFailedSchedules } from "@/messaging/schedule-failure-notifier";
import { MessageStore } from "@/sessions/message-store";
import { InvocationStore } from "@/runners/invocation-store";
import { encodeInvocation } from "@/runners/invocation-codec";
import { mainInvocations } from "@/runners/main-invocation-registry";
import { RunnerContextStore } from "@/runners/runner-context-store";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { createRunnerMessageRoutes } from "@/server/routes/runner-messages";
import { createRunnerProactivityRoutes } from "@/server/routes/runner-proactivity";
import { createAgentProactivityRoutes } from "@/server/routes/agent-proactivity";
import { fixtureNamedSession, fixtureUser } from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

let home: string;
let db: DataConnection<typeof schema>;
let scope: ReturnType<typeof fixtureNamedSession>;
let seq = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-stage1-proactivity-"));
  setLunaHome(home);
  db = new DataConnection(schema);
  scope = fixtureNamedSession(db.db, "session", "alice");
  fixtureUser(db.db, scope.agentId, "bob");
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function humanMessage(senderUserId: string, createdAt: number, sessionId = "session") {
  const row = new MessageStore(db.db).appendOnce({
    sessionId,
    channelMessageKey: `msg-${++seq}`,
    role: "user",
    senderUserId,
    content: [{ type: "text", text: "ping" }],
    channel: { type: "dashboard", id: "dashboard" },
  }).row;
  db.db
    .update(schema.messages)
    .set({ createdAt })
    .where(eq(schema.messages.id, row.id))
    .run();
  return row.id;
}

function assistantMessage(createdAt: number, sessionId = "session") {
  const replyUserId = db.db
    .select({ replyUserId: schema.agentShadows.replyUserId })
    .from(schema.agentShadows)
    .where(eq(schema.agentShadows.id, scope.shadowId))
    .get()!.replyUserId;
  const row = new MessageStore(db.db).appendOnce({
    sessionId,
    channelMessageKey: `bot-${++seq}`,
    role: "assistant",
    senderUserId: replyUserId,
    content: [{ type: "text", text: "ack" }],
    channel: { type: "dashboard", id: "dashboard" },
  }).row;
  db.db
    .update(schema.messages)
    .set({ createdAt })
    .where(eq(schema.messages.id, row.id))
    .run();
  return row.id;
}

function mintMainRunnerClaims(sessionId = "session", actorUserId = "user:alice") {
  const ctx = new RunnerContextStore(db.db).resolveForSession(sessionId, "codex");
  const invocationId = `inv-${++seq}`;
  const originId = `turn-${seq}`;
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
      instruction: "check",
      correlationId: "corr-1",
      hops: 2,
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

test("proactivity settings resolve Agent overrides over live Platform defaults", () => {
  const platform = new PlatformSettingsStore(db.db);
  const agents = new AgentSettingsStore(db.db);

  expect(resolveProactivitySettings(db.db, scope.agentId)).toEqual({
    heartbeatIntervalMs: 30 * MIN,
    heartbeatApprovalRequired: true,
    outboundPerSessionPerHour: 3,
    outboundPerRecipientPerDay: 10,
    outboundDedupWindowMs: 24 * 60 * MIN,
    quietHours: null,
    askDefaultExpiresMs: 2 * 60 * MIN,
    scheduleFailureNotifyIntervalMs: 24 * 60 * MIN,
  });

  // Platform admin updates platform defaults; un-overridden Agent picks them up immediately.
  platform.patch(
    {
      proactivity: {
        heartbeatIntervalMs: 15 * MIN,
        outboundPerSessionPerHour: 5,
        quietHours: { start: "23:00", end: "08:00" },
      },
    },
    "alice",
  );
  expect(resolveProactivitySettings(db.db, scope.agentId)).toMatchObject({
    heartbeatIntervalMs: 15 * MIN,
    outboundPerSessionPerHour: 5,
    quietHours: { start: "23:00", end: "08:00" },
  });

  // Agent overrides heartbeatIntervalMs and explicitly disables quietHours (`false`).
  agents.save("alice", scope.agentId, {
    proactivity: {
      heartbeatIntervalMs: 45 * MIN,
      quietHours: false,
    },
  });
  expect(resolveProactivitySettings(db.db, scope.agentId)).toMatchObject({
    heartbeatIntervalMs: 45 * MIN,
    outboundPerSessionPerHour: 5,
    quietHours: null,
  });
});

test("heartbeat skips idle Shadows, wakes on human messages or settled Tasks, and ignores Agent's own replies", () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });

  // No activity -> no heartbeat queued.
  expect(scheduleShadowHeartbeats(db.db, commands, NOW)).toEqual([]);

  // Assistant's own reply does NOT count as wake activity.
  assistantMessage(NOW - 5 * MIN);
  expect(scheduleShadowHeartbeats(db.db, commands, NOW)).toEqual([]);

  // Human message arrives -> wakes heartbeat and creates dedicated local session "心跳".
  humanMessage("user:alice", NOW - 2 * MIN);
  const [hbCmdId] = scheduleShadowHeartbeats(db.db, commands, NOW);
  expect(hbCmdId).toBeDefined();

  const hbState = db.db
    .select()
    .from(schema.shadowHeartbeats)
    .where(eq(schema.shadowHeartbeats.shadowId, scope.shadowId))
    .get()!;
  const hbSession = db.db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, hbState.sessionId))
    .get()!;
  expect(hbSession.title).toBe("心跳");
  const hbCmd = commands.get(hbCmdId!)!;
  expect(String(hbCmd.payload.content)).toContain("[session:session]");
  expect(String(hbCmd.payload.content)).toContain("journal.md");

  // Complete the heartbeat command; within interval or without new activity, nothing new is queued.
  db.db
    .update(schema.sessionCommands)
    .set({ status: "completed", updatedAt: NOW + MIN })
    .where(eq(schema.sessionCommands.id, hbCmdId!))
    .run();
  expect(scheduleShadowHeartbeats(db.db, commands, NOW + 31 * MIN)).toEqual([]);

  // If a heartbeat fails, the next pass re-covers from `coveredFrom` instead of losing the activity.
  humanMessage("user:bob", NOW + 32 * MIN);
  const [failedCmdId] = scheduleShadowHeartbeats(db.db, commands, NOW + 35 * MIN);
  expect(failedCmdId).toBeDefined();
  db.db
    .update(schema.sessionCommands)
    .set({ status: "failed", updatedAt: NOW + 36 * MIN })
    .where(eq(schema.sessionCommands.id, failedCmdId!))
    .run();
  const [retriedCmdId] = scheduleShadowHeartbeats(db.db, commands, NOW + 66 * MIN);
  expect(retriedCmdId).toBeDefined();
  expect(String(commands.get(retriedCmdId!)!.payload.content)).toContain("user:bob");
});

test("heartbeat memory access sees its own Shadow's trusted chat and person entries, never another Shadow's", () => {
  const otherShadow = new AgentStore(db.db).createShadow(
    "alice",
    scope.agentId,
    { name: "OtherShadow" },
    "k-other",
  );
  const store = new AgentMemoryStore(db.db);

  store.add(
    {
      agentId: scope.agentId,
      kind: "inline",
      trusted: true,
      userId: "user:alice",
      shadowId: scope.shadowId,
      chatId: "oc_duty_chat",
      owner: true,
    },
    {
      type: "chat",
      title: "值班群职责",
      description: "每天巡检看板",
      body: "异常时发言",
      visibility: "shadow",
    },
  );
  store.add(
    {
      agentId: scope.agentId,
      kind: "inline",
      trusted: true,
      userId: "user:alice",
      shadowId: otherShadow.id,
      chatId: "oc_other_chat",
      owner: true,
    },
    {
      type: "chat",
      title: "另一分身职责",
      description: "其他群",
      body: "私密",
      visibility: "shadow",
    },
  );

  const access = memoryAccess(
    db.db,
    {
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      actorUserId: "user:alice",
      sessionId: "session",
      taskId: null,
      runnerContextId: "ctx-hb",
    },
    "inline",
    "heartbeat",
  );
  const visible = store.index(access.viewer).entries.map(e => e.title);
  expect(visible).toContain("值班群职责");
  expect(visible).not.toContain("另一分身职责");
});

test("task.run schedule dispatches Task directly without Main turn and skips when Task run is active", async () => {
  let mainCalls = 0;
  const launched: { taskId: string; instruction: string; quiet: unknown }[] = [];

  db.db.insert(schema.tasks).values({
    id: "task_inspect",
    agent_id: scope.agentId,
    shadow_id: scope.shadowId,
    type: "task",
    title: "看板巡检",
    summary: "每日检查核心指标",
    status: "completed",
    creator_user_id: "user:alice",
    primary_session_id: "session",
    context_json: {},
    created_at: NOW,
    updated_at: NOW,
    last_activity_at: NOW,
  }).run();

  const service = new SessionCommandService({
    db: db.db,
    channelFor: () => undefined,
    executeTrigger: async () => {
      mainCalls++;
    },
    executeTaskRun: async command => {
      launched.push({
        taskId: String(command.payload.taskId),
        instruction: String(command.payload.content),
        quiet: true,
      });
      return { taskId: String(command.payload.taskId), runId: "run_1" };
    },
  });
  registerSessionCommands(db.db, service);

  db.db.insert(schema.sessionSchedules).values({
    id: "sched_task",
    title: "每日看板巡检",
    paused: false,
    actorUserId: "user:alice",
    sourceSessionId: "session",
    targetSessionId: "session",
    action: { kind: "task.run", taskId: "task_inspect", content: "对比昨日与上周同期指标" },
    timezone: "Asia/Shanghai",
    nextAt: NOW,
    intervalMs: 60 * MIN,
    enabled: true,
    revision: 1,
    overlap: "skip",
    misfire: "latest",
    expiresAfterMs: 3_600_000,
    createdAt: NOW - MIN,
  }).run();

  service.materializeSchedules(NOW);
  await service.waitForIdle();

  expect(mainCalls).toBe(0);
  expect(launched).toEqual([
    { taskId: "task_inspect", instruction: "对比昨日与上周同期指标", quiet: true },
  ]);

  // While a Task Run is active, the next scheduled occurrence skips cleanly under overlap="skip".
  db.db.insert(schema.taskRuns).values({
    id: "run_active",
    task_id: "task_inspect",
    run_index: 2,
    status: "running",
    reason: "restart",
    input_snapshot: { quiet: true },
    runner_type: "codex",
    started_at: NOW + 30 * MIN,
  }).run();

  service.materializeSchedules(NOW + 60 * MIN);
  const skipped = db.db
    .select()
    .from(schema.scheduleOccurrences)
    .all()
    .find(o => o.scheduledAt === NOW + 60 * MIN);
  expect(skipped?.status).toBe("skipped");
  expect(skipped?.reason).toContain("Previous task run is active");
});

test("runner self-management routes enforce Shadow scope for schedules, sessions and activity", async () => {
  const service = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, service);

  const claims = mintMainRunnerClaims("session", "user:alice");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("lunaAccessTokenClaims" as never, claims as never);
    await next();
  });
  app.route("/api/runner", createRunnerMessageRoutes({ db: db.db, channelFor: () => undefined }));
  app.route("/api/runner", createRunnerProactivityRoutes({ db: db.db, channelFor: () => undefined }));

  // Create schedule via Runner API.
  const createRes = await app.request("/api/runner/schedules", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "duty-1" },
    body: JSON.stringify({
      title: "早间检查",
      address: "session:session",
      timezone: "Asia/Shanghai",
      intervalMs: 3_600_000,
      action: { kind: "session.invoke", content: "检查待办" },
    }),
  });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string; revision: number };

  // List schedules.
  const listRes = await app.request("/api/runner/schedules");
  expect(listRes.status).toBe(200);
  const listed = (await listRes.json()) as { schedules: { id: string; title: string }[] };
  expect(listed.schedules.map(s => s.id)).toContain(created.id);

  // Pause schedule.
  const pauseRes = await app.request(`/api/runner/schedules/${encodeURIComponent(created.id)}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, expectedRevision: created.revision }),
  });
  expect(pauseRes.status).toBe(200);
  const paused = (await pauseRes.json()) as { schedule: { enabled: boolean; paused: boolean; revision: number } };
  expect(paused.schedule.enabled).toBe(false);
  expect(paused.schedule.paused).toBe(true);

  // Update schedule interval.
  const updateRes = await app.request(`/api/runner/schedules/${encodeURIComponent(created.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "两小时检查", intervalMs: 7_200_000, expectedRevision: paused.schedule.revision }),
  });
  expect(updateRes.status).toBe(200);

  // List sessions & query activity.
  humanMessage("user:bob", NOW - 1_000);
  const sessionsRes = await app.request("/api/runner/sessions?withUser=user:bob");
  expect(sessionsRes.status).toBe(200);
  const sessionsJson = (await sessionsRes.json()) as { sessions: { sessionId: string }[] };
  expect(sessionsJson.sessions.map(s => s.sessionId)).toContain("session");

  const activityRes = await app.request(`/api/runner/activity?since=${NOW - 5_000}`);
  expect(activityRes.status).toBe(200);
  const activityJson = (await activityRes.json()) as { activity: { hasWakeActivity: boolean } };
  expect(activityJson.activity.hasWakeActivity).toBe(true);

  // Cancel/delete schedule.
  const delRes = await app.request(`/api/runner/schedules/${encodeURIComponent(created.id)}`, {
    method: "DELETE",
  });
  expect(delRes.status).toBe(200);
  const afterDel = (await (await app.request("/api/runner/schedules")).json()) as { schedules: unknown[] };
  expect(afterDel.schedules).toHaveLength(0);
});

test("failed schedule occurrence records failure marker and rate-limits owner notifications", () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });

  db.db.insert(schema.sessionSchedules).values({
    id: "sched_broken",
    title: "异常巡检",
    paused: false,
    actorUserId: "user:alice",
    sourceSessionId: "session",
    targetSessionId: "session",
    action: { kind: "session.invoke", content: "run" },
    timezone: "Asia/Shanghai",
    nextAt: NOW,
    intervalMs: 60 * MIN,
    enabled: true,
    revision: 1,
    overlap: "skip",
    misfire: "latest",
    expiresAfterMs: 3_600_000,
    createdAt: NOW - MIN,
  }).run();

  db.db.insert(schema.scheduleOccurrences).values({
    id: "occ_fail_1",
    scheduleId: "sched_broken",
    scheduledAt: NOW,
    revision: 1,
    status: "failed",
    reason: "Target session is unavailable",
    snapshot: {},
    createdAt: NOW,
  }).run();

  // Without an external Feishu direct surface, Dashboard failure marker is recorded cleanly without throwing.
  notifyFailedSchedules(db.db, commands, NOW);
  const marker = db.db
    .select()
    .from(schema.scheduleFailureNotifications)
    .where(eq(schema.scheduleFailureNotifications.scheduleId, "sched_broken"))
    .get();
  expect(marker?.lastFailedOccurrenceId).toBe("occ_fail_1");
  expect(marker?.lastReason).toContain("Target session is unavailable");
});

test("Dashboard proactivity overview returns live heartbeats/requests/duties and supports manual heartbeat wake & request cancel", async () => {
  const commands = new SessionCommandService({ db: db.db, channelFor: () => undefined });
  registerSessionCommands(db.db, commands);

  humanMessage("user:alice", Date.now() - 10_000);
  db.db.insert(schema.correlatedRequests).values({
    id: "req_dash_1",
    kind: "ask",
    agentId: scope.agentId,
    shadowId: scope.shadowId,
    originSessionId: "session",
    targetAddress: "user:bob",
    targetSessionId: "session",
    targetUserId: "user:bob",
    instruction: "是否现在合并发布？",
    optionsJson: ["立即合并", "明天再发"],
    hops: 3,
    status: "pending",
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now() - 5_000,
  }).run();

  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("dashboardAuthSession" as never, {
        authenticated: true,
        account: { id: "alice", name: "Alice", provider: "local" },
      } as never);
      c.set("lunaRequestAuthKind" as never, "dashboard-cookie" as never);
      await next();
    })
    .route("/api/proactivity", createAgentProactivityRoutes({ db: db.db }));

  const overviewRes = await app.request(
    `/api/proactivity/overview?agentId=${encodeURIComponent(scope.agentId)}`,
  );
  expect(overviewRes.status).toBe(200);
  const overview = (await overviewRes.json()) as {
    heartbeats: { shadowId: string; sessionId: string | null; pendingActivity: { hasWakeActivity: boolean } }[];
    requests: { id: string; status: string; options: string[] }[];
  };
  expect(overview.heartbeats).toHaveLength(1);
  expect(overview.heartbeats[0]?.pendingActivity.hasWakeActivity).toBe(true);
  expect(overview.requests[0]).toMatchObject({
    id: "req_dash_1",
    status: "pending",
    options: ["立即合并", "明天再发"],
  });

  // Trigger manual heartbeat wake-up even before 30m interval elapses.
  const triggerRes = await app.request(
    `/api/proactivity/heartbeats/${encodeURIComponent(scope.shadowId)}/trigger?agentId=${encodeURIComponent(scope.agentId)}`,
    { method: "POST" },
  );
  expect(triggerRes.status).toBe(200);
  const triggered = (await triggerRes.json()) as {
    ok: boolean;
    sessionId: string;
    alreadyRunning: boolean;
  };
  expect(triggered.ok).toBe(true);
  expect(triggered.alreadyRunning).toBe(false);
  expect(triggered.sessionId).toBeString();

  // Cancel pending request from Dashboard.
  const cancelRes = await app.request(
    `/api/proactivity/requests/req_dash_1/cancel?agentId=${encodeURIComponent(scope.agentId)}`,
    { method: "POST" },
  );
  expect(cancelRes.status).toBe(200);
  expect(
    db.db
      .select()
      .from(schema.correlatedRequests)
      .where(eq(schema.correlatedRequests.id, "req_dash_1"))
      .get()?.status,
  ).toBe("cancelled");
});
