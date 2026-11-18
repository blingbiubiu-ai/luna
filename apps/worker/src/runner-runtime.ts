import { chmodSync, existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { contentHash } from "@luna/execution-store";

/** Where containers see the Worker's runner runtime, read-only. */
export const RUNNER_RUNTIME_MOUNT = "/opt/luna-runtime";
/** Versions kept besides the current one: an Executor started from one keeps using its directory. */
const KEPT_VERSIONS = 3;

export interface RunnerRuntime { root: string; version: string; }

/**
 * Install the Executor and `luna` CLI this Worker was built with under `<dataRoot>/runner-runtime`:
 * one directory per version and a `current` link to this one. Containers mount the root and run
 * `current/executor.js`; Bun resolves it to the version directory, so a running Executor and the
 * Jobs it starts stay on one version while `current` moves on.
 */
export function installRunnerRuntime(dataRoot: string, files: Record<string, string>): RunnerRuntime {
  const root = join(dataRoot, "runner-runtime");
  const version = contentHash(files).slice(0, 16);
  mkdirSync(root, { recursive: true, mode: 0o755 });
  chmodSync(root, 0o755);
  const target = join(root, version);
  if (!existsSync(target)) {
    const staging = join(root, `.staging-${randomBytes(6).toString("hex")}`);
    mkdirSync(staging, { mode: 0o755 });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(staging, name), content, { mode: 0o644 });
    renameSync(staging, target);
  }
  const link = join(root, `.current-${randomBytes(6).toString("hex")}`);
  symlinkSync(version, link);
  renameSync(link, join(root, "current"));
  prune(root, version);
  return { root, version };
}

/** The version a running Executor would start from now. */
export function currentRunnerRuntime(root: string): string | undefined {
  try { return readlinkSync(join(root, "current")); } catch { return undefined; }
}

function prune(root: string, current: string): void {
  const versions = readdirSync(root).filter(name => name !== "current" && name !== current)
    .map(name => ({ name, path: join(root, name), at: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of versions.filter(item => item.name.startsWith(".")).concat(versions.filter(item => !item.name.startsWith(".")).slice(KEPT_VERSIONS)))
    rmSync(old.path, { recursive: true, force: true });
}

/** The embedded runtime, or undefined when this Worker was not built with it (run from source). */
export async function embeddedRunnerRuntime(): Promise<Record<string, string> | undefined> {
  try {
    const { runnerRuntimeFiles } = await import("./runner-runtime-bundle");
    return Object.values(runnerRuntimeFiles).every(content => content.length > 0) ? runnerRuntimeFiles : undefined;
  } catch { return undefined; }
}
