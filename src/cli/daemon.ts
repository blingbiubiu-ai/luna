import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DaemonFiles, DaemonStartResult, DaemonStatusResult, DaemonStopResult, Env, ManagedService } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const LUNA_WORKSPACE_ROOT = moduleDir.endsWith("/dist")
  ? dirname(moduleDir)
  : dirname(dirname(moduleDir));
export const LUNA_WEB_DIST_PATH = join(LUNA_WORKSPACE_ROOT, "apps", "dashboard", "dist");

export function resolveDaemonFiles(service: ManagedService, argv: readonly string[], env: Env): DaemonFiles {
  const runtimeDir = readOption(argv, "--runtime-dir") ?? env.LUNA_RUNTIME_DIR ?? join(tmpdir(), "luna");
  return {
    runtimeDir,
    pidFile: join(runtimeDir, `${service}.pid`),
    logFile: join(runtimeDir, `${service}.log`)
  };
}

export function startDaemon(service: ManagedService, childArgs: readonly string[], argv: readonly string[], env: Env): DaemonStartResult {
  const daemonFiles = resolveDaemonFiles(service, argv, env);
  const currentStatus = readDaemonStatus(service, argv, env);
  if (currentStatus.running && currentStatus.pid !== undefined) {
    return { service, status: "already_running", pid: currentStatus.pid, ...daemonFiles };
  }

  mkdirSync(daemonFiles.runtimeDir, { recursive: true });
  const logFd = openSync(daemonFiles.logFile, "a");
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) {
      throw new Error("cannot resolve luna executable path");
    }
    const daemonStdio: ["ignore", number, number] = ["ignore", logFd, logFd];
    const childEnv = {
      ...process.env,
      LUNA_WEB_DIST_PATH:
        process.env.LUNA_WEB_DIST_PATH ?? LUNA_WEB_DIST_PATH
    };
    const child = spawn(process.execPath, [scriptPath, ...childArgs], {
      cwd: process.cwd(),
      detached: true,
      env: childEnv,
      stdio: daemonStdio
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`failed to start ${service}`);
    }
    writeFileSync(daemonFiles.pidFile, `${child.pid}\n`);
    return { service, status: "started", pid: child.pid, ...daemonFiles };
  } finally {
    closeSync(logFd);
  }
}

export async function stopDaemon(service: ManagedService, argv: readonly string[], env: Env): Promise<DaemonStopResult> {
  const daemonFiles = resolveDaemonFiles(service, argv, env);
  const pid = readDaemonPid(daemonFiles.pidFile);
  if (pid === undefined || !isDaemonProcess(service, pid)) {
    rmSync(daemonFiles.pidFile, { force: true });
    return { service, status: "not_running", ...daemonFiles };
  }

  process.kill(pid, "SIGTERM");
  await sleep(250);
  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
  }
  rmSync(daemonFiles.pidFile, { force: true });
  return { service, status: "stopped", pid, ...daemonFiles };
}

export function readDaemonStatus(service: ManagedService, argv: readonly string[], env: Env): DaemonStatusResult {
  const daemonFiles = resolveDaemonFiles(service, argv, env);
  const pid = readDaemonPid(daemonFiles.pidFile);
  const running = pid !== undefined && isDaemonProcess(service, pid);
  if (!running && existsSync(daemonFiles.pidFile)) {
    rmSync(daemonFiles.pidFile, { force: true });
  }
  return pid !== undefined && running
    ? { service, running, pid, ...daemonFiles }
    : { service, running: false, ...daemonFiles };
}

export function readDaemonPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) {
    return undefined;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonProcess(service: ManagedService, pid: number): boolean {
  if (!isProcessRunning(pid)) {
    return false;
  }
  const args = processArgsForPid(pid);
  if (args === undefined) {
    return false;
  }
  return isLunaCliProcessArgs(args) &&
    isDaemonStartCommand(service, args) &&
    args.includes(expectedDaemonStartMode(service));
}

function isDaemonStartCommand(service: ManagedService, args: string): boolean {
  if (args.includes(`${service} start`)) {
    return true;
  }
  return service === "agent" && (
    args.includes("src/cli/server-main.ts start") ||
    args.includes("dist/luna-service.js start") ||
    /(?:^|\s)(?:\S*\/)?luna-service(?:\s|$).*?(?:^|\s)start(?:\s|$)/.test(args)
  );
}

export function isLunaCliProcessArgs(args: string): boolean {
  return args.includes("src/cli/server-main.ts") ||
    args.includes("dist/luna-service.js") ||
    /(?:^|\s)(?:\S*\/)?luna-service(?:\s|$)/.test(args);
}

export function expectedDaemonStartMode(service: ManagedService): string {
  return "--foreground";
}

export function processArgsForPid(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const args = result.stdout.toString().trim();
  return args.length > 0 ? args : undefined;
}

export function stripProcessManagerArgs(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--dry-run" || arg === "--foreground" || arg === "--stdio" || arg === "--http") {
      continue;
    }
    if (arg === "--runtime-dir") {
      index += 1;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
