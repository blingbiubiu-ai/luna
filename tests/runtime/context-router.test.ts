import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { ExecutionError, openExecutionDatabase } from "@luna/execution-store";
import { TokenAuthority } from "@luna/execution-transport";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { WorkerContextPreparation } from "@luna/runner-protocol";

function fixture() {
  const db = openExecutionDatabase(":memory:");
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: "/unused",
    serviceToken: "s".repeat(43), adminToken: "a".repeat(43), homeWorkerId: "home" });
  const scheduler = new RuntimeScheduler(db, config, new TokenAuthority(db), () => ["home", "remote"]);
  registerWorker(scheduler, "home", 8, 4);
  return { db, config, scheduler };
}

function workerOnline(scheduler: RuntimeScheduler, workerId: string, capacity: number, occupied = 0) {
  scheduler.workers.heartbeat(workerId, {
    workerId, capacity, occupied, imageDigest: `sha256:${"a".repeat(64)}`, ready: true,
    capabilities: ["shadow-scope-v2"], projects: ["original", "project"],
  });
}

function registerWorker(scheduler: RuntimeScheduler, workerId: string, capacity: number, occupied = 0) {
  scheduler.workers.register({
    reverse: workerId !== "home", workerId, endpoint: "http://127.0.0.1:9999", controlToken: "w".repeat(43),
    executorHost: "127.0.0.1", executorPortStart: 41000, executorPortEnd: 41100,
  });
  workerOnline(scheduler, workerId, capacity, occupied);
}

function attachWorker(scheduler: RuntimeScheduler, workerId: string, requests: {workerId: string; path: string; body: unknown}[]) {
  scheduler.workers.attach(workerId, {
    async call<T>(_method: string, path: string, body?: unknown): Promise<T> {
      requests.push({workerId, path, body});
      if (path !== "/v2/context-prepare") throw new ExecutionError(503, "preparation_pending");
      const input = WorkerContextPreparation.parse(body);
      return {
        protocolVersion: 2, workerId, scope: input.scope, resources: input.resources, resourceRevision: input.resources.digest,
        home: `/test/agents/${input.scope.agentId}/shadows/${input.scope.shadowId}`,
        cwd: "/test/work", instructionFingerprint: "fixture", env: {},
      } as T;
    },
  });
}

async function queueJob(scheduler: RuntimeScheduler, id: string, contextId = id, shadowId = "shadow", projectId?: string) {
  const selection = fixtureJobScope("agent", shadowId);
  const {agentId} = selection.scope;
  const invocationId = `inv-${id}`, scopeKey = `session:${contextId}`;
  const project = projectId === undefined ? {} : {projectId};
  await scheduler.preparation.prepare({
    protocolVersion: 2, scope: {agentId, shadowId}, resources: selection.resources,
    invocationId, contextId, runnerId: contextId, scopeKey, runnerKind: "main", ...project,
  });
  return scheduler.submit({
    version: 2, ...selection, jobId: id, invocationId, environmentId: "luna", runnerContextId: contextId, scopeKey, ...project,
    runnerKind: "main", sessionId: "session", input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 1000,
  });
}

function capacityFixture() {
  const result = fixture();
  result.config.maxConcurrentJobs = 10;
  workerOnline(result.scheduler, "home", 1);
  const requests: Parameters<typeof attachWorker>[2] = [];
  attachWorker(result.scheduler, "home", requests);
  return { ...result, requests };
}

test("a local context retains its ownership while the Worker is offline", () => {
  const { db, scheduler } = fixture();
  try {
    const original = scheduler.contexts.route("old", "session:old", "project");
    expect(original.workerId).toBe("home");
    const worker = scheduler.workers.require("home");
    worker.lastSeen = 0;
    db.prepare("UPDATE runtime_workers SET state=? WHERE worker_id=?").run(JSON.stringify(worker), "home");
    expect(scheduler.contexts.route("old", "session:old", "project")).toEqual(original);
    expect(() => scheduler.contexts.route("new", "session:new")).toThrow("no_worker_available");
    expect(scheduler.contexts.find("new")).toBeNull();
  } finally { db.close(); }
});

test("configured projects establish local affinity without adoption", () => {
  const { db, scheduler } = fixture();
  try {
    expect(scheduler.contexts.route("first", "session:first", "project").workerId).toBe("home");
    expect(scheduler.contexts.route("second", "session:second", "project").workerId).toBe("home");
    expect(() => scheduler.contexts.route("first", "session:other", "project")).toThrow("affinity_conflict");
    db.prepare("INSERT INTO runtime_projects VALUES ('remote-project','remote')").run();
    expect(() => scheduler.contexts.route("remote", "session:remote", "remote-project")).toThrow("no_worker_available");
  } finally { db.close(); }
});

test("queued project jobs keep their Shadow placement until their Worker is available again", async () => {
  const { db, scheduler, requests } = capacityFixture();
  try {
    await queueJob(scheduler, "job-project", "new-context", "shadow", "original");
    registerWorker(scheduler, "remote", 8);
    attachWorker(scheduler, "remote", requests);
    scheduler.workers.drain("home");
    requests.length = 0;
    await scheduler.tick();
    expect(scheduler.jobs.require("job-project")).toMatchObject({
      workerId: null, lastError: {code: "shadow_worker_unavailable"}, job: {projectId: "original"},
    });
    expect(scheduler.placements.find(fixtureJobScope().scope)?.workerId).toBe("home");
    expect(requests).toEqual([]);
    scheduler.workers.resume("home");
    await scheduler.tick();
    expect(scheduler.jobs.require("job-project").workerId).toBe("home");
    expect(requests.map(({workerId, path}) => [workerId, path])).toEqual([["home", "/v1/environments/prepare"]]);
  } finally { db.close(); }
});

test("Job dispatch uses the owning Worker image without a Runtime image", async () => {
  const { db, scheduler, requests } = capacityFixture();
  try {
    const imageDigest = `sha256:${"b".repeat(64)}`;
    scheduler.workers.heartbeat("home", { workerId: "home", imageDigest, ready: true, capacity: 1, occupied: 0, capabilities: ["shadow-scope-v2"], projects: ["original"] });
    await queueJob(scheduler, "job-project", "new-context", "shadow", "original");
    await scheduler.tick();
    expect(scheduler.jobs.require("job-project").workerId).toBe("home");
    expect(requests).toEqual([
      expect.objectContaining({workerId: "home", path: "/v2/context-prepare", body: expect.objectContaining({projectId: "original"})}),
      expect.objectContaining({workerId: "home", path: "/v1/environments/prepare", body: expect.objectContaining({projectId: "original", spec: expect.objectContaining({imageDigest})})}),
    ]);
  } finally { db.close(); }
});

test("existing and new contexts share admission; queued work resumes after capacity is freed", async () => {
  const { db, scheduler, requests } = capacityFixture();
  try {
    scheduler.placements.bindContext(fixtureJobScope().scope, "existing", "session:existing", ["home"]);
    await queueJob(scheduler, "running");
    await scheduler.tick();
    await queueJob(scheduler, "waiting-existing", "existing");
    // Preparing a new context must not fail merely because the Worker is full.
    await queueJob(scheduler, "waiting-new", "new");
    requests.length = 0;
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    for (const id of ["waiting-existing", "waiting-new"]) {
      expect(scheduler.jobs.require(id)).toMatchObject({ placementState: "queued", workerId: null, lastError: { code: "capacity_exhausted" } });
    }
    // The existing reservation is reconciled even when the Worker is full.
    expect(requests.map(({path}) => path)).toEqual(["/v1/environments/prepare"]);
    const running = scheduler.jobs.require("running");
    running.placementState = "terminal"; scheduler.jobs.save(running);
    db.prepare("UPDATE scheduled_jobs SET pending=0 WHERE job_id=?").run(running.jobId);
    await scheduler.tick();
    expect(scheduler.jobs.require("waiting-existing").workerId).toBe("home");
    expect(scheduler.jobs.require("waiting-existing").lastError?.code).not.toBe("capacity_exhausted");
    expect(scheduler.jobs.require("waiting-new").placementState).toBe("queued");
    expect(scheduler.cancel("waiting-new").terminalResult?.reason).toBe("cancelled_before_dispatch");
  } finally { db.close(); }
});

test("heartbeat occupancy blocks existing-context admission until it drops", async () => {
  const { db, scheduler, requests } = capacityFixture();
  try {
    scheduler.placements.bindContext(fixtureJobScope().scope, "existing", "session:existing", ["home"]);
    workerOnline(scheduler, "home", 1, 1);
    await queueJob(scheduler, "waiting", "existing");
    requests.length = 0;
    await scheduler.tick();
    expect(scheduler.jobs.require("waiting").placementState).toBe("queued");
    expect(requests).toHaveLength(0);
    workerOnline(scheduler, "home", 1);
    await scheduler.tick();
    expect(scheduler.jobs.require("waiting").workerId).toBe("home");
  } finally { db.close(); }
});

test("drained existing contexts wait without preventing another Worker from using the global slot", async () => {
  const { db, scheduler, config, requests } = capacityFixture();
  try {
    config.maxConcurrentJobs = 1;
    await queueJob(scheduler, "blocked-job", "blocked");
    scheduler.workers.drain("home");
    registerWorker(scheduler, "remote", 8);
    attachWorker(scheduler, "remote", requests);
    await queueJob(scheduler, "eligible", "eligible", "second-shadow");
    await queueJob(scheduler, "global-wait", "global-wait", "second-shadow");
    await scheduler.tick();
    expect(scheduler.jobs.require("blocked-job")).toMatchObject({ workerId: null, placementState: "queued" });
    expect(scheduler.placements.find(fixtureJobScope().scope)?.workerId).toBe("home");
    expect(scheduler.jobs.require("eligible").workerId).toBe("remote");
    expect(scheduler.jobs.require("global-wait")).toMatchObject({ workerId: null, placementState: "queued" });
  } finally { db.close(); }
});

test("eight slots admit only eight of ten jobs and the queue survives scheduler restart", async () => {
  const { db, scheduler, config, requests } = capacityFixture();
  try {
    config.maxConcurrentJobs = 100;
    workerOnline(scheduler, "home", 8);
    for (let i = 0; i < 10; i++) {
      await queueJob(scheduler, `job-${i}`, `context-${i}`);
    }
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(scheduler.jobs.list().filter(j => j.workerId)).toHaveLength(8);
    expect(scheduler.jobs.list().filter(j => j.placementState === "queued")).toHaveLength(2);
    const restarted = new RuntimeScheduler(db, config, new TokenAuthority(db), () => ["home", "remote"]);
    restarted.workers.attach("home", { async call<T>(): Promise<T> { throw new Error("preparation pending"); } });
    await restarted.tick();
    expect(restarted.jobs.list().filter(j => j.workerId)).toHaveLength(8);
    expect(restarted.jobs.require("job-8").placementState).toBe("queued");
    expect(restarted.jobs.require("job-9").placementState).toBe("queued");
  } finally { db.close(); }
});
