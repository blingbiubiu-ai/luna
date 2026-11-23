import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  assertNoLegacyRequestId,
  callUnifiedService,
  deriveCommandIdempotencyKey,
  submitAndWaitCommand,
} from "@luna/cli-support/service-client";

const GROUPS_USAGE = [
  "Usage:",
  "  luna groups search [--query <name>] [--user <user:<id>>] [--limit <n>] [--offset <n>]",
  "  luna groups get <group-id>",
  "  luna groups lookup --channel-id <id> --chat-id <id>",
  "  luna groups create --name <name> --member user:<id> [--member user:<id>...] [--context-message <luna-message-id>...] [--repeat]",
  "  luna groups invite [--to group:<id>] --member user:<id> [--member user:<id>...] [--repeat]",
  "  luna groups create|invite (--json '<object>' | --stdin) [--repeat]",
].join("\n");

export async function runGroupsCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const action = argv[0];
  if (
    !action ||
    action === "help" ||
    hasFlag(argv, "--help") ||
    hasFlag(argv, "-h")
  ) {
    return { status: "ok", output: GROUPS_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    if (action === "status") {
      return {
        status: "error",
        code: "legacy_status_removed",
        message:
          "Per-domain status subcommands are removed in Protocol v2; use `luna commands status <id>` or `luna commands wait <id>`",
      };
    }

    if (argv.includes("--json") || hasFlag(argv, "--stdin")) {
      if (action !== "create" && action !== "invite") {
        throw new Error("JSON input is available for groups create and invite");
      }
      const stdin = hasFlag(argv, "--stdin");
      const jsonIndex = argv.indexOf("--json");
      const inline = jsonIndex === -1 ? undefined : argv[jsonIndex + 1];
      const jsonValue = inline && !inline.startsWith("--") ? inline : undefined;
      if ((!stdin && !jsonValue) || (stdin && jsonValue)) {
        throw new Error("Use --stdin or --json '<object>'");
      }
      const body: unknown = JSON.parse(jsonValue ?? (await Bun.stdin.text()));
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Expected a JSON object");
      }
      const key = deriveCommandIdempotencyKey(
        env,
        `groups.${action}`,
        body,
        { repeat: hasFlag(argv, "--repeat") },
      );
      return await submitAndWaitCommand(env, {
        method: "POST",
        path:
          action === "create"
            ? "/api/runner/groups"
            : "/api/runner/groups/invite",
        idempotencyKey: key,
        body: body as Record<string, unknown>,
      });
    }

    if (action === "search") {
      const params = new URLSearchParams();
      const rawUser =
        readOption(argv, "--user") ?? readOption(argv, "--user-id");
      const userId = rawUser?.startsWith("user:")
        ? rawUser.slice("user:".length)
        : rawUser;
      if (userId !== undefined) params.set("userId", userId);
      for (const [key, flag] of [
        ["q", "--query"],
        ["limit", "--limit"],
        ["offset", "--offset"],
      ] as const) {
        const value = readOption(argv, flag);
        if (value !== undefined) params.set(key, value);
      }
      const qs = params.toString();
      return await callUnifiedService(env, {
        method: "GET",
        path: qs ? `/api/runner/groups?${qs}` : "/api/runner/groups",
      });
    }

    if (action === "get" && argv[1] && !argv[1].startsWith("--")) {
      const rawId = argv[1];
      const groupId = rawId.startsWith("group:")
        ? rawId.slice("group:".length)
        : rawId;
      return await callUnifiedService(env, {
        method: "GET",
        path: `/api/runner/groups/${encodeURIComponent(groupId)}`,
      });
    }

    if (action === "lookup") {
      const channelId = readOption(argv, "--channel-id");
      const chatId = readOption(argv, "--chat-id");
      if (!channelId || !chatId) {
        return {
          status: "error",
          code: "invalid_group_command",
          message: "Usage: luna groups lookup --channel-id <id> --chat-id <id>",
        };
      }
      const params = new URLSearchParams({ channelId, chatId });
      return await callUnifiedService(env, {
        method: "GET",
        path: `/api/runner/groups/lookup?${params}`,
      });
    }

    for (const legacyFlag of ["--channel-id", "--chat-id", "--id-type"]) {
      if (argv.includes(legacyFlag)) {
        return {
          status: "error",
          code: "legacy_target_removed",
          message: `${legacyFlag} is removed on groups ${action} in Protocol v2; pass unified addresses (--member user:<id>, --to group:<id>)`,
        };
      }
    }

    const memberIds = argv.flatMap((arg, i) =>
      arg === "--member" && argv[i + 1] && !argv[i + 1]!.startsWith("--")
        ? [argv[i + 1]!]
        : [],
    );

    if (action === "invite" && memberIds.length > 0) {
      const to = readOption(argv, "--to")?.trim();
      const body = {
        ...(to ? { to } : {}),
        memberIds,
      };
      const key = deriveCommandIdempotencyKey(env, "groups.invite", body, {
        repeat: hasFlag(argv, "--repeat"),
      });
      return await submitAndWaitCommand(env, {
        method: "POST",
        path: "/api/runner/groups/invite",
        idempotencyKey: key,
        body,
      });
    }

    if (action === "create") {
      const name = readOption(argv, "--name")?.trim();
      const contextMessageIds: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--context-message") {
          const id = argv[i + 1];
          if (!id || id.startsWith("--")) {
            return {
              status: "error",
              code: "invalid_group_context",
              message: "--context-message requires a Luna message ID",
            };
          }
          contextMessageIds.push(id);
        }
      }
      if (!name || memberIds.length === 0) {
        return {
          status: "error",
          code: "invalid_group_command",
          message: GROUPS_USAGE,
        };
      }
      const body = { name, memberIds, contextMessageIds };
      const key = deriveCommandIdempotencyKey(env, "groups.create", body, {
        repeat: hasFlag(argv, "--repeat"),
      });
      return await submitAndWaitCommand(env, {
        method: "POST",
        path: "/api/runner/groups",
        idempotencyKey: key,
        body,
      });
    }

    return {
      status: "error",
      code: "invalid_group_command",
      message: GROUPS_USAGE,
    };
  } catch (error) {
    return {
      status: "error",
      code: "invalid_group_command",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
