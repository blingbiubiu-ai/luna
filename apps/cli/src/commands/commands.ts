import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  callUnifiedService,
  parseDurationMs,
  waitForCommand,
} from "@luna/cli-support/service-client";

const COMMANDS_USAGE = [
  "Usage:",
  "  luna commands status <command-id>",
  "  luna commands wait <command-id> [--timeout-ms <ms>]",
].join("\n");

export async function runCommandsCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const sub = argv[0];
  if (!sub || sub === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: COMMANDS_USAGE };
  }
  try {
    const id = argv[1];
    if (!id || id.startsWith("--")) {
      return {
        status: "error",
        code: "invalid_commands_query",
        message: COMMANDS_USAGE,
      };
    }
    if (sub === "status") {
      return await callUnifiedService(env, {
        method: "GET",
        path: `/api/runner/commands/${encodeURIComponent(id)}`,
      });
    }
    if (sub === "wait") {
      const timeoutRaw = readOption(argv, "--timeout-ms");
      const timeoutMs = timeoutRaw ? parseDurationMs(timeoutRaw) : 30_000;
      return await waitForCommand(env, id, { timeoutMs });
    }
    return {
      status: "error",
      code: "invalid_commands_query",
      message: COMMANDS_USAGE,
    };
  } catch (error) {
    return {
      status: "error",
      code: "commands_query_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
