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
  RUNNER_CONTEXT_FILE_RELATIVE_PATH,
  runnerContextFilePath,
  serializeRunnerContextFile,
  writeRunnerContextFile,
  type RunnerContextFile,
} from "../../src/runners/runner-context-file";

let runnerHome: string;

beforeEach(() => {
  runnerHome = mkdtempSync(join(tmpdir(), "luna-runner-context-file-"));
});

afterEach(() => {
  rmSync(runnerHome, { recursive: true, force: true });
});

function sampleContext(): RunnerContextFile {
  return {
    schemaVersion: 1,
    runnerKind: "work",
    owner: { type: "session", id: "session-1" },
    stableContext: {
      workSession: {
        id: "session-1",
        channel: { type: "feishu", id: "feishu-main" },
        surface: { kind: "group", externalId: "group-1" },
        thread: {
          externalId: "thread-1",
          rootMessageExternalId: "root-1",
        },
        delivery: { replyTarget: "session_thread" },
      },
    },
  };
}

test("runner context file path is shared across runner kinds", () => {
  expect(RUNNER_CONTEXT_FILE_RELATIVE_PATH).toBe(".luna/runner-context.json");
  expect(runnerContextFilePath("/luna/runners/task-1")).toBe(
    "/luna/runners/task-1/.luna/runner-context.json",
  );
});

test("writes deterministic pretty JSON to .luna/runner-context.json", () => {
  const result = writeRunnerContextFile(runnerHome, sampleContext());

  expect(result).toEqual({
    path: join(runnerHome, ".luna", "runner-context.json"),
    changed: true,
  });
  expect(existsSync(result.path)).toBe(true);
  expect(readFileSync(result.path, "utf-8")).toBe(
    `${JSON.stringify(sampleContext(), null, 2)}\n`,
  );
  expect(serializeRunnerContextFile(sampleContext())).toBe(
    readFileSync(result.path, "utf-8"),
  );
});

test("does not rewrite when content is unchanged", async () => {
  const first = writeRunnerContextFile(runnerHome, sampleContext());
  const before = statSync(first.path).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = writeRunnerContextFile(runnerHome, sampleContext());
  const after = statSync(second.path).mtimeMs;

  expect(second.changed).toBe(false);
  expect(after).toBe(before);
});

test("rewrites when content changes", async () => {
  const first = writeRunnerContextFile(runnerHome, sampleContext());
  const before = statSync(first.path).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const changed = {
    ...sampleContext(),
    stableContext: {
      workSession: {
        id: "session-1",
        channel: { type: "feishu", id: "feishu-main" },
        surface: { kind: "group", externalId: "group-2" },
        delivery: { replyTarget: "session_thread" },
      },
    },
  } satisfies RunnerContextFile;
  const second = writeRunnerContextFile(runnerHome, changed);
  const after = statSync(second.path).mtimeMs;

  expect(second.changed).toBe(true);
  expect(after).toBeGreaterThan(before);
  expect(JSON.parse(readFileSync(second.path, "utf-8"))).toMatchObject({
    stableContext: {
      workSession: {
        surface: { externalId: "group-2" },
      },
    },
  });
});
