import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";

export async function runWhoamiCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  if (argv[0] === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return {
      status: "ok",
      output:
        "Usage: luna whoami\n\nReturn the active invocation's Protocol v2 capabilities manifest.",
    };
  }
  return await callUnifiedService(env, {
    method: "GET",
    path: "/api/runner/whoami",
  });
}
