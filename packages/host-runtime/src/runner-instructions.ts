import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { dataBlock, joinBlocks, promptBlock } from "./prompt-blocks";


export type RunnerInstructionKind = "main" | "task" | "work";
export type RunnerInstructionAdapter = "claude" | "codex";

/** Who this Shadow is, rendered first in every instruction file. Read from Service, never from files. */
export interface RunnerSoul {
  readonly name: string;
  readonly agent: string;
  readonly owner: { readonly id: string; readonly name: string };
  /** Bodies of the Shadow's persona entries, oldest first; empty means the default persona. */
  readonly persona: readonly string[];
}

export interface EnsureRunnerWorkspaceInstructionFilesInput {
  readonly home: string;
  readonly promptsRoot: string;
  readonly runnerKind: RunnerInstructionKind;
  readonly runnerRootPath: string;
  readonly previousFingerprint: string | null;
  /** Worker grants Jobs sudo: add the root-access rules from the prompts directory. */
  readonly runnerSudo?: boolean;
  readonly soul?: RunnerSoul;
}

export interface EnsureRunnerWorkspaceInstructionFilesResult {
  readonly instructionFingerprint: string;
  readonly changed: boolean;
}

export const DEFAULT_PERSONA =
  "Speak concisely, directly and kindly, in the language the person uses. Say so when you do not know; do not make things up.";

/** Persona text beyond this many characters is left out, so instructions stay small enough to be read whole. */
export const PERSONA_CHAR_LIMIT = 4000;

type Section = readonly [tag: string, files: readonly string[]];

/** Block order is priority order: identity and hard rules first, command manuals last. */
const LAYOUT: Record<RunnerInstructionKind, readonly Section[]> = {
  main: [
    ["role", ["main/role.md"]],
    ["hard_rules", []],
    ["routing", ["main/routing.md"]],
    ["reply_protocol", ["shared/reply-protocol.md", "main/reply.md"]],
    ["task_commands", ["main/task-commands.md"]],
    ["session_commands", ["main/session-commands.md"]],
    ["input_rules", ["main/input.md"]],
    ["messaging", ["main/messaging.md"]],
    ["memory_rules", ["shared/memory.md"]],
    ["artifacts", ["shared/artifacts.md"]],
    ["environment", ["shared/runner-context.md", "main/filesystem.md"]],
  ],
  task: [
    ["role", ["task/role.md"]],
    ["hard_rules", []],
    ["evidence", ["task/evidence.md"]],
    ["memory_rules", ["shared/memory.md"]],
    ["artifacts", ["shared/artifacts.md"]],
    ["environment", ["shared/runner-context.md"]],
  ],
  work: [
    ["role", ["work/role.md"]],
    ["hard_rules", []],
    ["reply_protocol", ["shared/reply-protocol.md", "work/reply.md"]],
    ["memory_rules", ["shared/memory.md"]],
    ["artifacts", ["shared/artifacts.md"]],
    ["environment", ["shared/runner-context.md"]],
  ],
};

function _soulBlock(soul: RunnerSoul): string {
  let persona = "", used = 0;
  for (const body of soul.persona.map((text) => text.trim()).filter(Boolean)) {
    if (used + body.length > PERSONA_CHAR_LIMIT) {
      console.error(JSON.stringify({ level: "warn", msg: "Shadow persona exceeds the instruction limit; later entries left out", shadow: soul.name }));
      break;
    }
    persona += (persona ? "\n\n" : "") + body;
    used += body.length;
  }
  const { persona: _, ...who } = soul;
  return dataBlock("soul", { json: who, text: persona || DEFAULT_PERSONA });
}

/** Renders the instruction file for one runner kind. Exported for size checks. */
export function renderRunnerInstructions(input: Omit<EnsureRunnerWorkspaceInstructionFilesInput, "previousFingerprint">): string {
  const read = (file: string) => readFileSync(join(input.promptsRoot, file), "utf-8").trim();
  const resources = join(input.home, ".luna-resources");
  const directories = [
    `Luna HOME is \`${input.home}\`. It is shared only by Runner processes of this Shadow.`,
    `Your starting working directory is \`${input.runnerRootPath}\`.`,
    `Read your execution context from \`${join(input.runnerRootPath, ".luna", "runner-context.json")}\`.`,
    `Store working files in \`${join(input.runnerRootPath, "workspace")}\`.`,
    "Agent memory lives in Luna Service, not in files; use `luna memory`.",
    `Luna Skills are loaded through the provider’s Luna plugin.`,
    `Shared commands in \`${join(resources, "commands")}\` and user tools in \`${join(input.home, ".local", "bin")}\` are on PATH.`,
  ].join("\n");
  const hardRules = [
    `## Confidentiality\n\n${read("shared/confidentiality.md")}`,
    ...(input.runnerSudo ? [`## Root access\n\n${read("shared/root-access.md")}`] : []),
  ].join("\n\n");
  return joinBlocks([
    input.soul ? _soulBlock(input.soul) : "",
    promptBlock("luna_runtime", read("shared/runtime.md")),
    promptBlock("identity", read("shared/identity.md")),
    ...LAYOUT[input.runnerKind].map(([tag, files]) => promptBlock(tag,
      tag === "hard_rules" ? hardRules
        : [...files.map(read), ...(tag === "environment" ? [directories] : [])].join("\n\n"))),
  ]) + "\n";
}

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
  const source = renderRunnerInstructions(input);
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
