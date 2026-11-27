import { parseLlmJson } from "@luna/runner-protocol/llm-json";
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

const SAY_USAGE = [
  "Usage:",
  "  luna say [--to <address>] (--text <text> | --stdin) [--json] [--purpose progress|answer|notification] [--repeat]",
  "  luna say --to <address> --via-main (--text <text> | --stdin) [--task-id <id>] [--context-ref <artifact-id>...] [--repeat]",
  "Addresses: current (default), owner, main (Task Runner), task:<id>, user:<id>, session:<id>, group:<id>",
].join("\n");

function parseMessageJson(text: string) {
  const input: unknown = parseLlmJson(text);
  if (!Array.isArray(input)) return parseReply(JSON.stringify(input));
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

function currentDeliveryNote(
  purpose: "progress" | "answer" | "notification",
): string {
  if (purpose === "answer") {
    return "Sent as the turn answer. Final terminal output will be suppressed for this turn.";
  }
  const label = purpose === "progress" ? "interim progress" : "notification";
  return `Sent as ${label}. If terminalOutputMode is reply_current_session, your final output will still be sent to this chat (output LUNA_NOTHING_TO_SEND to stay silent); if ignored, terminal output is not sent.`;
}

function attachCurrentDeliveryNote(
  result: CliResult,
  purpose: "progress" | "answer" | "notification",
): CliResult {
  if (result.status !== "ok" || !result.output) return result;
  try {
    const parsed: unknown = JSON.parse(result.output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return result;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.note === "string") return result;
    return {
      ...result,
      output: JSON.stringify({
        ...record,
        note: currentDeliveryNote(purpose),
      }),
    };
  } catch {
    return result;
  }
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
        message: `${legacy} is removed in Protocol v2; pass a unified address via --to (current, owner, main, task:<id>, user:<id>, session:<id>, group:<id>)`,
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
    const viaMain = hasFlag(argv, "--via-main");
    const defaultTo = env.LUNA_RUNNER_KIND === "task" ? "main" : "current";
    const to = readOption(argv, "--to")?.trim() || defaultTo;
    if (viaMain && to === "current") {
      return {
        status: "error",
        code: "invalid_say_command",
        message: "--via-main requires a non-current target address via --to",
      };
    }
    const rawTaskId = readOption(argv, "--task-id")?.trim();
    if (rawTaskId && !viaMain) {
      return {
        status: "error",
        code: "invalid_say_command",
        message: "--task-id is only supported with --via-main",
      };
    }
    const relatedTaskId = rawTaskId
      ? rawTaskId.startsWith("task:")
        ? rawTaskId.slice("task:".length)
        : rawTaskId
      : undefined;
    const contextRefs = argv.flatMap((arg, idx) =>
      arg === "--context-ref" &&
      argv[idx + 1] &&
      !argv[idx + 1]!.startsWith("--")
        ? [
            argv[idx + 1]!.startsWith("artifact:")
              ? argv[idx + 1]!.slice("artifact:".length)
              : argv[idx + 1]!,
          ]
        : [],
    );
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
      ...(viaMain ? { viaMain: true } : {}),
      ...(relatedTaskId ? { relatedTaskId } : {}),
      ...(contextRefs.length > 0 ? { contextRefs } : {}),
      ...(reply ? { reply } : { content: [{ type: "text", text }] }),
      purpose,
    };
    const key = deriveCommandIdempotencyKey(env, "say", body, {
      repeat: hasFlag(argv, "--repeat"),
    });
    const isAsyncInvoke = viaMain || to === "main" || to.startsWith("task:");
    const result = await submitAndWaitCommand(
      env,
      {
        method: "POST",
        path: "/api/runner/messages",
        idempotencyKey: key,
        body,
      },
      isAsyncInvoke ? { wait: false } : undefined,
    );
    if (to === "current" && !viaMain) {
      return attachCurrentDeliveryNote(
        result,
        purpose as "progress" | "answer" | "notification",
      );
    }
    return result;
  } catch (error) {
    return {
      status: "error",
      code: "say_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
