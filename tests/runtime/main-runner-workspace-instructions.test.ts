import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  ensureMainRunnerWorkspaceInstructions,
  resolveMainRunnerPromptAssetsRoot,
} from "../../src/main-runner/workspace-instructions";
import { config, setLunaHome } from "../../src/shared";

let workspacePath: string;
let originalHome: string;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "luna-main-runner-workspace-"));
  originalHome = config.paths.home;
  setLunaHome(mkdtempSync(join(tmpdir(), "luna-main-runner-home-")));
});

afterEach(() => {
  const currentHome = config.paths.home;
  setLunaHome(originalHome);
  rmSync(currentHome, { recursive: true, force: true });
  rmSync(workspacePath, { recursive: true, force: true });
});

test("writes both Claude and Codex instruction entrypoints directly from .runner_prompt", () => {
  const result = ensureMainRunnerWorkspaceInstructions(workspacePath, null);

  const claudeMd = readFileSync(join(workspacePath, "CLAUDE.md"), "utf-8");
  const agentsMd = readFileSync(join(workspacePath, "AGENTS.md"), "utf-8");

  expect(claudeMd).toContain("<role>\nYou are the session-level dispatcher");
  expect(claudeMd).not.toContain("@.luna-prompts/main-runner/instructions.md");
  expect(agentsMd).toContain("<role>\nYou are the session-level dispatcher");
  expect(agentsMd).toContain("Main Runner");
  expect(agentsMd).toContain("<task_commands>");
  expect(agentsMd).toContain("luna messages send");
  expect(agentsMd).toContain("Stable runner context is available");
  expect(agentsMd).toContain(".luna/runner-context.json");
  expect(agentsMd).toContain("Per-turn or per-run user input");
  expect(existsSync(join(workspacePath, ".luna-prompts"))).toBe(false);
  expect(result.instructionFingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("skips rewriting generated files when the fingerprint matches", async () => {
  const first = ensureMainRunnerWorkspaceInstructions(workspacePath, null);
  const claudePath = join(workspacePath, "CLAUDE.md");
  const before = statSync(claudePath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = ensureMainRunnerWorkspaceInstructions(
    workspacePath,
    first.instructionFingerprint,
  );

  expect(second.changed).toBe(false);
  expect(statSync(claudePath).mtimeMs).toBe(before);
});

test("materializes only the current domain-command protocol", () => {
  ensureMainRunnerWorkspaceInstructions(workspacePath);
  const agentsMd = readFileSync(join(workspacePath, "AGENTS.md"), "utf-8");
  expect(agentsMd).toContain("luna session clarify");
  expect(agentsMd).toContain("luna task create");
  expect(agentsMd).toContain("LUNA_NOTHING_TO_SEND");
  expect(agentsMd).not.toContain("create_task_and_dispatch");
  expect(agentsMd).not.toContain("luna actions execute");
});
