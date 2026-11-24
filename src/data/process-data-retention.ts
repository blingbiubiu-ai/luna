import { sql } from "drizzle-orm";

import type { DrizzleDB } from "./data-connection";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { createLogger, type Logger } from "@/shared";

export const PROCESS_DATA_RETENTION_CHECK_INTERVAL_MS = 60 * 1000;
export const TOOLS_PRUNED_TIMELINE_EVENT_TYPE = "timeline.tools_pruned";

export interface ProcessDataPruneResult {
  readonly toolTimelineEvents: number;
  readonly progressNotificationAttempts: number;
  readonly nativeProgressDeliveries: number;
  readonly progressReplyDeliveries: number;
  readonly progressReplyDispatches: number;
  readonly totalAffected: number;
}

export interface PruneExpiredProcessDataInput {
  readonly now?: number;
  readonly retentionMs: number;
}

function runAndCount(
  tx: Omit<DrizzleDB, "$client">,
  statement: ReturnType<typeof sql>,
): number {
  const res = tx.run(statement) as unknown as { changes?: number };
  return typeof res?.changes === "number" ? res.changes : 0;
}

/**
 * Prunes expired tool-call timeline rows and associated progress-card delivery state
 * older than `now - retentionMs`, while leaving messages, public/lifecycle timeline events,
 * prompts, runner attempts, artifacts, memories, and active/suspended runs untouched.
 */
export function pruneExpiredProcessData(
  db: DrizzleDB,
  input: PruneExpiredProcessDataInput,
): ProcessDataPruneResult {
  const now = input.now ?? Date.now();
  const cutoff = now - Math.max(0, input.retentionMs);

  const result = db.transaction((tx) => {
    // 1. Intermediate `runner.tool` events on finished Tasks
    //    (retaining `runner.step`, lifecycle events, and any event linked to an artifact),
    //    recording a compact `timeline.tools_pruned` marker per affected Task Run so the UI
    //    never misleads operators into thinking the run originally had no tool calls.
    const prunableToolPredicate = sql`
      type = 'runner.tool'
      AND COALESCE(NULLIF(updated_at, 0), created_at) <= ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM artifacts a
        WHERE a.timeline_event_id = timeline_events.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_runs tr
        WHERE tr.id = timeline_events.task_run_id
          AND tr.status IN ('pending', 'running', 'waiting', 'paused')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = timeline_events.task_id
          AND t.status IN ('pending', 'running', 'waiting', 'paused')
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_deletions td
        WHERE td.task_id = timeline_events.task_id
      )
    `;
    const prunedGroups = tx.all<{
      taskId: string;
      taskRunId: string | null;
      runIndex: number | null;
      prunedCount: number;
      firstToolAt: number;
      lastToolAt: number;
    }>(sql`
      SELECT
        timeline_events.task_id AS taskId,
        timeline_events.task_run_id AS taskRunId,
        (SELECT tr.run_index FROM task_runs tr WHERE tr.id = timeline_events.task_run_id) AS runIndex,
        COUNT(*) AS prunedCount,
        MIN(timeline_events.created_at) AS firstToolAt,
        MAX(timeline_events.created_at) AS lastToolAt
      FROM timeline_events
      WHERE ${prunableToolPredicate}
      GROUP BY timeline_events.task_id, timeline_events.task_run_id
    `);
    const toolTimelineEvents = runAndCount(
      tx,
      sql`DELETE FROM timeline_events WHERE ${prunableToolPredicate}`,
    );
    for (const group of prunedGroups) {
      if (group.prunedCount <= 0) continue;
      const markerId = `retention-pruned:${group.taskId}:${group.taskRunId ?? "none"}`;
      const existing = tx.all<{ createdAt: number; data: string | null }>(
        sql`SELECT created_at AS createdAt, data FROM timeline_events WHERE id = ${markerId}`,
      )[0];
      let priorCount = 0;
      let priorFirstAt: number | undefined;
      let priorLastAt: number | undefined;
      if (existing?.data) {
        try {
          const parsed = JSON.parse(existing.data) as Record<string, unknown>;
          if (typeof parsed.prunedToolCount === "number") priorCount = parsed.prunedToolCount;
          if (typeof parsed.firstToolAt === "number") priorFirstAt = parsed.firstToolAt;
          if (typeof parsed.lastToolAt === "number") priorLastAt = parsed.lastToolAt;
        } catch {
          // Ignore malformed legacy marker JSON.
        }
      }
      const totalCount = priorCount + group.prunedCount;
      const firstToolAt =
        priorFirstAt !== undefined ? Math.min(priorFirstAt, group.firstToolAt) : group.firstToolAt;
      const lastToolAt =
        priorLastAt !== undefined ? Math.max(priorLastAt, group.lastToolAt) : group.lastToolAt;
      const summary = `已按保留策略自动清理 ${totalCount} 条过期工具调用明细`;
      const payload = JSON.stringify({
        prunedToolCount: totalCount,
        prunedAt: now,
        firstToolAt,
        lastToolAt,
        ...(group.taskRunId ? { taskRunId: group.taskRunId } : {}),
        ...(typeof group.runIndex === "number" ? { runIndex: group.runIndex } : {}),
      });
      tx.run(sql`
        INSERT INTO timeline_events (
          id, task_id, task_run_id, type, summary, data, visibility, created_at, updated_at
        ) VALUES (
          ${markerId},
          ${group.taskId},
          ${group.taskRunId},
          ${TOOLS_PRUNED_TIMELINE_EVENT_TYPE},
          ${summary},
          ${payload},
          'internal',
          ${lastToolAt},
          ${now}
        )
        ON CONFLICT(id) DO UPDATE SET
          summary = excluded.summary,
          data = excluded.data,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);
    }

    // 2. Sent/skipped status-card progress update attempts on finished Tasks
    //    (retaining `create_status_card` and `publish_task_result`).
    const progressNotificationAttempts = runAndCount(
      tx,
      sql`
        DELETE FROM notification_attempts
        WHERE action IN ('update_status_card_progress', 'update_status_card')
          AND status IN ('sent', 'skipped')
          AND updated_at <= ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = notification_attempts.task_id
              AND t.status IN ('pending', 'running', 'waiting', 'paused')
          )
      `,
    );

    // 3. Settled Feishu Native progress-card streaming checkpoints
    //    (preserving quarantined `$.pending` rows and any card bound to an active/waiting Task).
    const nativeProgressDeliveries = runAndCount(
      tx,
      sql`
        DELETE FROM native_progress_deliveries
        WHERE updated_at <= ${cutoff}
          AND (NOT json_valid(state) OR json_extract(state, '$.pending') IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM task_run_notifications trn
            JOIN tasks t ON t.id = trn.task_id
            WHERE trn.channel_id = native_progress_deliveries.channel_id
              AND trn.status_message_id = native_progress_deliveries.message_id
              AND t.status IN ('pending', 'running', 'waiting', 'paused')
          )
      `,
    );

    // 4. Settled status-card / progress-snapshot dispatches & channel deliveries
    //    (ordinary chat replies and active session/task status cards are never touched).
    const expiredProgressDispatches = sql`
      SELECT r.id
      FROM session_reply_dispatches r
      WHERE r.created_at <= ${cutoff}
        AND r.receipt IS NOT NULL
        AND json_valid(r.receipt)
        AND (
          json_extract(r.receipt, '$.replyMode') = 'update_status_card'
          OR json_type(r.receipt, '$.statusCard') IS NOT NULL
          OR json_type(r.receipt, '$.progressSnapshot') IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_channel_deliveries d
          WHERE d.dispatch_id = r.id
            AND d.status NOT IN ('sent', 'skipped')
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_turns st
          WHERE st.session_id = r.session_id
            AND st.status IN ('pending', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_run_notifications trn
          JOIN tasks t ON t.id = trn.task_id
          WHERE t.status IN ('pending', 'running', 'waiting', 'paused')
            AND (
              trn.status_message_id = r.id
              OR EXISTS (
                SELECT 1 FROM session_channel_deliveries d2
                WHERE d2.dispatch_id = r.id
                  AND d2.receipt IS NOT NULL
                  AND json_valid(d2.receipt)
                  AND json_extract(d2.receipt, '$.id') = trn.status_message_id
              )
            )
        )
    `;
    const progressReplyDeliveries = runAndCount(
      tx,
      sql`DELETE FROM session_channel_deliveries WHERE dispatch_id IN (${expiredProgressDispatches})`,
    );
    const progressReplyDispatches = runAndCount(
      tx,
      sql`DELETE FROM session_reply_dispatches WHERE id IN (${expiredProgressDispatches})`,
    );

    const totalAffected =
      toolTimelineEvents +
      progressNotificationAttempts +
      nativeProgressDeliveries +
      progressReplyDeliveries +
      progressReplyDispatches;

    return {
      toolTimelineEvents,
      progressNotificationAttempts,
      nativeProgressDeliveries,
      progressReplyDeliveries,
      progressReplyDispatches,
      totalAffected,
    };
  });

  if (result.totalAffected > 0) {
    try {
      db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);
    } catch {
      // Best-effort WAL checkpoint; never fail callers after a committed prune.
    }
  }

  return result;
}

export interface ProcessDataRetentionSchedulerInput {
  readonly db: DrizzleDB;
  readonly checkIntervalMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export class ProcessDataRetentionScheduler {
  private readonly _logger: Logger;
  private readonly _now: () => number;
  private readonly _setInterval: typeof setInterval;
  private readonly _clearInterval: typeof clearInterval;
  private readonly _settingsStore: PlatformSettingsStore;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _lastSweepAt: number | undefined;

  constructor(private readonly _input: ProcessDataRetentionSchedulerInput) {
    this._logger = _input.logger ?? createLogger("process-data-retention");
    this._now = _input.now ?? Date.now;
    this._setInterval = _input.setInterval ?? setInterval;
    this._clearInterval = _input.clearInterval ?? clearInterval;
    this._settingsStore = new PlatformSettingsStore(_input.db);
  }

  start(): void {
    if (this._timer !== undefined) {
      return;
    }
    this.tick("startup");
    this._timer = this._setInterval(
      () => this.tick("scheduled"),
      this._input.checkIntervalMs ?? PROCESS_DATA_RETENTION_CHECK_INTERVAL_MS,
    );
    this._timer.unref?.();
  }

  stop(): void {
    if (this._timer === undefined) {
      return;
    }
    this._clearInterval(this._timer);
    this._timer = undefined;
  }

  tick(reason: "startup" | "scheduled" = "scheduled"): ProcessDataPruneResult | undefined {
    try {
      const settings = this._settingsStore.get().retention;
      if (!settings.enabled) {
        return undefined;
      }
      const now = this._now();
      const intervalMs = settings.intervalMinutes * 60_000;
      if (
        reason !== "startup" &&
        this._lastSweepAt !== undefined &&
        now - this._lastSweepAt < intervalMs
      ) {
        return undefined;
      }
      this._lastSweepAt = now;
      const result = pruneExpiredProcessData(this._input.db, {
        now,
        retentionMs: settings.retentionDays * 86_400_000,
      });
      if (result.totalAffected > 0) {
        this._logger.info(
          { ...result, retentionDays: settings.retentionDays, reason },
          "pruned expired tool and progress data",
        );
      }
      return result;
    } catch (err) {
      this._logger.warn(
        { err, reason },
        "failed to prune expired tool and progress data",
      );
      return undefined;
    }
  }
}
