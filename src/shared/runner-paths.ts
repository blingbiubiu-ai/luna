import { Buffer } from "node:buffer";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { config } from "./config";

export interface RunnerPaths {
  readonly runnerRootPath: string;
  readonly workspacePath: string;
  readonly ipcPath: string;
}

/**
 * Computes the stable session runner paths without touching the filesystem.
 */
export function createSessionRunnerPaths(sessionId: string): RunnerPaths {
  return createRunnerPaths(sessionId);
}

/**
 * Computes the stable task runner paths without touching the filesystem.
 */
export function createTaskRunnerPaths(taskId: string): RunnerPaths {
  return createRunnerPaths(taskId);
}

export function deriveRunnerPaths(runnerRootPath: string): RunnerPaths {
  return {
    runnerRootPath,
    workspacePath: join(runnerRootPath, "workspace"),
    ipcPath: join(runnerRootPath, "ipc"),
  };
}

function createRunnerPaths(ownerId: string): RunnerPaths {
  return deriveRunnerPaths(
    resolveContainedOwnerRoot(config.paths.runnerRootBase, ownerId),
  );
}

function resolveContainedOwnerRoot(parentRoot: string, ownerId: string): string {
  const ownerRoot = resolve(parentRoot, safePathSegment(ownerId));
  const relativePath = relative(parentRoot, ownerRoot);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Resolved runner context path escaped ${parentRoot}.`);
  }
  return ownerRoot;
}

function safePathSegment(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return value;
  }

  return `encoded-${Buffer.from(value, "utf-8").toString("base64url")}`;
}
