import {fixtureExecutionReference} from "../helpers/platform-fixtures";
import {fixtureRunnerContext} from "../helpers/platform-fixtures";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureSessionOwnership} from "../helpers/platform-fixtures";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { accessTokens, sessions, tasks, users, runnerContexts, taskRuns } from "../../src/data/schema";
import { renewInvocationCredentials } from "../../src/runners/invocation-credentials";
import { InvocationService } from "../../src/runners/invocation-service";
import { AgentResourceBuilder } from "../../src/runners/agent-resource-builder";
import { InvocationResources } from "../../src/runners/invocation-resources";
import { PluginRegistry } from "../../src/plugins/registry";
import { InvocationStore } from "../../src/runners/invocation-store";
import { RuntimeFiles } from "../../src/runtime/files";
import { Runtime } from "../../src/runtime/runtime";
import { createDashboardAuthMiddleware, DashboardAuthService } from "../../src/server/auth";
import { createSessionsRoutes } from "../../src/server/routes/sessions";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { config } from "../../src/shared";
import { runtimeStub } from "../fixtures/runtime-stub";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "luna-invocation-authority-"));
  const sqlite = new Database(":memory:"); const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/data/drizzle" });
  db.insert(users).values({ id: "user1", kind: "human", displayName: "Tester", createdAt: "0", updatedAt: "0" }).run();
  db.insert(sessions).values({ id: "session1", created_by_user_id: "user1", channel_type: "test", channel_id: "test", created_at: 0, updated_at: 0 , ...fixtureSessionOwnership(db,"test","test")}).run();
  const session = db.select().from(sessions).where(eq(sessions.id, "session1")).get()!;
  db.insert(runnerContexts).values(fixtureRunnerContext(db, {id: "ctx1", owner_type: "session", owner_id: "session1", runner_type: "claude", runner_root_path: "/unused", created_at: 0, updated_at: 0})).run();
  const store = new InvocationStore(db);
  store.register({ agentConfig:fixtureExecutionReference(db,"ctx1"), id: "inv1", runnerKind: "work", actorUserId: "user1", runnerContextId: "ctx1", sessionId: "session1", taskId: null, taskRunId: null, originId: "turn1",
    inputSnapshot: { version: 1, kind: "work", input: { sessionId: "session1", runnerContextId: "ctx1", turnId: "turn1" } } as never, contextPackIds: [] });
  const resources = new InvocationResources(db, home);
  const builder = new AgentResourceBuilder(db, home, new PluginRegistry());
  const pin = (id: string) => {
    const {selection} = resources.pin(id, builder);
    return {resources: selection, resourceRevision: selection.digest};
  };
  store.createJob("runtime1", { version: 2,
    scope: {agentId: session.agent_id, shadowId: session.shadow_id, placementGeneration: 1}, ...pin("inv1"), jobId: "job1", invocationId: "inv1", environmentId: "luna", runnerContextId: "ctx1", scopeKey: "session:ctx1", runnerKind: "work", sessionId: "session1", input: { runnerType: "claude", prompt: "test" }, credentialsRevision: 1, timeoutMs: 10000 });
  const tokens = new AccessTokenService({ db, signingSecret: "test-secret" });
  const issued = tokens.issueToken({ userId: "user1", name: "test runner", source: "runner", role: "runner", runnerKind: "work", sourceRunnerJobId: "ctx1", sourceSessionId: "session1", ttlMs: 100000, now: Date.now(), metadata: { invocationId: "inv1", artifactIds: ["artifact1"] } });
  store.bindToken("inv1", issued.record.id);
  return { db, store, tokens, issued, pin, authority: new InvocationService(db),
    close() { sqlite.close(); rmSync(home, {recursive: true, force: true}); } };
}

test("renewal preserves scope, allows in-flight old token, and cancellation revokes both", () => {
  const f = fixture();
  try {
    const env = { LUNA_ACCESS_TOKEN: f.issued.token, LUNA_SERVICE_URL: "http://service:8090" };
    const updated = renewInvocationCredentials(f.db, "inv1", env, "test-secret");
    expect(updated.env.LUNA_ACCESS_TOKEN).not.toBe(env.LUNA_ACCESS_TOKEN);
    const fresh = f.tokens.verifyBearer(updated.env.LUNA_ACCESS_TOKEN!, { now: Date.now() });
    expect(fresh.claims).toMatchObject({ runnerKind: "work", runnerJobId: "ctx1", sessionId: "session1" });
    expect(f.db.select().from(accessTokens).where(eq(accessTokens.id, fresh.claims.tokenId)).get()?.metadataJson).toEqual({ invocationId: "inv1", artifactIds: ["artifact1"] });
    expect(f.authority.requireActive(f.issued.claims, "work").invocation.id).toBe("inv1");
    expect(renewInvocationCredentials(f.db, "inv1", updated.env, "test-secret").env).toEqual(updated.env);
    f.authority.revoke("inv1", "user_cancelled");
    for (const token of [env.LUNA_ACCESS_TOKEN, updated.env.LUNA_ACCESS_TOKEN!]) expect(() => f.tokens.verifyBearer(token, { now: Date.now() })).toThrow("revoked_access_token");
    expect(() => renewInvocationCredentials(f.db, "inv1", updated.env, "test-secret")).toThrow("Invocation is no longer active");
  } finally { f.close(); }
});

test("session timeline HTTP rejects a terminal invocation before token expiry", async () => {
  const f = fixture(); const oldSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
  const sandbox = config.sandbox;
  const descriptor = Object.getOwnPropertyDescriptor(config, "sandbox")!;
  Object.defineProperty(config, "sandbox", { configurable: true, get: () => ({ ...sandbox, runtimeConfigFile: "/test/runtime.json" }) });
  process.env.LUNA_ACCESS_TOKEN_SECRET = "test-secret";
  try {
    const app = new Hono(); app.use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db: f.db }));
    app.route("/api/sessions", createSessionsRoutes({db: f.db}));
    const request = () => app.request("http://service/api/sessions/session1/timeline/read", { headers: { Authorization: `Bearer ${f.issued.token}` } });
    expect((await request()).status).toBe(200);
    f.store.consume({ jobId: "job1", seq: 1, kind: "placement", data: { placementState: "terminal" } }, () => {});
    expect((await request()).status).toBe(401);
  } finally {
    Object.defineProperty(config, "sandbox", descriptor);
    if (oldSecret === undefined) delete process.env.LUNA_ACCESS_TOKEN_SECRET; else process.env.LUNA_ACCESS_TOKEN_SECRET = oldSecret;
    f.close();
  }
});

test("shutdown detach followed by local abort does not revoke or remotely cancel the Job", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writePrivateJson } = await import("@luna/execution-store");
  const { RuntimeAgentTransport, RuntimeDetachedError } = await import("../../src/runners/runtime-agent-transport");
  const f = fixture(); const root = mkdtempSync(join(tmpdir(), "luna-detach-"));
  let connected!: () => void; const attached = new Promise<void>(resolve => { connected = resolve; });
  const requests: string[] = [];
  const client = runtimeStub({
    runtimeId: "runtime1",
    async *events(_id, _after, signal) { connected(); if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); },
    async cancel() { requests.push("cancel"); throw new Error("Unexpected cancellation"); },
  });
  const transport = new RuntimeAgentTransport(f.db, client); const abort = new AbortController();
  try {
    const iterator = transport.stream({ id: "message1", role: "user", session_id: "session1", content: [{ type: "text", text: "test" }] }, {
      cwd: root, runnerContextId: "ctx1", isNewSession: true, signal: abort.signal,
      env: { LUNA_INVOCATION_ID: "inv1", LUNA_ACCESS_TOKEN: f.issued.token, LUNA_SERVICE_URL: "http://service:8090" },
    }, "claude", undefined, {});
    const observed = iterator.next().then(() => null, error => error);
    await Promise.race([attached, observed.then(error => { throw error ?? new Error("Stream ended before attachment"); })]);
    const stopped = transport.detach(); abort.abort("Kernel shutdown"); await stopped;
    expect(await observed).toBeInstanceOf(RuntimeDetachedError);
    expect(requests.includes("cancel")).toBe(false);
    expect(f.store.require("inv1").state).toBe("active");
    expect(f.tokens.verifyBearer(f.issued.token, { now: Date.now() }).claims.tokenId).toBe(f.issued.record.id);
  } finally {
    await transport.detach();
    f.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("revoked submit intent is cancelled under its original ID and settles only after Runtime terminal", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { openExecutionDatabase, writePrivateJson } = await import("@luna/execution-store");
  const { TokenAuthority, closeExecutionServer } = await import("@luna/execution-transport");
  const { RuntimeConfig } = await import("../../src/runtime/config");
  const { RuntimeScheduler } = await import("../../src/runtime/scheduler");
  const { runtimeServer } = await import("../../src/runtime/server");
  const { JobReconciler } = await import("../../src/runners/job-reconciler");
  const { sessionDispatcherFor } = await import("../../src/sessions/session-dispatcher");
  const f = fixture(); const root = mkdtempSync(join(tmpdir(), "luna-cancel-recovery-"));
  const runtimeDb = openExecutionDatabase(join(root, "runtime.sqlite"));
  const grants = new TokenAuthority(runtimeDb);
  const serviceToken = grants.issue("service", { role: "service", id: "service1" });
  const adminToken = grants.issue("admin", { role: "runtime", id: "runtime1" });
  const scheduler = new RuntimeScheduler(runtimeDb, RuntimeConfig.parse({ runtimeId: "runtime1", serviceId: "service1", dataRoot: root, serviceToken, adminToken, homeWorkerId: "worker1" }), grants);
  const client = new Runtime(scheduler, new RuntimeFiles(scheduler));
  try {
    const { sessionTurns } = await import("../../src/data/schema");
    for (const id of ["turn1", "turn2"]) f.db.insert(sessionTurns).values({ id, session_id: "session1", turn_kind: "execution", status: "running", runner_invoked: true, reason: "addressed", started_at: 0, created_at: 0, updated_at: 0 }).run();
    // Case 1: Service committed its intent but crashed before POST /jobs.
    scheduler.mode.drain();
    f.authority.revoke("inv1", "user_cancelled");
    await new JobReconciler(f.db, client, AbortSignal.timeout(5000)).recover();
    expect(scheduler.jobs.list()).toHaveLength(1);
    expect(scheduler.jobs.require("job1")).toMatchObject({ placementState: "terminal", cancelRequested: true, workerId: null });
    expect(f.store.job("job1")?.state).toBe("settled");
    expect(f.store.require("inv1")).toMatchObject({ state: "revoked" });
    expect(f.store.require("inv1").settledAt).not.toBeNull();
    expect(f.db.select().from(sessionTurns).where(eq(sessionTurns.id, "turn1")).get()?.status).toBe("failed");
    scheduler.mode.resume();

    // Case 2: a dispatched Job stays bound while its Worker cannot confirm cancellation.
    f.db.insert(runnerContexts).values(fixtureRunnerContext(f.db, {id: "ctx2", owner_type: "session", owner_id: "session1", runner_type: "codex", runner_root_path: "/unused", created_at: 0, updated_at: 0})).run();
    const snapshot = { version: 1 as const, kind: "work", input: { sessionId: "session1", runnerContextId: "ctx2", turnId: "turn2" } };
    f.store.register({ id: "inv2", runnerKind: "work", actorUserId: "user1", runnerContextId: "ctx2", sessionId: "session1", taskId: null, taskRunId: null, originId: "turn2", inputSnapshot: snapshot, contextPackIds: [] });
    const job = f.store.createJob("runtime1", { ...f.store.job("job1")!.request, ...f.pin("inv2"), jobId: "job2", invocationId: "inv2", runnerContextId: "ctx2", scopeKey: "session:ctx2" });
    await client.submit(job.request); scheduler.jobs.reserve("job2", "original_worker");
    f.authority.revoke("inv2", "user_cancelled");
    const detach = new AbortController(); const recovery = new JobReconciler(f.db, client, detach.signal).recover();
    let nextTurn = false;
    const lane = sessionDispatcherFor(f.db).dispatch({ kind: "user_messages", sessionId: "session1" }, async () => { nextTurn = true; });
    try {
      const deadline = Date.now() + 2000;
      while (!scheduler.jobs.require("job2").cancelRequested && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(scheduler.jobs.require("job2")).toMatchObject({ cancelRequested: true, workerId: "original_worker", placementState: "preparing" });
      expect(f.store.job("job2")?.state).not.toBe("settled");
      expect(f.store.require("inv2").settledAt).toBeNull();
      expect(nextTurn).toBe(false);
      expect(f.db.select().from(sessionTurns).where(eq(sessionTurns.id, "turn2")).get()?.status).toBe("running");
    } finally { detach.abort(); await recovery; await lane; }
    expect(f.store.require("inv2").settledAt).toBeNull();
  } finally { scheduler.stop();  runtimeDb.close(); f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("user cancellation terminates an unaccepted submit intent without waiting for drain to resume", async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { openExecutionDatabase, writePrivateJson } = await import("@luna/execution-store");
  const { TokenAuthority, closeExecutionServer } = await import("@luna/execution-transport");
  const { RuntimeConfig } = await import("../../src/runtime/config");
  const { RuntimeScheduler } = await import("../../src/runtime/scheduler");
  const { runtimeServer } = await import("../../src/runtime/server");
  const { RuntimeAgentTransport } = await import("../../src/runners/runtime-agent-transport");
  const f = fixture(); const root = mkdtempSync(join(tmpdir(), "luna-drain-cancel-"));
  const runtimeDb = openExecutionDatabase(join(root, "runtime.sqlite")); const grants = new TokenAuthority(runtimeDb);
  const serviceToken = grants.issue("service", { role: "service", id: "service" });
  const scheduler = new RuntimeScheduler(runtimeDb, RuntimeConfig.parse({ runtimeId: "runtime1", serviceId: "service", dataRoot: root, serviceToken, adminToken: "a".repeat(43), homeWorkerId: "worker" }), grants);
  scheduler.mode.drain();
  const client = new Runtime(scheduler, new RuntimeFiles(scheduler));
  const transport = new RuntimeAgentTransport(f.db, client); const abort = new AbortController(); const reason = new Error("User cancelled during drain");
  const timer = setTimeout(() => abort.abort(reason), 50);
  try {
    const iterator = transport.stream({ id: "message1", role: "user", session_id: "session1", content: [{ type: "text", text: "test" }] }, {
      cwd: root, runnerContextId: "ctx1", isNewSession: true, signal: abort.signal,
      env: { LUNA_INVOCATION_ID: "inv1", LUNA_ACCESS_TOKEN: f.issued.token },
    }, "claude", undefined, {});
    expect(await iterator.next().then(() => null, error => error)).toBe(reason);
    expect(scheduler.mode.state().draining).toBe(true);
    expect(scheduler.jobs.require("job1")).toMatchObject({ placementState: "terminal", cancelRequested: true, workerId: null });
    expect(f.store.job("job1")?.state).toBe("terminal");
    expect(f.store.require("inv1").state).toBe("revoked");
    expect(existsSync(join(root, "credentials"))).toBe(false);
  } finally {
    clearTimeout(timer); await transport.detach(); scheduler.stop();
    runtimeDb.close(); f.close(); rmSync(root, { recursive: true, force: true });
  }
});

for (const remainingMs of [-1, 30000]) test(`reattach refreshes a token with ${remainingMs}ms remaining before the first upload`, async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { writePrivateJson, ExecutionError } = await import("@luna/execution-store");
  const { TokenAuthority, executionServer, readJson, json, closeExecutionServer } = await import("@luna/execution-transport");
  const { RuntimeAgentTransport } = await import("../../src/runners/runtime-agent-transport");
  const f = fixture(); const root = mkdtempSync(join(tmpdir(), "luna-expired-reattach-"));
  const oldSecret = process.env.LUNA_ACCESS_TOKEN_SECRET; process.env.LUNA_ACCESS_TOKEN_SECRET = "test-secret";
  f.db.update(accessTokens).set({ expiresAt: Date.now() + remainingMs }).where(eq(accessTokens.id, f.issued.record.id)).run();
  const uploads: { expiresAt: number; env: Record<string, string> }[] = [];
  const client = runtimeStub({
    runtimeId: "runtime1",
    async credentials(_id, credentials) { uploads.push(credentials); throw new ExecutionError(422, "test_credentials_boundary"); },
  });
  const transport = new RuntimeAgentTransport(f.db, client);
  try {
    const iterator = transport.stream({ id: "message", role: "user", session_id: "session1", content: [{ type: "text", text: "resume" }] }, { cwd: root, runnerContextId: "ctx1", isNewSession: false, env: { LUNA_INVOCATION_ID: "inv1", LUNA_ACCESS_TOKEN: f.issued.token } }, "claude", undefined, {});
    await expect(iterator.next()).rejects.toMatchObject({ code: "test_credentials_boundary" });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(uploads[0]!.env.LUNA_ACCESS_TOKEN).not.toBe(f.issued.token);
    const claims = f.tokens.verifyBearer(uploads[0]!.env.LUNA_ACCESS_TOKEN!, { now: Date.now() }).claims;
    expect(f.authority.requireActive(claims, "work").invocation.id).toBe("inv1");
    expect(f.store.jobsFor("inv1").map(job => job.id)).toEqual(["job1"]);
  } finally {
    await transport.detach();  f.close(); rmSync(root, { recursive: true, force: true });
    if (oldSecret === undefined) delete process.env.LUNA_ACCESS_TOKEN_SECRET; else process.env.LUNA_ACCESS_TOKEN_SECRET = oldSecret;
  }
});


test("Main may deliver a completed task result without claiming the Task execution scope", () => {
  const f = fixture();
  try {
    f.db.insert(tasks).values({ id: "completed-task", type: "execution", title: "Completed", status: "completed", created_at: 0, updated_at: 0, last_activity_at: 0 , ...fixtureTaskOwnership(f.db,"session1")}).run();
    const context = {id: "main-context", owner_type: "session", owner_id: "session1", runner_type: "codex", runner_root_path: "/unused", created_at: 0, updated_at: 0};
    f.db.insert(runnerContexts).values(fixtureRunnerContext(f.db, context)).run();
    f.db.insert(runnerContexts).values(fixtureRunnerContext(f.db, {...context, id: "task-context", owner_type: "task", owner_id: "completed-task"})).run();
    f.db.insert(taskRuns).values({id: "old-run", task_id: "completed-task", run_index: 1, status: "completed", reason: "test", input_snapshot: {}, runner_type: "claude", runner_context_id: "task-context", started_at: 0}).run();
    const snapshot = {version: 1 as const, kind: "main", input: {
      runnerContext: {...fixtureRunnerContext(f.db, context), runner_session_id: null, instruction_fingerprint: null, workspacePath: "/unused", ipcPath: "/unused", last_run_id: null},
      input: {type: "task_result", sessionId: "session1", taskId: "completed-task", context: {sessionId: "session1", candidateOpenTasks: []},
        result: {taskId: "completed-task", taskRunId: "old-run", status: "completed", title: "Completed", summary: "Done", evidenceSummary: [], userVisibleReport: "Done", artifactIds: [], nextActions: []}}
    }};
    const base = {actorUserId: "user1", sessionId: "session1", taskId: "completed-task", taskRunId: "old-run", contextPackIds: []};
    f.store.register({...base, id: "main-result", runnerKind: "main", runnerContextId: "main-context", originId: "task-result", inputSnapshot: snapshot});
    expect(f.authority.requireScope("main-result").runnerKind).toBe("main");
    const taskSnapshot = {version: 1 as const, kind: "task", input: {taskId: "completed-task", taskRunId: "old-run", runnerContextId: "task-context"}};
    f.store.register({...base, id: "task-execution", runnerKind: "task", runnerContextId: "task-context", originId: "task-run", inputSnapshot: taskSnapshot});
    expect(() => f.authority.requireScope("task-execution")).toThrow("Task run is no longer current");
    f.authority.revoke("main-result", "cancelled");
    expect(() => f.authority.requireScope("main-result")).toThrow("Invocation is no longer active");
  } finally { f.close(); }
});

test("startup recovery cancels an invocation whose actor was disabled", async () => {
  const {JobReconciler} = await import("../../src/runners/job-reconciler");
  const f = fixture();
  try {
    f.db.update(users).set({status:"disabled"}).where(eq(users.id,"user1")).run();
    const cancelled: string[] = [];
    const runtime = runtimeStub({
      async cancelIntent(request) { cancelled.push(request.jobId); return {placementState: "terminal"} as never; },
      async *events(id) { yield {jobId: id, seq: 1, kind: "placement", data: {placementState: "terminal"}}; },
    });
    await new JobReconciler(f.db, runtime, AbortSignal.timeout(2000)).recover();
    expect(cancelled).toEqual(["job1"]);
    expect(f.store.require("inv1")).toMatchObject({state: "revoked", revokeReason: "active_user_required"});
    expect(f.store.require("inv1").settledAt).not.toBeNull();
    expect(() => f.tokens.verifyBearer(f.issued.token, {now: Date.now()})).toThrow("revoked_access_token");
  } finally {f.close();}
});

for (const boundary of ["submit", "events"] as const) test(`disabled actor at ${boundary} cannot upload credentials or publish late output`, async () => {
  const {RuntimeAgentTransport} = await import("../../src/runners/runtime-agent-transport");
  const f = fixture();
  const revoke = () => f.db.update(users).set({status:"disabled"}).where(eq(users.id,"user1")).run();
  const uploads: string[] = [], outputs: unknown[] = [];
  const runtime = runtimeStub({
    async submit() { if (boundary === "submit") revoke(); return {placementState: boundary === "submit" ? "queued" : "terminal"} as never; },
    async credentials(id) { uploads.push(id); },
    async *events(id) {
      revoke();
      yield {jobId: id, seq: 1, kind: "execution", data: {event: {seq: 1, at: 1, kind: "provider", data: {status: "stream", text: "must not publish"}}}};
      yield {jobId: id, seq: 2, kind: "placement", data: {placementState: "terminal"}};
    },
  });
  const transport = new RuntimeAgentTransport(f.db, runtime);
  try {
    const collect = async () => {
      for await (const event of transport.stream({id: "message", role: "user", session_id: "session1", content: [{type: "text", text: "test"}]},
        {cwd: "/unused", runnerContextId: "ctx1", isNewSession: true, env: {LUNA_INVOCATION_ID: "inv1", LUNA_ACCESS_TOKEN: f.issued.token}}, "claude", undefined, {})) outputs.push(event);
    };
    await expect(collect()).rejects.toThrow();
    expect(uploads).toEqual([]); expect(outputs).toEqual([]);
    expect(f.store.require("inv1").state).toBe("revoked");
    if (boundary === "events") expect(f.store.job("job1")).toMatchObject({state: "terminal", cursor: 2});
  } finally {await transport.detach(); f.close();}
});

test("scope revoked during health check prevents preparation and Job creation", async () => {
  const {RuntimeAgentTransport} = await import("../../src/runners/runtime-agent-transport");
  const f = fixture();
  const original = f.store.require("inv1");
  f.store.register({agentConfig:fixtureExecutionReference(f.db,"ctx1"), id: "preparing", originId: "prepare-turn", runnerKind: "work", actorUserId: "user1", runnerContextId: "ctx1", sessionId: "session1", taskId: null, taskRunId: null, inputSnapshot: original.inputSnapshot, contextPackIds: []});
  const calls: string[] = [];
  const runtime = runtimeStub({
    async verify() { f.db.update(users).set({status:"disabled"}).where(eq(users.id,"user1")).run(); },
    async files<T>() { calls.push("files"); return {} as T; },
    async submit() { calls.push("submit"); return {} as never; },
  });
  const transport = new RuntimeAgentTransport(f.db, runtime);
  try {
    const iterator = transport.stream({id: "message", role: "user", session_id: "session1", content: [{type: "text", text: "test"}]},
      {cwd: "/unused", runnerContextId: "ctx1", isNewSession: true, env: {LUNA_INVOCATION_ID: "preparing"}}, "claude", undefined, {});
    await expect(iterator.next()).rejects.toThrow("active_user_required");
    expect(calls).toEqual([]);
    expect(f.store.jobsFor("preparing")).toHaveLength(0);
  } finally {await transport.detach(); f.close();}
});

test("periodic cancellation reaches a revoked Job while its live stream owns the session lane", async () => {
  const {RuntimeAgentTransport} = await import("../../src/runners/runtime-agent-transport");
  const {sessionDispatcherFor} = await import("../../src/sessions/session-dispatcher");
  const f = fixture();
  let connected!: () => void, cancelled!: () => void;
  const attached = new Promise<void>(resolve => {connected = resolve;});
  const cancellation = new Promise<void>(resolve => {cancelled = resolve;});
  const requests: string[] = [];
  const runtime = runtimeStub({
    async credentials() {},
    async cancelIntent(request) {requests.push(request.jobId); cancelled(); return {placementState: "terminal"} as never;},
    async *events(id, after, signal) {
      connected();
      if (after === 0) {
        await Promise.race([cancellation, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}))]);
        if (!signal.aborted) yield {jobId: id, seq: 1, kind: "placement", data: {placementState: "terminal"}};
      }
    },
  });
  const transport = new RuntimeAgentTransport(f.db, runtime);
  transport.recoverCancellations();
  const dispatcher = sessionDispatcherFor(f.db);
  const running = dispatcher.dispatch({kind: "session_trigger", sessionId: "session1"}, async () => {
    for await (const _ of transport.stream({id: "message", role: "user", session_id: "session1", content: [{type: "text", text: "test"}]},
      {cwd: "/unused", runnerContextId: "ctx1", isNewSession: true, env: {LUNA_INVOCATION_ID: "inv1", LUNA_ACCESS_TOKEN: f.issued.token}}, "claude", undefined, {})) {}
  }).then(() => null, error => error);
  try {
    await attached;
    f.authority.revoke("inv1", "scope_disabled");
    expect(f.store.require("inv1").settledAt).toBeNull();
    const outcome = await Promise.race([running, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancellation deadlock")), 4000))]);
    expect(outcome).toBeInstanceOf(Error);
    await dispatcher.dispatch({kind: "session_trigger", sessionId: "session1"}, async () => {});
    expect(requests).toContain("job1");
    expect(f.store.job("job1")?.state).toBe("settled");
    expect(f.store.require("inv1").settledAt).not.toBeNull();
  } finally {await transport.detach(); await running; f.close();}
});


test("transport rejects missing or mismatched pinned model before contacting Runtime", async () => {
 const {RuntimeAgentTransport}=await import("../../src/runners/runtime-agent-transport");
 const f=fixture();let calls=0;
 const transport=new RuntimeAgentTransport(f.db,runtimeStub({async verify(){calls++;}}));
 try {
  const base=f.store.require("inv1");
  f.store.register({id:"unpinned",runnerKind:base.runnerKind,actorUserId:base.actorUserId,runnerContextId:base.runnerContextId,
   sessionId:base.sessionId,taskId:base.taskId,taskRunId:base.taskRunId,originId:"unconfigured",inputSnapshot:base.inputSnapshot,contextPackIds:[]});
  for(const [id,type,model] of [["inv1","codex",undefined],["inv1","claude","different"],["unpinned","claude",undefined]] as const){
   const stream=transport.stream({id:"message",role:"user",session_id:"session1",content:[{type:"text",text:"test"}]},
    {cwd:"/unused",runnerContextId:"ctx1",isNewSession:true,env:{LUNA_INVOCATION_ID:id}},type,model,{});
   await expect(stream.next()).rejects.toMatchObject({code:"invocation_config_mismatch"});
  }
  expect(calls).toBe(0);
 } finally {await transport.detach();f.close();}
});
