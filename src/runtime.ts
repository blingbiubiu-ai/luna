import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSharedWorkspacePath,
  resolveRunnerRootBase,
  setLunaHome,
  setSharedWorkspacePath,
  setRunnerRootBase,
} from "./shared";
import { loadDefaultLunaEnv } from "@luna/host-runtime/env";
import {
  DEFAULT_LUNA_SERVICE_HOST,
  DEFAULT_LUNA_SERVICE_PORT,
  DEFAULT_LUNA_DASHBOARD_TOKEN,
  assertSafeDashboardBinding,
} from "@luna/host-runtime/defaults";

/**
 * Environment variables used to start the Luna agent runtime.
 */
export interface AgentRuntimeEnvironment {
  readonly [name: string]: string | undefined;
  readonly HOME?: string;
  readonly LUNA_HOME?: string;
  readonly LUNA_SERVICE_HOST?: string;
  readonly LUNA_SERVICE_PORT?: string;
  readonly LUNA_DASHBOARD_TOKEN?: string;
  readonly LUNA_RUNTIME_DIR?: string;
  readonly LUNA_RUNNERS_DIR?: string;
  readonly LUNA_SHARED_WORKSPACE_DIR?: string;
}

/**
 * Resolved options for the Luna agent runtime.
 */
export interface AgentRuntimeOptions {
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly runtimeDir: string;
  readonly runnersDir: string;
  readonly sharedWorkspaceDir: string;
  readonly dashboardToken?: string;
}

/**
 * Current in-process runtime status.
 */
export interface AgentRuntimeStatus {
  readonly status: "running" | "stopped";
  readonly service: "luna-agent-runtime";
}

let _running = false;
let _bootstrapped = false;
let _activeOptions: AgentRuntimeOptions | undefined;

type KernelModule = typeof import("./kernel");
let _kernel: KernelModule["kernel"] | undefined;

/**
 * Resolve agent runtime options from environment variables.
 * @param env Environment variable map.
 * @returns Normalized runtime options.
 */
export function resolveAgentRuntimeOptions(
  env: AgentRuntimeEnvironment = process.env,
): AgentRuntimeOptions {
  loadDefaultLunaEnv(env);
  const port =
    env.LUNA_SERVICE_PORT === undefined
      ? DEFAULT_LUNA_SERVICE_PORT
      : Number(env.LUNA_SERVICE_PORT);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("LUNA_SERVICE_PORT must be an integer between 1 and 65535");
  }

  const dashboardToken =
    env.LUNA_DASHBOARD_TOKEN?.trim() || DEFAULT_LUNA_DASHBOARD_TOKEN;
  assertSafeDashboardBinding(env.LUNA_SERVICE_HOST ?? DEFAULT_LUNA_SERVICE_HOST, dashboardToken);
  const home = env.LUNA_HOME ?? `${env.HOME ?? ""}/.luna`;
  return {
    home,
    host: env.LUNA_SERVICE_HOST ?? DEFAULT_LUNA_SERVICE_HOST,
    port,
    runtimeDir: env.LUNA_RUNTIME_DIR ?? join(tmpdir(), "luna"),
    runnersDir: resolveRunnerRootBase({
      home,
      ...(env.LUNA_RUNNERS_DIR === undefined
        ? {}
        : { configured: env.LUNA_RUNNERS_DIR }),
    }),
    sharedWorkspaceDir: resolveSharedWorkspacePath({
      home,
      ...(env.LUNA_SHARED_WORKSPACE_DIR === undefined
        ? {}
        : { configured: env.LUNA_SHARED_WORKSPACE_DIR }),
    }),
    dashboardToken,
  };
}

/**
 * Return the current in-process runtime status.
 * @returns Runtime status.
 */
export function getAgentRuntimeStatus(): AgentRuntimeStatus {
  return {
    status: _running ? "running" : "stopped",
    service: "luna-agent-runtime",
  };
}

/**
 * Start the Luna agent runtime.
 * @param options Runtime options.
 */
export async function startAgentRuntime(
  options: AgentRuntimeOptions = resolveAgentRuntimeOptions(),
): Promise<void> {
  if (
    _bootstrapped &&
    _activeOptions !== undefined &&
    !_areSameOptions(_activeOptions, options)
  ) {
    throw new Error(
      "Agent runtime cannot restart with different options in the same process",
    );
  }

  if (_running) {
    return;
  }

  process.env.LUNA_HOME = options.home;
  process.env.LUNA_SERVICE_HOST = options.host;
  process.env.LUNA_SERVICE_PORT = String(options.port);
  process.env.LUNA_RUNTIME_DIR = options.runtimeDir;
  process.env.LUNA_RUNNERS_DIR = options.runnersDir;
  process.env.LUNA_SHARED_WORKSPACE_DIR = options.sharedWorkspaceDir;
  Bun.env.LUNA_HOME = options.home;
  Bun.env.LUNA_SERVICE_HOST = options.host;
  Bun.env.LUNA_SERVICE_PORT = String(options.port);
  Bun.env.LUNA_RUNTIME_DIR = options.runtimeDir;
  Bun.env.LUNA_RUNNERS_DIR = options.runnersDir;
  Bun.env.LUNA_SHARED_WORKSPACE_DIR = options.sharedWorkspaceDir;
  if (options.dashboardToken !== undefined) {
    process.env.LUNA_DASHBOARD_TOKEN = options.dashboardToken;
    Bun.env.LUNA_DASHBOARD_TOKEN = options.dashboardToken;
  }
  setLunaHome(options.home);
  setRunnerRootBase(options.runnersDir);
  setSharedWorkspacePath(options.sharedWorkspaceDir);

  if (!_bootstrapped) {
    const { bootLoader } = await import("./boot-loader");
    await bootLoader.bootstrap();
    _kernel = (await import("./kernel")).kernel;
    _bootstrapped = true;
    _activeOptions = { ...options };
  } else {
    const kernel = await _loadKernel();
    await kernel.start();
  }

  _running = true;
}

/**
 * Stop the Luna agent runtime.
 */
export async function stopAgentRuntime(): Promise<void> {
  if (!_running) {
    return;
  }

  const kernel = await _loadKernel();
  await kernel.stop();
  _running = false;
}

async function _loadKernel(): Promise<KernelModule["kernel"]> {
  if (!_kernel) {
    _kernel = (await import("./kernel")).kernel;
  }
  return _kernel;
}

function _areSameOptions(
  current: AgentRuntimeOptions,
  next: AgentRuntimeOptions,
): boolean {
  return (
    current.home === next.home &&
    current.host === next.host &&
    current.port === next.port &&
    current.runtimeDir === next.runtimeDir &&
    current.runnersDir === next.runnersDir &&
    current.sharedWorkspaceDir === next.sharedWorkspaceDir &&
    current.dashboardToken === next.dashboardToken
  );
}
