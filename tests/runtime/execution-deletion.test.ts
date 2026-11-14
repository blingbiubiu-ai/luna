import {fixtureJobScope} from "../helpers/job-scope";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureScope} from "../helpers/platform-fixtures";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { config, setLunaHome } from "../../src/shared";
import { SessionStore } from "../../src/sessions/session-store";
import { RunnerContextStore, bindRunnerContextsToRuntime } from "../../src/runners/runner-context-store";
import { deleteDashboardSession } from "../../src/dashboard-api/deletion";
import { deleteDashboardTask } from "../../src/dashboard-api/task-deletion";
import { InvocationStore } from "../../src/runners/invocation-store";
import { ContextPreparationManager } from "../../src/runtime/context-preparation";
import { drainExecutionCleanup } from "../../src/runners/execution-cleanup";
import type { ExecutionRuntime } from "../../src/runtime/execution-runtime";
import { contentHash } from "@luna/execution-store";
import type { JobRequest } from "@luna/runner-protocol";

for (const kind of ["session", "task"] as const) test(`${kind} deletion removes execution payloads and retries downstream cleanup after disconnection`, async () => {
  const previousHome = config.paths.home;
  const home = mkdtempSync(join(tmpdir(), "luna-execution-deletion-")); setLunaHome(home);
  const connection = new DataConnection(schema), db = connection.db;
  const executionDb = new Database(":memory:");
  try {
    const session = new SessionStore(db).createLocalSession("admin",fixtureScope(db,"admin"));
    if (kind === "task") db.insert(schema.tasks).values({ id: "task", type: "task", title: "delete", status: "completed", priority: "medium", created_at: 1, updated_at: 1, last_activity_at: 1 , ...fixtureTaskOwnership(db, session.id)}).run();
    bindRunnerContextsToRuntime(db, "runtime");
    const contexts = new RunnerContextStore(db);
    const context = kind === "session" ? contexts.resolveForSession(session.id, "codex") : contexts.resolveForTask("task", "codex");
    const job: JobRequest = { version: 2, ...fixtureJobScope(session.agent_id, session.shadow_id), jobId: "job", invocationId: "inv", environmentId: "environment", runnerContextId: context.id, scopeKey: "scope", runnerKind: kind === "session" ? "main" : "task", sessionId: session.id, ...(kind === "task" ? { taskId: "task", taskRunId: "run" } : {}), input: { runnerType: "codex", prompt: "deleted input" }, credentialsRevision: 1, timeoutMs: 1000 };
    db.insert(schema.runnerInvocations).values({ agentId: session.agent_id, shadowId: session.shadow_id, id: "inv", runnerKind: job.runnerKind, actorUserId: "admin", runnerContextId: context.id, sessionId: session.id, ...(kind === "task" ? { taskId: "task" } : {}), originId: "origin", state: "settled", inputSnapshot: { version: 1, input: "deleted input" }, contextPackIds: [], createdAt: 1, settledAt: 2 }).run();
    db.insert(schema.runnerJobs).values({ id: job.jobId, runtimeId: "runtime", invocationId: "inv", request: job, requestHash: contentHash(job), state: "settled", createdAt: 1, updatedAt: 2 }).run();
    if (kind === "session") {
      db.insert(schema.tasks).values({
        id: "survivor", type: "task", title: "Surviving task", status: "completed", priority: "medium",
        primary_session_id: session.id, created_at: 1, updated_at: 1, last_activity_at: 1,
        ...fixtureTaskOwnership(db, session.id),
      }).run();
      const taskContext = contexts.resolveForTask("survivor", "codex");
      db.insert(schema.runnerInvocations).values({
        id: "task-history", agentId: session.agent_id, shadowId: session.shadow_id, runnerKind: "task",
        actorUserId: "admin", runnerContextId: taskContext.id, sessionId: session.id, taskId: "survivor",
        originId: "task-origin", state: "settled", inputSnapshot: {version: 1, input: "retained task input"},
        contextPackIds: [], createdAt: 1, settledAt: 2,
      }).run();
    }
    const deleteOwner = () => kind === "session" ? deleteDashboardSession(db, session.id) : deleteDashboardTask(db, "task");
    const invocations = new InvocationStore(db);
    const releases: unknown[] = [];
    const scheduler = {
      preparationSettled: (id: string) => invocations.canReleasePreparation(id),
      jobs: {list: () => []},
      workers: {client: () => ({call: async (_method: string, _path: string, body: unknown) => { releases.push(body); }})},
    } as unknown as ConstructorParameters<typeof ContextPreparationManager>[1];
    const preparation = new ContextPreparationManager(executionDb, scheduler);
    executionDb.prepare("INSERT INTO runtime_preparation_intents VALUES (?, ?, ?, ?, 'active', NULL)").run(
      "inv", JSON.stringify({protocolVersion: 2, invocationId: "inv", scope: {agentId: session.agent_id, shadowId: session.shadow_id},
        resources: job.resources, contextId: context.id, runnerId: context.id, scopeKey: job.scopeKey, runnerKind: job.runnerKind}),
      "worker", 1,
    );
    db.run(sql`UPDATE runner_invocations SET settled_at=NULL, state='active' WHERE invocation_id='inv'`);
    db.insert(schema.runnerResourceSnapshots).values({
      digest: job.resources.digest, agentId: session.agent_id, shadowId: session.shadow_id, selection: job.resources, createdAt: 1,
    }).run();
    db.insert(schema.invocationResourceSnapshots).values({invocationId: "inv", digest: job.resources.digest, createdAt: 1}).run();
    expect(deleteOwner).toThrow();
    await preparation.releaseSettled();
    expect(releases).toEqual([]);

    invocations.finish("inv");
    deleteOwner();
    await preparation.releaseSettled();
    await preparation.releaseSettled();
    expect(releases).toEqual([{invocationId: "inv", contextId: context.id, scope: job.scope, resourceRevision: job.resources.digest}]);
    expect(executionDb.query("SELECT state FROM runtime_preparation_intents").get()).toEqual({state: "released"});
    expect(db.select().from(schema.runnerJobs).all()).toHaveLength(0);
    expect(db.select().from(schema.invocationResourceSnapshots).all()).toHaveLength(0);
    expect(db.select().from(schema.runnerResourceSnapshots).all()).toHaveLength(1);
    expect(invocations.find("inv")).toBeUndefined();
    if (kind === "session") {
      expect(invocations.require("task-history")).toMatchObject({sessionId: session.id, taskId: "survivor"});
      expect(db.select().from(schema.tasks).get()?.primary_session_id).toBeNull();
    }
    expect(db.select().from(schema.runnerContextOrigins).all()).toHaveLength(kind === "session" ? 1 : 0);
    const manifest = () => db.all<{ pending_execution: string }>(sql`SELECT pending_execution FROM ${sql.raw(kind + "_deletions")}`)[0]!.pending_execution;
    expect(JSON.parse(manifest())).toEqual([{ jobId: "job", runtimeId: "runtime" }]);
    const signal = new AbortController().signal;
    let offline = true, deleted = 0;
    const runtime = { runtimeId: "runtime", async delete(id: string) { expect(id).toBe("job"); if (offline) throw new Error("offline"); deleted++; } } as unknown as ExecutionRuntime;
    await drainExecutionCleanup(db, runtime, signal);
    expect(JSON.parse(manifest())).toHaveLength(1);
    offline = false;
    await drainExecutionCleanup(db, runtime, signal);
    await drainExecutionCleanup(db, runtime, signal);
    expect(deleted).toBe(1);
    expect(manifest()).toBe("[]");
    expect(db.all<{name:string}>(sql`PRAGMA table_info(runner_jobs)`).map(row => row.name)).not.toContain("settlement_acked");
  } finally {
    executionDb.close();
    connection.close();
    setLunaHome(previousHome);
    rmSync(home, { recursive: true, force: true });
  }
});
