import { and, eq, inArray, ne } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { notificationAttempts } from "@/data/schema";
import { uuid } from "@/shared";

/**
 * Represents Notification Attempt values used by notification delivery.
 */
export type NotificationAttempt = typeof notificationAttempts.$inferSelect;

/**
 * Input contract for delivery resolve notification attempt operations in notification.
 */
export interface ResolveNotificationAttemptInput {
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly subscriptionId: string;
  readonly messageId: string;
  readonly action: string;
}

/**
 * Describes the Resolved Notification Attempt contract used by notification delivery.
 */
export interface ResolvedNotificationAttempt {
  readonly attempt: NotificationAttempt;
  readonly created: boolean;
}

/**
 * Persists and reads Notification Attempt Store records for notification delivery.
 */
export class NotificationAttemptStore {
  constructor(private readonly _db: DrizzleDB) {}

  resolve(input: ResolveNotificationAttemptInput): NotificationAttempt {
    return this.resolveWithCreated(input).attempt;
  }

  resolveWithCreated(
    input: ResolveNotificationAttemptInput,
  ): ResolvedNotificationAttempt {
    const existing = this._db
      .select()
      .from(notificationAttempts)
      .where(eq(notificationAttempts.idempotency_key, input.idempotencyKey))
      .get();
    if (existing) {
      return { attempt: existing, created: false };
    }

    const semanticExisting = this._db
      .select()
      .from(notificationAttempts)
      .where(
        and(
          eq(notificationAttempts.task_id, input.taskId),
          eq(notificationAttempts.subscription_id, input.subscriptionId),
          eq(notificationAttempts.message_id, input.messageId),
          eq(notificationAttempts.action, input.action),
        ),
      )
      .get();
    if (semanticExisting) {
      this._db
        .update(notificationAttempts)
        .set({
          idempotency_key: input.idempotencyKey,
          updated_at: Date.now(),
        })
        .where(eq(notificationAttempts.id, semanticExisting.id))
        .run();
      return {
        attempt: this.requireById(semanticExisting.id),
        created: false,
      };
    }

    const now = Date.now();
    const row = {
      id: uuid(),
      idempotency_key: input.idempotencyKey,
      task_id: input.taskId,
      subscription_id: input.subscriptionId,
      message_id: input.messageId,
      action: input.action,
      status: "pending",
      outbound_id: null,
      created_at: now,
      updated_at: now,
    } satisfies NotificationAttempt;
    this._db.insert(notificationAttempts).values(row).run();
    return { attempt: row, created: true };
  }

  markSent(attemptId: string, outboundId: string): NotificationAttempt {
    const updatedAt = Date.now();
    this._db
      .update(notificationAttempts)
      .set({
        status: "sent",
        outbound_id: outboundId,
        updated_at: updatedAt,
      })
      .where(eq(notificationAttempts.id, attemptId))
      .run();
    return this.requireById(attemptId);
  }

  markFailed(attemptId: string): NotificationAttempt {
    const updatedAt = Date.now();
    this._db
      .update(notificationAttempts)
      .set({
        status: "failed",
        updated_at: updatedAt,
      })
      .where(eq(notificationAttempts.id, attemptId))
      .run();
    return this.requireById(attemptId);
  }

  findCreateForMessages(input: {
    readonly taskId: string;
    readonly subscriptionId: string;
    readonly messageIds: readonly string[];
  }): NotificationAttempt | undefined {
    if (input.messageIds.length === 0) {
      return undefined;
    }

    return this._db
      .select()
      .from(notificationAttempts)
      .where(
        and(
          eq(notificationAttempts.task_id, input.taskId),
          eq(notificationAttempts.subscription_id, input.subscriptionId),
          eq(notificationAttempts.action, "create_status_card"),
          inArray(notificationAttempts.message_id, [...input.messageIds]),
        ),
      )
      .all()
      .sort(_compareAttemptKeepPriority)[0];
  }

  hasCreateForMessagesInOtherSubscription(input: {
    readonly taskId: string;
    readonly subscriptionId: string;
    readonly messageIds: readonly string[];
  }): boolean {
    if (input.messageIds.length === 0) {
      return false;
    }

    return (
      this._db
        .select({ id: notificationAttempts.id })
        .from(notificationAttempts)
        .where(
          and(
            eq(notificationAttempts.task_id, input.taskId),
            ne(notificationAttempts.subscription_id, input.subscriptionId),
            eq(notificationAttempts.action, "create_status_card"),
            inArray(notificationAttempts.message_id, [...input.messageIds]),
          ),
        )
        .get() !== undefined
    );
  }

  requireById(attemptId: string): NotificationAttempt {
    const row = this._db
      .select()
      .from(notificationAttempts)
      .where(eq(notificationAttempts.id, attemptId))
      .get();
    if (!row) {
      throw new Error(`Notification attempt "${attemptId}" was not found.`);
    }
    return row;
  }
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
