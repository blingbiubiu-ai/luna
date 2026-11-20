import type { CliResult, Env } from "@luna/cli-support/types";
import { callUnifiedService } from "@luna/cli-support/service-client";

const usage = [
  "luna chat listen status   # whether you listen to this group chat without being addressed",
  "luna chat listen on|off   # switch it for this chat; only when the Agent owner, or a member allowed to, asked you in this turn",
].join("\n");

/** Listening for the group chat of the current invocation; Service derives the chat and the authority from the token. */
export async function runChatCli(argv: readonly string[], env: Env): Promise<CliResult> {
  const [command, action] = argv;
  if (command !== "listen" || !action || !["status", "on", "off"].includes(action))
    return command === undefined || command === "help" || argv.includes("--help") ? {status: "ok", output: usage}
      : {status: "error", code: "invalid_chat_command", message: usage};
  return action === "status"
    ? callUnifiedService(env, {method: "GET", path: "/api/runner/chat/listening"})
    : callUnifiedService(env, {method: "PUT", path: "/api/runner/chat/listening", body: {enabled: action === "on"}});
}
