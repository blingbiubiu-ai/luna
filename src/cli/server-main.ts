#!/usr/bin/env bun

import type { CliResult, Env } from "@luna/cli-support/types";
import { loadDefaultLunaEnv } from "@luna/cli-support/env";
import { hasFlag } from "@luna/cli-support/options";
import {
  runAgentDbCli,
  runDaemonStopCli,
  runDaemonStatusCli,
  runAgentStartCli,
  runDaemonRestartCli,
  resolveAgentRuntimeStartOptions,
} from "./commands/agent";
import { runMcpCli, startMcpStdioBridge } from "./commands/mcp";
import { LUNA_WEB_DIST_PATH, stripProcessManagerArgs } from "./daemon";

export { loadDefaultLunaEnv } from "@luna/cli-support/env";
export { resolveAgentRuntimeStartOptions } from "./commands/agent";
export { startMcpStdioBridge } from "./commands/mcp";

export async function runServerCli(
  argv: string[],
  env: Env = process.env,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { status: "ok", output: serverHelpText() };
  }
  if (["start", "stop", "restart", "status", "db"].includes(command)
    && (hasFlag(rest, "--help") || hasFlag(rest, "-h"))) {
    return { status: "ok", output: serverHelpText() };
  }
  if (command === "runtime") { const { runRuntimeCli } = await import("./commands/runtime"); return runRuntimeCli(rest, env); }
  if (command === "admin") {
    const { runPlatformAdminCli } = await import("./commands/platform-admin");
    return runPlatformAdminCli(rest, env);
  }
  if (command === "worker") return { status: "error", code: "worker_command_moved", message: "Use luna worker bind|init|start|status; Worker is a separate executable" };
  if (command === "version") {
    return { status: "ok", output: "0.1.0" };
  }
  if (command === "start") {
    return runAgentStartCli(rest, env, {
      command: "luna-service start",
      foregroundChildArgs: (argv) => ["start", "--foreground", ...stripProcessManagerArgs(argv)],
    });
  }
  if (command === "stop") {
    return runDaemonStopCli("agent", rest, env);
  }
  if (command === "restart") {
    return runDaemonRestartCli(
      "agent",
      ["start", "--foreground", ...stripProcessManagerArgs(rest)],
      rest,
      env,
    );
  }
  if (command === "status") {
    return runDaemonStatusCli("agent", rest, env);
  }
  if (command === "db") {
    return runAgentDbCli(rest, env);
  }
  if (command === "mcp") {
    return runMcpCli(rest, env);
  }
  return {
    status: "error",
    code: "unknown_luna_service_command",
    message: `unknown luna-service command: ${command}`,
  };
}

function serverHelpText(): string {
  return [
    "Luna Service CLI",
    "",
    "Usage:",
    "  luna service start [--foreground] [--port <port>] [--host <host>] [--home <path>] [--runtime-dir <path>] [--runners-dir <path>] [--shared-workspace-dir <path>] [--dry-run]",
    "  luna service stop [--dry-run]",
    "  luna service restart [--dry-run]",
    "  luna service status [--dry-run]",
    "  luna service db reset --yes",
    "  luna service admin grant --user-id <canonical-user-id> [--home <path>]",
    "  luna service mcp bridge --stdio",
    "  luna service runtime init|start|status|workers",
    "  luna service version",
    "",
    "Commands:",
    "  start              Start Luna Service",
    "  stop               Stop the Luna Service daemon",
    "  restart            Restart the Luna Service daemon",
    "  status             Show Luna Service daemon and runtime status",
    "  db reset           Reset the local Luna database",
    "  mcp                Run local Luna MCP bridges",
    "  version            Print CLI version",
  ].join("\n");
}

if (import.meta.main) {
  loadDefaultLunaEnv(process.env);
  const argv = Bun.argv.slice(2);
  const isForegroundStart =
    argv[0] === "start" &&
    hasFlag(argv, "--foreground") &&
    !hasFlag(argv, "--dry-run") &&
    !hasFlag(argv, "--help") &&
    !hasFlag(argv, "-h");
  if (isForegroundStart) {
    const startArgs = argv.slice(1);
    process.env.LUNA_WEB_DIST_PATH ??= LUNA_WEB_DIST_PATH;
    Bun.env.LUNA_WEB_DIST_PATH ??= LUNA_WEB_DIST_PATH;
    const { startAgentRuntime, stopAgentRuntime } = await import("../index");
    await startAgentRuntime(resolveAgentRuntimeStartOptions(startArgs));
    console.log(JSON.stringify({ status: "ok", service: "luna-agent-runtime" }));
    const keepAlive = setInterval(() => {}, 60_000);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    clearInterval(keepAlive);
    await stopAgentRuntime();
  } else if (argv[0] === "mcp" && argv[1] === "bridge" && hasFlag(argv, "--stdio") && !hasFlag(argv, "--dry-run")) {
    await startMcpStdioBridge(argv.slice(2));
  } else {
    const result = await runServerCli(argv);
    if (result.output) {
      process.stdout.write(`${result.output}\n`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (result.status === "error") {
      process.exit(1);
    }
  }
}
