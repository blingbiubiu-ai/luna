import { scheduleTimingShape, resolveScheduleTiming } from "@luna/service-client/schedule-input";
import { calendarOccurrence } from "@luna/service-client/schedule-timing";
import { scanArtifactRefs } from "@luna/service-client/artifact-ref";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "@/data";
import { sessionSchedules, scheduleOccurrences, sessions } from "@/data/schema";
import type { SessionCommandService } from "@/messaging/session-command-service";
import { AgentStore } from "@/agents/agent-store";
import { deleteDashboardSchedule } from "@/dashboard-api/task-deletion";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { GatewayError } from "../gateway-error";

const editorSchema = z.object({
  title: z.string().trim().min(1).max(120),
  targetSessionId: z.string().min(1),
  action: z.object({ kind: z.enum(["message.send", "session.invoke"]), content: z.string().trim().min(1).max(100000), contextRefs: z.array(z.string()).default([]) }).strict(),
  ...scheduleTimingShape,
  revision: z.number().int().positive().optional(),
}).strict();
type Schedule = typeof sessionSchedules.$inferSelect;
type ScheduleScope = { actorUserId: string; agentId: string; shadowId?: string };

export function scheduleManagementRoutes(db: () => DrizzleDB, service: () => SessionCommandService) {
  function ownerScope(c: Context): ScheduleScope {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) throw new HTTPException(auth.status as 401 | 403, { res: auth });
    const agentId = c.req.query("agentId");
    if (!agentId) throw new GatewayError("agent_scope_required", "Select an Agent", 400);
    const agents = new AgentStore(db());
    agents.requireOwner(auth.user.id, agentId);
    const shadowId = c.req.query("shadowId");
    if (shadowId && agents.shadow(shadowId).agentId !== agentId) {
      throw new GatewayError("shadow_not_found", "Shadow not found", 404);
    }
    return { actorUserId: auth.user.id, agentId, ...(shadowId ? { shadowId } : {}) };
  }
  function inScope(scope: ScheduleScope) {
    return and(eq(sessions.agent_id, scope.agentId), scope.shadowId ? eq(sessions.shadow_id, scope.shadowId) : undefined);
  }
  function get(id: string, scope: ScheduleScope) {
    const row = db().select({ schedule: sessionSchedules }).from(sessionSchedules)
      .innerJoin(sessions, eq(sessions.id, sessionSchedules.sourceSessionId))
      .where(and(eq(sessionSchedules.id, id), inScope(scope))).get()?.schedule;
    if (!row) throw new GatewayError("not_found", "Schedule not found", 404);
    return row;
  }
  function checkRevision(row: Schedule, revision: number | undefined) {
    if (revision !== row.revision) throw new GatewayError("revision_conflict", "任务已更新，请刷新后重试。", 409);
  }
  function cancelPending(row: Schedule) {
    for (const occurrence of db().select().from(scheduleOccurrences).where(eq(scheduleOccurrences.scheduleId, row.id)).all()) {
      if (occurrence.commandId && service().get(occurrence.commandId)?.status === "pending") {
        service().cancel(occurrence.commandId);
        db().update(scheduleOccurrences).set({ status: "cancelled", reason: "Schedule paused or edited" }).where(eq(scheduleOccurrences.id, occurrence.id)).run();
      }
    }
  }
  function requireScheduleActor(row: Schedule, scope: ScheduleScope) {
    if (row.actorUserId !== scope.actorUserId) throw new GatewayError("schedule_actor_required", "Only the schedule's execution user can edit or resume it", 403);
  }
  function save(scope: ScheduleScope, input: unknown, id?: string) {
    const body = editorSchema.parse(input);
    const now = Date.now();
    const timing = resolveScheduleTiming(body, now);
    return db().transaction(tx => {
      const existing = id ? get(id, scope) : undefined;
      if (existing) {
        requireScheduleActor(existing, scope);
        checkRevision(existing, body.revision);
      }
      const scheduleId = id ?? randomUUID();
      const revision = (existing?.revision ?? 0) + 1;
      const sourceSessionId = existing?.sourceSessionId ?? body.targetSessionId;
      const source = tx.select().from(sessions).where(and(eq(sessions.id, sourceSessionId), inScope(scope))).get();
      if (!source || source.status !== "active") throw new GatewayError("source_unavailable", "Source session is unavailable", 404);
      const actor = { userId: scope.actorUserId, sourceSessionId, originId: scheduleId };
      const refs = [...body.action.contextRefs, ...scanArtifactRefs(body.action.content)];
      service().authorize(actor, body.targetSessionId, body.action.kind, refs);
      service().authorize(actor, body.targetSessionId, "message.send", refs);
      if (existing) cancelPending(existing);
      const { revision: _revision, ...values } = body;
      const row = { ...values, ...timing, actorUserId: scope.actorUserId, sourceSessionId, revision,
        enabled: existing ? existing.enabled : true, paused: existing ? !existing.enabled : false };
      if (existing) tx.update(sessionSchedules).set(row).where(eq(sessionSchedules.id, scheduleId)).run();
      else tx.insert(sessionSchedules).values({ ...row, id: scheduleId, overlap: "skip", misfire: "latest", expiresAfterMs: 86400000, createdAt: now }).run();
      return get(scheduleId, scope);
    });
  }
  return new Hono()
    .get("/schedules", c => {
      const scope = ownerScope(c);
      return c.json(db().select({ schedule: sessionSchedules }).from(sessionSchedules)
        .innerJoin(sessions, eq(sessions.id, sessionSchedules.sourceSessionId))
        .where(inScope(scope)).all().map(row => row.schedule));
    })
    .get("/occurrences", c => {
      const scope = ownerScope(c);
      return c.json(db().select({ occurrence: scheduleOccurrences }).from(scheduleOccurrences)
        .innerJoin(sessionSchedules, eq(sessionSchedules.id, scheduleOccurrences.scheduleId))
        .innerJoin(sessions, eq(sessions.id, sessionSchedules.sourceSessionId))
        .where(inScope(scope)).all().map(row => row.occurrence));
    })
    .post("/schedule-editor", async c => c.json(save(ownerScope(c), await c.req.json()), 201))
    .put("/schedule-editor/:id", async c => c.json(save(ownerScope(c), await c.req.json(), c.req.param("id"))))
    .delete("/schedules/:id", c => {
      const schedule = get(c.req.param("id"), ownerScope(c));
      deleteDashboardSchedule(db(), schedule.id);
      return c.json({ ok: true });
    })
    .post("/schedules/:id/state", async c => {
      const scope = ownerScope(c);
      const body = z.object({ enabled: z.boolean(), revision: z.number().int().positive() }).strict().parse(await c.req.json());
      const row = db().transaction(tx => {
        const existing = get(c.req.param("id"), scope);
        checkRevision(existing, body.revision);
        if (existing.enabled === body.enabled) return existing;
        let nextAt = existing.nextAt;
        if (body.enabled) {
          requireScheduleActor(existing, scope);
          const now = Date.now();
          if (!existing.paused && !existing.recurrence && existing.intervalMs === null) throw new GatewayError("already_finished", "一次性任务已结束，请编辑执行时间后再恢复。", 409);
          if (nextAt <= now) {
            if (existing.recurrence) nextAt = calendarOccurrence(existing.recurrence, existing.timezone, now);
            else if (existing.intervalMs === null) throw new GatewayError("time_elapsed", "执行时间已过，请编辑未来时间后再恢复。", 409);
            else nextAt += (Math.floor((now - nextAt) / existing.intervalMs) + 1) * existing.intervalMs;
          }
          const actor = { userId: existing.actorUserId, sourceSessionId: existing.sourceSessionId, originId: existing.id };
          const refs = [...(existing.action.contextRefs as string[] ?? []), ...scanArtifactRefs(String(existing.action.content))];
          service().authorize(actor, existing.targetSessionId, String(existing.action.kind), refs);
          service().authorize(actor, existing.targetSessionId, "message.send", refs);
        } else cancelPending(existing);
        tx.update(sessionSchedules).set({ enabled: body.enabled, paused: !body.enabled, nextAt, revision: existing.revision + 1 }).where(eq(sessionSchedules.id, existing.id)).run();
        return get(existing.id, scope);
      });
      return c.json(row);
    });
}
