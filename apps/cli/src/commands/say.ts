import { parseReply } from "@luna/runner-protocol/reply";
import type { CliResult, Env } from "@luna/cli-support/types";
import { hasFlag, readOption } from "@luna/cli-support/options";
import {
  assertNoLegacyRequestId,
  deriveCommandIdempotencyKey,
  submitAndWaitCommand,
} from "@luna/cli-support/service-client";
import { z } from "zod";

const shorthand = z
  .array(
    z.union([
      z.object({ text: z.string() }).strict(),
      z.object({ mention: z.string() }).strict(),
    ]),
  )
  .min(1)
  .max(32);

const LEGACY_TARGET_FLAGS = [
  "--chat-id",
  "--feishu-user-id",
  "--id-type",
  "--channel-id",
  "--session-id",
  "--user-id",
] as const;

const SAY_USAGE =
  "Usage: luna say [--to <address>] (--text <text> | --stdin) [--json] [--purpose progress|answer|notification] [--repeat]\nAddresses: current (default), owner, user:<id>, session:<id>, group:<id>";

function parseMessageJson(text: string) {
  const input: unknown = JSON.parse(text);
  if (!Array.isArray(input)) return parseReply(text);
  return parseReply(
    JSON.stringify({
      type: "luna.reply",
      version: 1,
      presentation: "message",
      content: shorthand.parse(input).map(block =>
        "text" in block
          ? { type: "text", text: block.text }
          : { type: "mention", userId: block.mention },
      ),
    }),
  );
}

export async function runSayCli(
  argv: readonly string[],
  env: Env,
): Promise<CliResult> {
  if (argv[0] === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { status: "ok", output: SAY_USAGE };
  }
  try {
    assertNoLegacyRequestId(argv);
    const legacy = LEGACY_TARGET_FLAGS.find(flag => argv.includes(flag));
    if (legacy) {
      return {
        status: "error",
        code: "legacy_target_removed",
        message: `${legacy} is removed in Protocol v2; pass a unified address via --to (current, user:<id>, session:<id>, group:<id>)`,
      };
    }
    if (argv.includes("--mention") || argv.includes("--mention-bot")) {
      return {
        status: "error",
        code: "invalid_say_command",
        message: "Use --json with a mention block containing a Luna user ID",
      };
    }
    const inlineText = readOption(argv, "--text");
    const stdin = hasFlag(argv, "--stdin");
    if (stdin && inlineText !== undefined) {
      return {
        status: "error",
        code: "invalid_say_command",
        message: "Choose --text or --stdin, not both",
      };
    }
    const text = stdin ? await Bun.stdin.text() : inlineText;
    if (!text || !text.trim()) {
      return {
        status: "error",
        code: "invalid_say_command",
        message: SAY_USAGE,
      };
    }
    const to = readOption(argv, "--to")?.trim() || "current";
    const purpose =
      readOption(argv, "--purpose") ??
      (to === "current" ? "progress" : "notification");
    if (!["progress", "answer", "notification"].includes(purpose)) {
      return {
        status: "error",
        code: "invalid_say_command",
        message: SAY_USAGE,
      };
    }
    const reply = hasFlag(argv, "--json") ? parseMessageJson(text) : undefined;
    const body = {
      to,
      ...(reply ? { reply } : { content: [{ type: "text", text }] }),
      purpose,
    };
    const key = deriveCommandIdempotencyKey(env, "say", body, {
      repeat: hasFlag(argv, "--repeat"),
    });
    return await submitAndWaitCommand(env, {
      method: "POST",
      path: "/api/runner/messages",
      idempotencyKey: key,
      body,
    });
  } catch (error) {
    return {
      status: "error",
      code: "say_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
