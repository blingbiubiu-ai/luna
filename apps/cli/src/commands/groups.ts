import type { CliResult, Env } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";
export async function runGroupsCli(argv: readonly string[], env: Env): Promise<CliResult> {
  if (argv.includes("--json") || argv.includes("--stdin")) {
    try {
      const action = argv[0];
      if (action !== "create" && action !== "invite") throw new Error("JSON input is available for groups create and invite");
      const stdin = argv.includes("--stdin");
      const jsonIndex = argv.indexOf("--json");
      const inline = jsonIndex === -1 ? undefined : argv[jsonIndex + 1];
      const jsonValue = inline && !inline.startsWith("--") ? inline : undefined;
      if (!argv.includes("--json") || (!stdin && !jsonValue) || (stdin && jsonValue))
        throw new Error("Use --json --stdin or --json '<object>'");
      const key = readOption(argv, "--request-id");
      const options = argv.slice(1).filter((_, index) => {
        const position = index + 1;
        return (!jsonValue || position !== jsonIndex + 1) && (key === undefined || position !== argv.indexOf("--request-id") + 1);
      });
      const allowed = ["--json", ...(stdin ? ["--stdin"] : []), ...(key ? ["--request-id"] : [])];
      if (options.length !== allowed.length || allowed.some(flag => !options.includes(flag)))
        throw new Error("Put group fields in JSON when using --json");
      const body: unknown = JSON.parse(jsonValue ?? await Bun.stdin.text());
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
      return await callUnifiedService(env, { method: "POST", path: action === "create" ? "/api/runner/groups" : "/api/runner/groups/invite",
        idempotencyKey: key ?? crypto.randomUUID(), body: body as Record<string, unknown> });
    } catch (error) {
      return { status: "error", code: "invalid_group_command", message: String(error) };
    }
  }
  const channelId = readOption(argv, "--channel-id");
  const params = new URLSearchParams();
  if (channelId) params.set("channelId", channelId);
  if (argv[0] === "search") {
    for (const [key, flag] of [["q", "--query"], ["userId", "--user-id"], ["limit", "--limit"], ["offset", "--offset"]] as const) {
      const value = readOption(argv, flag);
      if (value !== undefined) params.set(key, value);
    }
    return callUnifiedService(env, { method: "GET", path: `/api/runner/groups?${params}` });
  }
  if (argv[0] === "get" && argv[1]) return callUnifiedService(env, { method: "GET", path: `/api/runner/groups/${encodeURIComponent(argv[1])}` });
  if (argv[0] === "status" && argv[1]) return callUnifiedService(env, { method: "GET", path: `/api/runner/commands/${encodeURIComponent(argv[1])}` });
  const chatId = readOption(argv, "--chat-id");
  if (argv[0] === "lookup" && channelId && chatId) {
    params.set("chatId", chatId); return callUnifiedService(env, { method: "GET", path: `/api/runner/groups/lookup?${params}` });
  }
  const name = readOption(argv, "--name"), key = readOption(argv, "--request-id");
  const memberIds = argv.flatMap((arg, i) => arg === "--member" && argv[i+1] && !argv[i+1]!.startsWith("--") ? [argv[i+1]!] : []);
  if (argv[0] === "invite" && channelId && chatId && key && memberIds.length) return callUnifiedService(env, { method: "POST", path: "/api/runner/groups/invite", idempotencyKey: key,
    body: { channelId, chatId, idType: readOption(argv, "--id-type") ?? "open_id", memberIds } });
  const contextMessageIds: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--context-message") {
    const id = argv[i + 1];
    if (!id || id.startsWith("--")) return {status: "error", code: "invalid_group_context", message: "--context-message requires a Luna message ID"};
    contextMessageIds.push(id);
  }
  if (contextMessageIds.length && argv[0] !== "create") return {status: "error", code: "invalid_group_context", message: "Context messages belong to group creation"};
  if (argv[0] === "create" && channelId && name && key && memberIds.length) return callUnifiedService(env, { method: "POST", path: "/api/runner/groups", idempotencyKey: key,
    body: { channelId, name, idType: readOption(argv, "--id-type") ?? "open_id", memberIds, contextMessageIds } });
  return { status: "error", code: "invalid_group_command", message: "Usage: luna groups search [--query <name>] [--user-id <Luna-user-id>]; get <group-id>; lookup --channel-id <id> --chat-id <id>; create --channel-id <id> --name <name> --member <provider-user-id> [--member <id>] [--context-message <luna-message-id>] --request-id <key> [--id-type open_id|user_id|union_id]; invite --channel-id <id> --chat-id <id> --member <provider-user-id> --request-id <key>; status <command-id>" };
}
