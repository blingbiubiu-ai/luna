import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { directRecipients, channelSurfaces, messages, sessionTimelineEntries, sessions, userIdentityLinks } from "@/data/schema";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { SessionStore } from "@/sessions/session-store";
import { GatewayError } from "@/server/gateway-error";
import { feishuRecipientClaims, requireFeishuRecipientClaim, type FeishuRecipientIdType } from "./feishu-recipient";
export type FeishuUserTarget = { kind: "feishu_user"; channelId: string; idType: FeishuRecipientIdType; id: string };
export type MessageTarget = FeishuUserTarget | {
    kind: "current_session";
} | {
    kind: "session";
    sessionId: string;
} | {
    kind: "surface";
    channelId: string;
    surfaceId: string;
    threadId?: string | undefined;
} | {
    kind: "user";
    userId: string;
    channelId?: string | undefined;
};
/** Resolution has no delivery side effects. External conversation creation is explicit. */
export function resolveMessageTarget(db: DrizzleDB, target: MessageTarget, currentSessionId?: string, create = false): string {
    if (currentSessionId && (target.kind === "user" || target.kind === "surface" || target.kind === "feishu_user")) {
        const store = new SessionStore(db);
        const current = store.getById(currentSessionId);
        if (!current || (target.channelId && current.channel_id !== target.channelId))
            throw new GatewayError("channel_forbidden", "Channel is outside the current session's binding", 403);
        store.requireReplyUserId(currentSessionId);
        if (target.kind === "user") target = {...target, channelId: current.channel_id};
    }
    if (target.kind === "feishu_user") {
        const claim = requireFeishuRecipientClaim(db, target.channelId, target.idType, target.id);
        const binding = new BotBindingStore(db).requireActive(target.channelId);
        const existing = db.select({ recipient: directRecipients }).from(directRecipients)
            .innerJoin(sessions, eq(sessions.id, directRecipients.sessionId))
            .where(and(eq(directRecipients.channelId, target.channelId), eq(directRecipients.idType, target.idType),
                eq(directRecipients.recipientId, target.id), eq(directRecipients.claimId, claim.claimId),
                eq(sessions.binding_id, binding.id), eq(sessions.status, "active"))).get()?.recipient;
        if (existing) return existing.sessionId;
        try { return resolveMessageTarget(db, { kind: "user", userId: claim.userId, channelId: target.channelId }, currentSessionId); }
        catch (error) { if (!(error instanceof GatewayError) || error.code !== "user_surface_unavailable") throw error; }
        if (!create) throw new GatewayError("recipient_unresolved", "Resolve this recipient before sending", 409);
        return db.transaction(tx => {
            const resolved = new SessionStore(tx as unknown as DrizzleDB).resolveByChannelSurface({ channelType: "feishu", channelId: target.channelId, groupId: `recipient:${claim.claimId}` });
            tx.insert(directRecipients).values({ id: randomUUID(), channelId: target.channelId, idType: target.idType, recipientId: target.id, sessionId: resolved.id, claimId: claim.claimId }).run();
            return resolved.id;
        });
    }
    if (target.kind === "current_session") {
        if (!currentSessionId)
            throw new GatewayError("missing_session", "No current session", 400);
        return currentSessionId;
    }
    if (target.kind === "session") {
        if (!db.select().from(sessions).where(eq(sessions.id, target.sessionId)).get())
            throw new GatewayError("session_not_found", "Session not found", 404);
        return target.sessionId;
    }
    if (target.kind === "user") {
        const currentBinding = target.channelId ? new BotBindingStore(db).activeForChannel(target.channelId) : undefined;
        const userSessions = db.select({ sessionId: directRecipients.sessionId }).from(directRecipients)
            .innerJoin(sessions, eq(sessions.id, directRecipients.sessionId))
            .innerJoin(channelSurfaces, and(eq(channelSurfaces.channelId, sessions.channel_id), eq(channelSurfaces.externalId, directRecipients.surfaceId)))
            .innerJoin(userIdentityLinks, eq(userIdentityLinks.id, directRecipients.claimId))
            .where(and(eq(userIdentityLinks.userId, target.userId), eq(sessions.status, "active"), eq(channelSurfaces.surfaceKind, "p2p"),
                currentBinding ? eq(sessions.binding_id, currentBinding.id) : undefined,
                target.channelId ? eq(directRecipients.channelId, target.channelId) : undefined)).all();
        const candidates = db.select({ session: sessions, surface: channelSurfaces }).from(sessions)
            .innerJoin(channelSurfaces, and(eq(channelSurfaces.channelId, sessions.channel_id), eq(channelSurfaces.externalId, sessions.group_id)))
            .innerJoin(sessionTimelineEntries, eq(sessionTimelineEntries.sessionId, sessions.id)).innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
            .where(and(eq(messages.senderUserId, target.userId), eq(sessionTimelineEntries.entryKind, "message"), eq(channelSurfaces.surfaceKind, "p2p"), eq(sessions.status, "active"), target.channelId ? eq(sessions.channel_id, target.channelId) : undefined,
                currentBinding ? eq(sessions.binding_id, currentBinding.id) : undefined)).all();
        const ids = [...new Set([...candidates.filter(c => !c.session.thread_key).map(c => c.session.id), ...userSessions.map(r => r.sessionId)])];
        if (ids.length === 0 && create) {
            const surfaces = [...new Map(candidates.map(c => [JSON.stringify([c.session.channel_id, c.session.group_id]), c.session])).values()];
            if (surfaces.length === 1) {
                const surface = surfaces[0]!;
                return new SessionStore(db).resolveByChannelSurface({ channelType: surface.channel_type, channelId: surface.channel_id, groupId: surface.group_id! }).id;
            }
            if (surfaces.length === 0 && target.channelId) {
                const claims = feishuRecipientClaims(db, target.channelId, "open_id", { userId: target.userId });
                if (claims.length === 1)
                    return resolveMessageTarget(db, { kind: "feishu_user", channelId: target.channelId, idType: "open_id", id: claims[0]!.id }, currentSessionId, true);
            }
        }
        if (ids.length !== 1)
            throw new GatewayError(ids.length ? "ambiguous_target" : "user_surface_unavailable", "Specify an existing private session or resolve the provider conversation first", 409);
        return ids[0]!;
    }
    const surface = db.select().from(channelSurfaces).where(and(eq(channelSurfaces.channelId, target.channelId), eq(channelSurfaces.externalId, target.surfaceId))).get();
    if (!surface)
        throw new GatewayError("surface_unavailable", "Only known channel surfaces can be resolved", 404);
    const binding = new BotBindingStore(db).requireActive(target.channelId);
    const existing = db.select().from(sessions).where(and(eq(sessions.channel_id, target.channelId), eq(sessions.group_id, target.surfaceId), eq(sessions.binding_id, binding.id), eq(sessions.status, "active"))).all().find(s => (s.thread_key ?? undefined) === target.threadId);
    if (existing)
        return existing.id;
    if (!create)
        throw new GatewayError("session_not_found", "Resolve the target conversation before sending", 404);
    if (target.threadId)
        throw new GatewayError("thread_unavailable", "Import or explicitly create the external thread first", 409);
    return new SessionStore(db).resolveByChannelSurface({ channelType: surface.channelType, channelId: target.channelId, groupId: target.surfaceId }).id;
}
