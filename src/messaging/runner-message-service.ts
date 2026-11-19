import { parseReply, replyMarkdown, type ReplyDocument } from "@luna/runner-protocol/reply";
import { InvocationService } from "@/runners/invocation-service";
import { sessionCommandsFor } from "./session-command-service";
import type { DrizzleDB } from "@/data";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import type { ReplyChannel } from "@/channels/outbound";
export class RunnerMessageService {
    constructor(private readonly db: DrizzleDB, private readonly channelFor: (id: string) => ReplyChannel | undefined) { }
    actor(claims: LunaAccessTokenClaims | undefined) {
        if (claims?.source !== "runner" || claims.role !== "runner" || !["main", "work"].includes(claims.runnerKind ?? ""))
            throw new GatewayError("runner_required", "A Main or Work Runner token is required", 403);
          const { invocation, snapshot } = new InvocationService(this.db).requireActive(claims!, claims!.runnerKind as "main" | "work");
          if (snapshot.kind === "task") throw new GatewayError("runner_required", "Main or Work required", 403);
          const source = snapshot.kind === "main" && snapshot.input.input.type === "session_trigger" ? snapshot.input.input : undefined;
          return { userId: invocation.actorUserId, sourceSessionId: invocation.sessionId!, currentSessionId: invocation.sessionId!, originId: invocation.originId,
              ...(snapshot.kind === "main" && snapshot.input.input.type === "user_messages"
                ? {triggerMessageId: snapshot.input.input.messages.at(-1)?.messageId} : {}),
              contextBefore: invocation.createdAt,
              ...(source ? { correlationId: source.correlationId, hops: source.hops } : {}) };
    }
    get(claims: LunaAccessTokenClaims | undefined, id: string) {
        const actor = this.actor(claims);
        const row = sessionCommandsFor(this.db, this.channelFor).get(id);
        if (!row || row.actorUserId !== actor.userId || row.sourceSessionId !== actor.sourceSessionId || (row.sessionId !== actor.currentSessionId && row.originId !== actor.originId))
            throw new GatewayError("command_not_found", "Command not found", 404);
        return row;
    }
    async send(claims: LunaAccessTokenClaims | undefined, key: string, content: string, purpose: "progress" | "answer" | "notification", targetSessionId?: string, reply?: ReplyDocument, mentionBotUserId?: string) {
        if (key === "service-final-answer") throw new GatewayError("reserved_request_id", "Reserved request ID", 400);
        const actor = this.actor(claims);
        if (reply) { reply = parseReply(JSON.stringify(reply)); content = replyMarkdown(reply); }
        return sessionCommandsFor(this.db, this.channelFor).accept(actor, targetSessionId ?? actor.currentSessionId, "message.send", key, { content, purpose, ...(reply ? { reply } : {}), ...(mentionBotUserId ? { mentionBotUserId } : {}) });
    }
    invoke(claims: LunaAccessTokenClaims | undefined, key: string, sessionId: string, instruction: string, contextRefs: string[] = []) {
        const actor = this.actor(claims);
        if (sessionId === actor.currentSessionId)
            throw new GatewayError("self_handoff", "Cannot hand off to the same session", 409);
        return sessionCommandsFor(this.db, this.channelFor).accept(actor, sessionId, "session.invoke", key, { content: instruction, contextRefs });
    }
}
