import { parseReply } from "@luna/runner-protocol/reply";
import type { CliResult, Env } from "@luna/cli-support/types";
import { readOption } from "@luna/cli-support/options";
import { callUnifiedService } from "@luna/cli-support/service-client";
import { z } from "zod";

const shorthand = z.array(z.union([
    z.object({ text: z.string() }).strict(),
    z.object({ mention: z.string() }).strict(),
])).min(1).max(32);

function parseMessageJson(text: string) {
    const input: unknown = JSON.parse(text);
    if (!Array.isArray(input)) return parseReply(text);
    return parseReply(JSON.stringify({ type: "luna.reply", version: 1, presentation: "message",
        content: shorthand.parse(input).map(block => "text" in block
            ? { type: "text", text: block.text }
            : { type: "mention", userId: block.mention }) }));
}
export async function runMessagesCli(argv: readonly string[], env: Env): Promise<CliResult> {
    try {
        if (argv[0] === "status" && argv[1])
            return callUnifiedService(env, { method: "GET", path: `/api/runner/commands/${encodeURIComponent(argv[1])}` });
        const inlineText = readOption(argv, "--text");
        if (argv.includes("--stdin") && inlineText !== undefined)
            return { status: "error", code: "invalid_message_command", message: "Choose --text or --stdin" };
        const text = argv.includes("--stdin") ? await Bun.stdin.text() : inlineText;
        const key = readOption(argv, "--request-id");
        const sessionId = readOption(argv, "--session-id");
        const chatId = readOption(argv, "--chat-id");
        const userId = readOption(argv, "--user-id");
        const feishuId = readOption(argv, "--feishu-user-id");
        const channelId = readOption(argv, "--channel-id");
        const idType = readOption(argv, "--id-type") ?? "open_id";
        if ([sessionId, userId, feishuId, chatId].filter(Boolean).length > 1 || (chatId && !channelId) || (feishuId && (!channelId || !["open_id", "user_id", "union_id"].includes(idType))))
            return { status: "error", code: "invalid_target", message: "Choose one target; Feishu IDs require --channel-id and a valid --id-type" };
        const target = chatId ? { kind: "surface", channelId, surfaceId: chatId } : feishuId ? { kind: "feishu_user", channelId, idType, id: feishuId } : userId ? { kind: "user", userId, ...(channelId ? { channelId } : {}) } : sessionId ? { kind: "session", sessionId } : { kind: "current_session" };
        const purpose = readOption(argv, "--purpose") ?? "progress";
        if (argv.includes("--mention") || argv.includes("--mention-bot")) {
            return { status: "error", code: "invalid_message_command", message: "Use --json with a mention block containing a Luna user ID" };
        }
        if (argv[0] === "handoff" && sessionId && text && key)
            return callUnifiedService(env, { method: "POST", path: "/api/runner/handoffs", idempotencyKey: key, body: { target: { kind: "session", sessionId }, instruction: text, contextRefs: [] } });
        if (argv[0] !== "send" || !text || !["progress", "answer", "notification"].includes(purpose)) {
            return { status: "error", code: "invalid_message_command", message: "Usage: luna messages send (--text <text> | --stdin) [--json] [--request-id <stable-id>] [--chat-id <id> --channel-id <channel> | --session-id <id> | --user-id <id> | --feishu-user-id <id> --channel-id <channel> --id-type open_id|user_id|union_id] [--purpose progress|answer|notification]; luna messages status <command-id>" };
        }
        const reply = argv.includes("--json") ? parseMessageJson(text) : undefined;
        let result = await callUnifiedService(env, { method: "POST", path: "/api/runner/messages", idempotencyKey: key ?? crypto.randomUUID(),
            body: { target, ...(reply ? { reply } : { content: [{ type: "text", text }] }), purpose } });
        const deadline = Date.now() + 30000;
        while (result.status === "ok") {
            const receipt = JSON.parse(result.output!) as { commandId: string; deliveryStatus: string };
            if (receipt.deliveryStatus === "sent") return result;
            if (!["pending", "running"].includes(receipt.deliveryStatus))
                return { ...result, status: "error", code: "message_delivery_failed", message: `Delivery status is ${receipt.deliveryStatus}; inspect the command before retrying` };
            if (Date.now() >= deadline)
                return { ...result, status: "error", code: "message_delivery_pending", message: "Delivery is still pending; query messages status with this commandId and reuse the request ID" };
            await Bun.sleep(250);
            result = await callUnifiedService(env, { method: "GET", path: `/api/runner/commands/${encodeURIComponent(receipt.commandId)}` });
        }
        return result;
    }
    catch (error) {
        return { status: "error", code: "message_command_failed", message: String(error) };
    }
}
