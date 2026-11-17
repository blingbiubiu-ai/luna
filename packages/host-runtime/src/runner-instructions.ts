import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";


export type RunnerInstructionKind = "main" | "task" | "work";
export type RunnerInstructionAdapter = "claude" | "codex";

export interface EnsureRunnerWorkspaceInstructionFilesInput {
  readonly home: string;
  readonly promptsRoot: string;
  readonly runnerKind: RunnerInstructionKind;
  readonly runnerRootPath: string;
  readonly previousFingerprint: string | null;
  /** Worker grants Jobs sudo: add the root-access rules from the prompts directory. */
  readonly runnerSudo?: boolean;
}

export interface EnsureRunnerWorkspaceInstructionFilesResult {
  readonly instructionFingerprint: string;
  readonly changed: boolean;
}

const RUNNER_ENTRY_FILE: Record<RunnerInstructionKind, string> = {
  main: "main-runner/instructions.md",
  task: "task-runner/instructions.md",
  work: "work-runner/instructions.md",
};

function _instructionFilePath(
  runnerRootPath: string,
  adapter: RunnerInstructionAdapter,
): string {
  return join(runnerRootPath, adapter === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

function _renderInstructionContent(
  adapter: RunnerInstructionAdapter,
  source: string,
): string {
  if (adapter === "codex") {
    return source.replaceAll("Claude Code", "Codex");
  }
  return source;
}

function _writeFileIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath) && readFileSync(filePath, "utf-8") === content) {
    return false;
  }
  writeFileSync(filePath, content, "utf-8");
  return true;
}

export function ensureRunnerWorkspaceInstructionFiles(
  input: EnsureRunnerWorkspaceInstructionFilesInput,
): EnsureRunnerWorkspaceInstructionFilesResult {
  const promptsRoot = input.promptsRoot;
  const entryPath = join(promptsRoot, RUNNER_ENTRY_FILE[input.runnerKind]);
  const resources = join(input.home, ".luna-resources");
  const paths = { commands: join(resources, "commands") };
  const source = [
    readFileSync(entryPath, "utf-8").trimEnd(),
    readFileSync(join(promptsRoot, "runtime-confidentiality.md"), "utf-8").trimEnd(),
    ...(input.runnerSudo ? [readFileSync(join(promptsRoot, "runner-root-access.md"), "utf-8").trimEnd()] : []),
    [
      "## Execution directories",
      `Luna HOME is \`${input.home}\`. It is shared only by Runner processes of this Shadow.`,
      `Your starting working directory is \`${input.runnerRootPath}\`.`,
      `Read your execution context from \`${join(input.runnerRootPath, ".luna", "runner-context.json")}\`.`,
      `Store working files in \`${join(input.runnerRootPath, "workspace")}\`.`,
      "Agent memory and this Shadow's persona live in Luna Service, not in files; use `luna memory`.",
      `Luna Skills are loaded through the provider’s Luna plugin.`,
      `Shared commands in \`${paths.commands}\` and user tools in \`${join(input.home, ".local", "bin")}\` are on PATH.`,
    ].join("\n"),
  ].join("\n\n") + "\n";
  const instructionFingerprint = createHash("sha256")
    .update(source)
    .digest("hex");

  mkdirSync(input.runnerRootPath, { recursive: true });

  const claudePath = _instructionFilePath(input.runnerRootPath, "claude");
  const agentsPath = _instructionFilePath(input.runnerRootPath, "codex");
  const filesMissing = !existsSync(claudePath) || !existsSync(agentsPath);

  if (input.previousFingerprint === instructionFingerprint && !filesMissing) {
    return {
      instructionFingerprint,
      changed: false,
    };
  }

  const claudeChanged = _writeFileIfChanged(
    claudePath,
    _renderInstructionContent("claude", source),
  );
  const agentsChanged = _writeFileIfChanged(
    agentsPath,
    _renderInstructionContent("codex", source),
  );

  return {
    instructionFingerprint,
    changed: claudeChanged || agentsChanged || filesMissing,
  };
}
