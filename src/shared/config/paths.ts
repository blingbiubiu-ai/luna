import { homedir } from "node:os";
import { join } from "node:path";

import dayjs from "dayjs";

/** Current operating system user home directory. */
export const user_home = homedir();

/** Root directory for Luna agent runtime data. */
export let home = Bun.env.LUNA_HOME || join(user_home, ".luna");

/** Base directory containing all session and task runner roots. */
export let runnerRootBase = join(home, "runners");

/** Directory containing long-term memory files. */
export let memory = join(home, "memory");

/** Directory containing daily log files. */
export let logs = join(memory, "logs");

/**
 * Resolve the daily log file path for a date.
 * @param date Date to resolve.
 * @returns Absolute daily log file path.
 */
export function resolveDailyLogFilePath(date: Date): string {
  const dateString = dayjs(date).format("YYYY-MM-DD");
  return join(logs, `${dateString}.md`);
}

/** Workspace directory for agent tasks. */
export let workspace = join(home, "workspace");

/** Directory containing the shared workspace mounted into runners. */
export let sharedWorkspace = join(workspace, "projects");

/** Directory containing uploaded files. */
export let uploads = join(workspace, "uploads");

/** Directory containing generated output files. */
export let outputs = join(workspace, "outputs");

/** Directory containing Service-managed artifact blobs. */
export let artifacts = join(home, "artifacts");

/** Directory containing runtime database files. */
export let data = join(home, "data");

/**
 * Resolve a runtime data file path.
 * @param filename Data file name.
 * @returns Absolute data file path.
 */
export function resolveDataFilePath(filename: string): string {
  return join(data, filename);
}

/** Claude-compatible home directory under Luna home. */
export let claude_home = join(home, ".claude");

/** Claude-compatible skills directory under Luna home. */
export let skills = join(claude_home, "skills");

/** Codex-compatible agents directory under Luna home. */
export let agents_home = join(home, ".agents");

/**
 * Re-point all derived runtime paths to a new Luna home directory.
 * @param next_home New Luna home directory.
 */
export function setLunaHome(next_home: string): void {
  home = next_home;
  runnerRootBase = join(home, "runners");
  memory = join(home, "memory");
  logs = join(memory, "logs");
  workspace = join(home, "workspace");
  sharedWorkspace = join(workspace, "projects");
  uploads = join(workspace, "uploads");
  outputs = join(workspace, "outputs");
  artifacts = join(home, "artifacts");
  data = join(home, "data");
  claude_home = join(home, ".claude");
  skills = join(claude_home, "skills");
  agents_home = join(home, ".agents");
}

/** Set the fully resolved base directory containing runner roots. */
export function setRunnerRootBase(nextBase: string): void {
  runnerRootBase = nextBase;
}

/** Set the fully resolved shared workspace directory. */
export function setSharedWorkspacePath(nextPath: string): void {
  sharedWorkspace = nextPath;
}
