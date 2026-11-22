import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessionCommands, sessions } from "@/data/schema";
import { isGroupChannelSurface } from "@/channels/directory-store";
import { GatewayError } from "@/server/gateway-error";
import { InvocationService } from "@/runners/invocation-service";
import { parseReply, replyMarkdown, type ReplyDocument } from "@luna/runner-protocol/reply";
import { sessionCommandsFor } from "./session-command-service";
import { getKernel } from "@/server/routes/kernel";

/** Accepted answers retain ownership of delivery, including ambiguous provider outcomes. */
export function runnerAnswers(db: DrizzleDB, sessionId: string, originId: string) {
  return db.select().from(sessionCommands)
    .where(and(eq(sessionCommands.sessionId, sessionId), eq(sessionCommands.originId, originId),
      eq(sessionCommands.kind, "message.send")))
    .orderBy(asc(sessionCommands.createdAt), sql`session_commands.rowid`).all()
    .filter(command => command.payload.purpose === "answer" &&
      ["pending", "running", "sent", "unknown"].includes(command.status));
}

/** Accept before business settlement so terminal-Job recovery can repeat safely. */
export function finalizeRunnerReply(db: DrizzleDB, input: {
  sessionId: string; originId: string; invocationId?: string; text: string;
  allowSilent: boolean; actorUserId?: string | null | undefined;
  /** The message this answer responds to and the person who asked; addressed in a Feishu group. */
  addressee?: ReplyAddressee | undefined;
}) {
  const answers = runnerAnswers(db, input.sessionId, input.originId);
  if (answers.length) return { kind: "existing" as const, commandIds: answers.map(row => row.id) };
  const text = input.text.trim();
  if (text === "LUNA_NOTHING_TO_SEND") {
    if (!input.allowSilent) throw new Error("Runner ended a private turn without an answer");
    return { kind: "silent" as const };
  }
  if (!text || /(?:^|\n)LUNA_NOTHING_TO_SEND\s*$/.test(text)) throw new Error("Missing or mixed final reply");
  const invocation = input.invocationId ? new InvocationService(db).requireScope(input.invocationId) : undefined;
  if (invocation && (invocation.sessionId !== input.sessionId || invocation.originId !== input.originId)) throw new Error("Final reply scope mismatch");
  const userId = invocation?.actorUserId ?? input.actorUserId;
  if (!userId) throw new Error("Final reply actor is missing");
  const parsed = parseReply(text);
  const accept = (reply: ReplyDocument) => sessionCommandsFor(db, id => getKernel().replyChannel(id)).accept({
    userId, sourceSessionId: input.sessionId, originId: input.originId,
  }, input.sessionId, "message.send", "service-final-answer", { content: replyMarkdown(reply), reply, purpose: "answer" });
  const addressee = input.addressee && feishuGroup(db, input.sessionId) ? input.addressee : undefined;
  const quoted = addressee?.messageId && !parsed.replyTo ? { ...parsed, replyTo: addressee.messageId } : parsed;
  const mentioned = addressee?.userId && parsed.presentation !== "card" && !parsed.content.some(block => block.type === "mention")
    ? { ...quoted, presentation: "message" as const, content: [{ type: "mention" as const, userId: addressee.userId }, { type: "text" as const, text: " " }, ...quoted.content] }
    : quoted;
  let command;
  try { command = accept(mentioned); }
  catch (error) {
    // Someone without a resolvable address in this chat still gets the quoted answer.
    if (mentioned === quoted || !(error instanceof GatewayError) || !MENTION_REFUSALS.has(error.code)) throw error;
    command = accept(quoted);
  }
  return { kind: "queued" as const, commandId: command.id };
}

export interface ReplyAddressee { readonly messageId?: string | undefined; readonly userId?: string | undefined }
const MENTION_REFUSALS = new Set(["mention_unresolved", "bot_mention_self", "bot_mention_group_required", "invalid_mention"]);

/** Answers are addressed only where a chat holds several people: a Feishu group or one of its topics. */
function feishuGroup(db: DrizzleDB, sessionId: string): boolean {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.channel_type !== "feishu" || !session.group_id) return false;
  return isGroupChannelSurface(db, session.channel_id, session.group_id, session.channel_type);
}
