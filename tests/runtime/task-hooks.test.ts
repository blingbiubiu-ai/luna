import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildClaudePtyStopHookCommand,
  TASK_POST_TOOL_HOOK_CMD,
  TASK_STOP_HOOK_CMD,
} from "../../apps/executor/src/task-hooks";
import { prepareRunnerEnvironment } from "../../apps/executor/src/executor/runner-environment";

function runShell(command: string, env: Record<string, string>) {
  const proc = Bun.spawnSync(["/bin/sh", "-c", command], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
  };
}

test("task hooks suppress stdout when an outdated luna CLI exits non-zero with error JSON, and forward valid hook JSON on exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-task-hooks-"));
  try {
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeLuna = join(fakeBin, "luna");
    const eventsFile = join(dir, "claude-hooks.jsonl");

    // 1. Simulate stale image CLI printing error JSON to stdout and exiting 1.
    writeFileSync(
      fakeLuna,
      '#!/bin/sh\nprintf \'{"status":"error","code":"unknown_command","message":"unknown command: internal"}\\n\'\nexit 1\n',
    );
    chmodSync(fakeLuna, 0o755);

    const env = { PATH: `${fakeBin}:/usr/bin:/bin` };
    expect(runShell(TASK_POST_TOOL_HOOK_CMD, env)).toEqual({ exitCode: 0, stdout: "" });
    expect(runShell(TASK_STOP_HOOK_CMD, env)).toEqual({ exitCode: 0, stdout: "" });

    const claudeStopFallback = runShell(buildClaudePtyStopHookCommand(eventsFile), env);
    expect(claudeStopFallback).toEqual({ exitCode: 0, stdout: "" });
    expect(readFileSync(eventsFile, "utf8").trim()).toBe('{"event":"Stop"}');

    // 2. Simulate current CLI returning valid PostToolUse / Stop JSON with exit 0.
    writeFileSync(
      fakeLuna,
      '#!/bin/sh\nif [ "$3" = "post-tool" ]; then printf \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"inbox msg"}}\\n\'; else printf \'{"decision":"block","reason":"check inbox"}\\n\'; fi\n',
    );
    chmodSync(fakeLuna, 0o755);

    expect(runShell(TASK_POST_TOOL_HOOK_CMD, env)).toEqual({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"inbox msg"}}\n',
    });
    expect(runShell(TASK_STOP_HOOK_CMD, env)).toEqual({
      exitCode: 0,
      stdout: '{"decision":"block","reason":"check inbox"}\n',
    });
    expect(runShell(buildClaudePtyStopHookCommand(eventsFile), env)).toEqual({
      exitCode: 0,
      stdout: '{"decision":"block","reason":"check inbox"}\n',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareRunnerEnvironment places runtimeBin ahead of /usr/local/bin in PATH when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-runner-env-"));
  try {
    const home = join(dir, "home");
    const runtimeBin = join(dir, "runtime-bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(runtimeBin, { recursive: true });

    const prepared = prepareRunnerEnvironment(
      {
        HOME: home,
        PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      },
      {
        gradleWrapper: join(dir, "no-gradle"),
        fswatch: join(dir, "no-fswatch"),
        runtimeBin,
      },
    );
    const parts = (prepared.PATH ?? "").split(":");
    expect(parts.indexOf(runtimeBin)).toBeGreaterThanOrEqual(0);
    expect(parts.indexOf(runtimeBin)).toBeLessThan(parts.indexOf("/usr/local/bin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
