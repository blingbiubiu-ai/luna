import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Env } from "@luna/cli-support/types";

type Component = "service" | "worker";

/** Keep deployment code out of the client bundle; run the standalone entrypoint. */
export function deploymentEntrypoint(component: Component, env: Env, directory = import.meta.dir): string {
  const bundle = `luna-${component}.js`;
  const candidates = [join(directory, bundle)];
  if (directory.endsWith("/apps/cli/dist")) candidates.push(resolve(directory, "../../../dist", bundle));
  if (directory.endsWith("/apps/cli/src")) {
    candidates.push(resolve(directory, "../../..", component === "service" ? "src/cli/server-main.ts" : "apps/worker/src/main.ts"));
  }
  const local = candidates.find(existsSync);
  if (local) return local;
  const installed = Bun.which(`luna-${component}`, { PATH: env.PATH ?? "" });
  if (installed) return realpathSync(installed);
  throw new Error(`luna ${component} is not installed; install the ${component} component (luna-${component}) alongside the Luna CLI.`);
}

export async function runDeployment(component: Component, args: string[], env: Env, inherit = false) {
  const entrypoint = deploymentEntrypoint(component, env);
  const child = spawn(process.execPath, [entrypoint, ...args], { env, stdio: inherit ? "inherit" : ["inherit", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const exitCode = await new Promise<number>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
    return { exitCode, stdout, stderr };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
