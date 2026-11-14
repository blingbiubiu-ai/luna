import { resolveSharedWorkspacePath } from "@luna/host-runtime/shared-workspace";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { defaultLunaHome, loadLunaEnvAt } from "@luna/host-runtime/env";
import { defaultWorkerHome, WorkerConfig, WorkerLocalConfig, WorkerBindingConfig } from "./config";
import { readPrivateJson, writePrivateJson } from "@luna/execution-store";
import { ExecutionClient } from "@luna/execution-transport";

type Env = Record<string, string | undefined>;
interface CliResult { status: "ok" | "error"; code?: string; message?: string; output?: string; }
function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

export async function runWorkerCli(argv: string[], env: Env = process.env): Promise<CliResult> {
  const command = argv[0];
  if (!command || command === "help" || argv.includes("--help") || argv.includes("-h")) return { status: "ok", output: "luna worker init [--image IMAGE] [--port PORT] [--home DIR] [--config FILE]; luna worker bind --service URL [--local] [--runtime-config FILE] [--home DIR] [--config FILE]; luna worker start|status [--home DIR] [--config FILE]" };
  const home = resolve(readOption(argv, "--home") ?? env.LUNA_WORKER_HOME ?? (readOption(argv, "--config") ? dirname(resolve(readOption(argv, "--config")!)) : defaultWorkerHome(env)));
  env = loadLunaEnvAt(home, { ...env, LUNA_WORKER_HOME: home });
  const file = resolve(readOption(argv, "--config") ?? join(home, "worker.json"));
  const bindingFile = join(dirname(file), "binding.json");
  try {
    if (command === "bind") {
      if (argv.includes("--image") || argv.includes("--image-digest")) return { status: "error", code: "worker_local_option", message: "Select the image with luna worker init --image IMAGE" };
      if (!existsSync(file)) return { status: "error", code: "worker_not_initialized", message: "Run luna worker init before binding" };
      const localConfig = WorkerLocalConfig.parse(readPrivateJson(file));
      const serviceUrl = readOption(argv, "--service");
      if (!serviceUrl) throw new Error("Service URL required");
      const origin = new URL(serviceUrl);
      if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))) throw new Error("HTTPS Service origin required");
      const local = argv.includes("--local");
      if (local && !["127.0.0.1", "localhost"].includes(origin.hostname)) throw new Error("Local binding requires a loopback Service");
      const existing = existsSync(bindingFile) ? WorkerBindingConfig.parse(readPrivateJson(bindingFile)) : undefined;
      if (existing && (local || existing.serviceUrl !== origin.origin)) {
        return { status: "error", code: "worker_service_mismatch", message: "For an existing Worker, use its original Service address and an Agent binding code without --local" };
      }
      let code = env.LUNA_WORKER_BIND_CODE;
      if (!local && !code) { const input = createInterface({ input: process.stdin, output: process.stdout }); try { code = await input.question("One-time binding code: "); } finally { input.close(); } }
      if (existing) {
        const response = await fetch(new URL("/api/worker/bind", origin), {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json", authorization: `Bearer ${existing.controlToken}` },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { code?: string } | null;
          return { status: "error", code: body?.code ?? "worker_binding_failed", message: "Could not assign this Worker. Check the Agent binding code and Worker ownership." };
        }
        const { workerId, agentId } = await response.json() as { workerId?: string; agentId?: string };
        if (workerId !== existing.workerId || !agentId) throw new Error("Unexpected Worker assignment");
        return { status: "ok", output: JSON.stringify({ workerId, agentId }) };
      }
      let bound: { workerId: string; token: string; runtimeId: string; projectId: string };
      if (local) {
        // Explicit local pairing is the only operation that reads Service's
        // private admin config. Worker start uses only its own saved binding.
        const runtime = readPrivateJson(resolve(readOption(argv, "--runtime-config") ?? join(defaultLunaHome(env), "runtime", "runtime.json"))) as {
          runtimeId: string; homeWorkerId: string; port: number; adminToken: string; sharedProject?: { projectId: string };
        };
        bound = { workerId: runtime.homeWorkerId, token: randomBytes(32).toString("base64url"), runtimeId: runtime.runtimeId, projectId: runtime.sharedProject?.projectId ?? "shared" };
        await new ExecutionClient(`http://127.0.0.1:${runtime.port}`, runtime.adminToken).call("POST", "/v1/workers", {
          reverse: true, workerId: bound.workerId, controlToken: bound.token, endpoint: "http://127.0.0.1:1", executorHost: "127.0.0.1", executorPortStart: localConfig.executorPortStart, executorPortEnd: localConfig.executorPortEnd,
        });
      } else {
        const response = await fetch(new URL("/api/worker/bind", serviceUrl), { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Worker binding failed");
        bound = await response.json() as typeof bound;
      }
      const binding = WorkerBindingConfig.parse({ workerId: bound.workerId, runtimeId: bound.runtimeId, controlToken: bound.token, serviceUrl: origin.origin });
      writePrivateJson(bindingFile, binding);
      return { status: "ok", output: JSON.stringify({ workerId: binding.workerId, bindingFile }) };
    }

    if (command === "init") {
      if (["--advertise-host", "--publish-host", "--host"].some(flag => argv.includes(flag))) {
        return { status: "error", code: "loopback_worker_required", message: "Worker uses 127.0.0.1 for its control and Executor ports" };
      }
      if (existsSync(file)) return { status: "error", code: "configuration_exists", message: "Worker configuration already exists" };
      if (["--runtime-id", "--runtime-endpoint", "--service", "--id"].some(flag => argv.includes(flag))) return { status: "error", code: "worker_binding_option", message: "Use luna worker bind --service URL for connection identity" };
      const imageDigest = execFileSync("docker", ["image", "inspect", readOption(argv, "--image") ?? "luna-runner:latest", "--format", "{{.Id}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
      const config = WorkerLocalConfig.parse({ dataRoot: dirname(file), imageDigest,
        projects: [{ projectId: "shared", hostPath: resolveSharedWorkspacePath({ home, configured: env.LUNA_WORKER_PROJECTS_DIR ?? join(home, "projects") }) }],
        port: Number(readOption(argv, "--port") ?? 8092) });
      writePrivateJson(file, config);
      return { status: "ok", output: JSON.stringify({ configFile: file }) };
    }
    if (!existsSync(file)) return { status: "error", code: "worker_not_initialized", message: "Run luna worker init first" };
    const localConfig = WorkerLocalConfig.parse(readPrivateJson(file));
    if (!existsSync(bindingFile)) return { status: "error", code: "worker_not_bound", message: "Run luna worker bind --service URL before starting" };
    const binding = WorkerBindingConfig.parse(readPrivateJson(bindingFile));
    const config = WorkerConfig.parse({ ...localConfig, ...binding, runtimeEndpoint: `http://host.docker.internal:${localConfig.port}` });
    if (command === "start") { const { runWorker } = await import("./service"); await runWorker(config); return { status: "ok", output: JSON.stringify({ workerId: config.workerId, port: config.port }) }; }
    if (command === "status") {
      const host = config.listenHost;
      return { status: "ok", output: JSON.stringify(await new ExecutionClient(`http://${host}:${config.port}`, config.controlToken).call("GET", "/v1/health")) };
    }
    return { status: "error", code: "unknown_worker_command", message: "Unknown Worker command" };
  } catch { return { status: "error", code: "worker_command_failed", message: "Check private configuration, Docker, image and Worker connectivity" }; }
}
