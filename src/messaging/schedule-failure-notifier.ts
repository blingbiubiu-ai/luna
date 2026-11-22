import { eq, sql } from "drizzle-orm";
import { AgentStore } from "@/agents/agent-store";
import { resolveProactivitySettings } from "@/agents/agent-settings-store";
import type { DrizzleDB } from "@/data";
import { scheduleFailureNotifications } from "@/data/schema";
import { resolveLunaAddress } from "./luna-address";
import type { SessionCommandService } from "./session-command-service";

const FAILURE_LOOKBACK_MS = 48 * 60 * 60 * 1000;

interface FailedScheduleRow {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly scheduleTitle: string;
  readonly agentId: string;
  readonly shadowId: string;
  readonly sourceSessionId: string;
  readonly failureReason: string;
  readonly failedAt: number;
}

/**
 * Detects schedule occurrences that failed, expired, or whose launched `task.run`
 * ended in `failed`, records a durable marker for Dashboard, and notifies the Agent
 * owner via direct chat at most once per `scheduleFailureNotifyIntervalMs`.
 */
export function notifyFailedSchedules(
  db: DrizzleDB,
  commands: Pick<SessionCommandService, "accept">,
  now = Date.now(),
): string[] {
  const rows = db.all<FailedScheduleRow>(sql`
    SELECT
      o.id AS occurrenceId,
      sc.id AS scheduleId,
      sc.title AS scheduleTitle,
      s.agent_id AS agentId,
      s.shadow_id AS shadowId,
      sc.source_session_id AS sourceSessionId,
      CASE
        WHEN tr.status = 'failed' THEN coalesce(tr.error, 'Scheduled Task Run failed')
        WHEN o.status = 'skipped' AND o.reason = 'Expired' THEN 'Scheduled occurrence expired before execution'
        ELSE coalesce(o.reason, cmd.error, 'Scheduled occurrence failed')
      END AS failureReason,
      coalesce(tr.finished_at, cmd.updated_at, o.created_at) AS failedAt
    FROM schedule_occurrences o
    JOIN session_schedules sc ON sc.id = o.schedule_id
    JOIN sessions s ON s.id = sc.target_session_id
    JOIN luna_agents a ON a.id = s.agent_id
    LEFT JOIN session_commands cmd ON cmd.id = o.command_id
    LEFT JOIN task_runs tr ON tr.id = json_extract(cmd.payload, '$.result.runId')
    LEFT JOIN schedule_failure_notifications fn ON fn.schedule_id = sc.id
    WHERE a.status = 'active'
      AND o.id NOT LIKE '%:missed'
      AND o.created_at > ${now - FAILURE_LOOKBACK_MS}
      AND (fn.last_failed_occurrence_id IS NULL OR fn.last_failed_occurrence_id <> o.id)
      AND (
        o.status = 'failed'
        OR (o.status = 'skipped' AND o.reason = 'Expired')
        OR tr.status = 'failed'
      )
    ORDER BY o.created_at ASC
  `);

  if (!rows.length) return [];

  // Deduplicate to the latest failed occurrence per schedule in one pass.
  const latestBySchedule = new Map<string, FailedScheduleRow>();
  for (const row of rows) {
    latestBySchedule.set(row.scheduleId, row);
  }

  const notifiedCommandIds: string[] = [];
  const agents = new AgentStore(db);

  for (const item of latestBySchedule.values()) {
    const existing = db
      .select()
      .from(scheduleFailureNotifications)
      .where(eq(scheduleFailureNotifications.scheduleId, item.scheduleId))
      .get();
    const intervalMs = resolveProactivitySettings(
      db,
      item.agentId,
    ).scheduleFailureNotifyIntervalMs;

    const shouldSend =
      intervalMs > 0 &&
      (existing?.lastNotifiedAt == null ||
        now - existing.lastNotifiedAt >= intervalMs);

    let notificationCommandId = existing?.notificationCommandId ?? null;
    let lastNotifiedAt = existing?.lastNotifiedAt ?? null;

    if (shouldSend) {
      try {
        const ownerUserId = agents.ownerUserId(item.agentId);
        const ownerDirect = resolveLunaAddress(
          db,
          { agentId: item.agentId, shadowId: item.shadowId },
          `user:${ownerUserId}`,
          { create: true },
        );
        const label = item.scheduleTitle
          ? `「${item.scheduleTitle}」(${item.scheduleId})`
          : item.scheduleId;
        const text = `定时任务执行异常：${label}\n原因：${item.failureReason}`;
        const cmd = commands.accept(
          {
            userId: ownerUserId,
            sourceSessionId: ownerDirect.sessionId,
            originId: `schedule-failure:${item.occurrenceId}`,
          },
          ownerDirect.sessionId,
          "message.send",
          "notify-owner",
          { content: text, purpose: "notification" },
        );
        notificationCommandId = cmd.id;
        lastNotifiedAt = now;
        notifiedCommandIds.push(cmd.id);
      } catch {
        // Owner has no bound direct chat surface on this Shadow; keep Dashboard failure marker only.
      }
    }

    db.insert(scheduleFailureNotifications)
      .values({
        scheduleId: item.scheduleId,
        lastFailedOccurrenceId: item.occurrenceId,
        lastFailedAt: item.failedAt,
        lastReason: item.failureReason,
        lastNotifiedAt,
        notificationCommandId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: scheduleFailureNotifications.scheduleId,
        set: {
          lastFailedOccurrenceId: item.occurrenceId,
          lastFailedAt: item.failedAt,
          lastReason: item.failureReason,
          lastNotifiedAt,
          notificationCommandId,
          updatedAt: now,
        },
      })
      .run();
  }

  return notifiedCommandIds;
}
