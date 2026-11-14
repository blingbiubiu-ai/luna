import { defaultLunaHome } from "@luna/host-runtime/env";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { RuntimeConfig } from "../../runtime/config";
import { ExecutionError, readPrivateJson, writePrivateJson } from "@luna/execution-store";
import { ExecutionClient } from "@luna/execution-transport";
import { readOption } from "@luna/cli-support/options";
import type { CliResult, Env } from "@luna/cli-support/types";

/** Deployment CLI: secrets are exchanged through private files, never argv/output. */
export async function runRuntimeCli(argv: string[], env: Env = process.env): Promise<CliResult> {
  const file = resolve(readOption(argv, "--config") ?? join(readOption(argv, "--home") ?? defaultLunaHome(env), "runtime", "runtime.json"));
  const command = argv[0];
  if (!command || command === "--help") return { status: "ok", output: "runtime init [--home-worker ID]; runtime status [--config FILE]; runtime mode status|drain|resume|set shared; runtime workers add --file PAIR | list | drain ID | remove ID" };
  try {
    if (command === "start") return { status: "error", code: "runtime_embedded", message: "Runtime is owned by Luna Service. Run luna service start instead." };
    if ((command === "init" && readOption(argv, "--mode") === "isolated") ||
        (command === "mode" && argv[1] === "set" && argv[2] === "isolated")) {
      return { status: "error", code: "isolated_mode_unsupported", message: "Runtime uses one shared container per Shadow." };
    }
    if (command === "init") {
      if (argv.includes("--image") || argv.includes("--image-digest")) return { status: "error", code: "worker_image_required", message: "Configure the image on luna worker init --image IMAGE" };
      if (existsSync(file)) return { status: "error", code: "configuration_exists", message: "Runtime configuration already exists" };
      const config = RuntimeConfig.parse({ runtimeId: randomUUID(), serviceId: "luna-service", dataRoot: dirname(file), homeWorkerId: readOption(argv, "--home-worker") ?? "local", sharedProject: { projectId: "shared" },
        serviceToken: randomBytes(32).toString("base64url"), adminToken: randomBytes(32).toString("base64url"),
        listenHost: readOption(argv, "--host") ?? "0.0.0.0", port: Number(readOption(argv, "--port") ?? 8091), mode: readOption(argv, "--mode") ?? "shared" });
      writePrivateJson(file, config);
      return { status: "ok", output: JSON.stringify({ configFile: file, runtimeId: config.runtimeId }) };
    }
    const config = RuntimeConfig.parse(readPrivateJson(file));
    const host = config.listenHost === "0.0.0.0" ? "127.0.0.1" : config.listenHost;
    const client = new ExecutionClient(`http://${host}:${config.port}`, config.adminToken);
    if (command === "status") return { status: "ok", output: JSON.stringify(await client.call("GET", "/v1/health")) };
    if (command === "mode") {
      if (argv[1] === "status") return { status: "ok", output: JSON.stringify(await client.call("GET", "/v1/mode")) };
      if (argv[1] === "drain" || argv[1] === "resume") return { status: "ok", output: JSON.stringify(await client.call("POST", `/v1/mode/${argv[1]}`)) };
      if (argv[1] === "set" && argv[2] === "shared") return { status: "ok", output: JSON.stringify(await client.call("PUT", "/v1/mode", { mode: argv[2] })) };
    }
    if (command === "workers") {
      const action = argv[1]; const id = argv[2];
      if (action === "list") return { status: "ok", output: JSON.stringify(await client.call("GET", "/v1/workers")) };
      if (action === "add") {
        const pair = readOption(argv, "--file"); if (!pair) throw new Error("Pairing file required");
        return { status: "ok", output: JSON.stringify(await client.call("POST", "/v1/workers", readPrivateJson(pair))) };
      }
      if ((action === "drain" || action === "remove") && id && !id.startsWith("--")) {
        await client.call(action === "drain" ? "POST" : "DELETE", `/v1/workers/${encodeURIComponent(id)}${action === "drain" ? "/drain" : ""}`);
        return { status: "ok" };
      }
    }
    return { status: "error", code: "unknown_runtime_command", message: "Unknown Runtime command" };
  } catch (error) {
    if (error instanceof ExecutionError) return { status: "error", code: error.code, message: error.code };
    return { status: "error", code: "runtime_command_failed", message: "Check private configuration, command arguments and Runtime connectivity" };
  }
}
