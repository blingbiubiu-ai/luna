import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const RUNNER_CONTEXT_FILE_RELATIVE_PATH = ".luna/runner-context.json";

export type RunnerKind = "main" | "task";
export type RunnerOwnerType = "session" | "task";

export interface RunnerContextFile {
  readonly schemaVersion: 1;
  readonly runnerKind: RunnerKind;
  readonly owner: {
    readonly type: RunnerOwnerType;
    readonly id: string;
  };
  readonly stableContext: Record<string, unknown>;
}

export interface WriteRunnerContextFileResult {
  readonly path: string;
  readonly changed: boolean;
}

export function runnerContextFilePath(runnerRootPath: string): string {
  return join(runnerRootPath, ".luna", "runner-context.json");
}

export function serializeRunnerContextFile(
  context: RunnerContextFile,
): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export function writeRunnerContextFile(
  runnerRootPath: string,
  context: RunnerContextFile,
): WriteRunnerContextFileResult {
  const path = runnerContextFilePath(runnerRootPath);
  const content = serializeRunnerContextFile(context);
  if (existsSync(path) && readFileSync(path, "utf-8") === content) {
    return { path, changed: false };
  }
  mkdirSync(join(runnerRootPath, ".luna"), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return { path, changed: true };
}
