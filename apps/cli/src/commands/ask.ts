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

const ASK_USAGE = [
  "Usage:",
  "  luna ask --to <address|main> (--text <text> | --stdin) [--context <text>] [--options '<json-array>'] [--actor owner|user:<id>] [--expires-in <duration>] [--wait [<duration>]] [--repeat]",
  "  luna ask reply <request-id> (--text <text> | --stdin) (--done | --progress | --declined) [--option <selected-option>]",
  "  luna ask message <request-id> (--text <text> | --stdin) [--repeat]",
  "  luna ask wait <request-id> [--timeout <duration>]",
  "  luna ask cancel <request-id>",
  "  luna ask get <request-id>",
  "  luna ask list [--status open|in_progress|done|declined|cancelled|expired|failed] [--mode card|delegate] [--role origin|target] [--limit <n>]",
  "Addresses: owner, current, main (Task Runner), user:<id>, session:<id>, group:<id>",
].join("\n");

function parseOptionalWaitDurationMs(
  argv: readonly string[],
  flagName: string,
  defaultWhenPresentMs: number,
): number | undefined {
  const idx = argv.indexOf(flagName);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith("--")) return defaultWhenPresentMs;
  return parseDurationMs(next);
}

export async function runAskCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const sub = argv[0];
  if (!sub || sub === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: ASK_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);

    if (sub === "create") {
      return {
        status: "error",
        code: "invalid_ask_command",
        message:
          "`luna ask` creates a request directly without `create`: run `luna ask --to <address> --text '...'`",
      };
    }
    if (sub === "update" || sub === "answer") {
      return {
        status: "error",
        code: "invalid_ask_command",
        message:
          `\`luna ask ${sub}\` is not used; run \`luna ask reply <request-id> --done|--progress|--declined --text '...'\``,
      };
    }

    // Direct ask creation: `luna ask --to <address|main> (--text <text> | --stdin) ...`
    if (sub.startsWith("--")) {
      const to =
        readOption(argv, "--to")?.trim() ||
        (env.LUNA_RUNNER_KIND === "task" ? "main" : undefined);
      const inlineText = readOption(argv, "--text");
      const stdin = hasFlag(argv, "--stdin");
      if (stdin && inlineText !== undefined) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: "Choose --text or --stdin, not both",
        };
      }
      const goal = stdin ? await Bun.stdin.text() : inlineText;
      if (!to || !goal?.trim()) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      const actor = readOption(argv, "--actor")?.trim();
      const context = readOption(argv, "--context");
      const optionsRaw = readOption(argv, "--options");
      let options: string[] | undefined;
      if (optionsRaw !== undefined) {
        const parsed: unknown = JSON.parse(optionsRaw);
        if (
          !Array.isArray(parsed) ||
          parsed.some(item => typeof item !== "string")
        ) {
          throw new Error(
            "--options must be a JSON string array, e.g. '[\"同意\",\"拒绝\"]'",
          );
        }
        options = parsed;
      }
      const expiresInRaw = readOption(argv, "--expires-in");
      const expiresInMs = expiresInRaw
        ? parseDurationMs(expiresInRaw)
        : undefined;
      const waitMs = parseOptionalWaitDurationMs(argv, "--wait", 60_000);

      const idempotencyBody = {
        to,
        ...(actor ? { actor } : {}),
        goal,
        ...(context !== undefined ? { context } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(expiresInMs !== undefined ? { expiresInMs } : {}),
      };
      const key = deriveCommandIdempotencyKey(
        env,
        "ask",
        idempotencyBody,
        { repeat: hasFlag(argv, "--repeat") },
      );
      return await submitAndWaitCommand(
        env,
        {
          method: "POST",
          path: "/api/runner/requests",
          idempotencyKey: key,
          body: {
            ...idempotencyBody,
            ...(waitMs !== undefined ? { waitMs } : {}),
          },
        },
        { wait: false },
      );
    }

    if (sub === "list") {
      return await callUnifiedService(env, {
        method: "GET",
        path: servicePathWithQuery("/api/runner/requests", {
          status: readOption(argv, "--status"),
          mode: readOption(argv, "--mode"),
          role: readOption(argv, "--role"),
          limit: readOption(argv, "--limit"),
        }),
      });
    }

    if (sub === "get") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      return await callUnifiedService(env, {
        method: "GET",
        path: `/api/runner/requests/${encodeURIComponent(id)}`,
      });
    }

    if (sub === "reply") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      const isProgress = hasFlag(argv, "--progress");
      const isDone = hasFlag(argv, "--done");
      const isDeclined = hasFlag(argv, "--declined");
      const actionFlags = [isProgress, isDone, isDeclined].filter(Boolean).length;
      if (actionFlags !== 1) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message:
            "Choose exactly one status flag: --done, --progress, or --declined",
        };
      }
      const action: "progress" | "done" | "declined" = isProgress
        ? "progress"
        : isDone
          ? "done"
          : "declined";
      const inlineText = readOption(argv, "--text");
      const stdin = hasFlag(argv, "--stdin");
      if (stdin && inlineText !== undefined) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: "Choose --text or --stdin, not both",
        };
      }
      const selectedOption = readOption(argv, "--option");
      const summary = (stdin ? await Bun.stdin.text() : inlineText) ?? selectedOption;
      if (!summary?.trim()) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      return await callUnifiedService(env, {
        method: "POST",
        path: `/api/runner/requests/${encodeURIComponent(id)}/update`,
        body: {
          action,
          summary,
          ...(selectedOption !== undefined ? { selectedOption } : {}),
        },
      });
    }

    if (sub === "message") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      const inlineText = readOption(argv, "--text");
      const stdin = hasFlag(argv, "--stdin");
      if (stdin && inlineText !== undefined) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: "Choose --text or --stdin, not both",
        };
      }
      const message = stdin ? await Bun.stdin.text() : inlineText;
      if (!message?.trim()) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      const body = { message };
      const key = deriveCommandIdempotencyKey(
        env,
        "ask.message",
        { id, ...body },
        { repeat: hasFlag(argv, "--repeat") },
      );
      return await submitAndWaitCommand(
        env,
        {
          method: "POST",
          path: `/api/runner/requests/${encodeURIComponent(id)}/messages`,
          idempotencyKey: key,
          body,
        },
        { wait: false },
      );
    }

    if (sub === "wait") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      const timeoutRaw = readOption(argv, "--timeout");
      const timeoutMs = timeoutRaw ? parseDurationMs(timeoutRaw) : 60_000;
      return await callUnifiedService(env, {
        method: "POST",
        path: `/api/runner/requests/${encodeURIComponent(id)}/wait`,
        body: { timeoutMs },
      });
    }

    if (sub === "cancel") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return {
          status: "error",
          code: "invalid_ask_command",
          message: ASK_USAGE,
        };
      }
      return await callUnifiedService(env, {
        method: "POST",
        path: `/api/runner/requests/${encodeURIComponent(id)}/cancel`,
      });
    }

    return {
      status: "error",
      code: "invalid_ask_command",
      message: ASK_USAGE,
    };
  } catch (error) {
    return {
      status: "error",
      code: "ask_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
