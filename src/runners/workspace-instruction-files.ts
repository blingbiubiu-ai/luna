import { config } from "@/shared/config";
import { resolveRunnerPromptsRoot } from "./runner-prompts";
import { ensureRunnerWorkspaceInstructionFiles as render, type EnsureRunnerWorkspaceInstructionFilesInput as RenderInput } from "@luna/host-runtime/runner-instructions";
export type { RunnerInstructionKind, RunnerInstructionAdapter, EnsureRunnerWorkspaceInstructionFilesResult } from "@luna/host-runtime/runner-instructions";
export type EnsureRunnerWorkspaceInstructionFilesInput = Omit<RenderInput, "home" | "promptsRoot">;
export function ensureRunnerWorkspaceInstructionFiles(input: EnsureRunnerWorkspaceInstructionFilesInput) {
  return render({ ...input, home: config.paths.home, promptsRoot: resolveRunnerPromptsRoot() });
}
