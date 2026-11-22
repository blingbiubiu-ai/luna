import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  assertNoLegacyRequestId,
  callUnifiedService,
  deriveCommandIdempotencyKey,
  servicePathWithQuery,
  submitAndWaitCommand,
} from "@luna/cli-support/service-client";

const SESSIONS_USAGE = [
  "Usage:",
  "  luna sessions list [--kind local|p2p|group|thread] [--with-user <user:<id>>] [--limit <n>]",
  "  luna sessions timeline [--session <address-or-id>] [--before-entry-id <id>] [--after-entry-id <id>] [--limit <n>] [--include-references true|false]",
  "  luna sessions messages [--session <address-or-id>]",
  "  luna sessions create-thread [--handoff <instruction>] [--title <title>] [--anchor-message-id <id>] [--context-message <id>...] [--json '<object>' | --stdin] [--repeat]",
  "  luna sessions clarify|release (--stdin | --json '<object>') [--repeat]",
].join("\n");

function resolveSessionId(
  raw: string | undefined,
  env: Env,
): string | undefined {
  const value = raw?.trim() || env.LUNA_SESSION_ID?.trim();
  if (!value) return undefined;
  if (value === "current") return env.LUNA_SESSION_ID?.trim();
  if (value.startsWith("session:")) return value.slice("session:".length);
  return value;
}

export async function runSessionsCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  const command = argv[0];
  if (
    !command ||
    command === "help" ||
    hasFlag(argv, "--help") ||
    hasFlag(argv, "-h")
  ) {
    return { status: "ok", output: SESSIONS_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    if (command === "status") {
      return {
        status: "error",
        code: "legacy_status_removed",
        message:
          "Per-domain status subcommands are removed in Protocol v2; use `luna commands status <id>` or `luna commands wait <id>`",
      };
    }
    if (
      command === "read_session_timeline" ||
      command === "find_recent_session_attachments"
    ) {
      return {
        status: "error",
        code: "invalid_operation",
        message: `${command} is removed in Protocol v2; use \`luna sessions timeline\``,
      };
    }
    if (argv.includes("--session-id")) {
      return {
        status: "error",
        code: "legacy_target_removed",
        message:
          "--session-id is removed in Protocol v2; use --session current or --session session:<id>",
      };
    }
    if (command === "list") {
      const rawWithUser = readOption(argv, "--with-user")?.trim();
      const withUser = rawWithUser?.startsWith("user:")
        ? rawWithUser.slice("user:".length)
        : rawWithUser;
      return await callUnifiedService(env, {
        method: "GET",
        path: servicePathWithQuery("/api/runner/sessions", {
          kind: readOption(argv, "--kind"),
          withUser,
          limit: readOption(argv, "--limit"),
        }),
      });
    }
    if (command === "timeline" || command === "messages") {
      const sessionId = resolveSessionId(readOption(argv, "--session"), env);
      if (!sessionId) {
        return {
          status: "error",
          code: "missing_session",
          message: "Provide --session session:<id> or set LUNA_SESSION_ID",
        };
      }
      const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
      return await callUnifiedService(env, {
        method: "GET",
        path:
          command === "messages"
            ? `${base}/messages`
            : servicePathWithQuery(`${base}/timeline/read`, {
                beforeEntryId: readOption(argv, "--before-entry-id"),
                afterEntryId: readOption(argv, "--after-entry-id"),
                limit: readOption(argv, "--limit"),
                includeReferences: readOption(argv, "--include-references"),
              }),
      });
    }
    if (command === "create-thread") {
      const jsonIndex = argv.indexOf("--json");
      const jsonNext = jsonIndex === -1 ? undefined : argv[jsonIndex + 1];
      let effectiveArgv = argv;
      if (
        jsonIndex !== -1 &&
        hasFlag(argv, "--stdin") &&
        (jsonNext === undefined || jsonNext.startsWith("--"))
      ) {
        effectiveArgv = argv.filter(flag => flag !== "--json");
      }
      const inline = readOption(effectiveArgv, "--json");
      const stdin = hasFlag(effectiveArgv, "--stdin");
      if (inline !== undefined && stdin) {
        return {
          status: "error",
          code: "invalid_operation",
          message: "Choose --json '<object>' or --stdin, not both",
        };
      }
      const base: unknown = stdin
        ? JSON.parse(await Bun.stdin.text())
        : inline !== undefined
          ? JSON.parse(inline)
          : {};
      if (!base || typeof base !== "object" || Array.isArray(base)) {
        throw new Error("Expected a JSON object");
      }
      const body = { ...(base as Record<string, unknown>) };
      const title = readOption(effectiveArgv, "--title");
      const anchorMessageId = readOption(effectiveArgv, "--anchor-message-id");
      const handoff = readOption(effectiveArgv, "--handoff");
      const contextMessages = effectiveArgv.flatMap((arg, i) =>
        arg === "--context-message" &&
        effectiveArgv[i + 1] &&
        !effectiveArgv[i + 1]!.startsWith("--")
          ? [effectiveArgv[i + 1]!]
          : [],
      );
      if (title !== undefined) body.title = title;
      if (anchorMessageId !== undefined) body.anchorMessageId = anchorMessageId;
      if (contextMessages.length > 0) body.contextMessageIds = contextMessages;
      if (handoff !== undefined) body.handoffInstruction = handoff;

      const key = deriveCommandIdempotencyKey(
        env,
        "sessions.create-thread",
        body,
        { repeat: hasFlag(effectiveArgv, "--repeat") },
      );
      return await submitAndWaitCommand(env, {
        method: "POST",
        path: "/api/runner/sessions/create-thread",
        idempotencyKey: key,
        body,
      });
    }
    if (command === "clarify" || command === "release") {
      const inline = readOption(argv, "--json");
      const stdin = hasFlag(argv, "--stdin");
      if ((inline !== undefined) === stdin) {
        return {
          status: "error",
          code: "invalid_operation",
          message: "Provide exactly one of --stdin or --json '<object>'",
        };
      }
      const parsed: unknown = JSON.parse(
        stdin ? await Bun.stdin.text() : inline!,
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object");
      }
      const body = parsed as Record<string, unknown>;
      const key = deriveCommandIdempotencyKey(
        env,
        `sessions.${command}`,
        body,
        { repeat: hasFlag(argv, "--repeat") },
      );
      return await submitAndWaitCommand(env, {
        method: "POST",
        path: `/api/runner/sessions/${command}`,
        idempotencyKey: key,
        body,
      });
    }
    return {
      status: "error",
      code: "invalid_operation",
      message: SESSIONS_USAGE,
    };
  } catch (error) {
    return {
      status: "error",
      code: "operation_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
