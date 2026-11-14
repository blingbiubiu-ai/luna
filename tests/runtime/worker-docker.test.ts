import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash, openExecutionDatabase } from "@luna/execution-store";
import { closeExecutionServer, ExecutionClient, TokenAuthority } from "@luna/execution-transport";
import type { JobRequest } from "@luna/runner-protocol";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeFiles } from "../../src/runtime/files";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { runtimeServer } from "../../src/runtime/server";
import { WorkerConfig } from "@luna/worker/config";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";
import { EnvironmentManager } from "@luna/worker/environment-manager";
import { EnvironmentStore } from "@luna/worker/environment-store";
import { workerServer } from "@luna/worker/server";

const enabled = process.env.LUNA_DOCKER_INTEGRATION === "1";
for (const mode of ["shared", "isolated"] as const) {
test.skipIf(!enabled)(`real Worker ${mode} host directory lifecycle: direct cancellation, terminal status and context files`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-worker-test-")));
  const projectPath = join(root, "projects"); mkdirSync(projectPath);
  const suffix = contentHash(root).slice(0, 12); const workerId = `worker_${suffix}`;
  const digest = execFileSync("docker", ["image", "inspect", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  const runtimeDb = openExecutionDatabase(join(root, "runtime", "state.sqlite"));
  const workerDb = openExecutionDatabase(join(root, "worker", "state.sqlite"));
  const grants = new TokenAuthority(runtimeDb);
  const serviceToken = grants.issue("service", { role: "service", id: "service1" });
  const adminToken = grants.issue("admin", { role: "runtime", id: "runtime1" });
  const scheduler = new RuntimeScheduler(runtimeDb, RuntimeConfig.parse({ runtimeId: "runtime1", serviceId: "service1", dataRoot: join(root, "runtime"), serviceToken, adminToken, homeWorkerId: workerId,  mode, resources: { memory: "1g", cpus: 1, pidsLimit: 128 } }), grants);
  const runtime = runtimeServer(grants, scheduler);
  await new Promise<void>((resolve) => runtime.listen(0, "0.0.0.0", resolve));
  const runtimePort = (runtime.address() as { port: number }).port;
  const workerGrants = new TokenAuthority(workerDb);
  const workerToken = workerGrants.issue("runtime", { role: "runtime", id: "runtime1" });
  const config = WorkerConfig.parse({ workerId, runtimeId: "runtime1", dataRoot: join(root, "worker"), runtimeEndpoint: `http://host.docker.internal:${runtimePort}`, controlToken: workerToken, imageDigest: digest, network: `luna-test-${suffix}`, executorPortStart: 42900, executorPortEnd: 42910, idleTimeoutMs: 1000, projects: [{ projectId: "project", hostPath: projectPath }] });
  const driver = new DockerEnvironmentDriver(workerDb, config); const store = new EnvironmentStore(workerDb);
  const manager = new EnvironmentManager(store, driver);
  await driver.preflight();
  mkdirSync(join(config.dataRoot, ".ssh"), { recursive: true });
  writeFileSync(join(config.dataRoot, ".ssh/id_rsa"), "fixture-key");
  writeFileSync(join(config.dataRoot, ".ssh/known_hosts"), "fixture-host");
  writeFileSync(join(config.dataRoot, ".runner-gitconfig"), "[user]\nname = Luna\n");
  const worker = workerServer(workerGrants, manager);
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const workerPort = (worker.address() as { port: number }).port;
  const client = new Runtime(scheduler, new RuntimeFiles(scheduler));
  const admin = new ExecutionClient(`http://127.0.0.1:${runtimePort}`, adminToken);
  const job = (id: string, context: string): JobRequest => ({ version: 2, ...fixtureJobScope(), jobId: id, invocationId: `inv_${id}`, environmentId: "luna", runnerContextId: context, scopeKey: `session:${context}`, runnerKind: "main", sessionId: context, input: { runnerType: "claude", prompt: "test" }, credentialsRevision: 1, timeoutMs: 30000 });
  try {
    await admin.call("POST", "/v1/workers", { workerId, endpoint: `http://127.0.0.1:${workerPort}`, controlToken: workerToken, executorHost: "127.0.0.1", executorPortStart: 42900, executorPortEnd: 42910 });
    await scheduler.workers.poll();
    await client.submit(job("job1", "context1"));
    await scheduler.tick();
    const assigned = scheduler.jobs.require("job1");
    expect(assigned.assignment, assigned.lastError?.code).not.toBeNull();
    await client.submit(job("job2", "context2")); await scheduler.tick();
    expect(scheduler.jobs.require("job2").lastError?.code).toBeUndefined();
    expect(store.list()).toHaveLength(mode === "shared" ? 1 : 2);
    const environment = store.list()[0]!;
    expect(scheduler.binding("job1")!.handle.instanceId === scheduler.binding("job2")!.handle.instanceId).toBe(mode === "shared");
    const instance = scheduler.binding("job1")!.handle.instanceId;
    const projectPreparation = { operationId: "late-project", contextId: "project-context", scopeKey: "session:project-context", projectId: "project", operation: { kind: "provision" } };
    if (mode === "shared") {
      const originalContainer = (await driver.inspect(environment))!.Id;
      const prepared = await client.files<{ home: string }>(projectPreparation);
      expect(prepared.home).toBe(driver.mountPlan(environment).layout.home);
      expect((await driver.inspect(environment))!.Id).toBe(originalContainer);
      expect(scheduler.jobs.require("job2").placementState).not.toBe("terminal");
    }
    await client.cancel("job1"); await scheduler.tick();
    const deadline = Date.now() + 10000;
    while (scheduler.jobs.require("job1").placementState !== "terminal" && Date.now() < deadline) await delay(100);
    expect(scheduler.jobs.require("job1").placementState).toBe("terminal");
    await delay(200); await scheduler.tick();
    expect(store.active(environment.id)).toHaveLength(mode === "shared" ? 1 : 0);
    expect((await driver.inspect(environment))!.State.Running).toBe(true);
    await client.cancel("job2"); await scheduler.tick();
    while (scheduler.jobs.require("job2").placementState !== "terminal" && Date.now() < deadline) await delay(100);
    await delay(200); await scheduler.tick();
    expect(store.active(environment.id)).toHaveLength(0);
    if (mode === "shared") {
      const prepared = await client.files<{ home: string }>(projectPreparation);
      expect(prepared.home).toBe(driver.mountPlan(environment).layout.home);
      expect(store.active(environment.id)).toHaveLength(0);
      expect(store.require(environment.id).instanceId).toBe(instance);
    }
    const executorId = (await driver.inspect(environment))!.Id;
    const inspectionBeforeSwitch = (await driver.inspect(environment))!;
    expect(inspectionBeforeSwitch.Mounts.some(mount =>
      ["/projects", "/.ssh", "/.runner-gitconfig", "/etc/passwd"].some(path => mount.Destination.endsWith(path)))).toBe(false);
    const tables = JSON.parse(execFileSync("docker", ["exec", executorId, "bun", "-e", "const {Database}=require('bun:sqlite'); const db=new Database('/data/control/executor.sqlite',{readonly:true}); console.log(JSON.stringify(db.query(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all()))"], { encoding: "utf8" }));
    expect(tables).toEqual([{ name: "executor_attempts" }, { name: "executor_jobs" }]);
    expect(await new ExecutionClient(driver.endpoint(environment.id), driver.deployment(environment.id).controlToken).call("POST", "/v1/jobs/job1/query", { assignment: assigned.assignment }).catch(error => error.code)).toBe("job_not_found");
    const content = Buffer.from("remote context contents");
    const operation = { operationId: "write1", contextId: "context1", scopeKey: "session:context1", operation: { kind: "write", path: "notes/readme.txt", content: content.toString("base64"), sha256: createHash("sha256").update(content).digest("hex") } };
    const written = await client.files<{ size: number; sha256: string }>(operation);
    expect(await client.files<{ size: number; sha256: string }>(operation)).toEqual(written);
    const read = await client.files<{ content: string }>({ operationId: "read1", contextId: "context1", scopeKey: "session:context1", operation: { kind: "read", path: "notes/readme.txt" } });
    expect(Buffer.from(read.content, "base64").toString()).toBe("remote context contents");
    await expect(client.files({ operationId: "delete-nonempty", contextId: "context1", scopeKey: "session:context1", operation: { kind: "delete", path: "notes" } })).rejects.toMatchObject({ status: 409, code: "directory_not_empty" });
    await expect(client.files({ operationId: "missing-file", contextId: "context1", scopeKey: "session:context1", operation: { kind: "stat", path: "absent" } })).rejects.toMatchObject({ status: 404, code: "file_not_found" });
    const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1);
    const oversizedWrite = { operationId: "oversized-file", contextId: "context1", scopeKey: "session:context1", operation: { kind: "write", path: "too-large", content: tooLarge.toString("base64"), sha256: createHash("sha256").update(tooLarge).digest("hex") } };
    for (let attempt = 0; attempt < 2; attempt++) await expect(client.files(oversizedWrite)).rejects.toMatchObject({ status: 413, code: "file_too_large" });

    expect(store.active(environment.id)).toHaveLength(0);
    await delay(1100); await manager.reap();
    if (mode === "shared") expect((await driver.inspect(environment))!.State.Running).toBe(true);
    else {
      expect(await driver.inspect(environment)).toBeNull();
      const restored = await client.files<{ content: string }>({ operationId: "read-after-reap", contextId: "context1", scopeKey: "session:context1", operation: { kind: "read", path: "notes/readme.txt" } });
      expect(Buffer.from(restored.content, "base64").toString()).toBe("remote context contents");
      expect(store.require(environment.id).instanceId).toBe(instance);
      expect((await driver.inspect(environment))!.State.Running).toBe(true);
    }
    // Drain execution environments, then change only container policy. Data and
    // the Worker-issued UID must not depend on which Executor was created first.
    const owner = { uid: config.runnerUid, gid: config.runnerGid };
    await admin.call("POST", "/v1/mode/drain");
    await admin.call("PUT", "/v1/mode", { mode: mode === "shared" ? "isolated" : "shared" });
    expect(await driver.inspect(environment)).toBeNull();
    await admin.call("POST", "/v1/mode/resume");
    const afterSwitch = await client.files<{ content: string }>({ operationId: "read-after-mode-switch", contextId: "context1", scopeKey: "session:context1", operation: { kind: "read", path: "notes/readme.txt" } });
    expect(Buffer.from(afterSwitch.content, "base64").toString()).toBe("remote context contents");
    expect(driver.contexts.ensure("context1", "session:context1")).toEqual({ contextId: "context1", scopeKey: "session:context1" });
    const switched = store.list().find(item => item.spec.mode === scheduler.config.mode)!;
    const inspection = await driver.inspect(switched);
    expect(inspection?.State.Running).toBe(true);
    expect(execFileSync("docker", ["exec", "--user", `${owner.uid}:${owner.gid}`, inspection!.Id, "cat", join(driver.mountPlan(switched).layout.runners, "context1", "notes/readme.txt")], { encoding: "utf8" })).toBe("remote context contents");
    expect(readFileSync(join(driver.mountPlan(switched).layout.runners, "context1", "notes/readme.txt"), "utf8")).toBe("remote context contents");

  } finally {
    scheduler.stop(); await closeExecutionServer(runtime); await closeExecutionServer(worker);
    for (const environment of store.list()) {
      await driver.remove(environment);
      execFileSync("docker", ["volume", "rm", `luna-${contentHash(workerId).slice(0, 12)}-${environment.id}`], { stdio: "ignore" });
    }
    execFileSync("docker", ["network", "rm", config.network], { stdio: "ignore" });
    runtimeDb.close(); workerDb.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60000);

}
