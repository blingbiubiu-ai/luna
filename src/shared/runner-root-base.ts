import {
  accessSync,
  constants,
  mkdirSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import * as paths from "./config/paths";

export function resolveRunnerRootBase(input: {
  readonly home: string;
  readonly configured?: string;
}): string {
  const candidate = input.configured ?? join(input.home, "runners");
  if (!isAbsolute(candidate)) {
    throw new Error(`Runner root base must be absolute: ${candidate}`);
  }
  const normalized = resolve(candidate);
  if (normalized === parse(normalized).root) {
    throw new Error("Runner root base cannot be the filesystem root.");
  }
  return normalized;
}

export function ensureRunnerRootBase(path: string): void {
  mkdirSync(path, { recursive: true });
  if (!statSync(path).isDirectory()) {
    throw new Error(`Runner root base is not a directory: ${path}`);
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`Runner root base must be writable: ${path}`, {
      cause: error,
    });
  }
}

export function isPathContainedByRunnerRootBase(
  candidate: string,
  base = paths.runnerRootBase,
): boolean {
  const relativePath = relative(resolve(base), resolve(candidate));
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}
