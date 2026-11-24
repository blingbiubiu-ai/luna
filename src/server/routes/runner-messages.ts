import { replyMarkdown, replySchema } from "@luna/runner-protocol/reply";
import { resolveScheduleTiming, scheduleTimingShape } from "@luna/service-client/schedule-input";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { AgentError } from "@/agents/agent-store";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import { sessionSchedules } from "@/data/schema";
import {
  assertHeartbeatOutboundApproved,
  isHeartbeatSession,
} from "@/messaging/correlated-request-service";
import { resolveMessageTarget } from "@/messaging/delivery-target";
import { parseTaskAddress, resolveLunaAddress } from "@/messaging/luna-address";
import { RunnerMessageService } from "@/messaging/runner-message-service";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

export const messageTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("feishu_user"),
      channelId: z.string().min(1),
      idType: z.enum(["open_id", "user_id", "union_id"]),
      id: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z.object({ kind: z.literal("current_session") }).strict(),
  z.object({ kind: z.literal("session"), sessionId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("surface"),
      channelId: z.string().min(1),
      surfaceId: z.string().min(1),
      threadId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("user"),
      userId: z.string().min(1),
      channelId: z.string().optional(),
    })
    .strict(),
]);

const bodySchema = z
  .object({
    target: messageTargetSchema.optional(),
    to: z.string().min(1).max(512).optional(),
    viaMain: z.boolean().default(false),
    contextRefs: z.array(z.string().min(1)).max(20).default([]),
    content: z
      .array(
        z
          .object({ type: z.literal("text"), text: z.string().min(1).max(100000) })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    reply: replySchema.optional(),
    mentionBotUserId: z.string().min(1).max(256).optional(),
    purpose: z.enum(["progress", "answer", "notification"]).default("progress"),
  })
  .strict()
  .refine(
    body => Boolean(body.content) !== Boolean(body.reply),
    "Choose content or reply",
  )
  .refine(
    body => Boolean(body.target) !== Boolean(body.to),
    "Choose target or to",
  );

export function createRunnerMessageRoutes(
  options: {
    db?: DrizzleDB;
    channelFor?: (id: string) => ReplyChannel | undefined;
  } = {},
) {
  const service = () =>
    new RunnerMessageService(
      options.db ?? getKernel().database.db,
      options.channelFor ?? (id => getKernel().replyChannel(id)),
    );

  return new Hono<{
    Variables: {
      lunaAccessTokenClaims: LunaAccessTokenClaims | undefined;
    };
  }>()
    .onError((error, c) =>
      error instanceof GatewayError
        ? c.json(
            { error: error.code, message: error.message },
            error.status as 400,
          )
        : error instanceof AgentError
          ? c.json({ error: error.code }, error.status)
          : c.json({ error: "internal_error", message: String(error) }, 500),
    )
    .post("/messages", async c => {
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) {
        return c.json({ error: "invalid_idempotency_key" }, 400);
      }
      const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: "invalid_request", details: parsed.error.issues },
          400,
        );
      }
      const text = parsed.data.reply
        ? replyMarkdown(parsed.data.reply)
        : parsed.data.content!.map(block => block.text).join("\n");
      const claims = c.get("lunaAccessTokenClaims");
      if (claims?.runnerKind === "task" && parsed.data.to?.trim() !== "main") {
        throw new GatewayError(
          "address_forbidden",
          "Task Runner may only send messages to 'main'",
          403,
        );
      }
      const svc = service();
      const actor = svc.anyActor(claims);
      const db = options.db ?? getKernel().database.db;

      // 1) Task Runner speaking (`luna say --to main`): always invokes subscribing Main (`peer_message`).
      if (actor.runnerKind === "task") {
        const resolved = resolveLunaAddress(
          db,
          {
            agentId: actor.agentId,
            shadowId: actor.shadowId,
            currentSessionId: actor.currentSessionId,
            taskId: actor.taskId,
          },
          "main",
          { create: false },
        );
        const cmd = svc.invokePeer(
          actor,
          key,
          resolved.sessionId,
          text,
          parsed.data.contextRefs,
        );
        return c.json(
          {
            commandId: cmd.id,
            kind: "session.invoke",
            status: cmd.status,
            sessionId: cmd.sessionId,
            result: {
              sessionId: cmd.sessionId,
              triggerId: cmd.id,
              viaMain: true,
            },
            error: cmd.error,
          },
          202,
        );
      }

      // 2) Main / Work Runner soft note to a Task (`luna say --to task:<id>`)
      const targetTaskId = parsed.data.to ? parseTaskAddress(parsed.data.to) : null;
      if (targetTaskId) {
        if (parsed.data.viaMain) {
          throw new GatewayError(
            "invalid_request",
            "--via-main is only for session addresses, not task:<id>",
            400,
          );
        }
        assertHeartbeatOutboundApproved(db, actor);
        const event = svc.sendToTask(actor, key, targetTaskId, text);
        return c.json(
          {
            commandId: event.id,
            kind: "task.message",
            status: "accepted",
            taskId: targetTaskId,
            result: {
              taskId: targetTaskId,
              inboxEventId: event.id,
            },
            error: null,
          },
          200,
        );
      }

      // 3) Heartbeat sessions must never bypass target Main context (`--via-main` required).
      if (isHeartbeatSession(db, actor.currentSessionId) && !parsed.data.viaMain) {
        throw new GatewayError(
          "heartbeat_via_main_required",
          "Heartbeat sessions cannot send raw messages directly to users; pass `--via-main` so the target session's Main handles delivery in context.",
          403,
        );
      }

      const isCurrentTarget = parsed.data.to
        ? parsed.data.to === "current" ||
          parsed.data.to === `session:${actor.currentSessionId}`
        : parsed.data.target?.kind === "current_session";
      if (parsed.data.mentionBotUserId && !isCurrentTarget) {
        throw new GatewayError(
          "bot_mention_group_required",
          "Bot mentions must use the current group conversation",
          400,
        );
      }
      const target = parsed.data.to
        ? resolveLunaAddress(
            db,
            {
              agentId: actor.agentId,
              shadowId: actor.shadowId,
              currentSessionId: actor.currentSessionId,
            },
            parsed.data.to,
            { create: true },
          ).sessionId
        : resolveMessageTarget(db, parsed.data.target!, actor.currentSessionId, true);
      assertHeartbeatOutboundApproved(db, actor);

      // 4) `--via-main` delegates one-way to target session's Main (`session.invoke` `peer_message`) without a Request ticket.
      if (parsed.data.viaMain) {
        const cmd = svc.invokePeer(
          actor,
          key,
          target,
          text,
          parsed.data.contextRefs,
        );
        return c.json(
          {
            commandId: cmd.id,
            kind: "session.invoke",
            status: cmd.status,
            sessionId: cmd.sessionId,
            result: {
              sessionId: cmd.sessionId,
              triggerId: cmd.id,
              viaMain: true,
            },
            error: cmd.error,
          },
          202,
        );
      }

      const row = await svc.send(
        claims,
        key,
        text,
        parsed.data.purpose,
        target,
        parsed.data.reply,
        parsed.data.mentionBotUserId,
      );
      return c.json(
        {
          commandId: row.id,
          kind: "message.send",
          status: row.status,
          deliveryStatus: row.status,
          sessionId: row.sessionId,
          messageId: row.messageId,
          providerMessageId: row.providerMessageId,
          result: {
            sessionId: row.sessionId,
            messageId: row.messageId,
            providerMessageId: row.providerMessageId,
          },
          error: row.error,
        },
        ["pending", "running", "deferred"].includes(row.status) ? 202 : 200,
      );
    })
    .post("/schedules", async c => {
      const runnerActionSchema = z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("message.send"),
            content: z.string().min(1).max(100000),
          })
          .strict(),
        z
          .object({
            kind: z.literal("session.invoke"),
            content: z.string().min(1).max(100000),
          })
          .strict(),
        z
          .object({
            kind: z.literal("task.run"),
            taskId: z.string().trim().min(1),
            content: z.string().min(1).max(100000).optional(),
            instruction: z.string().min(1).max(100000).optional(),
          })
          .strict()
          .refine(
            a => Boolean(a.content ?? a.instruction),
            "content or instruction is required",
          ),
      ]);
      const schema = z
        .object({
          title: z.string().trim().max(120).optional(),
          target: messageTargetSchema.optional(),
          address: z.string().min(1).max(512).optional(),
          ...scheduleTimingShape,
          action: runnerActionSchema,
        })
        .strict()
        .refine(
          b => Boolean(b.target) !== Boolean(b.address),
          "Choose target or address",
        );
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const body = parsed.data;
      try {
        new Intl.DateTimeFormat("en", { timeZone: body.timezone });
      } catch {
        return c.json({ error: "invalid_timezone" }, 400);
      }
      const svc = service();
      const actor = svc.actor(c.get("lunaAccessTokenClaims"));
      const db = options.db ?? getKernel().database.db;
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w.-]{1,128}$/.test(key)) {
        return c.json({ error: "invalid_idempotency_key" }, 400);
      }
      const target = body.address
        ? resolveLunaAddress(
            db,
            {
              agentId: actor.agentId,
              shadowId: actor.shadowId,
              currentSessionId: actor.currentSessionId,
            },
            body.address,
            { create: true },
          ).sessionId
        : resolveMessageTarget(db, body.target!, actor.currentSessionId, true);
      if (target !== actor.currentSessionId) {
        assertHeartbeatOutboundApproved(db, actor);
      }
      const normalizedAction =
        body.action.kind === "task.run"
          ? {
              kind: "task.run" as const,
              taskId: body.action.taskId,
              content: (body.action.content ?? body.action.instruction)!,
            }
          : body.action;
      const storedAction = {
        ...normalizedAction,
        requestedNextAt: body.nextAt,
      };
      const id = `schedule:${actor.originId}:${key}`;
      const existing = db
        .select()
        .from(sessionSchedules)
        .where(eq(sessionSchedules.id, id))
        .get();
      if (existing) {
        if (
          existing.actorUserId !== actor.userId ||
          existing.targetSessionId !== target ||
          JSON.stringify(existing.action) !== JSON.stringify(storedAction) ||
          existing.timezone !== body.timezone ||
          existing.intervalMs !== body.intervalMs ||
          JSON.stringify(existing.recurrence ?? null) !==
            JSON.stringify(body.recurrence ?? null)
        ) {
          return c.json({ error: "idempotency_conflict" }, 409);
        }
        return c.json(existing, 200);
      }
      let timing;
      try {
        timing = resolveScheduleTiming(body);
      } catch (error) {
        return c.json(
          { error: "invalid_timing", message: String(error) },
          400,
        );
      }
      const created = db.transaction(tx => {
        const commands = sessionCommandsFor(
          db,
          options.channelFor ?? (id => getKernel().replyChannel(id)),
        );
        const taskId =
          normalizedAction.kind === "task.run"
            ? normalizedAction.taskId
            : undefined;
        commands.authorize(
          actor,
          target,
          normalizedAction.kind,
          [],
          Date.now(),
          taskId,
        );
        if (
          normalizedAction.kind === "session.invoke" ||
          normalizedAction.kind === "task.run"
        ) {
          commands.authorize(actor, target, "message.send");
        }
        const row = {
          id,
          title: body.title ?? "",
          paused: false,
          actorUserId: actor.userId,
          sourceSessionId: actor.sourceSessionId,
          targetSessionId: target,
          action: storedAction,
          ...timing,
          enabled: true,
          revision: 1,
          overlap: "skip",
          misfire: "latest",
          expiresAfterMs: 86400000,
          createdAt: Date.now(),
        };
        tx.insert(sessionSchedules).values(row).run();
        return row;
      });
      return c.json(
        {
          ...created,
          commandId: created.id,
          kind: "schedule.create",
          status: "applied",
          result: created,
          error: null,
        },
        201,
      );
    });
}
