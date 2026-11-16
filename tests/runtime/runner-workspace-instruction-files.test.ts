import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  ensureRunnerWorkspaceInstructionFiles,
  type EnsureRunnerWorkspaceInstructionFilesInput,
} from "../../src/runners/workspace-instruction-files";
import { config, setLunaHome } from "../../src/shared";
import { defaultRunnerPromptsDirectory } from "../../src/runners/runner-prompts";

let runnerRootPath: string;
let originalHome: string;

function runEnsure(
  overrides: Partial<EnsureRunnerWorkspaceInstructionFilesInput> = {},
) {
  return ensureRunnerWorkspaceInstructionFiles({
    runnerKind: "main",
    runnerRootPath,
    previousFingerprint: null,
    ...overrides,
  });
}

beforeEach(() => {
  runnerRootPath = mkdtempSync(join(tmpdir(), "luna-runner-instructions-"));
  originalHome = config.paths.home;
  setLunaHome(mkdtempSync(join(tmpdir(), "luna-runner-home-")));
});

afterEach(() => {
  const currentHome = config.paths.home;
  setLunaHome(originalHome);
  rmSync(currentHome, { recursive: true, force: true });
  rmSync(runnerRootPath, { recursive: true, force: true });
});

test("materializes CLAUDE.md and AGENTS.md directly from .runner_prompt", () => {
  const result = runEnsure();

  expect(result.instructionFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(result.changed).toBe(true);
  expect(readFileSync(join(runnerRootPath, "CLAUDE.md"), "utf-8")).toContain(
    "# Main Runner Runtime Prompt",
  );
  expect(readFileSync(join(runnerRootPath, "CLAUDE.md"), "utf-8")).not.toContain(
    "@.luna-prompts/main-runner/instructions.md",
  );
  expect(readFileSync(join(runnerRootPath, "AGENTS.md"), "utf-8")).toContain(
    "# Main Runner Runtime Prompt",
  );
  expect(existsSync(join(runnerRootPath, ".luna-prompts"))).toBe(false);
});

test("does not rewrite generated files when the fingerprint matches and files exist", async () => {
  const first = runEnsure();
  const claudePath = join(runnerRootPath, "CLAUDE.md");
  const agentsPath = join(runnerRootPath, "AGENTS.md");
  const beforeClaude = statSync(claudePath).mtimeMs;
  const beforeAgents = statSync(agentsPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = runEnsure({ previousFingerprint: first.instructionFingerprint });

  expect(second.changed).toBe(false);
  expect(statSync(claudePath).mtimeMs).toBe(beforeClaude);
  expect(statSync(agentsPath).mtimeMs).toBe(beforeAgents);
});

test("regenerates missing files even when the fingerprint matches", async () => {
  const first = runEnsure();
  const agentsPath = join(runnerRootPath, "AGENTS.md");
  rmSync(agentsPath);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = runEnsure({ previousFingerprint: first.instructionFingerprint });

  expect(second.changed).toBe(true);
  expect(existsSync(agentsPath)).toBe(true);
});

test("materializes task runner instructions without a .luna-prompts workspace path", () => {
  runEnsure({ runnerKind: "task" });

  const agentsMd = readFileSync(join(runnerRootPath, "AGENTS.md"), "utf-8");

  expect(agentsMd).toContain("# Task Runner Runtime Prompt");
  expect(agentsMd).toContain("luna artifacts materialize artifact:<id> --json");
  expect(agentsMd).not.toContain("@.luna-prompts/task-runner/instructions.md");
});

test("every runner and provider receives the shared confidentiality policy", () => {
  for (const runnerKind of ["main", "task", "work"] as const) {
    runEnsure({ runnerKind });
    for (const entry of ["AGENTS.md", "CLAUDE.md"]) {
      const content = readFileSync(join(runnerRootPath, entry), "utf-8");
      expect(content).toContain("## Internal Runtime Confidentiality");
      const policy = readFileSync(
        join(defaultRunnerPromptsDirectory(), "runtime-confidentiality.md"),
        "utf-8",
      );
      expect(content).toContain(policy.trim());
    }
  }
});

test("a shared policy change refreshes instructions even when the role is unchanged", () => {
  const first = runEnsure();
  const policyPath = join(defaultRunnerPromptsDirectory(), "runtime-confidentiality.md");
  writeFileSync(policyPath, readFileSync(policyPath, "utf-8") + "\nAdditional policy revision.\n");

  const second = runEnsure({ previousFingerprint: first.instructionFingerprint });

  expect(second.changed).toBe(true);
  expect(second.instructionFingerprint).not.toBe(first.instructionFingerprint);
  for (const entry of ["AGENTS.md", "CLAUDE.md"]) {
    expect(readFileSync(join(runnerRootPath, entry), "utf-8")).toContain("Additional policy revision.");
  }
});

test("missing shared policy fails closed instead of generating unprotected instructions", () => {
  const first = runEnsure();
  rmSync(join(defaultRunnerPromptsDirectory(), "runtime-confidentiality.md"));
  expect(() => runEnsure({ previousFingerprint: first.instructionFingerprint })).toThrow();
});


test("all generated Runner entrypoints use the current command/report protocol", () => {
  for (const runnerKind of ["main", "work", "task"] as const) {
    runEnsure({runnerKind});
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const content = readFileSync(join(runnerRootPath, name), "utf8");
      expect(content).toContain(`Luna HOME is \`${config.paths.home}\``);
      expect(content).toContain(`Your starting working directory is \`${runnerRootPath}\``);
      expect(content).toContain(join(runnerRootPath, ".luna", "runner-context.json"));
      expect(content).toContain(join(config.paths.home, ".luna-resources", "commands"));
      expect(content).toContain("luna memory add --type persona");
      expect(content).not.toContain(".luna-resources/config/");
      expect(content).toContain("luna memory get <id>");
      expect(content).not.toMatch(/\$HOME\/\.luna-resources\/memory\/(SOUL|USER|MAIN|TASK|WORK)\.md/);
      expect(content).not.toContain("$HOME/projects/");
      expect(content).not.toContain("/data/contexts/");
      expect(content).not.toMatch(/luna actions|create_task_and_dispatch|attach_existing_task_and_dispatch|update_task_and_restart_runner|ask_clarification|batch_response|no_reply|reply_normal|publish_task_result/);
      if (runnerKind === "task") {
        expect(content).toContain("luna task report --request-id final-report --stdin");
        expect(content).toContain("You cannot send user messages");
      } else {
        expect(content).toContain("luna messages send");
        expect(content).toContain("LUNA_NOTHING_TO_SEND");
      }
    }
  }
});
