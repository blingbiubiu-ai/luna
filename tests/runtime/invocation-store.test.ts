import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureNamedSession, fixtureRunnerContext } from "../helpers/platform-fixtures";
import { runnerContexts } from "../../src/data/schema";
import { AgentResourceBuilder } from "../../src/runners/agent-resource-builder";
import { InvocationResources } from "../../src/runners/invocation-resources";
import { PluginRegistry } from "../../src/plugins/registry";
import { InvocationStore } from "../../src/runners/invocation-store";
import type { JobRequest } from "@luna/runner-protocol";

const invocation = {
  id: "inv1", runnerKind: "work" as const, actorUserId: "user1", runnerContextId: "ctx1", sessionId: "session1",
  taskId: null, taskRunId: null, originId: "turn1", contextPackIds: [],
  inputSnapshot: {version: 1 as const, kind: "work", input: {sessionId: "session1", runnerContextId: "ctx1", turnId: "turn1"}},
};

test("invocation ledger survives restart, rolls back failed projection/settlement and never revives revoked authority", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-invocations-"));
  let sqlite = new Database(join(root, "service.sqlite"));
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    let db = drizzle(sqlite);
    migrate(db, {migrationsFolder: "src/data/drizzle"});
    sqlite.exec("CREATE TABLE test_business (id TEXT PRIMARY KEY)");
    const scope = fixtureNamedSession(db, "session1", "user1");
    db.insert(runnerContexts).values(fixtureRunnerContext(db, {
      id: "ctx1", owner_type: "session", owner_id: "session1", runner_type: "claude",
      runner_root_path: root, created_at: 0, updated_at: 0,
    })).run();
    let store = new InvocationStore(db);
    const pin = (id: string) => {
      const {selection} = new InvocationResources(db, root).pin(id, new AgentResourceBuilder(db, root, new PluginRegistry()));
      return {resources: selection, resourceRevision: selection.digest};
    };
    store.register(invocation);
    const job: JobRequest = {
      version: 2, scope: {...scope, placementGeneration: 1}, ...pin(invocation.id),
      jobId: "job1", invocationId: "inv1", environmentId: "luna", runnerContextId: "ctx1",
      scopeKey: "session:ctx1", runnerKind: "work", sessionId: "session1",
      input: {runnerType: "claude", prompt: "test"}, credentialsRevision: 1, timeoutMs: 10000,
    };
    store.createJob("runtime1", job);
    const firstCredentials = store.credentials("job1", { expiresAt: Date.now() + 100000, env: { LUNA_ACCESS_TOKEN: "first" } });
    expect(firstCredentials.revision).toBe(1);
    sqlite.close(); sqlite = new Database(join(root, "service.sqlite")); sqlite.exec("PRAGMA foreign_keys=ON"); db = drizzle(sqlite); store = new InvocationStore(db);
    expect(store.credentials("job1", firstCredentials).revision).toBe(1);
    expect(store.credentials("job1", { ...firstCredentials, env: { LUNA_ACCESS_TOKEN: "renewed" } }).revision).toBe(2);
    expect(store.job("job1")!.credentialsHash).not.toContain("renewed");
    expect(store.require("inv1").activeJobId).toBe("job1");
    expect(store.createJob("runtime1", job).request).toEqual(job);
    expect(() => store.createJob("runtime1", { ...job, jobId: "job2" })).toThrow("invocation_job_active");
    store.register({...invocation, id: "inv-retry", originId: "turn-retry",
      inputSnapshot: {...invocation.inputSnapshot, input: {...invocation.inputSnapshot.input, turnId: "turn-retry"}}});
    store.createJob("runtime1", { ...job, ...pin("inv-retry"), jobId: "job-retry", invocationId: "inv-retry" });
    const consume = (seq: number, kind: string, data: unknown) => store.consume({ jobId: "job-retry", seq, kind: "execution", data: { event: { seq, at: 1, kind, data } } }, () => {});
    consume(1, "provider", { status: "init", sessionId: "provider-session" });
    consume(2, "provider", { status: "checkpoint" });
    consume(3, "provider", { status: "stream", text: "failed attempt partial text" });
    consume(4, "state", { jobId: "job-retry", assignmentId: "assignment", instanceId: "instance", bootId: "boot", streamId: "stream", requestHash: "hash", state: "starting", lastSeq: 4, createdAt: 1,
      retry: { attempt: 2, totalRetries: 1, consecutiveRetries: 1, deadlineAt: 10000, nextRetryAt: null, reason: "rate_limited" } });
    expect(store.job("job-retry")!.providerState).toEqual({ sessionId: "provider-session", checkpoint: true });
    consume(5, "provider", { status: "success", result: "final answer" });
    expect(store.job("job-retry")!.providerState?.text).toBe("final answer");
    const event = { jobId: "job1", seq: 1, kind: "placement" as const, data: { placementState: "terminal" } };
    expect(() => store.consume(event, () => { sqlite.exec("INSERT INTO test_business VALUES ('projection')"); throw new Error("rollback"); })).toThrow("rollback");
    expect(store.job("job1")!.cursor).toBe(0); expect(sqlite.query("SELECT * FROM test_business").all()).toHaveLength(0);
    expect(store.consume(event, () => {})).toBe(true);
    expect(store.consume(event, () => { throw new Error("must not repeat"); })).toBe(false);
    expect(() => store.settle("job1", () => { sqlite.exec("INSERT INTO test_business VALUES ('settled')"); throw new Error("rollback"); })).toThrow("rollback");
    expect(store.job("job1")!.state).toBe("terminal");
    expect(sqlite.query("SELECT * FROM test_business").all()).toHaveLength(0);
    store.revoke("inv1", "cancelled");
    store.settle("job1", () => sqlite.exec("INSERT INTO test_business VALUES ('settled')"));
    expect(store.require("inv1").state).toBe("revoked");
    store.settle("job1", () => { throw new Error("must not repeat"); });
    expect(store.register(invocation).state).toBe("revoked");
    expect(() => store.createJob("runtime1", { ...job, jobId: "job2" })).toThrow("invocation_inactive");
  } finally { sqlite.close(); rmSync(root, { recursive: true, force: true }); }
});
