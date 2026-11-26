import { ServiceLink } from "./service-link";
import { join } from "node:path";
import { openPlatformExecutionDatabase } from "@luna/execution-store";
import { TokenAuthority, closeExecutionServer } from "@luna/execution-transport";
import type { WorkerConfig } from "./config";
import { EnvironmentStore } from "./environment-store";
import { DockerEnvironmentDriver } from "./docker-driver";
import { embeddedRunnerRuntime, installRunnerRuntime } from "./runner-runtime";
import { EnvironmentManager } from "./environment-manager";
import { workerServer, executorCallbackServer } from "./server";
import { nosuidStartupWarning } from "./root-host";
import { WorkerUpgradeManager } from "./upgrade";
import { WorkerModelProviderManager } from "./model-providers/manager";
import { testModelProfile } from "./model-providers/test";

export async function runWorker(config: WorkerConfig): Promise<void> {
  const db = openPlatformExecutionDatabase(join(config.dataRoot, "worker.sqlite"));
  const grants = new TokenAuthority(db);
  grants.register("runtime-control", config.controlToken, { role: "runtime", id: config.runtimeId });
  const callbackPort = config.serviceUrl && process.platform === "linux" ? (config.callbackPort ?? config.port + 100) : undefined;
  if (callbackPort && (callbackPort > 65535 || callbackPort === config.port)) throw new Error("Invalid Worker callback port");
  if (config.serviceUrl) config = { ...config, runtimeEndpoint: `http://host.docker.internal:${callbackPort ?? config.port}` };
  // Containers run the Executor and `luna` CLI built with this Worker, not the image's copies.
  const files = await embeddedRunnerRuntime();
  const runtime = files ? installRunnerRuntime(config.dataRoot, files) : undefined;
  if (!runtime) console.error(JSON.stringify({ level: "warn", msg: "Worker built without its runner runtime; containers use the image's Executor" }));
  const driver = new DockerEnvironmentDriver(db, config, runtime); await driver.preflight();
  // Not fatal: Shadows without root run normally; root ones show "root 未生效" until fixed.
  const nosuid = nosuidStartupWarning(config.dataRoot);
  if (nosuid) console.error(JSON.stringify({ level: "warn", msg: nosuid }));
  const manager = new EnvironmentManager(new EnvironmentStore(db), driver);
  let link: ServiceLink | undefined;
  const models = new WorkerModelProviderManager({ db, dataRoot: config.dataRoot, workerId: config.workerId,
    ready: () => !link || link.ready,
    active: assignment => {
      const reservation = manager.store.byReservationId(assignment.executionEnvironmentId, assignment.reservationId);
      const occupant = reservation?.occupant;
      return reservation?.state === "ready" && occupant?.kind === "job" && occupant.jobId === assignment.jobId
        && occupant.assignmentId === assignment.assignmentId && occupant.requestHash === assignment.requestHash
        && occupant.scope.agentId === assignment.scope.agentId && occupant.scope.shadowId === assignment.scope.shadowId;
    },
    test: (model, env, executionDriver) => testModelProfile(config, runtime, model, env, executionDriver),
  });
  const modelPort = config.modelPort ?? config.port + 200;
  if (modelPort > 65535 || modelPort === config.port || modelPort === callbackPort) throw new Error("Invalid Worker model port");
  models.start(modelPort, config.modelHost);
  let stopFn: (() => Promise<void>) | undefined;
  const upgrade = new WorkerUpgradeManager(config, {
    onStatusChange: () => link?.heartbeat(),
    onRestart: () => { void stopFn?.(); },
    onImageRepoDigest: repoDigest => { driver.imageRepoDigest = repoDigest; },
  });
  link = config.serviceUrl ? new ServiceLink(manager, grants, config.serviceUrl, config.controlToken, upgrade, models) : undefined;
  const server = workerServer(grants, manager, link ? (job, instance, body) => link!.events(job, instance, body) : undefined, upgrade, models);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.listenHost, resolve); });
  const callbackServer = callbackPort && link ? executorCallbackServer(grants, (job, instance, body) => link!.events(job, instance, body)) : undefined;
  if (callbackServer) await new Promise<void>((resolve, reject) => {
    callbackServer.once("error", reject); callbackServer.listen(callbackPort, config.callbackHost, resolve);
  });
  link?.start();
  let reaping = false;
  const timer = setInterval(() => {
    models.reconcile();
    if (reaping) return; reaping = true;
    void manager.reap().catch(() => { /* Unreachable state retains occupancy and containers. */ }).finally(() => { reaping = false; });
  }, 5000);
  const stop = async () => { link?.stop(); clearInterval(timer); await models.close(); if (callbackServer) await closeExecutionServer(callbackServer); await closeExecutionServer(server); db.close(); process.exit(0); };
  stopFn = stop;
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
}
