import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliResult, Env } from "@luna/cli-support/types";
import { callUnifiedService } from "@luna/cli-support/service-client";

const POST_TOOL_THROTTLE_MS = 15_000;
const MAX_STOP_BLOCKS_PER_RUN = 2;

function sanitizeFileId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

export async function runInternalCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  if (argv[0] !== "task-hook") {
    return { status: "ok", output: "" };
  }
  if (env.LUNA_RUNNER_KIND !== "task" || !env.LUNA_TASK_RUN_ID) {
    return { status: "ok", output: "" };
  }
  const phaseArg = argv[1];
  if (phaseArg !== "post-tool" && phaseArg !== "stop") {
    return { status: "ok", output: "" };
  }

  const runKey = sanitizeFileId(env.LUNA_TASK_RUN_ID);
  if (phaseArg === "post-tool") {
    const stampPath = join(tmpdir(), `luna-task-hook-${runKey}.stamp`);
    const now = Date.now();
    try {
      if (existsSync(stampPath)) {
        const st = statSync(stampPath);
        if (now - st.mtimeMs < POST_TOOL_THROTTLE_MS) {
          return { status: "ok", output: "" };
        }
      }
      writeFileSync(stampPath, String(now), { mode: 0o600 });
    } catch {
      // Best-effort local throttle stamp.
    }

    try {
      const res = await callUnifiedService(env, {
        method: "POST",
        path: "/api/runner/task-reports/hook-check",
        body: { phase: "post_tool" },
      });
      if (res.status !== "ok" || !res.output) return { status: "ok", output: "" };
      const parsed = JSON.parse(res.output) as {
        action?: string;
        additionalContext?: string;
      };
      if (parsed.action === "inject" && parsed.additionalContext) {
        return {
          status: "ok",
          output: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: parsed.additionalContext,
            },
          }),
        };
      }
    } catch {
      // Never fail a tool call because of a transient hook error.
    }
    return { status: "ok", output: "" };
  }

  // phase === "stop"
  const countPath = join(tmpdir(), `luna-task-stop-${runKey}.count`);
  let count = 0;
  try {
    if (existsSync(countPath)) {
      count = Number.parseInt(readFileSync(countPath, "utf8").trim(), 10) || 0;
    }
  } catch {
    count = 0;
  }
  if (count >= MAX_STOP_BLOCKS_PER_RUN) {
    return { status: "ok", output: "" };
  }

  try {
    const res = await callUnifiedService(env, {
      method: "POST",
      path: "/api/runner/task-reports/hook-check",
      body: { phase: "stop" },
    });
    if (res.status !== "ok" || !res.output) return { status: "ok", output: "" };
    const parsed = JSON.parse(res.output) as {
      action?: string;
      reason?: string;
    };
    if (parsed.action === "block" && parsed.reason) {
      try {
        writeFileSync(countPath, String(count + 1), { mode: 0o600 });
      } catch {
        // Best-effort counter persistence.
      }
      return {
        status: "ok",
        output: JSON.stringify({
          decision: "block",
          reason: parsed.reason,
        }),
      };
    }
  } catch {
    // Allow exit on transient hook failure.
  }
  return { status: "ok", output: "" };
}
