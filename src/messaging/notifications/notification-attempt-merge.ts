import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { notificationAttempts } from "@/data/schema";

import type { NotificationAttempt } from "./notification-attempt-store";

/**
 * Executes remap Notification Attempt Messages logic for notification delivery.
 */
export function remapNotificationAttemptMessages(
  db: DrizzleDB,
  sourceMessageId: string,
  canonicalMessageId: string,
): void {
  db.update(notificationAttempts)
    .set({ message_id: canonicalMessageId, updated_at: Date.now() })
    .where(eq(notificationAttempts.message_id, sourceMessageId))
    .run();
  mergeDuplicateNotificationAttempts(db);
}

/**
 * Executes remap Notification Attempt Subscriptions logic for notification delivery.
 */
export function remapNotificationAttemptSubscriptions(
  db: DrizzleDB,
  sourceSubscriptionId: string,
  canonicalSubscriptionId: string,
): void {
  db.update(notificationAttempts)
    .set({ subscription_id: canonicalSubscriptionId, updated_at: Date.now() })
    .where(eq(notificationAttempts.subscription_id, sourceSubscriptionId))
    .run();
  mergeDuplicateNotificationAttempts(db);
}

/**
 * Executes merge Duplicate Notification Attempts logic for notification delivery.
 */
export function mergeDuplicateNotificationAttempts(db: DrizzleDB): void {
  const rows = db.select().from(notificationAttempts).all();
  const groups = new Map<string, NotificationAttempt[]>();
  for (const row of rows) {
    const key = [
      row.task_id,
      row.subscription_id,
      row.message_id,
      row.action,
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const duplicates of groups.values()) {
    if (duplicates.length < 2) {
      continue;
    }
    _mergeDuplicateRows(db, duplicates);
  }
}

function _mergeDuplicateRows(
  db: DrizzleDB,
  duplicates: readonly NotificationAttempt[],
): void {
  const [keeper] = [...duplicates].sort(_compareAttemptKeepPriority);
  if (!keeper) {
    return;
  }

  const outboundId = _chooseOutboundId(duplicates);
  const status = _chooseStatus(duplicates, outboundId);
  const updatedAt = Math.max(...duplicates.map((row) => row.updated_at));

  for (const duplicate of duplicates) {
    if (duplicate.id === keeper.id) {
      continue;
    }
    db.delete(notificationAttempts)
      .where(eq(notificationAttempts.id, duplicate.id))
      .run();
  }

  db.update(notificationAttempts)
    .set({
      status,
      outbound_id: outboundId,
      updated_at: updatedAt,
    })
    .where(eq(notificationAttempts.id, keeper.id))
    .run();
}

function _chooseOutboundId(
  rows: readonly NotificationAttempt[],
): string | null {
  return [...rows]
    .sort(_compareAttemptKeepPriority)
    .find((row) => row.outbound_id !== null)?.outbound_id ?? null;
}

function _chooseStatus(
  rows: readonly NotificationAttempt[],
  outboundId: string | null,
): string {
  if (outboundId !== null || rows.some((row) => row.status === "sent")) {
    return "sent";
  }
  if (rows.some((row) => row.status === "pending")) {
    return "pending";
  }
  return "failed";
}

function _compareAttemptKeepPriority(
  left: NotificationAttempt,
  right: NotificationAttempt,
): number {
  const statusDiff = _attemptScore(right) - _attemptScore(left);
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const createdDiff = left.created_at - right.created_at;
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return left.id.localeCompare(right.id);
}

function _attemptScore(row: NotificationAttempt): number {
  if (row.status === "sent" && row.outbound_id !== null) {
    return 3;
  }
  if (row.status === "sent") {
    return 2;
  }
  if (row.status === "pending") {
    return 1;
  }
  return 0;
}
