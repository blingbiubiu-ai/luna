import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openExecutionDatabase, contentHash } from "@luna/execution-store";
import { ExecutorStore } from "@luna/executor/executor/store";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { RuntimeConfig } from "../../src/runtime/config";
import { TokenAuthority } from "@luna/execution-transport";
import { WorkerConfig } from "@luna/worker/config";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";
import { EnvironmentStore } from "@luna/worker/environment-store";
import type { JobRequest } from "@luna/runner-protocol";

const job: JobRequest = { version: 2, ...fixtureJobScope(), jobId: "job", invocationId: "invocation", environmentId: "environment", runnerContextId: "context", scopeKey: "session:context", runnerKind: "main", sessionId: "session", input: { runnerType: "codex", prompt: "private content" }, credentialsRevision: 1, timeoutMs: 10000 };
const assignment = { scope:job.scope, jobId: job.jobId, assignmentId: "assignment", reservationId: "reservation", instanceId: "instance", workerId: "worker", executionEnvironmentId: "environment", contextId: job.runnerContextId, scopeKey: job.scopeKey, requestHash: contentHash(job) };

test("Executor persists only Jobs and attempts, preserves terminal until release, then removes payloads", () => {
  const db = openExecutionDatabase(":memory:");
  try {
    const store = new ExecutorStore(db, "instance");
    store.register(assignment); store.submit({ job, assignment });
    store.retries.claim(job.jobId, Date.now());
    store.transition(job.jobId, "starting"); store.transition(job.jobId, "running");
    store.output(job.jobId, { status: "tool_start", id: "tool-1", name: "Bash", title: "执行命令" });
    store.output(job.jobId, { status: "tool_result", id: "tool-1", text: "工具调用已结束" });
    expect(store.takeLiveEvents().get(job.jobId)?.filter(event => event.kind === "provider")).toHaveLength(2);
    store.output(job.jobId, { status: "success", result: "private result" });
    store.retries.finish(job.jobId, Date.now(), "success");
    store.transition(job.jobId, "succeeded");
    const reboot = new ExecutorStore(db, "instance");
    expect(reboot.snapshot(job.jobId).result).toBe("private result");
    expect(reboot.list(true)).toHaveLength(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "executor_attempts" }, { name: "executor_jobs" }]);
    expect(db.query("EXPLAIN QUERY PLAN SELECT snapshot_json FROM executor_jobs WHERE json_extract(snapshot_json,'$.state') IN ('queued','starting','running','retry_wait','cancelling')").all().map((row: any) => row.detail).join()).toContain("executor_jobs_state");
    reboot.delete(job.jobId); reboot.delete(job.jobId);
    expect(reboot.list()).toHaveLength(0);
    expect(db.query("SELECT count(*) n FROM executor_attempts").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("released Runtime Jobs leave the hot loop and credentials are removed; deletion keeps only a replay tombstone", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-runtime-cleanup-"));
  const db = openExecutionDatabase(":memory:");
  try {
    const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", homeWorkerId: "worker", dataRoot: root, serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
    const scheduler = new RuntimeScheduler(db, config, new TokenAuthority(db));
    scheduler.submit(job); scheduler.putCredentials(job.jobId, { revision: 1, expiresAt: Date.now() + 10000, env: { API_KEY: "private-token" } });
    const secret = join(root, "credentials", `job_${contentHash(job.jobId)}.json`);
    expect(existsSync(secret)).toBe(true);
    scheduler.cancel(job.jobId); await scheduler.tick();
    expect(existsSync(secret)).toBe(false);
    expect(scheduler.jobs.list(true)).toHaveLength(0);
    expect(scheduler.jobs.require(job.jobId).placementState).toBe("terminal");
    await scheduler.delete(job.jobId); await scheduler.delete(job.jobId);
    expect(scheduler.jobs.find(job.jobId)).toBeUndefined();
    expect(db.query("SELECT count(*) n FROM runtime_events").get()).toEqual({ n: 0 });
    expect(() => scheduler.submit(job)).toThrow("job_deleted");
    expect(() => scheduler.cancelIntent(job)).toThrow("job_deleted");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stopped Shadow environments do not exhaust the finite port pool", () => {
  const db = openExecutionDatabase(":memory:");
  try {
    const config = WorkerConfig.parse({ workerId: "worker", runtimeId: "runtime", dataRoot: "/tmp/unused-review", runtimeEndpoint: "http://127.0.0.1:8091", controlToken: "a".repeat(43), imageDigest: "sha256:" + "a".repeat(64), executorPortStart: 41000, executorPortEnd: 41000 });
    const store = new EnvironmentStore(db), driver = new DockerEnvironmentDriver(db, config);
    for (let n = 0; n < 3; n++) {
      const requestId = `request-${n}`, scoped=fixtureJobScope("agent",`shadow-${n}`);
      const { environment } = store.prepare({ requestId, occupant: { kind: "maintenance", scope:scoped.scope, operationId: requestId, operationHash: "a".repeat(64), contextId: `context-${n}` }, spec: { protocolVersion:2,scope:scoped.scope,resourceSelection:scoped.resources,environmentId: "environment", mode: "shared", scopeKey: `session-${n}`, imageDigest: `sha256:${"a".repeat(64)}`, callbackRuntimeId: config.runtimeId, resources: { memory: "1g", cpus: 1, pidsLimit: 128 } } });
      expect(driver.deployment(environment.id).port).toBe(41000);
      store.cancelPreparation(requestId, true); store.stopped(environment.id);
    }
  } finally { db.close(); }
});
