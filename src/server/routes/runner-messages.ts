import { replyMarkdown, replySchema } from "@luna/runner-protocol/reply";
import { scheduleTimingShape, resolveScheduleTiming } from "@luna/service-client/schedule-input";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessionSchedules } from "@/data/schema";
import { AgentError } from "@/agents/agent-store";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import { resolveMessageTarget } from "@/messaging/delivery-target";
import { Hono } from "hono";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import type { ReplyChannel } from "@/channels/outbound";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { RunnerMessageService } from "@/messaging/runner-message-service";
import { getKernel } from "./kernel";
export const messageTargetSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("feishu_user"), channelId: z.string().min(1), idType: z.enum(["open_id", "user_id", "union_id"]), id: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
    z.object({ kind: z.literal("current_session") }).strict(), z.object({ kind: z.literal("session"), sessionId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("surface"), channelId: z.string().min(1), surfaceId: z.string().min(1), threadId: z.string().optional() }).strict(),
    z.object({ kind: z.literal("user"), userId: z.string().min(1), channelId: z.string().optional() }).strict(),
]);
const bodySchema = z.object({
    target: messageTargetSchema,
    content: z.array(z.object({ type: z.literal("text"), text: z.string().min(1).max(20000) }).strict()).min(1).max(10).optional(),
    reply: replySchema.optional(),
    mentionBotUserId: z.string().min(1).max(256).optional(),
    purpose: z.enum(["progress", "answer", "notification"]).default("progress"),
}).strict().refine(body => Boolean(body.content) !== Boolean(body.reply), "Choose content or reply");
export function createRunnerMessageRoutes(options: {
    db?: DrizzleDB;
    channelFor?: (id: string) => ReplyChannel | undefined;
} = {}) {
    const service = () => new RunnerMessageService(options.db ?? getKernel().database.db, options.channelFor ?? ((id) => getKernel().replyChannel(id)));
    return new Hono<{
        Variables: {
            lunaAccessTokenClaims: LunaAccessTokenClaims | undefined;
        };
    }>()
        .onError((error, c) => error instanceof GatewayError
        ? c.json({ error: error.code, message: error.message }, error.status as 400)
        : error instanceof AgentError ? c.json({ error: error.code }, error.status) : c.json({ error: "internal_error" }, 500))
        .post("/messages", async (c) => {
        const key = c.req.header("Idempotency-Key");
        if (!key || !/^[\w.-]{1,128}$/.test(key))
            return c.json({ error: "invalid_idempotency_key" }, 400);
        const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success)
            return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
        const text = parsed.data.reply ? replyMarkdown(parsed.data.reply) : parsed.data.content!.map((block) => block.text).join("\n");
        const svc = service();
        const claims = c.get("lunaAccessTokenClaims");
        const actor = svc.actor(claims);
        const db = options.db ?? getKernel().database.db;
        if (parsed.data.mentionBotUserId && parsed.data.target.kind !== "current_session")
            throw new GatewayError("bot_mention_group_required", "Bot mentions must use the current group conversation", 400);
        const target = resolveMessageTarget(db, parsed.data.target, actor.currentSessionId, true);
        const row = await svc.send(claims, key, text, parsed.data.purpose, target, parsed.data.reply, parsed.data.mentionBotUserId);
        return c.json({ commandId: row.id, sessionId: row.sessionId, deliveryStatus: row.status, messageId: row.messageId, providerMessageId: row.providerMessageId, error: row.error }, ["pending", "running"].includes(row.status) ? 202 : 200);
    })
        .post("/handoffs", async (c) => {
        const schema = z.object({ target: messageTargetSchema, instruction: z.string().min(1).max(100000), contextRefs: z.array(z.string()).default([]) }).strict();
        const body = schema.safeParse(await c.req.json().catch(() => null));
        const key = c.req.header("Idempotency-Key");
        if (!body.success || !key)
            return c.json({ error: "invalid_request" }, 400);
        const svc = service(), claims = c.get("lunaAccessTokenClaims"), actor = svc.actor(claims);
        const target = resolveMessageTarget(options.db ?? getKernel().database.db, body.data.target, actor.currentSessionId, true);
        const row = svc.invoke(claims, key, target, body.data.instruction, body.data.contextRefs);
        return c.json({ commandId: row.id, triggerId: row.id, sessionId: row.sessionId, status: row.status }, 202);
    })
        .post("/schedules", async (c) => {
        const schema = z.object({ target: messageTargetSchema, ...scheduleTimingShape, action: z.object({ kind: z.enum(["message.send", "session.invoke"]), content: z.string().min(1).max(100000) }).strict() }).strict();
        const parsed = schema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success)
            return c.json({ error: "invalid_request" }, 400);
        const body = parsed.data;
        try {
            new Intl.DateTimeFormat("en", { timeZone: body.timezone });
        }
        catch {
            return c.json({ error: "invalid_timezone" }, 400);
        }
        const svc = service(), actor = svc.actor(c.get("lunaAccessTokenClaims"));
        const db = options.db ?? getKernel().database.db;
        const key = c.req.header("Idempotency-Key");
        if (!key || !/^[\w.-]{1,128}$/.test(key))
            return c.json({ error: "invalid_idempotency_key" }, 400);
        const target = resolveMessageTarget(db, body.target, actor.currentSessionId, true);
        const id = `schedule:${actor.originId}:${key}`;
        const existing = db.select().from(sessionSchedules).where(eq(sessionSchedules.id, id)).get();
        if (existing) {
            if (existing.actorUserId !== actor.userId || existing.targetSessionId !== target || JSON.stringify(existing.action) !== JSON.stringify({ ...body.action, requestedNextAt: body.nextAt }) || existing.timezone !== body.timezone || existing.intervalMs !== body.intervalMs || JSON.stringify(existing.recurrence ?? null) !== JSON.stringify(body.recurrence ?? null))
                return c.json({ error: "idempotency_conflict" }, 409);
            return c.json(existing, 200);
        }
        let timing;
        try { timing = resolveScheduleTiming(body); }
        catch (error) { return c.json({ error: "invalid_timing", message: String(error) }, 400); }
        const created = db.transaction(tx => {
            const commands = sessionCommandsFor(db, options.channelFor ?? (id => getKernel().replyChannel(id)));
            commands.authorize(actor, target, body.action.kind);
            if (body.action.kind === "session.invoke")
                commands.authorize(actor, target, "message.send");
            const row = { id, actorUserId: actor.userId, sourceSessionId: actor.sourceSessionId, targetSessionId: target, action: { ...body.action, requestedNextAt: body.nextAt }, ...timing, enabled: true, revision: 1, overlap: "skip", misfire: "latest", expiresAfterMs: 86400000, createdAt: Date.now() };
            tx.insert(sessionSchedules).values(row).run();
            return row;
        });
        return c.json(created, 201);
    })
        .get("/commands/:id", (c) => {
        const row = service().get(c.get("lunaAccessTokenClaims") as LunaAccessTokenClaims | undefined, c.req.param("id"));
        return c.json({ commandId: row.id, sessionId: row.sessionId, deliveryStatus: row.status, messageId: row.messageId, providerMessageId: row.providerMessageId, error: row.error });
    });
}
