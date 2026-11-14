import type { CliResult, Env } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";
export async function runUsersCli(argv: readonly string[], env: Env): Promise<CliResult> {
  const params = new URLSearchParams();
  const channel = readOption(argv, "--channel-id");
  if (channel) params.set("channelId", channel);
  if (argv[0] === "get" && argv[1]) return callUnifiedService(env, { method: "GET", path: `/api/runner/users/${encodeURIComponent(argv[1])}` });
  if (argv[0] === "search") {
    for (const [key, option] of [["q", "--query"], ["kind", "--kind"], ["limit", "--limit"], ["offset", "--offset"]]) {
      const value = readOption(argv, option!); if (value) params.set(key!, value);
    }
    return callUnifiedService(env, { method: "GET", path: `/api/runner/users?${params}` });
  }
  const id = readOption(argv, "--feishu-user-id");
  if (argv[0] === "lookup" && channel && id) {
    params.set("id", id); params.set("idType", readOption(argv, "--id-type") ?? "open_id");
    return callUnifiedService(env, { method: "GET", path: `/api/runner/users/lookup?${params}` });
  }
  return { status: "error", code: "invalid_user_command", message: "Usage: luna users search --query <name> [--kind user|bot]; luna users get <user-id>; luna users lookup --channel-id <channel> --feishu-user-id <id> [--id-type open_id|user_id|union_id]" };
}
