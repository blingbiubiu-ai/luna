import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { resolveProactivitySettings } from "@/agents/agent-settings-store";
import { queryShadowActivity } from "@/agents/shadow-activity";
import { triggerShadowHeartbeatNow } from "@/agents/shadow-heartbeat";
import type { DrizzleDB } from "@/data";
import {
  agentShadows,
  channelSurfaces,
  correlatedRequests,
  lunaAgents,
  memoryConsolidations,
  sessionCommands,
  sessionRunnerAttempts,
  sessions,
  sessionTimelineEvents,
  shadowHeartbeats,
  users,
} from "@/data/schema";
import { inspectOutboundQuota } from "@/messaging/outbound-governance";
import { sessionCommandsFor } from "@/messaging/session-command-service";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { GatewayError } from "../gateway-error";
import { getKernel } from "./kernel";

type ProactivityOwnerScope = {
  readonly actorUserId: string;
  readonly agentId: string;
  readonly shadowId?: string;
};

function resolveSessionDisplayTitle(
  row: typeof sessions.$inferSelect | undefined,
  surfaceTitleByKey: ReadonlyMap<string, string>,
): string {
  if (!row) return "未知会话";
  if (row.title?.trim()) return row.title.trim();
  if (row.group_id) {
    const surfaceTitle = surfaceTitleByKey.get(`${row.channel_id}:${row.group_id}`);
    if (surfaceTitle?.trim()) return surfaceTitle.trim();
    return row.group_id;
  }
  return row.channel_type === "dashboard" ? "本地会话" : row.id.slice(0, 8);
}

export function createAgentProactivityRoutes(
  options: { db?: DrizzleDB } = {},
) {
  const db = () => options.db ?? getKernel().database.db;
  const service = () =>
    sessionCommandsFor(db(), id => getKernel().replyChannel(id));

  function ownerScope(c: Context): ProactivityOwnerScope {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) {
      throw new HTTPException(auth.status as 401 | 403, { res: auth });
    }
    const agentId = c.req.query("agentId");
    if (!agentId) {
      throw new GatewayError("agent_scope_required", "Select an Agent", 400);
    }
    const agents = new AgentStore(db());
    agents.requireOwner(auth.account.id, agentId);
    const shadowId = c.req.query("shadowId");
    if (shadowId && agents.shadow(shadowId).agentId !== agentId) {
      throw new GatewayError("shadow_not_found", "Shadow not found", 404);
    }
    return {
      actorUserId: agents.ownerUserId(agentId),
      agentId,
      ...(shadowId ? { shadowId } : {}),
    };
  }

  return new Hono()
    .onError((error, c) =>
      error instanceof HTTPException
        ? error.getResponse()
        : error instanceof GatewayError
          ? c.json(
              { error: error.code, message: error.message },
              error.status as 400,
            )
          : error instanceof AgentError
            ? c.json({ error: error.code, message: error.message }, error.status)
            : c.json({ error: "invalid_request", message: String(error) }, 400),
    )
    .get("/overview", c => {
      const scope = ownerScope(c);
      const now = Date.now();
      const d = db();
      const agentRow = d
        .select()
        .from(lunaAgents)
        .where(eq(lunaAgents.id, scope.agentId))
        .get();
      if (!agentRow) {
        throw new GatewayError("agent_not_found", "Agent not found", 404);
      }

      const settings = resolveProactivitySettings(d, scope.agentId);
      const timezone = new PlatformSettingsStore(d).get().general.timezone;
      const quota = inspectOutboundQuota(d, scope.agentId, null, now);

      const shadowsInScope = d
        .select()
        .from(agentShadows)
        .where(
          and(
            eq(agentShadows.agentId, scope.agentId),
            eq(agentShadows.status, "active"),
            scope.shadowId ? eq(agentShadows.id, scope.shadowId) : undefined,
          ),
        )
        .all();

      const shadowNameById = new Map(
        shadowsInScope.map(s => [s.id, s.name] as const),
      );
      // Include all agent shadows for name lookup on cross-shadow references.
      for (const s of d
        .select({ id: agentShadows.id, name: agentShadows.name })
        .from(agentShadows)
        .where(eq(agentShadows.agentId, scope.agentId))
        .all()) {
        shadowNameById.set(s.id, s.name);
      }

      const allAgentSessions = d
        .select()
        .from(sessions)
        .where(eq(sessions.agent_id, scope.agentId))
        .all();
      const sessionById = new Map(allAgentSessions.map(s => [s.id, s] as const));

      const surfaces = d.select().from(channelSurfaces).all();
      const surfaceTitleByKey = new Map<string, string>();
      for (const sf of surfaces) {
        if (sf.displayName) {
          surfaceTitleByKey.set(`${sf.channelId}:${sf.externalId}`, sf.displayName);
        }
      }

      const userNameById = new Map(
        d
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.agentId, scope.agentId))
          .all()
          .map(u => [u.id, u.displayName] as const),
      );

      const consolidation = d
        .select()
        .from(memoryConsolidations)
        .where(eq(memoryConsolidations.agentId, scope.agentId))
        .get();

      // 1. Per-Shadow heartbeats
      const hbStates = new Map(
        d
          .select()
          .from(shadowHeartbeats)
          .where(eq(shadowHeartbeats.agentId, scope.agentId))
          .all()
          .map(row => [row.shadowId, row] as const),
      );

      const heartbeats = shadowsInScope.map(shadow => {
        const state = hbStates.get(shadow.id);
        const latestCmd = state?.commandId
          ? d
              .select()
              .from(sessionCommands)
              .where(eq(sessionCommands.id, state.commandId))
              .get()
          : undefined;
        const intervalMs = settings.heartbeatIntervalMs;
        const since =
          latestCmd && latestCmd.status !== "completed" && state
            ? state.coveredFrom
            : state
              ? state.cursorAt
              : Math.max(0, now - Math.max(intervalMs, 30 * 60_000));
        const excludeIds = [state?.sessionId, consolidation?.sessionId].filter(
          (id): id is string => Boolean(id),
        );
        const report = queryShadowActivity(d, shadow.id, {
          since,
          excludeSessionIds: excludeIds,
        });
        const referenceAt = state ? state.lastQueuedAt : shadow.createdAt;
        const nextEligibleAt =
          intervalMs > 0 ? referenceAt + intervalMs : null;

        const latestAttemptOutput = latestCmd
          ? d
              .select({ rawOutput: sessionRunnerAttempts.rawOutput })
              .from(sessionRunnerAttempts)
              .where(eq(sessionRunnerAttempts.turnId, latestCmd.id))
              .orderBy(desc(sessionRunnerAttempts.attemptIndex))
              .limit(1)
              .get()?.rawOutput ?? null
          : null;
        const cleanSummary =
          latestAttemptOutput &&
          latestAttemptOutput.trim() &&
          latestAttemptOutput.trim() !== "LUNA_NOTHING_TO_SEND"
            ? latestAttemptOutput.trim().slice(0, 240)
            : null;

        return {
          shadowId: shadow.id,
          shadowName: shadow.name,
          isDefault: shadow.id === agentRow.defaultShadowId,
          sessionId: state?.sessionId ?? null,
          cursorAt: state?.cursorAt ?? null,
          lastQueuedAt: state?.lastQueuedAt ?? null,
          nextEligibleAt,
          latestCommand: latestCmd
            ? {
                id: latestCmd.id,
                status: latestCmd.status,
                error: latestCmd.error,
                summary: cleanSummary,
                createdAt: latestCmd.createdAt,
                updatedAt: latestCmd.updatedAt,
              }
            : null,
          pendingActivity: {
            hasWakeActivity: report.hasWakeActivity,
            messageSessions: report.messagesBySession.length,
            messageCount: report.messagesBySession.reduce(
              (acc, item) => acc + item.messageCount,
              0,
            ),
            taskRunCount: report.taskRuns.length,
            scheduleOccurrenceCount: report.scheduleOccurrences.length,
            correlatedRequestCount: report.correlatedRequests.length,
          },
        };
      });

      // 2. Correlated requests (Asks & Handoffs)
      const rawRequests = d
        .select()
        .from(correlatedRequests)
        .where(
          and(
            eq(correlatedRequests.agentId, scope.agentId),
            scope.shadowId
              ? eq(correlatedRequests.shadowId, scope.shadowId)
              : undefined,
          ),
        )
        .orderBy(desc(correlatedRequests.updatedAt))
        .limit(100)
        .all();

      const requests = rawRequests.map(req => ({
        id: req.id,
        kind: req.kind,
        status: req.status,
        shadowId: req.shadowId,
        shadowName: shadowNameById.get(req.shadowId) ?? req.shadowId,
        originSessionId: req.originSessionId,
        originSessionTitle: resolveSessionDisplayTitle(
          sessionById.get(req.originSessionId),
          surfaceTitleByKey,
        ),
        targetAddress: req.targetAddress,
        targetSessionId: req.targetSessionId,
        targetSessionTitle: resolveSessionDisplayTitle(
          sessionById.get(req.targetSessionId),
          surfaceTitleByKey,
        ),
        targetUserId: req.targetUserId,
        targetUserName: req.targetUserId
          ? (userNameById.get(req.targetUserId) ?? req.targetUserId)
          : null,
        instruction: req.instruction,
        contextSummary: req.contextSummary,
        options: req.optionsJson ?? [],
        result: req.resultJson,
        resolvedByUserId: req.resolvedByUserId,
        resolvedByUserName: req.resolvedByUserId
          ? (userNameById.get(req.resolvedByUserId) ?? req.resolvedByUserId)
          : null,
        expiresAt: req.expiresAt,
        createdAt: req.createdAt,
        updatedAt: req.updatedAt,
      }));

      // 3. Outbound governance stats, deferred queue & recent control events
      const scopedSessionIds = allAgentSessions
        .filter(s => !scope.shadowId || s.shadow_id === scope.shadowId)
        .map(s => s.id);
      let sentLast24h = 0;
      let deferredQueue: {
        id: string;
        sessionId: string;
        sessionTitle: string;
        contentPreview: string;
        availableAt: number;
        createdAt: number;
      }[] = [];
      let recentEvents: {
        id: string;
        sessionId: string;
        sessionTitle: string;
        controlKind: string;
        reasonKind: string;
        summary: string;
        createdAt: number;
      }[] = [];

      if (scopedSessionIds.length) {
        const recentProactiveCmds = d
          .select()
          .from(sessionCommands)
          .where(
            and(
              inArray(sessionCommands.sessionId, scopedSessionIds),
              eq(sessionCommands.kind, "message.send"),
              sql`json_extract(${sessionCommands.payload}, '$.proactiveGovernance.proactive') = 1`,
            ),
          )
          .orderBy(desc(sessionCommands.createdAt))
          .limit(200)
          .all();

        sentLast24h = recentProactiveCmds.filter(
          cmd =>
            cmd.createdAt >= now - 86_400_000 &&
            !["cancelled", "failed", "deferred"].includes(cmd.status),
        ).length;

        deferredQueue = d
          .select()
          .from(sessionCommands)
          .where(
            and(
              inArray(sessionCommands.sessionId, scopedSessionIds),
              eq(sessionCommands.status, "deferred"),
            ),
          )
          .orderBy(sessionCommands.availableAt)
          .limit(50)
          .all()
          .map(cmd => ({
            id: cmd.id,
            sessionId: cmd.sessionId,
            sessionTitle: resolveSessionDisplayTitle(
              sessionById.get(cmd.sessionId),
              surfaceTitleByKey,
            ),
            contentPreview: String(cmd.payload.content ?? "").slice(0, 160),
            availableAt: cmd.availableAt,
            createdAt: cmd.createdAt,
          }));

        recentEvents = d
          .select()
          .from(sessionTimelineEvents)
          .where(
            and(
              inArray(sessionTimelineEvents.sessionId, scopedSessionIds),
              inArray(sessionTimelineEvents.controlKind, [
                "outbound_throttled",
                "outbound_deferred",
              ]),
            ),
          )
          .orderBy(desc(sessionTimelineEvents.createdAt))
          .limit(30)
          .all()
          .map(ev => ({
            id: ev.id,
            sessionId: ev.sessionId,
            sessionTitle: resolveSessionDisplayTitle(
              sessionById.get(ev.sessionId),
              surfaceTitleByKey,
            ),
            controlKind: ev.controlKind,
            reasonKind: ev.reasonKind,
            summary: ev.summary,
            createdAt: ev.createdAt,
          }));
      }

      return c.json({
        now,
        settings: {
          ...settings,
          timezone,
          inQuietHours: quota.inQuietHours,
          quietHoursEndsAt: quota.quietHoursEndsAt,
        },
        heartbeats,
        requests,
        governance: {
          sentLast24h,
          deferredQueue,
          recentEvents,
        },
      });
    })
    .post("/heartbeats/:shadowId/trigger", c => {
      const scope = ownerScope(c);
      const shadowId = c.req.param("shadowId");
      const shadow = new AgentStore(db()).shadow(shadowId);
      if (shadow.agentId !== scope.agentId) {
        throw new GatewayError("shadow_not_found", "Shadow not found", 404);
      }
      const result = triggerShadowHeartbeatNow(db(), service(), shadowId);
      return c.json({ ok: true, ...result });
    })
    .post("/requests/:requestId/cancel", c => {
      const scope = ownerScope(c);
      const requestId = c.req.param("requestId");
      const d = db();
      const existing = d
        .select()
        .from(correlatedRequests)
        .where(
          and(
            eq(correlatedRequests.id, requestId),
            eq(correlatedRequests.agentId, scope.agentId),
          ),
        )
        .get();
      if (!existing) {
        throw new GatewayError("request_not_found", "Request not found", 404);
      }
      if (existing.status !== "pending") {
        return c.json({ ok: true, status: existing.status, alreadySettled: true });
      }
      const now = Date.now();
      d.update(correlatedRequests)
        .set({
          status: "cancelled",
          resolvedByUserId: scope.actorUserId,
          resultJson: { cancelledByOwner: true },
          updatedAt: now,
        })
        .where(
          and(
            eq(correlatedRequests.id, requestId),
            eq(correlatedRequests.status, "pending"),
          ),
        )
        .run();
      if (existing.outboundCommandId) {
        const outCmd = service().get(existing.outboundCommandId);
        if (outCmd && ["pending", "deferred"].includes(outCmd.status)) {
          service().cancel(existing.outboundCommandId);
        }
      }
      return c.json({ ok: true, status: "cancelled", alreadySettled: false });
    });
}
