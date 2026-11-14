import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { taskSubscriptions } from "@/data/schema";
import { remapNotificationAttemptSubscriptions } from "@/messaging/notifications/notification-attempt-merge";

import { createTaskSubscriptionSurfaceKey } from "./task-subscription-store";
import type { TaskSubscription } from "./types";

/**
 * Executes merge Duplicate Task Subscriptions For Session logic for task workflow.
 */
export function mergeDuplicateTaskSubscriptionsForSession(
  db: DrizzleDB,
  sessionId: string,
): void {
  const rows = db
    .select()
    .from(taskSubscriptions)
    .where(eq(taskSubscriptions.session_id, sessionId))
    .all();
  const rowsByTaskSurface = new Map<string, TaskSubscription[]>();
  for (const row of rows) {
    const key = `${row.task_id}:${_surfaceKeyForRow(row)}`;
    rowsByTaskSurface.set(key, [
      ...(rowsByTaskSurface.get(key) ?? []),
      row,
    ]);
  }

  for (const duplicates of rowsByTaskSurface.values()) {
    if (duplicates.length < 2) {
      continue;
    }
    _mergeDuplicateRows(db, duplicates);
  }
}

/**
 * Moves task subscriptions from an alias session to the canonical session.
 */
export function moveTaskSubscriptionsToCanonicalSession(
  db: DrizzleDB,
  sourceSessionId: string,
  canonicalSessionId: string,
): void {
  const sourceRows = db
    .select()
    .from(taskSubscriptions)
    .where(eq(taskSubscriptions.session_id, sourceSessionId))
    .all();

  for (const sourceRow of sourceRows) {
    const canonicalRow = db
      .select()
      .from(taskSubscriptions)
      .where(
        and(
          eq(taskSubscriptions.task_id, sourceRow.task_id),
          eq(taskSubscriptions.session_id, canonicalSessionId),
          eq(taskSubscriptions.surface_key, _surfaceKeyForRow(sourceRow)),
        ),
      )
      .get();

    if (!canonicalRow) {
      db.update(taskSubscriptions)
        .set({
          session_id: canonicalSessionId,
          surface_key: _surfaceKeyForRow(sourceRow),
          updated_at: Date.now(),
        })
        .where(eq(taskSubscriptions.id, sourceRow.id))
        .run();
      continue;
    }

    _mergeIntoCanonicalRow(db, canonicalRow, sourceRow);
  }

  mergeDuplicateTaskSubscriptionsForSession(db, canonicalSessionId);
}

function _mergeDuplicateRows(
  db: DrizzleDB,
  duplicates: readonly TaskSubscription[],
): void {
  const [keeper] = [...duplicates].sort(_compareSubscriptionKeepPriority);
  if (!keeper) {
    return;
  }

  const visibility = duplicates.some((row) => row.visibility === "full")
    ? "full"
    : keeper.visibility;
  const notificationLevel = _chooseNotificationLevel(duplicates);
  const updatedAt = Math.max(...duplicates.map((row) => row.updated_at));

  db.update(taskSubscriptions)
    .set({
      visibility,
      notification_level: notificationLevel,
      updated_at: updatedAt,
    })
    .where(eq(taskSubscriptions.id, keeper.id))
    .run();

  for (const duplicate of duplicates) {
    if (duplicate.id === keeper.id) {
      continue;
    }
    remapNotificationAttemptSubscriptions(db, duplicate.id, keeper.id);
    db.delete(taskSubscriptions)
      .where(
        and(
          eq(taskSubscriptions.id, duplicate.id),
          eq(taskSubscriptions.task_id, keeper.task_id),
          eq(taskSubscriptions.session_id, keeper.session_id),
          eq(taskSubscriptions.surface_key, _surfaceKeyForRow(keeper)),
        ),
      )
      .run();
  }
}

function _mergeIntoCanonicalRow(
  db: DrizzleDB,
  canonicalRow: TaskSubscription,
  sourceRow: TaskSubscription,
): void {
  db.update(taskSubscriptions)
    .set({
      visibility:
        canonicalRow.visibility === "full" || sourceRow.visibility === "full"
          ? "full"
          : canonicalRow.visibility,
      notification_level: _chooseNotificationLevel([canonicalRow, sourceRow]),
      updated_at: Math.max(canonicalRow.updated_at, sourceRow.updated_at),
    })
    .where(eq(taskSubscriptions.id, canonicalRow.id))
    .run();

  remapNotificationAttemptSubscriptions(db, sourceRow.id, canonicalRow.id);
  db.delete(taskSubscriptions)
    .where(eq(taskSubscriptions.id, sourceRow.id))
    .run();
}

function _chooseNotificationLevel(
  rows: readonly TaskSubscription[],
): TaskSubscription["notification_level"] {
  return rows.some((row) => row.notification_level === "all")
    ? "all"
    : "major_updates";
}

function _compareSubscriptionKeepPriority(
  left: TaskSubscription,
  right: TaskSubscription,
): number {
  const visibilityDiff = _visibilityScore(right) - _visibilityScore(left);
  if (visibilityDiff !== 0) {
    return visibilityDiff;
  }

  const createdDiff = left.created_at - right.created_at;
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return left.id.localeCompare(right.id);
}

function _visibilityScore(row: TaskSubscription): number {
  return row.visibility === "full" ? 1 : 0;
}

function _surfaceKeyForRow(row: TaskSubscription): string {
  return row.surface_key ??
    createTaskSubscriptionSurfaceKey({
      channelType: row.channel_type,
      channelId: row.channel_id,
      ...(row.group_id !== null ? { groupId: row.group_id } : {}),
      ...(row.thread_key !== null ? { threadId: row.thread_key } : {}),
      ...(row.root_message_key !== null
        ? { rootMessageId: row.root_message_key }
        : {}),
    });
}
