import { asc, eq, isNull } from "drizzle-orm";

import { createLogger } from "@/shared";
import type { DrizzleDB } from "@/data";
import {
  notificationAttempts,
  taskRunNotifications,
  taskRuns,
} from "@/data/schema";
import type { WorkReplyChannel } from "@/work/types";

import {
  TaskRunNotificationStore,
  type TaskRunNotification,
} from "./task-run-notification-store";
import { TaskRunNotificationService } from "./task-run-notification-service";

const logger = createLogger("task-run-notification-recovery");

export interface TaskRunNotificationRecoveryOptions {
  readonly db: DrizzleDB;
  readonly channelForNotification: (
    notification: TaskRunNotification,
  ) => WorkReplyChannel | undefined;
}

/**
 * Recovers run-level status-card notification state after process restart.
 */
export class TaskRunNotificationRecovery {
  private readonly _store: TaskRunNotificationStore;
  private readonly _service: TaskRunNotificationService;

  constructor(private readonly _options: TaskRunNotificationRecoveryOptions) {
    this._store = new TaskRunNotificationStore(_options.db);
    this._service = new TaskRunNotificationService(_options);
  }

  async recoverPending(): Promise<number> {
    let recovered = 0;
    recovered += this._backfillSentCreates();
    recovered += await this._retryUnsentCreates();
    recovered += await this._recoverTerminalUpdates();
    return recovered;
  }

  private _backfillSentCreates(): number {
    const rows = this._options.db
      .select()
      .from(taskRunNotifications)
      .where(isNull(taskRunNotifications.status_message_id))
      .orderBy(asc(taskRunNotifications.created_at), asc(taskRunNotifications.id))
      .all();
    let count = 0;
    for (const row of rows) {
      const attempt = this._options.db
        .select()
        .from(notificationAttempts)
        .where(
          eq(
            notificationAttempts.idempotency_key,
            JSON.stringify([
              "task-run-notification",
              row.task_run_id,
              row.subscription_id,
              "create_status_card",
            ]),
          ),
        )
        .get();
      if (
        attempt?.status !== "sent" ||
        attempt.outbound_id === null
      ) {
        continue;
      }
      this._store.setStatusMessageId(row.id, attempt.outbound_id);
      count += 1;
    }
    return count;
  }

  private async _retryUnsentCreates(): Promise<number> {
    const rows = this._options.db
      .select({
        notificationId: taskRunNotifications.id,
        taskId: taskRunNotifications.task_id,
        runId: taskRuns.id,
        runReason: taskRuns.reason,
        sourceMessageId: taskRuns.source_message_id,
      })
      .from(taskRunNotifications)
      .innerJoin(taskRuns, eq(taskRuns.id, taskRunNotifications.task_run_id))
      .where(isNull(taskRunNotifications.status_message_id))
      .orderBy(asc(taskRunNotifications.created_at), asc(taskRunNotifications.id))
      .all();

    let count = 0;
    for (const row of rows) {
      try {
        await this._service.onRunCreated({
          taskId: row.taskId,
          taskRunId: row.runId,
          ...(row.sourceMessageId !== null
            ? { sourceMessageId: row.sourceMessageId }
            : {}),
          reason: row.runReason,
        });
        const recovered = this._store.requireById(row.notificationId);
        if (recovered.statusMessageId !== null) {
          count += 1;
        }
      } catch (err) {
        logger.warn({err, notificationId: row.notificationId}, "Status card creation remains pending recovery");
      }
    }
    return count;
  }

  private async _recoverTerminalUpdates(): Promise<number> {
    const rows = this._options.db
      .select({
        notificationId: taskRunNotifications.id,
        runId: taskRuns.id,
        status: taskRuns.status,
        error: taskRuns.error,
      })
      .from(taskRunNotifications)
      .innerJoin(taskRuns, eq(taskRuns.id, taskRunNotifications.task_run_id))
      .where(eq(taskRunNotifications.state, "active"))
      .orderBy(asc(taskRunNotifications.created_at), asc(taskRunNotifications.id))
      .all();

    let count = 0;
    for (const row of rows) {
      try {
        if (row.status === "completed") {
          await this._service.onRunCompleted({ taskRunId: row.runId });
          count += 1;
        } else if (row.status === "failed") {
          await this._service.onRunFailed({
            taskRunId: row.runId,
            error: row.error ?? "Recovered failed Task Run.",
          });
          count += 1;
        } else if (row.status === "cancelled") {
          await this._service.onRunCancelled({
            taskRunId: row.runId,
            reason: "Recovered cancelled Task Run.",
          });
          count += 1;
        }
      } catch (err) {
        logger.warn({err, notificationId: row.notificationId}, "Status card update remains pending recovery");
      }
    }
    return count;
  }
}
