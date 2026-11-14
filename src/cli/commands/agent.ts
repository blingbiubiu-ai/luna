import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeOptions } from "../../index";
import { resolveSharedWorkspacePath } from "@luna/host-runtime/shared-workspace";
import { resolveRunnerRootBase } from "../../shared/runner-root-base";
import { assertSafeDashboardBinding, DEFAULT_LUNA_SERVICE_HOST, DEFAULT_LUNA_SERVICE_PORT, DEFAULT_LUNA_DASHBOARD_TOKEN } from "@luna/host-runtime/defaults";
import type { AgentRuntimeProbeResult, CliResult, Env, ManagedService } from "@luna/cli-support/types";
import { LUNA_WEB_DIST_PATH, processArgsForPid, readDaemonStatus, resolveDaemonFiles, startDaemon, stopDaemon } from "../daemon";
import { hasFlag, readOption, readOptionIfPresent } from "@luna/cli-support/options";
import { errorMessage, fetchWithRetry, fetchWithTimeout } from "@luna/cli-support/service-client";

export interface AgentStartCliOptions {
  readonly command: string;
  readonly foregroundChildArgs: (argv: readonly string[]) => readonly string[];
}

export function runAgentStartCli(
  argv: readonly string[],
  env: Env,
  options: AgentStartCliOptions,
): CliResult {
  let runtimeOptions: AgentRuntimeOptions;
  try {
    runtimeOptions = resolveAgentRuntimeStartOptions(argv, env);
  } catch (error) {
    return {
      status: "error",
      code: "agent_start_options_invalid",
      message: (error as Error).message
    };
  }
  const daemonFiles = resolveDaemonFiles("agent", argv, env);
  if (hasFlag(argv, "--dry-run")) {
    const { dashboardToken, ...publicOptions } = runtimeOptions;
    return {
      status: "ok",
      output: JSON.stringify({
        command: options.command,
        ...publicOptions,
        dashboardAuth: dashboardToken === DEFAULT_LUNA_DASHBOARD_TOKEN
          ? "local-dev-default"
          : "configured",
        mode: hasFlag(argv, "--foreground") ? "foreground" : "daemon",
        pidFile: daemonFiles.pidFile,
        logFile: daemonFiles.logFile,
        webDistPath: LUNA_WEB_DIST_PATH
      })
    };
  }
  if (hasFlag(argv, "--foreground")) {
    return {
      status: "error",
      code: "agent_foreground_requires_executable",
      message: "start --foreground is a long-running process; run luna service start --foreground or pass --dry-run"
    };
  }

  return {
    status: "ok",
    output: JSON.stringify(startDaemon("agent", options.foregroundChildArgs(argv), argv, env))
  };
}

export function runAgentDbCli(argv: readonly string[], env: Env): CliResult {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "reset") {
    return {
      status: "error",
      code: "unknown_agent_db_command",
      message: `unknown agent db command: ${subcommand ?? ""}`.trim()
    };
  }
  if (!hasFlag(rest, "--yes")) {
    return {
      status: "error",
      code: "agent_db_reset_requires_yes",
      message: "luna service db reset requires --yes"
    };
  }

  const home = readOption(rest, "--home") ?? env.LUNA_HOME ?? join(homedir(), ".luna");
  const files = [
    join(home, "data", "luna.db"),
    join(home, "data", "luna.db-shm"),
    join(home, "data", "luna.db-wal"),
  ];
  for (const file of files) {
    rmSync(file, { force: true });
  }
  return {
    status: "ok",
    output: JSON.stringify({ status: "ok", reset: "luna-db", files })
  };
}

export async function runDaemonStopCli(service: ManagedService, argv: readonly string[], env: Env): Promise<CliResult> {
  const daemonFiles = resolveDaemonFiles(service, argv, env);
  if (hasFlag(argv, "--dry-run")) {
    return { status: "ok", output: JSON.stringify({ command: "luna-service stop", pidFile: daemonFiles.pidFile, logFile: daemonFiles.logFile }) };
  }
  return { status: "ok", output: JSON.stringify(await stopDaemon(service, argv, env)) };
}

export async function runDaemonRestartCli(service: ManagedService, childArgs: readonly string[], argv: readonly string[], env: Env): Promise<CliResult> {
  const daemonFiles = resolveDaemonFiles(service, argv, env);
  if (hasFlag(argv, "--dry-run")) {
    return { status: "ok", output: JSON.stringify({ command: "luna-service restart", pidFile: daemonFiles.pidFile, logFile: daemonFiles.logFile }) };
  }
  const stop = await stopDaemon(service, argv, env);
  const start = startDaemon(service, childArgs, argv, env);
  return { status: "ok", output: JSON.stringify({ service, status: "restarted", stop, start }) };
}

export async function runDaemonStatusCli(service: ManagedService, argv: readonly string[], env: Env): Promise<CliResult> {
  const daemonFiles = resolveDaemonFiles(service, argv, env);
  if (hasFlag(argv, "--dry-run")) {
    return { status: "ok", output: JSON.stringify({ command: "luna-service status", pidFile: daemonFiles.pidFile, logFile: daemonFiles.logFile }) };
  }
  const status = readDaemonStatus(service, argv, env);
  if (!status.running || status.pid === undefined) {
    return { status: "ok", output: JSON.stringify(status) };
  }
  return {
    status: "ok",
    output: JSON.stringify({
      ...status,
      runtime: await readAgentRuntimeProbe(status.pid, argv, env),
    }),
  };
}

/**
 * Resolve start options for the Luna agent runtime CLI.
 * @param argv CLI arguments after `agent start`.
 * @param env Environment variable map.
 * @returns Normalized agent runtime options.
 */
export function resolveAgentRuntimeStartOptions(argv: readonly string[], env: Env = process.env): AgentRuntimeOptions {
  const home = readOption(argv, "--home") ?? env.LUNA_HOME;
  const host = readOption(argv, "--host") ?? env.LUNA_SERVICE_HOST;
  const port = readOption(argv, "--port") ?? env.LUNA_SERVICE_PORT;
  const runtimeDir = readOption(argv, "--runtime-dir") ?? env.LUNA_RUNTIME_DIR;
  const configuredRunnersDir = readOption(argv, "--runners-dir") ??
    env.LUNA_RUNNERS_DIR;
  const configuredSharedWorkspaceDir =
    readOption(argv, "--shared-workspace-dir") ??
    env.LUNA_SHARED_WORKSPACE_DIR;
  const dashboardToken =
    env.LUNA_DASHBOARD_TOKEN?.trim() || DEFAULT_LUNA_DASHBOARD_TOKEN;
  const resolvedPort = port === undefined ? DEFAULT_LUNA_SERVICE_PORT : Number(port);
  if (!Number.isInteger(resolvedPort) || resolvedPort <= 0 || resolvedPort > 65535) {
    throw new Error("LUNA_SERVICE_PORT must be an integer between 1 and 65535");
  }
  assertSafeDashboardBinding(host ?? DEFAULT_LUNA_SERVICE_HOST, dashboardToken);
  const resolvedHome = home ?? `${env.HOME ?? ""}/.luna`;
  return {
    home: resolvedHome,
    host: host ?? DEFAULT_LUNA_SERVICE_HOST,
    port: resolvedPort,
    runtimeDir: runtimeDir ?? join(tmpdir(), "luna"),
    runnersDir: resolveRunnerRootBase({
      home: resolvedHome,
      ...(configuredRunnersDir === undefined
        ? {}
        : { configured: configuredRunnersDir }),
    }),
    sharedWorkspaceDir: resolveSharedWorkspacePath({
      home: resolvedHome,
      ...(configuredSharedWorkspaceDir === undefined
        ? {}
        : { configured: configuredSharedWorkspaceDir }),
    }),
    ...(dashboardToken ? { dashboardToken } : {})
  };
}

export async function readAgentRuntimeProbe(
  pid: number,
  argv: readonly string[],
  env: Env,
): Promise<AgentRuntimeProbeResult> {
  const endpoint = `${agentRuntimeBaseUrl(pid, argv, env)}/api/runtime/status`;
  const token =
    env.LUNA_DASHBOARD_TOKEN?.trim() || DEFAULT_LUNA_DASHBOARD_TOKEN;
  try {
    const cookie = await loginToAgentRuntime(endpoint, token);
    const response = await fetchWithTimeout(endpoint, {
      headers: { cookie },
    });
    if (!response.ok) {
      return {
        endpoint,
        reachable: true,
        error: `runtime status returned HTTP ${response.status}`,
      };
    }
    const payload = await response.json() as {
      readonly status?: unknown;
      readonly agent?: unknown;
      readonly channels?: unknown;
    };
    return {
      endpoint,
      reachable: true,
      ...(typeof payload.status === "string" ? { status: payload.status } : {}),
      ...(payload.agent !== undefined ? { agent: payload.agent } : {}),
      ...(payload.channels !== undefined ? { channels: payload.channels } : {}),
    };
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      error: errorMessage(error),
    };
  }
}

export async function loginToAgentRuntime(
  runtimeStatusEndpoint: string,
  token: string,
): Promise<string> {
  const loginEndpoint = runtimeStatusEndpoint.replace(
    /\/api\/runtime\/status$/,
    "/api/auth/login",
  );
  const response = await fetchWithRetry(loginEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    throw new Error(`runtime login returned HTTP ${response.status}`);
  }
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("runtime login did not return a session cookie");
  }
  return cookie;
}

export function agentRuntimeBaseUrl(
  pid: number,
  argv: readonly string[],
  env: Env,
): string {
  const processArgs = processArgsForPid(pid)?.split(/\s+/) ?? [];
  const host = normalizeLocalProbeHost(
    readOptionIfPresent(argv, "--host") ??
      readOptionIfPresent(processArgs, "--host") ??
      env.LUNA_SERVICE_HOST ??
      DEFAULT_LUNA_SERVICE_HOST,
  );
  const port = readOptionIfPresent(argv, "--port") ??
    readOptionIfPresent(processArgs, "--port") ??
    env.LUNA_SERVICE_PORT ??
    String(DEFAULT_LUNA_SERVICE_PORT);
  return `http://${host}:${port}`;
}

export function normalizeLocalProbeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}
