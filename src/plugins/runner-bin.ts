import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { resolveRunnerBinDir } from "@/runners/runner-root-layout";
import type { PluginRegistry } from "./registry";

/**
 * Stage command launchers and runtime directories for the read-only runner mount.
 */
export function materializeRunnerBin(input: {
  readonly pluginRegistry: PluginRegistry;
}): string {
  const binDir = resolveRunnerBinDir();
  const staged = mkdtempSync(`${binDir}.tmp-`);
  try {
    for (const plugin of input.pluginRegistry.listPlugins()) {
      for (const cmd of plugin.manifest.containerCommands ?? []) {
        const dest = join(staged, cmd.binary);
        copyFileSync(cmd.shimScript, dest);
        chmodSync(dest, 0o755);
        if (cmd.runtimeDirectory !== undefined) {
          const runtime = join(staged, ".runtime");
          mkdirSync(runtime, { recursive: true });
          cpSync(cmd.runtimeDirectory, join(runtime, cmd.binary), { recursive: true, dereference: true });
        }
      }
    }
    for (const entry of readdirSync(binDir)) {
      rmSync(join(binDir, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(staged)) {
      renameSync(join(staged, entry), join(binDir, entry));
    }
    return binDir;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
