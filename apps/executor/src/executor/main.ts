import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Id,ExecutionScope } from "@luna/runner-protocol";
import { openExecutionDatabase, readPrivateJson } from "@luna/execution-store";
import { TokenAuthority } from "@luna/execution-transport";
import { createExecutor } from "./server";
import { configureRunnerSudo, ensureRunnerAccount, sanitizeHome } from "./runner-sudo";

import { RunnerLayout } from "@luna/runner-protocol/runner-assets";

/** The Job entry built beside this Executor, wherever it is installed (image or Worker mount). */
const defaultRunnerEntry = fileURLToPath(new URL(import.meta.file.endsWith(".ts") ? "./job-main.ts" : "./job-main.js", import.meta.url));
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ExecutorDeployment = z.object({
  protocolVersion:z.literal(2),scope:ExecutionScope,
  instanceId: Id, runtimeId: Id, workerId: Id,
  dataRoot: z.string().default("/data"), runnerEntry: z.string().default(defaultRunnerEntry),
  runtimeEndpoint: z.url().refine((value) => new URL(value).protocol === "http:"),
  runnerUid: z.number().int().min(1).max(4294967294), runnerGid: z.number().int().min(0).max(4294967294),
  capacity: z.number().int().positive(), listenHost: z.string().default("0.0.0.0"), port: z.number().int().min(1).max(65535).default(8080),
  controlToken: token, maintenanceToken: token, runnerLayout: RunnerLayout,
  runnerSudo: z.boolean().default(false),
}).strict();

export async function runExecutor(configFile: string): Promise<void> {
  const config = ExecutorDeployment.parse(readPrivateJson(configFile));
  ensureRunnerAccount({ uid: config.runnerUid, gid: config.runnerGid, home: config.runnerLayout.home });
  configureRunnerSudo({ uid: config.runnerUid, gid: config.runnerGid, home: config.runnerLayout.home, enabled: config.runnerSudo });
  if (config.runnerSudo) sanitizeHome(config.runnerLayout.home, config.runnerUid, config.runnerGid);
  const db = openExecutionDatabase(join(config.dataRoot, "control", "executor.sqlite"));
  db.exec("DROP TABLE IF EXISTS execution_credentials");
  const authority = new TokenAuthority();
  authority.register("runtime-control", config.controlToken, { role: "runtime", id: config.runtimeId });
  authority.register("worker-maintenance", config.maintenanceToken, { role: "worker", id: config.workerId });
  const executor = createExecutor(db, authority, config);
  await executor.start();
  await new Promise<void>((resolve, reject) => {
    executor.server.once("error", reject);
    executor.server.listen(config.port, config.listenHost, resolve);
  });
  // Container shutdown interrupts processes; it is not a user cancellation.
  // Docker/tini terminates remaining children, and the next boot appends interruption events.
  const exit = () => { executor.reporter.stop(); db.close(); process.exit(0); };
  process.once("SIGTERM", exit); process.once("SIGINT", exit);
}
if (import.meta.main) {
  runExecutor(process.argv[2] ?? "/run/luna/executor.json").catch(() => {
    console.error("Executor initialization failed; inspect private configuration and execution storage"); process.exit(1);
  });
}
