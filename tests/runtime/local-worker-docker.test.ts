import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash, openExecutionDatabase } from "@luna/execution-store";
import { ExecutionClient, TokenAuthority, closeExecutionServer } from "@luna/execution-transport";
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

const docker = (...args: string[]) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

test.skipIf(process.env.LUNA_DOCKER_INTEGRATION !== "1")("Local Docker Worker preserves job preparation and project ownership", async () => {
  const image = docker("image", "inspect", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", "--format", "{{.Id}}");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-local-worker-")));
  const suffix = contentHash(root).slice(0, 12);
  const homeWorkerId = "a_" + suffix;
  const runtimeDb = openExecutionDatabase(join(root, "runtime/state.sqlite"));
  const grants = new TokenAuthority(runtimeDb);
  const serviceToken = grants.issue("service", { role: "service", id: "service" });
  const adminToken = grants.issue("admin", { role: "runtime", id: "runtime" });
  const scheduler = new RuntimeScheduler(runtimeDb, RuntimeConfig.parse({
    runtimeId: "runtime", serviceId: "service", dataRoot: join(root, "runtime"),
    serviceToken, adminToken, homeWorkerId,  mode: "shared",
    resources: { memory: "1g", cpus: 1, pidsLimit: 128 },
  }), grants);
  const files = new RuntimeFiles(scheduler);
  const runtime = runtimeServer(grants, scheduler);
  await new Promise<void>(resolve => runtime.listen(0, "0.0.0.0", resolve));
  const port = (runtime.address() as { port: number }).port;
  const service = new Runtime(scheduler, new RuntimeFiles(scheduler));
  const admin = new ExecutionClient("http://127.0.0.1:" + port, adminToken);
  const cleanups: Array<() => Promise<void>> = [];
  const startWorker = async (id: string, firstPort: number, projectPath?: string) => {
    const dataRoot = join(root, id);
    const db = openExecutionDatabase(join(dataRoot, "state.sqlite"));
    const authority = new TokenAuthority(db);
    const controlToken = authority.issue("runtime", { role: "runtime", id: "runtime" });
    const config = WorkerConfig.parse({
      workerId: id, runtimeId: "runtime", dataRoot, controlToken, imageDigest: image,
      runtimeEndpoint: "http://host.docker.internal:" + port, network: "luna-multi-" + id,
      capacity: 2, executorPortStart: firstPort, executorPortEnd: firstPort + 9,
      projects: projectPath ? [{ projectId: "local-project", hostPath: projectPath }] : [],
    });
    const driver = new DockerEnvironmentDriver(db, config);
    const store = new EnvironmentStore(db);
    const server = workerServer(authority, new EnvironmentManager(store, driver));
    const listen = async (port: number) => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
    };
    cleanups.push(async () => {
      if (server.listening) await closeExecutionServer(server);
      for (const environment of store.list()) await driver.remove(environment);
      const volumes = docker("volume", "ls", "-q", "--filter", "label=luna.worker=" + id).split("\n").filter(Boolean);
      if (volumes.length) docker("volume", "rm", ...volumes);
      try { docker("network", "rm", config.network); } catch {}
      db.close();
    });
    await driver.preflight();
    await listen(0);
    const workerPort = (server.address() as { port: number }).port;
    await admin.call("POST", "/v1/workers", {
      workerId: id, endpoint: "http://127.0.0.1:" + workerPort, controlToken,
      executorHost: "127.0.0.1", executorPortStart: firstPort, executorPortEnd: firstPort + 9,
    });
    await scheduler.workers.poll();
    return {
      server, store, restart: () => listen(workerPort),
      client: new ExecutionClient("http://127.0.0.1:" + workerPort, controlToken),
    };
  };
  const submit = (id: string, context: string, projectId?: string) => {
    const job: JobRequest = {
      version: 2, ...fixtureJobScope(), jobId: id, invocationId: "inv-" + id, environmentId: "luna",
      runnerContextId: context, ...(projectId ? { projectId } : {}), scopeKey: "session:" + context, runnerKind: "main",
      sessionId: context, input: { runnerType: "codex", prompt: "Placement test" },
      credentialsRevision: 1, timeoutMs: 60000,
    };
    return service.submit(job);
  };
  const cancel = async (id: string) => {
    await service.cancel(id);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await scheduler.tick();
      if (runtimeDb.query("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(id)) return;
      await delay(100);
    }
    throw new Error("Worker reservation was not released for " + id);
  };
  try {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "original.txt"), "local Worker project");
    const a = await startWorker(homeWorkerId, 43600, project);
    const pair = {
      workerId: homeWorkerId, endpoint: "http://192.0.2.1:8092", controlToken: "t".repeat(43),
      executorHost: "127.0.0.1", executorPortStart: 43600, executorPortEnd: 43609,
    };
    await expect(admin.call("POST", "/v1/workers", pair)).rejects.toMatchObject({
      status: 422, code: "loopback_worker_required",
    });
    await expect(admin.call("POST", "/v1/workers", {
      ...pair, endpoint: "http://127.0.0.1:8092", workerId: "second",
    })).rejects.toMatchObject({ status: 409, code: "local_worker_required" });

    await submit("home", "home-context");
    await scheduler.tick();
    expect(scheduler.jobs.require("home")).toMatchObject({ placementState: "assigned", workerId: homeWorkerId });
    await submit("shared", "shared-context");
    await scheduler.tick();
    expect(scheduler.binding("shared")?.handle.instanceId).toBe(scheduler.binding("home")?.handle.instanceId);
    await cancel("home");
    await cancel("shared");
    await admin.call("POST", "/v1/mode/drain");
    await admin.call("PUT", "/v1/mode", { mode: "isolated" });
    await admin.call("POST", "/v1/mode/resume");

    await service.files({
      operationId: "project-context", contextId: "project-context", scopeKey: "session:project-context",
      projectId: "local-project", operation: { kind: "provision" },
    });
    await closeExecutionServer(a.server);
    await submit("offline", "project-context", "local-project");
    await scheduler.tick();
    const offline = scheduler.jobs.require("offline");
    expect(offline).toMatchObject({ placementState: "reconnecting", workerId: homeWorkerId, assignment: null });
    await a.restart();
    await scheduler.tick();
    expect(scheduler.jobs.require("offline")).toMatchObject({
      placementState: "assigned", workerId: homeWorkerId, assignmentId: offline.assignmentId,
    });
    const instanceId = scheduler.binding("offline")!.handle.instanceId;
    const containerId = docker("ps", "-q", "--filter", "label=luna.instance=" + instanceId);
    expect(docker("exec", containerId, "cat", join(root, homeWorkerId, "runner", "projects", "original.txt"))).toBe("local Worker project");
    await cancel("offline");

    // Simulate a lost prepare response after the real Worker has registered the
    // reservation on Executor. Runtime has the assignment intent but no handle.
    await submit("lost-prepare", "home-context");
    const reserved = scheduler.jobs.reserve("lost-prepare", homeWorkerId);
    const request = {
      requestId: "prep_" + reserved.assignmentId,
      occupant: {
        kind: "job", invocationId:reserved.job.invocationId,scope:reserved.job.scope, jobId: reserved.jobId, assignmentId: reserved.assignmentId,
        requestHash: reserved.requestHash, scopeKey: reserved.job.scopeKey, contextId: reserved.job.runnerContextId,
      },
      spec: {
        environmentId: "luna", scopeKey: reserved.job.scopeKey, mode: "isolated", imageDigest: image,
        callbackRuntimeId: "runtime", resources: scheduler.config.resources,
      },
    };
    await a.client.call("POST", "/v1/environments/prepare", request);
    expect(scheduler.binding(reserved.jobId)).toBeNull();
    await cancel(reserved.jobId);
    expect(scheduler.jobs.require(reserved.jobId)).toMatchObject({
      assignmentId: reserved.assignmentId, execution: { state: "cancelled" },
    });
    expect(a.store.reservation(request.requestId)?.state).toBe("released");
    await expect(a.client.call("POST", "/v1/environments/prepare", request)).rejects.toMatchObject({
      status: 409, code: "preparation_cancelled",
    });

    // A reservation can persist before Docker preparation fails. Cancellation
    // must close it even while the underlying project path is unavailable.
    renameSync(project, project + "-offline");
    try {
      const unavailableFile = { operationId: "file-prepare-rejected", contextId: "unavailable-project-context",
        scopeKey: "session:unavailable-project-context", projectId: "local-project", operation: { kind: "provision" } };
      await expect(service.files(unavailableFile)).rejects.toMatchObject({ code: "project_directory_missing" });
      expect(a.store.list().flatMap(env => a.store.active(env.id)).filter(row => row.occupant.kind === "maintenance")).toHaveLength(0);
      await expect(service.files(unavailableFile)).rejects.toMatchObject({ code: "project_directory_missing" });

      await submit("cancel-preparing", "failed-preparation-context", "local-project");
      await scheduler.tick();
      const preparing = scheduler.jobs.require("cancel-preparing");
      expect(preparing).toMatchObject({ workerId: homeWorkerId, placementState: "reconnecting", assignment: null });
      const requestId = "prep_" + preparing.assignmentId;
      expect(a.store.reservation(requestId)?.state).toBe("preparing");
      await service.cancel("cancel-preparing");
      await scheduler.tick();
      expect(scheduler.jobs.require("cancel-preparing")).toMatchObject({
        placementState: "terminal", assignment: null, terminalResult: { state: "cancelled" },
      });
      expect(a.store.reservation(requestId)?.state).toBe("cancelled");
    } finally {
      renameSync(project + "-offline", project);
    }
    await admin.call("POST", "/v1/mode/drain");
    expect(await admin.call("PUT", "/v1/mode", { mode: "shared" })).toMatchObject({ mode: "shared" });
  } finally {
    scheduler.stop();
    await closeExecutionServer(runtime);
    const cleaned = await Promise.allSettled(cleanups.map(cleanup => cleanup()));
    runtimeDb.close();
    rmSync(root, { recursive: true, force: true });
    for (const result of cleaned) if (result.status === "rejected") throw result.reason;
  }
}, 150000);
