import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ensureRunnerWorkspaceInstructionFiles } from "@/runners/workspace-instruction-files";

/**
 * Ensures a Work Runner root has stable instruction entrypoints for both
 * Claude Code and Codex.
 */
export function ensureWorkRunnerWorkspaceInstructions(
  runnerRootPath: string,
  previousFingerprint: string | null = null,
): { readonly instructionFingerprint: string; readonly changed: boolean } {
  return ensureRunnerWorkspaceInstructionFiles({
    runnerKind: "work",
    runnerRootPath,
    previousFingerprint,
  });
}

export function resolveWorkRunnerPromptAssetsRoot(
  moduleDir = import.meta.dir,
): string {
  const candidates = [
    resolve(moduleDir, "..", "prompts"),
    resolve(moduleDir, "..", "src", "prompts"),
  ];
  const promptAssetsRoot = candidates.find((candidate) => existsSync(candidate));
  if (promptAssetsRoot === undefined) {
    throw new Error(
      `Work Runner prompt assets not found: ${candidates.join(", ")}`,
    );
  }
  return promptAssetsRoot;
}
