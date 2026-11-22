import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  callUnifiedService,
  servicePathWithQuery,
} from "@luna/cli-support/service-client";

const ACTIVITY_USAGE =
  "Usage: luna activity --since <ISO-8601-or-epoch-ms> [--limit <n>]";

export async function runActivityCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  if (argv[0] === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: ACTIVITY_USAGE };
  }
  try {
    const since = readOption(argv, "--since")?.trim();
    if (!since) {
      return {
        status: "error",
        code: "missing_since",
        message: ACTIVITY_USAGE,
      };
    }
    return await callUnifiedService(env, {
      method: "GET",
      path: servicePathWithQuery("/api/runner/activity", {
        since,
        limit: readOption(argv, "--limit"),
      }),
    });
  } catch (error) {
    return {
      status: "error",
      code: "activity_query_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
