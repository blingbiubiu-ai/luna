import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { runnerOperations, sessionCommands } from "@/data/schema";
import { InvocationService } from "@/runners/invocation-service";
import { parseReply, replyMarkdown } from "@luna/runner-protocol/reply";
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

/**
 * Accept before business settlement so terminal-Job recovery can repeat safely.
 * Service delivers the Runner's reply as written (`replyTo` quotes and inline
 * `mention` blocks are chosen by the Agent itself, never injected or stripped here).
 */
export function finalizeRunnerReply(db: DrizzleDB, input: {
  sessionId: string; originId: string; invocationId?: string; text: string;
  allowSilent: boolean; actorUserId?: string | null | undefined;
}) {
  const answers = runnerAnswers(db, input.sessionId, input.originId);
  if (answers.length) return { kind: "existing" as const, commandIds: answers.map(row => row.id) };
  // Protocol v2 invariant (3.6): atomic `create-thread --handoff` anchored to this turn's message suppresses source group duplicate reply.
  const threadHandoff = db.select().from(runnerOperations)
    .where(and(eq(runnerOperations.sessionId, input.sessionId), eq(runnerOperations.originId, input.originId)))
    .all()
    .find(op => {
      if (op.status !== "applied" || op.request.kind !== "session.create_thread" || !op.result?.handoffCommandId) {
        return false;
      }
      const latestTurnMsgId = op.context.sourceMessageIds.at(-1);
      return !latestTurnMsgId || op.request.payload.anchorMessageId === latestTurnMsgId;
    });
  if (threadHandoff?.result?.handoffCommandId) {
    return { kind: "thread_handoff" as const, commandId: threadHandoff.result.handoffCommandId };
  }
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
  const reply = parseReply(text);
  const command = sessionCommandsFor(db, id => getKernel().replyChannel(id)).accept({
    userId, sourceSessionId: input.sessionId, originId: input.originId,
  }, input.sessionId, "message.send", "service-final-answer", { content: replyMarkdown(reply), reply, purpose: "answer" });
  return { kind: "queued" as const, commandId: command.id };
}
