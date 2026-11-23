import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  callUnifiedService,
  servicePathWithQuery,
} from "@luna/cli-support/service-client";

const REQUESTS_USAGE =
  "Usage: luna requests list [--status pending|answered|done|declined|cancelled|expired] [--kind ask|handoff] [--limit <n>]";

export async function runRequestsCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const sub = argv[0];
  if (!sub || sub === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: REQUESTS_USAGE };
  }
  try {
    if (sub !== "list") {
      return {
        status: "error",
        code: "invalid_requests_command",
        message: REQUESTS_USAGE,
      };
    }
    return await callUnifiedService(env, {
      method: "GET",
      path: servicePathWithQuery("/api/runner/requests", {
        status: readOption(argv, "--status"),
        kind: readOption(argv, "--kind"),
        limit: readOption(argv, "--limit"),
      }),
    });
  } catch (error) {
    return {
      status: "error",
      code: "requests_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
