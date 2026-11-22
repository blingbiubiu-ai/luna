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

const ASKS_USAGE = [
  "Usage:",
  "  luna asks create --to <address> (--question <text> | --stdin) [--context <text>] [--options '<json-array>'] [--expires-in <duration>] [--repeat]",
  "  luna asks answer <request-id> (--answer <text> | --stdin) [--option <selected-option>]",
  "  luna asks cancel <request-id>",
  "  luna asks list [--status pending|answered|done|declined|cancelled|expired] [--limit <n>]",
].join("\n");

export async function runAsksCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const sub = argv[0];
  if (!sub || sub === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: ASKS_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    if (sub === "list") {
      return await callUnifiedService(env, {
        method: "GET",
        path: servicePathWithQuery("/api/runner/asks", {
          status: readOption(argv, "--status"),
          limit: readOption(argv, "--limit"),
        }),
      });
    }
    if (sub === "create") {
      const to = readOption(argv, "--to")?.trim();
      const inlineQuestion = readOption(argv, "--question");
      const stdin = hasFlag(argv, "--stdin");
      if (stdin && inlineQuestion !== undefined) {
        return {
          status: "error",
          code: "invalid_ask",
          message: "Choose --question or --stdin, not both",
        };
      }
      const question = stdin ? await Bun.stdin.text() : inlineQuestion;
      if (!to || !question?.trim()) {
        return { status: "error", code: "invalid_ask", message: ASKS_USAGE };
      }
      const context = readOption(argv, "--context");
      const optionsRaw = readOption(argv, "--options");
      let options: string[] | undefined;
      if (optionsRaw !== undefined) {
        const parsed: unknown = JSON.parse(optionsRaw);
        if (
          !Array.isArray(parsed) ||
          parsed.some(item => typeof item !== "string")
        ) {
          throw new Error("--options must be a JSON string array, e.g. '[\"同意\",\"拒绝\"]'");
        }
        options = parsed;
      }
      const expiresInRaw = readOption(argv, "--expires-in");
      const expiresInMs = expiresInRaw
        ? parseDurationMs(expiresInRaw)
        : undefined;
      const body = {
        to,
        question,
        ...(context !== undefined ? { context } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(expiresInMs !== undefined ? { expiresInMs } : {}),
      };
      const key = deriveCommandIdempotencyKey(env, "asks.create", body, {
        repeat: hasFlag(argv, "--repeat"),
      });
      return await submitAndWaitCommand(
        env,
        {
          method: "POST",
          path: "/api/runner/asks",
          idempotencyKey: key,
          body,
        },
        { wait: false },
      );
    }
    if (sub === "answer") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return { status: "error", code: "invalid_ask", message: ASKS_USAGE };
      }
      const inlineAnswer = readOption(argv, "--answer");
      const stdin = hasFlag(argv, "--stdin");
      if (stdin && inlineAnswer !== undefined) {
        return {
          status: "error",
          code: "invalid_ask",
          message: "Choose --answer or --stdin, not both",
        };
      }
      const answer = stdin ? await Bun.stdin.text() : inlineAnswer;
      const selectedOption = readOption(argv, "--option");
      const resolvedAnswer = answer ?? selectedOption;
      if (!resolvedAnswer?.trim()) {
        return { status: "error", code: "invalid_ask", message: ASKS_USAGE };
      }
      return await callUnifiedService(env, {
        method: "POST",
        path: `/api/runner/asks/${encodeURIComponent(id)}/answer`,
        body: {
          answer: resolvedAnswer,
          ...(selectedOption !== undefined ? { selectedOption } : {}),
        },
      });
    }
    if (sub === "cancel") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        return { status: "error", code: "invalid_ask", message: ASKS_USAGE };
      }
      return await callUnifiedService(env, {
        method: "POST",
        path: `/api/runner/asks/${encodeURIComponent(id)}/cancel`,
      });
    }
    return { status: "error", code: "invalid_ask", message: ASKS_USAGE };
  } catch (error) {
    return {
      status: "error",
      code: "asks_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
