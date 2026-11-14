import { describe, expect, test } from "bun:test";

import {
  normalizeRunnerProgressStep,
  runnerProgressStepFromAssistant,
} from "../../src/runners/runner-progress-step";

describe("runner progress step", () => {
  test("preserves the line between a tool description and invocation", () => {
    expect(
      runnerProgressStepFromAssistant({
        id: "assistant-progress",
        session_id: "session-progress",
        role: "assistant",
        content: [{
          type: "text",
          text: "Locate skill definition\n\n<Bash> find skills -type f",
        }],
      }),
    ).toBe("Locate skill definition\n<Bash> find skills -type f");
  });

  test("normalizes blank lines and horizontal whitespace", () => {
    expect(
      normalizeRunnerProgressStep("  Read context \r\n\r\n  <Read File>   AGENTS.md  "),
    ).toBe("Read context\n<Read File> AGENTS.md");
  });

  test("returns undefined for empty progress", () => {
    expect(normalizeRunnerProgressStep(" \n \r\n ")).toBeUndefined();
  });

  test("applies one shared bounded length with an ellipsis", () => {
    expect(
      normalizeRunnerProgressStep("123456", { maxLength: 5 }),
    ).toBe("1234…");
  });
});
