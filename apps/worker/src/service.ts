import { ServiceLink } from "./service-link";
import { join } from "node:path";
import { openPlatformExecutionDatabase } from "@luna/execution-store";
import { TokenAuthority, closeExecutionServer } from "@luna/execution-transport";
import type { WorkerConfig } from "./config";
import { EnvironmentStore } from "./environment-store";
import { DockerEnvironmentDriver } from "./docker-driver";
import { EnvironmentManager } from "./environment-manager";
import { workerServer, executorCallbackServer } from "./server";

export async function runWorker(config: WorkerConfig): Promise<void> {
  const db = openPlatformExecutionDatabase(join(config.dataRoot, "worker.sqlite"));
  const grants = new TokenAuthority(db);
  grants.register("runtime-control", config.controlToken, { role: "runtime", id: config.runtimeId });
  const callbackPort = config.serviceUrl && process.platform === "linux" ? (config.callbackPort ?? config.port + 100) : undefined;
  if (callbackPort && (callbackPort > 65535 || callbackPort === config.port)) throw new Error("Invalid Worker callback port");
  if (config.serviceUrl) config = { ...config, runtimeEndpoint: `http://host.docker.internal:${callbackPort ?? config.port}` };
  const driver = new DockerEnvironmentDriver(db, config); await driver.preflight();
  const manager = new EnvironmentManager(new EnvironmentStore(db), driver);
  const link = config.serviceUrl ? new ServiceLink(manager, grants, config.serviceUrl, config.controlToken) : undefined;
  const server = workerServer(grants, manager, link ? (job, instance, body) => link.events(job, instance, body) : undefined);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.listenHost, resolve); });
  const callbackServer = callbackPort && link ? executorCallbackServer(grants, (job, instance, body) => link.events(job, instance, body)) : undefined;
  if (callbackServer) await new Promise<void>((resolve, reject) => {
    callbackServer.once("error", reject); callbackServer.listen(callbackPort, config.callbackHost, resolve);
  });
  link?.start();
  let reaping = false;
  const timer = setInterval(() => {
    if (reaping) return; reaping = true;
    void manager.reap().catch(() => { /* Unreachable state retains occupancy and containers. */ }).finally(() => { reaping = false; });
  }, 5000);
  const stop = async () => { link?.stop(); clearInterval(timer); if (callbackServer) await closeExecutionServer(callbackServer); await closeExecutionServer(server); db.close(); process.exit(0); };
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
}
