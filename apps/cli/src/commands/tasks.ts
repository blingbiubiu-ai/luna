import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  assertNoLegacyRequestId,
  callUnifiedService,
  deriveCommandIdempotencyKey,
  parseDurationMs,
  servicePathWithQuery,
  submitAndWaitCommand,
} from "@luna/cli-support/service-client";

const TASKS_USAGE = [
  "Usage:",
  "  luna tasks list [--agent-id <id> | --session <address-or-id>]",
  "  luna tasks get (--task-id <id> | <id>)",
  "  luna tasks progress (--task-id <id> | <id>) [--run-id <id|all>] [--limit <n>] [--cursor <cursor>]",
  "  luna tasks create|update|restart|cancel (--stdin | --json '<object>') [--repeat]",
  "  luna tasks status-card (--task-id <id> | --json '<object>') [--resend] [--style card|native] [--repeat]",
  "  luna tasks pause [--wake-in <duration>] (--reason <text> | --stdin)",
  "  luna tasks report (--stdin | --text <report>) [--repeat]",
].join("\n");

function resolveSessionParam(
  raw: string | undefined,
  env: Env,
): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "current") return env.LUNA_SESSION_ID?.trim();
  if (trimmed.startsWith("session:")) return trimmed.slice("session:".length);
  return trimmed;
}

function readTaskId(argv: readonly string[]): string | undefined {
  const fromFlag = readOption(argv, "--task-id")?.trim();
  if (fromFlag) return fromFlag;
  const pos = argv[1];
  return pos && !pos.startsWith("--") ? pos.trim() : undefined;
}

export async function runTasksCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const command = argv[0];
  if (
    !command ||
    command === "help" ||
    hasFlag(argv, "--help") ||
    hasFlag(argv, "-h")
  ) {
    return { status: "ok", output: TASKS_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    if (command === "status") {
      return {
        status: "error",
        code: "legacy_status_removed",
        message:
          "Per-domain status subcommands are removed in Protocol v2; use `luna commands status <id>` or `luna commands wait <id>`",
      };
    }
    if (command === "list") {
      if (argv.includes("--session-id")) {
        return {
          status: "error",
          code: "legacy_target_removed",
          message:
            "--session-id is removed in Protocol v2; use --session current or --session session:<id>",
        };
      }
      if (argv.includes("--session")) {
        const sessionId = resolveSessionParam(
          readOption(argv, "--session"),
          env,
        );
        if (!sessionId) {
          return {
            status: "error",
            code: "missing_session",
            message: "missing --session or LUNA_SESSION_ID",
          };
        }
        return await callUnifiedService(env, {
          method: "GET",
          path: servicePathWithQuery("/api/tasks", { sessionId }),
        });
      }
      const agentId = (
        readOption(argv, "--agent-id") ?? env.LUNA_AGENT_ID
      )?.trim();
      if (!agentId) {
        return {
          status: "error",
          code: "agent_scope_required",
          message: "Use --agent-id, --session, or set LUNA_AGENT_ID",
        };
      }
      return await callUnifiedService(env, {
        method: "GET",
        path: servicePathWithQuery("/api/tasks", { agentId }),
      });
    }
    if (command === "get") {
      const taskId = readTaskId(argv);
      if (!taskId) {
        return {
          status: "error",
          code: "missing_task_id",
          message: "missing --task-id",
        };
      }
      return await callUnifiedService(env, {
        method: "GET",
        path: `/api/tasks/${encodeURIComponent(taskId)}`,
      });
    }
    if (command === "progress") {
      const taskId = readTaskId(argv);
      if (!taskId) {
        return {
          status: "error",
          code: "missing_task_id",
          message: "missing --task-id",
        };
      }
      return await callUnifiedService(env, {
        method: "GET",
        path: servicePathWithQuery(
          `/api/tasks/${encodeURIComponent(taskId)}/progress`,
          {
            runId: readOption(argv, "--run-id"),
            limit: readOption(argv, "--limit"),
            cursor: readOption(argv, "--cursor"),
          },
        ),
      });
    }
    if (command === "pause") {
      const inlineReason = readOption(argv, "--reason");
      const stdin = hasFlag(argv, "--stdin");
      if ((inlineReason !== undefined) === stdin) {
        return {
          status: "error",
          code: "invalid_pause",
          message:
            "Use `luna tasks pause [--wake-in <duration>]` with exactly one of --reason <text> or --stdin",
        };
      }
      const reason = (inlineReason ?? (await Bun.stdin.text())).trim();
      if (!reason) {
        return {
          status: "error",
          code: "invalid_pause",
          message: "Pause reason must not be empty",
        };
      }
      const wakeInRaw = readOption(argv, "--wake-in");
      const wakeInMs = wakeInRaw ? parseDurationMs(wakeInRaw) : undefined;
      return await callUnifiedService(env, {
        method: "POST",
        path: "/api/runner/task-reports/pause",
        body: {
          reason,
          ...(wakeInMs !== undefined ? { wakeInMs } : {}),
        },
      });
    }
    if (command === "report") {
      if (hasFlag(argv, "--waiting")) {
        return {
          status: "error",
          code: "legacy_flag_removed",
          message:
            "`--waiting` is removed; ask Main with `luna ask --to main --text '...' [--wait 60s]` or suspend via `luna tasks pause`",
        };
      }
      const inline = readOption(argv, "--text");
      const stdin = hasFlag(argv, "--stdin");
      if ((inline !== undefined) === stdin) {
        return {
          status: "error",
          code: "invalid_report",
          message:
            "Use `luna tasks report [--repeat]` with exactly one of --stdin or --text <report>",
        };
      }
      const content = inline ?? (await Bun.stdin.text());
      if (!content.trim()) {
        return {
          status: "error",
          code: "invalid_report",
          message: "Report must not be empty",
        };
      }
      const body = { content };
      const key = deriveCommandIdempotencyKey(env, "tasks.report", body, {
        repeat: hasFlag(argv, "--repeat"),
      });
      return await submitAndWaitCommand(env, {
        method: "POST",
        path: "/api/runner/task-reports",
        idempotencyKey: key,
        body,
      });
    }
    if (command === "status-card" && readOption(argv, "--task-id")) {
      if (readOption(argv, "--json") !== undefined || hasFlag(argv, "--stdin")) {
        return {
          status: "error",
          code: "invalid_operation",
          message:
            "Use --task-id <id> [--resend] [--style card|native] [--repeat], without --json/--stdin",
        };
      }
      const body = {
        taskId: readOption(argv, "--task-id")!,
        resend: hasFlag(argv, "--resend"),
        ...(readOption(argv, "--style")
          ? { style: readOption(argv, "--style") }
          : {}),
      };
      const key = deriveCommandIdempotencyKey(env, "tasks.status-card", body, {
        repeat: hasFlag(argv, "--repeat"),
      });
      return await submitAndWaitCommand(env, {
        method: "POST",
        path: "/api/runner/tasks/status-card",
        idempotencyKey: key,
        body,
      });
    }
    if (
      !["create", "update", "restart", "cancel", "status-card"].includes(command)
    ) {
      return {
        status: "error",
        code: "invalid_operation",
        message: TASKS_USAGE,
      };
    }
    const inline = readOption(argv, "--json");
    const stdin = hasFlag(argv, "--stdin");
    if ((inline !== undefined) === stdin) {
      return {
        status: "error",
        code: "invalid_operation",
        message: "Provide exactly one of --stdin or --json '<object>'",
      };
    }
    const parsed: unknown = JSON.parse(
      stdin ? await Bun.stdin.text() : inline!,
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object");
    }
    const body = { ...(parsed as Record<string, unknown>) };
    if (readOption(argv, "--style")) {
      if (command !== "status-card") {
        throw new Error("--style is only valid for tasks status-card");
      }
      body.style = readOption(argv, "--style");
    }
    if (hasFlag(argv, "--resend")) {
      if (command !== "status-card") {
        throw new Error("--resend is only valid for tasks status-card");
      }
      body.resend = true;
    }
    const key = deriveCommandIdempotencyKey(env, `tasks.${command}`, body, {
      repeat: hasFlag(argv, "--repeat"),
    });
    return await submitAndWaitCommand(env, {
      method: "POST",
      path: `/api/runner/tasks/${command}`,
      idempotencyKey: key,
      body,
    });
  } catch (error) {
    return {
      status: "error",
      code: "operation_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
