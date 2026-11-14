import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ensureRunnerWorkspaceInstructionFiles } from "@/runners/workspace-instruction-files";

/**
 * Ensures a session Main Runner root has stable instruction entrypoints.
 *
 * `CLAUDE.md` and `AGENTS.md` are both materialized at runner-root creation
 * time so Claude and Codex runners see the same session instructions before
 * adapter-specific startup code runs. Runner roots do not rely on a
 * `.luna-prompts` directory at runtime.
 */
export function ensureMainRunnerWorkspaceInstructions(
  runnerRootPath: string,
  previousFingerprint: string | null = null,
): { readonly instructionFingerprint: string; readonly changed: boolean } {
  return ensureRunnerWorkspaceInstructionFiles({
    runnerKind: "main",
    runnerRootPath,
    previousFingerprint,
  });
}

export function resolveMainRunnerPromptAssetsRoot(
  moduleDir = import.meta.dir,
): string {
  const candidates = [
    resolve(moduleDir, "..", "prompts"),
    resolve(moduleDir, "..", "src", "prompts"),
  ];
  const promptAssetsRoot = candidates.find((candidate) => existsSync(candidate));
  if (promptAssetsRoot === undefined) {
    throw new Error(
      `Main Runner prompt assets not found: ${candidates.join(", ")}`,
    );
  }
  return promptAssetsRoot;
}
