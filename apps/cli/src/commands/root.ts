import type { CliResult, Env } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";

/** luna root status [--user <user-id>]: root switch of this Shadow and whether a person is trusted. */
export async function runRootCli(argv: readonly string[], env: Env): Promise<CliResult> {
  if (argv[0] !== "status") return { status: "error", code: "invalid_root_command", message: "Usage: luna root status [--user <user-id>]" };
  const user = readOption(argv, "--user");
  return callUnifiedService(env, { method: "GET", path: `/api/runner/root/status${user ? `?user=${encodeURIComponent(user)}` : ""}` });
}
