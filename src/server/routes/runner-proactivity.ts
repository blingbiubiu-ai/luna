import { resolveScheduleTiming, scheduleTimingShape } from "@luna/service-client/schedule-input";
import { calendarOccurrence } from "@luna/service-client/schedule-timing";
import { scanArtifactRefs } from "@luna/service-client/artifact-ref";
import { and, desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AgentError } from "@/agents/agent-store";
import { listShadowSessions, queryShadowActivity } from "@/agents/shadow-activity";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import {
  scheduleFailureNotifications,
  scheduleOccurrences,
  sessionSchedules,
  sessions,
} from "@/data/schema";
import { deleteDashboardSchedule } from "@/dashboard-api/task-deletion";
import { assertHeartbeatOutboundApproved } from "@/messaging/correlated-request-service";
import { resolveMessageTarget } from "@/messaging/delivery-target";
import { resolveLunaAddress } from "@/messaging/luna-address";
import { RunnerMessageService } from "@/messaging/runner-message-service";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import type { LunaAccessTokenClaims } from "../auth/access-token-service";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";
import { messageTargetSchema } from "./runner-messages";

const runnerScheduleActionUpdateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message.send"),
    content: z.string().trim().min(1).max(100000),
    contextRefs: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    kind: z.literal("session.invoke"),
    content: z.string().trim().min(1).max(100000),
    contextRefs: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    kind: z.literal("task.run"),
    taskId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(100000).optional(),
    instruction: z.string().trim().min(1).max(100000).optional(),
    contextRefs: z.array(z.string()).default([]),
  }).strict().refine(a => Boolean(a.content ?? a.instruction), "content or instruction is required"),
]);

const updateScheduleSchema = z.object({
  title: z.string().trim().max(120).optional(),
  target: messageTargetSchema.optional(),
  address: z.string().min(1).max(512).optional(),
  targetSessionId: z.string().min(1).optional(),
  action: runnerScheduleActionUpdateSchema.optional(),
  ...scheduleTimingShape,
  timezone: z.string().min(1).optional(),
  expectedRevision: z.number().int().positive().optional(),
}).strict();

export function createRunnerProactivityRoutes(
  options: {
    db?: DrizzleDB;
    channelFor?: (id: string) => ReplyChannel | undefined;
  } = {},
) {
  const db = () => options.db ?? getKernel().database.db;
  const channelFor =
    options.channelFor ?? ((id: string) => getKernel().replyChannel(id));
  const runnerSvc = () => new RunnerMessageService(db(), channelFor);

  function loadShadowSchedules(agentId: string, shadowId: string) {
    const shadowSessionIds = new Set(
      db()
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.agent_id, agentId),
            eq(sessions.shadow_id, shadowId),
          ),
        )
        .all()
        .map(r => r.id),
    );
    if (!shadowSessionIds.size) return [];
    const failureMap = new Map(
      db()
        .select()
        .from(scheduleFailureNotifications)
        .all()
        .map(f => [
          f.scheduleId,
          {
            occurrenceId: f.lastFailedOccurrenceId,
            failedAt: f.lastFailedAt,
            reason: f.lastReason,
            notifiedAt: f.lastNotifiedAt,
          },
        ]),
    );
    return db()
      .select()
      .from(sessionSchedules)
      .orderBy(desc(sessionSchedules.createdAt))
      .all()
      .filter(
        row =>
          shadowSessionIds.has(row.sourceSessionId) ||
          shadowSessionIds.has(row.targetSessionId),
      )
      .map(row => ({
        ...row,
        lastFailure: failureMap.get(row.id) ?? null,
      }));
  }

  function requireShadowSchedule(
    id: string,
    agentId: string,
    shadowId: string,
  ) {
    const found = loadShadowSchedules(agentId, shadowId).find(s => s.id === id);
    if (!found) {
      throw new GatewayError(
        "schedule_not_found",
        "Schedule not found in this Shadow",
        404,
      );
    }
    return found;
  }

  function cancelPendingOccurrences(scheduleId: string) {
    const commands = sessionCommandsFor(db(), channelFor);
    for (const occurrence of db()
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.scheduleId, scheduleId))
      .all()) {
      if (
        occurrence.commandId &&
        commands.get(occurrence.commandId)?.status === "pending"
      ) {
        commands.cancel(occurrence.commandId);
        db()
          .update(scheduleOccurrences)
          .set({ status: "cancelled", reason: "Schedule paused or edited" })
          .where(eq(scheduleOccurrences.id, occurrence.id))
          .run();
      }
    }
  }

  return new Hono<{
    Variables: {
      lunaAccessTokenClaims: LunaAccessTokenClaims | undefined;
    };
  }>()
    .onError((error, c) => {
      if (error instanceof HTTPException) return error.getResponse();
      if (error instanceof GatewayError) {
        return c.json(
          { error: error.code, message: error.message },
          error.status as 400,
        );
      }
      if (error instanceof AgentError) {
        return c.json({ error: error.code }, error.status);
      }
      if (error instanceof z.ZodError) {
        return c.json(
          { error: "invalid_request", details: error.issues },
          400,
        );
      }
      return c.json({ error: "internal_error", message: String(error) }, 500);
    })
    .get("/schedules", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const query = z
        .object({
          status: z.enum(["active", "paused", "finished"]).optional(),
        })
        .parse(c.req.query());
      const rows = loadShadowSchedules(actor.agentId, actor.shadowId).filter(
        row => {
          if (!query.status) return true;
          if (query.status === "active") return row.enabled;
          if (query.status === "paused") return !row.enabled && row.paused;
          return !row.enabled && !row.paused;
        },
      );
      return c.json({ schedules: rows });
    })
    .get("/schedules/:id", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const schedule = requireShadowSchedule(
        c.req.param("id"),
        actor.agentId,
        actor.shadowId,
      );
      const occurrences = db()
        .select()
        .from(scheduleOccurrences)
        .where(eq(scheduleOccurrences.scheduleId, schedule.id))
        .orderBy(desc(scheduleOccurrences.scheduledAt))
        .limit(20)
        .all();
      return c.json({ schedule, occurrences });
    })
    .put("/schedules/:id", async c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const body = updateScheduleSchema.parse(
        await c.req.json().catch(() => null),
      );
      const now = Date.now();
      const updated = db().transaction(tx => {
        const existing = requireShadowSchedule(
          c.req.param("id"),
          actor.agentId,
          actor.shadowId,
        );
        if (
          body.expectedRevision !== undefined &&
          body.expectedRevision !== existing.revision
        ) {
          throw new GatewayError(
            "revision_conflict",
            "Schedule revision changed; re-read before updating",
            409,
          );
        }
        const targetSessionId = body.address
          ? resolveLunaAddress(
              db(),
              {
                agentId: actor.agentId,
                shadowId: actor.shadowId,
                currentSessionId: actor.currentSessionId,
              },
              body.address,
              { create: true },
            ).sessionId
          : body.target
            ? resolveMessageTarget(
                db(),
                body.target,
                actor.currentSessionId,
                true,
              )
            : body.targetSessionId ?? existing.targetSessionId;
        if (targetSessionId !== actor.currentSessionId) {
          assertHeartbeatOutboundApproved(db(), actor);
        }

        const nextAction = body.action
          ? body.action.kind === "task.run"
            ? {
                kind: "task.run" as const,
                taskId: body.action.taskId,
                content: (body.action.content ?? body.action.instruction)!,
                contextRefs: body.action.contextRefs,
              }
            : body.action
          : (existing.action as {
              kind: "message.send" | "session.invoke" | "task.run";
              content: string;
              taskId?: string;
              contextRefs?: string[];
            });

        const timezone = body.timezone ?? existing.timezone;
        const hasTimingOverride =
          body.nextAt !== undefined ||
          body.recurrence !== undefined ||
          (body.intervalMs !== null && body.intervalMs !== undefined);
        let timing: {
          nextAt: number;
          timezone: string;
          intervalMs: number | null;
          recurrence: typeof existing.recurrence;
        };
        try {
          timing = hasTimingOverride
            ? resolveScheduleTiming(
                {
                  timezone,
                  nextAt: body.nextAt,
                  intervalMs:
                    body.intervalMs !== undefined
                      ? body.intervalMs
                      : body.recurrence
                        ? null
                        : existing.intervalMs,
                  recurrence:
                    body.recurrence !== undefined
                      ? body.recurrence
                      : body.intervalMs || body.nextAt
                        ? null
                        : existing.recurrence,
                },
                now,
              )
            : {
                nextAt: existing.nextAt,
                timezone,
                intervalMs: existing.intervalMs,
                recurrence: existing.recurrence,
              };
        } catch (err) {
          throw new GatewayError("invalid_timing", String(err), 400);
        }

        const commands = sessionCommandsFor(db(), channelFor);
        const refs = [
          ...(nextAction.contextRefs ?? []),
          ...scanArtifactRefs(String(nextAction.content)),
        ];
        const taskId =
          nextAction.kind === "task.run" ? nextAction.taskId : undefined;
        commands.authorize(
          {
            userId: existing.actorUserId,
            sourceSessionId: existing.sourceSessionId,
            originId: existing.id,
          },
          targetSessionId,
          nextAction.kind,
          refs,
          now,
          taskId,
        );
        if (
          nextAction.kind === "session.invoke" ||
          nextAction.kind === "task.run"
        ) {
          commands.authorize(
            {
              userId: existing.actorUserId,
              sourceSessionId: existing.sourceSessionId,
              originId: existing.id,
            },
            targetSessionId,
            "message.send",
            refs,
          );
        }

        cancelPendingOccurrences(existing.id);
        tx.update(sessionSchedules)
          .set({
            title: body.title ?? existing.title,
            targetSessionId,
            action: nextAction,
            ...timing,
            revision: existing.revision + 1,
          })
          .where(eq(sessionSchedules.id, existing.id))
          .run();
        return requireShadowSchedule(existing.id, actor.agentId, actor.shadowId);
      });
      return c.json({ schedule: updated });
    })
    .post("/schedules/:id/state", async c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const body = z
        .object({
          enabled: z.boolean(),
          expectedRevision: z.number().int().positive().optional(),
        })
        .strict()
        .parse(await c.req.json().catch(() => null));
      const updated = db().transaction(tx => {
        const existing = requireShadowSchedule(
          c.req.param("id"),
          actor.agentId,
          actor.shadowId,
        );
        if (
          body.expectedRevision !== undefined &&
          body.expectedRevision !== existing.revision
        ) {
          throw new GatewayError(
            "revision_conflict",
            "Schedule revision changed; re-read before changing state",
            409,
          );
        }
        if (existing.enabled === body.enabled) return existing;
        let nextAt = existing.nextAt;
        if (body.enabled) {
          const now = Date.now();
          if (
            !existing.paused &&
            !existing.recurrence &&
            existing.intervalMs === null
          ) {
            throw new GatewayError(
              "already_finished",
              "One-shot schedule already finished; update nextAt to a future time first",
              409,
            );
          }
          if (nextAt <= now) {
            if (existing.recurrence) {
              nextAt = calendarOccurrence(
                existing.recurrence,
                existing.timezone,
                now,
              );
            } else if (existing.intervalMs === null) {
              throw new GatewayError(
                "time_elapsed",
                "Scheduled time has elapsed; update nextAt to a future time first",
                409,
              );
            } else {
              nextAt +=
                (Math.floor((now - nextAt) / existing.intervalMs) + 1) *
                existing.intervalMs;
            }
          }
          const commands = sessionCommandsFor(db(), channelFor);
          const refs = [
            ...((existing.action.contextRefs as string[]) ?? []),
            ...scanArtifactRefs(String(existing.action.content)),
          ];
          const taskId =
            existing.action.kind === "task.run" &&
            typeof existing.action.taskId === "string"
              ? existing.action.taskId
              : undefined;
          commands.authorize(
            {
              userId: existing.actorUserId,
              sourceSessionId: existing.sourceSessionId,
              originId: existing.id,
            },
            existing.targetSessionId,
            String(existing.action.kind),
            refs,
            now,
            taskId,
          );
          commands.authorize(
            {
              userId: existing.actorUserId,
              sourceSessionId: existing.sourceSessionId,
              originId: existing.id,
            },
            existing.targetSessionId,
            "message.send",
            refs,
          );
        } else {
          cancelPendingOccurrences(existing.id);
        }
        tx.update(sessionSchedules)
          .set({
            enabled: body.enabled,
            paused: !body.enabled,
            nextAt,
            revision: existing.revision + 1,
          })
          .where(eq(sessionSchedules.id, existing.id))
          .run();
        return requireShadowSchedule(existing.id, actor.agentId, actor.shadowId);
      });
      return c.json({ schedule: updated });
    })
    .delete("/schedules/:id", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const existing = requireShadowSchedule(
        c.req.param("id"),
        actor.agentId,
        actor.shadowId,
      );
      cancelPendingOccurrences(existing.id);
      deleteDashboardSchedule(db(), existing.id);
      return c.json({ ok: true, id: existing.id });
    })
    .get("/sessions", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const query = z
        .object({
          kind: z.enum(["local", "p2p", "group", "thread"]).optional(),
          withUser: z.string().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(c.req.query());
      const rows = listShadowSessions(db(), actor.shadowId, {
        kind: query.kind,
        withUserId: query.withUser,
        limit: query.limit,
      });
      return c.json({ sessions: rows });
    })
    .get("/activity", c => {
      const actor = runnerSvc().actor(c.get("lunaAccessTokenClaims"));
      const query = z
        .object({
          since: z.string().min(1),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(c.req.query());
      const sinceMs = /^\d+$/.test(query.since)
        ? Number(query.since)
        : Date.parse(query.since);
      if (!Number.isFinite(sinceMs) || sinceMs < 0) {
        throw new GatewayError(
          "invalid_since",
          "Provide --since as epoch ms or ISO-8601 timestamp",
          400,
        );
      }
      const activity = queryShadowActivity(db(), actor.shadowId, {
        since: sinceMs,
        limit: query.limit,
      });
      return c.json({ activity });
    });
}
