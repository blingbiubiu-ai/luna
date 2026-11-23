import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  assertNoLegacyRequestId,
  callUnifiedService,
  deriveCommandIdempotencyKey,
  parseDurationMs,
  submitAndWaitCommand,
} from "@luna/cli-support/service-client";

const HANDOFF_USAGE =
  "Usage: luna handoff --to <address> (--text <instruction> | --stdin) [--expires-in <duration>] [--repeat]\nAddresses: self, user:<id>, session:<id>, group:<id>";

const HANDOFFS_USAGE =
  "Usage: luna handoffs resolve <request-id> (--summary <text> | --declined --reason <text>)";

export async function runHandoffCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  if (argv[0] === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: HANDOFF_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    const to = readOption(argv, "--to")?.trim();
    const inlineText = readOption(argv, "--text");
    const stdin = hasFlag(argv, "--stdin");
    if (stdin && inlineText !== undefined) {
      return {
        status: "error",
        code: "invalid_handoff",
        message: "Choose --text or --stdin, not both",
      };
    }
    const instruction = stdin ? await Bun.stdin.text() : inlineText;
    if (!to || !instruction?.trim()) {
      return {
        status: "error",
        code: "invalid_handoff",
        message: HANDOFF_USAGE,
      };
    }
    const expiresInRaw = readOption(argv, "--expires-in");
    const expiresInMs = expiresInRaw ? parseDurationMs(expiresInRaw) : undefined;
    const contextRefs = argv.flatMap((arg, i) =>
      arg === "--context-ref" && argv[i + 1] && !argv[i + 1]!.startsWith("--")
        ? [argv[i + 1]!]
        : [],
    );
    const body = {
      to,
      instruction,
      contextRefs,
      ...(expiresInMs !== undefined ? { expiresInMs } : {}),
    };
    const key = deriveCommandIdempotencyKey(env, "handoff", body, {
      repeat: hasFlag(argv, "--repeat"),
    });
    return await submitAndWaitCommand(
      env,
      {
        method: "POST",
        path: "/api/runner/handoffs",
        idempotencyKey: key,
        body,
      },
      { wait: false },
    );
  } catch (error) {
    return {
      status: "error",
      code: "invalid_handoff",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runHandoffsCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  if (
    !argv[0] ||
    argv[0] === "help" ||
    hasFlag(argv, "--help") ||
    hasFlag(argv, "-h")
  ) {
    return { status: "ok", output: HANDOFFS_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    if (argv[0] !== "resolve" || !argv[1] || argv[1].startsWith("--")) {
      return {
        status: "error",
        code: "invalid_handoffs_command",
        message: HANDOFFS_USAGE,
      };
    }
    const requestId = argv[1];
    const declined = hasFlag(argv, "--declined");
    const summary = readOption(argv, "--summary");
    const reason = readOption(argv, "--reason");
    if (declined ? !reason?.trim() : !(summary ?? reason)?.trim()) {
      return {
        status: "error",
        code: "invalid_handoffs_command",
        message: HANDOFFS_USAGE,
      };
    }
    return await callUnifiedService(env, {
      method: "POST",
      path: `/api/runner/handoffs/${encodeURIComponent(requestId)}/resolve`,
      body: {
        declined,
        ...(summary !== undefined ? { summary } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    });
  } catch (error) {
    return {
      status: "error",
      code: "handoffs_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
