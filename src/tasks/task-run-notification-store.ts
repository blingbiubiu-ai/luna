import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { taskRunNotifications } from "@/data/schema";
import { createId } from "@/shared";

export type TaskRunNotificationState = "active" | "terminal";

export interface TaskRunNotification {
  readonly id: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly runIndex: number;
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly groupId: string | null;
  readonly threadKey: string | null;
  readonly rootMessageKey: string | null;
  readonly surfaceKey: string | null;
  readonly statusCardStyle: "card" | "native";
  readonly statusMessageId: string | null;
  readonly state: TaskRunNotificationState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ResolveTaskRunNotificationInput {
  readonly statusCardStyle?: "card" | "native";
  readonly taskId: string;
  readonly taskRunId: string;
  readonly runIndex: number;
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly groupId?: string | null;
  readonly threadKey?: string | null;
  readonly rootMessageKey?: string | null;
  readonly surfaceKey?: string | null;
}

export interface FindTaskRunNotificationByStatusMessageInput {
  readonly channelType: string;
  readonly channelId: string;
  readonly statusMessageId: string;
}

/**
 * Persists and reads Task Run status-card notification mappings.
 */
export class TaskRunNotificationStore {
  constructor(private readonly _db: DrizzleDB) {}

  resolveForRunSubscription(
    input: ResolveTaskRunNotificationInput,
  ): TaskRunNotification {
    const existing = this._db
      .select()
      .from(taskRunNotifications)
      .where(
        and(
          eq(taskRunNotifications.task_run_id, input.taskRunId),
          eq(taskRunNotifications.subscription_id, input.subscriptionId),
        ),
      )
      .get();
    if (existing) {
      return _toTaskRunNotification(existing);
    }

    const now = Date.now();
    const row: typeof taskRunNotifications.$inferInsert = {
      id: createId("task_run_notification"),
      task_id: input.taskId,
      task_run_id: input.taskRunId,
      run_index: input.runIndex,
      subscription_id: input.subscriptionId,
      session_id: input.sessionId,
      channel_type: input.channelType,
      channel_id: input.channelId,
      group_id: input.groupId ?? null,
      thread_key: input.threadKey ?? null,
      root_message_key: input.rootMessageKey ?? null,
      surface_key: input.surfaceKey ?? null,
      status_message_id: null,
      status_card_style: input.statusCardStyle ?? "card",
      state: "active",
      created_at: now,
      updated_at: now,
    };
    this._db.insert(taskRunNotifications).values(row).run();
    return _toTaskRunNotification(
      row as typeof taskRunNotifications.$inferSelect,
    );
  }

  listForRun(taskRunId: string): TaskRunNotification[] {
    return this._db
      .select()
      .from(taskRunNotifications)
      .where(eq(taskRunNotifications.task_run_id, taskRunId))
      .all()
      .map(_toTaskRunNotification);
  }

  requireById(id: string): TaskRunNotification {
    const row = this._db
      .select()
      .from(taskRunNotifications)
      .where(eq(taskRunNotifications.id, id))
      .get();
    if (!row) {
      throw new Error(`Task Run notification "${id}" was not found.`);
    }
    return _toTaskRunNotification(row);
  }

  setStatusMessageId(
    id: string,
    statusMessageId: string,
  ): TaskRunNotification {
    const updatedAt = Date.now();
    this._db
      .update(taskRunNotifications)
      .set({
        status_message_id: statusMessageId,
        updated_at: updatedAt,
      })
      .where(eq(taskRunNotifications.id, id))
      .run();
    return this.requireById(id);
  }

  markTerminal(id: string): TaskRunNotification {
    const updatedAt = Date.now();
    this._db
      .update(taskRunNotifications)
      .set({
        state: "terminal",
        updated_at: updatedAt,
      })
      .where(eq(taskRunNotifications.id, id))
      .run();
    return this.requireById(id);
  }

  findByStatusMessage(
    input: FindTaskRunNotificationByStatusMessageInput,
  ): TaskRunNotification | undefined {
    const row = this._db
      .select()
      .from(taskRunNotifications)
      .where(
        and(
          eq(taskRunNotifications.channel_type, input.channelType),
          eq(taskRunNotifications.channel_id, input.channelId),
          eq(taskRunNotifications.status_message_id, input.statusMessageId),
        ),
      )
      .get();
    return row ? _toTaskRunNotification(row) : undefined;
  }
}

function _toTaskRunNotification(
  row: typeof taskRunNotifications.$inferSelect,
): TaskRunNotification {
  return {
    id: row.id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    runIndex: row.run_index,
    subscriptionId: row.subscription_id,
    sessionId: row.session_id,
    channelType: row.channel_type,
    channelId: row.channel_id,
    groupId: row.group_id,
    threadKey: row.thread_key,
    rootMessageKey: row.root_message_key,
    surfaceKey: row.surface_key,
    statusMessageId: row.status_message_id,
    statusCardStyle: row.status_card_style,
    state: row.state as TaskRunNotificationState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
