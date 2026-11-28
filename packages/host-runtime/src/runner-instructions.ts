import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { dataBlock, joinBlocks, promptBlock } from "./prompt-blocks";


export type RunnerInstructionKind = "main" | "task";
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
  /** The working directory as the Runner sees it, written into the instructions. */
  readonly runnerRootPath: string;
  /** Where to write the files when that differs from `runnerRootPath` (a Worker host path). */
  readonly writeRoot?: string;
  /** Worker grants Jobs sudo: add the root-access rules from the prompts directory. */
  readonly runnerSudo?: boolean;
  readonly soul?: RunnerSoul;
}

export interface EnsureRunnerWorkspaceInstructionFilesResult {
  /** Hash of the generated instructions. Informational: it never decides whether a provider session resumes. */
  readonly instructionFingerprint: string;
  readonly changed: boolean;
}

export const DEFAULT_PERSONA =
  "Speak concisely, directly and kindly, in the language the person uses. Say so when you do not know; do not make things up.";

/** Persona text beyond this many characters is left out, so instructions stay small enough to be read whole. */
export const PERSONA_CHAR_LIMIT = 4000;

/** A prompt file, or one included only when the Worker grants the Runner sudo. */
type Part = string | { readonly file: string; readonly when: "sudo" };
/** `"soul"` is the Shadow's names and persona, data from Service; every other block is files joined in order. */
type Section = "soul" | readonly [tag: string, parts: readonly Part[]];

/**
 * The whole instruction file of each Runner kind, block by block. Block order is priority
 * order: identity and hard rules first, command manuals last. Files may use `{{home}}` and
 * `{{runnerRoot}}`.
 */
const LAYOUT: Record<RunnerInstructionKind, readonly Section[]> = {
  main: [
    "soul",
    ["luna_runtime", ["shared/runtime.md"]],
    ["identity", ["shared/identity.md"]],
    ["role", ["main/role.md"]],
    ["hard_rules", ["shared/confidentiality.md", { file: "shared/root-access.md", when: "sudo" }]],
    ["routing", ["main/routing.md"]],
    ["reply_protocol", ["shared/reply-protocol.md", "main/reply.md"]],
    ["task_commands", ["main/task-commands.md"]],
    ["session_commands", ["main/session-commands.md"]],
    ["input_rules", ["main/input.md"]],
    ["messaging", ["main/messaging.md"]],
    ["memory_rules", ["shared/memory.md"]],
    ["artifacts", ["shared/artifacts.md"]],
    ["environment", ["shared/runner-context.md", "main/filesystem.md", "shared/directories.md"]],
  ],
  task: [
    "soul",
    ["luna_runtime", ["shared/runtime.md"]],
    ["identity", ["shared/identity.md"]],
    ["role", ["task/role.md"]],
    ["hard_rules", ["shared/confidentiality.md", { file: "shared/root-access.md", when: "sudo" }]],
    ["evidence", ["task/evidence.md"]],
    ["memory_rules", ["shared/memory.md"]],
    ["artifacts", ["shared/artifacts.md"]],
    ["environment", ["shared/runner-context.md", "shared/directories.md"]],
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
export function renderRunnerInstructions(input: EnsureRunnerWorkspaceInstructionFilesInput): string {
  const values: Record<string, string> = { home: input.home, runnerRoot: input.runnerRootPath };
  const read = (file: string) => readFileSync(join(input.promptsRoot, file), "utf-8").trim()
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Unknown placeholder {{${name}}} in prompt file ${file}`);
      return value;
    });
  const included = (part: Part) => typeof part === "string" || (part.when === "sudo" && input.runnerSudo === true);
  return joinBlocks(LAYOUT[input.runnerKind].map((section) => {
    if (section === "soul") return input.soul ? _soulBlock(input.soul) : "";
    const [tag, parts] = section;
    return promptBlock(tag, parts.filter(included)
      .map((part) => read(typeof part === "string" ? part : part.file)).join("\n\n"));
  })) + "\n";
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

  const writeRoot = input.writeRoot ?? input.runnerRootPath;
  mkdirSync(writeRoot, { recursive: true });

  const claudePath = _instructionFilePath(writeRoot, "claude");
  const agentsPath = _instructionFilePath(writeRoot, "codex");
  const filesMissing = !existsSync(claudePath) || !existsSync(agentsPath);

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
