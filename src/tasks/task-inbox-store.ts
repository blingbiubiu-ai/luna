import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import {
  taskInboxEvents,
  type TaskInboxEventKind,
} from "@/data/schema";

export type TaskInboxEventRow = typeof taskInboxEvents.$inferSelect;

export class TaskInboxStore {
  constructor(private readonly db: DrizzleDB) {}

  append(input: {
    readonly id?: string | undefined;
    readonly taskId: string;
    readonly kind: TaskInboxEventKind;
    readonly source: string;
    readonly correlationId?: string | null | undefined;
    readonly content: string;
    readonly payload?: Record<string, unknown> | null | undefined;
    readonly now?: number | undefined;
  }): TaskInboxEventRow {
    const now = input.now ?? Date.now();
    return this.db.transaction(tx => {
      if (input.id) {
        const existing = tx
          .select()
          .from(taskInboxEvents)
          .where(eq(taskInboxEvents.id, input.id))
          .get();
        if (existing) return existing;
      }
      const maxRow = tx
        .select({ maxSeq: sql<number>`coalesce(max(${taskInboxEvents.seq}), 0)` })
        .from(taskInboxEvents)
        .where(eq(taskInboxEvents.taskId, input.taskId))
        .get();
      const seq = (maxRow?.maxSeq ?? 0) + 1;
      const id = input.id ?? `tie_${randomUUID()}`;
      tx.insert(taskInboxEvents)
        .values({
          id,
          taskId: input.taskId,
          seq,
          kind: input.kind,
          source: input.source,
          correlationId: input.correlationId ?? null,
          content: input.content,
          payloadJson: input.payload ?? null,
          deliveredContextId: null,
          deliveredRunId: null,
          deliveredAt: null,
          createdAt: now,
        })
        .run();
      return tx
        .select()
        .from(taskInboxEvents)
        .where(eq(taskInboxEvents.id, id))
        .get()!;
    });
  }

  /** Lists undelivered inbox events for `taskId` without marking them consumed. */
  peekUndelivered(taskId: string): TaskInboxEventRow[] {
    return this.db
      .select()
      .from(taskInboxEvents)
      .where(
        and(
          eq(taskInboxEvents.taskId, taskId),
          isNull(taskInboxEvents.deliveredContextId),
        ),
      )
      .orderBy(asc(taskInboxEvents.seq))
      .all();
  }

  /**
   * Atomically claims undelivered inbox events for `(runnerContextId, runId)`.
   * When `includeContextRebuild` is true (a brand-new provider session is being
   * seeded from scratch), returns all prior events for the task and updates any
   * undelivered ones to `runnerContextId`.
   */
  consumePending(input: {
    readonly taskId: string;
    readonly runnerContextId: string;
    readonly runId: string;
    readonly includeContextRebuild?: boolean | undefined;
    readonly now?: number | undefined;
  }): TaskInboxEventRow[] {
    const now = input.now ?? Date.now();
    return this.db.transaction(tx => {
      const pending = tx
        .select()
        .from(taskInboxEvents)
        .where(
          input.includeContextRebuild
            ? eq(taskInboxEvents.taskId, input.taskId)
            : and(
                eq(taskInboxEvents.taskId, input.taskId),
                isNull(taskInboxEvents.deliveredContextId),
              ),
        )
        .orderBy(asc(taskInboxEvents.seq))
        .all();
      if (pending.length === 0) return [];
      for (const row of pending) {
        if (row.deliveredContextId === null) {
          tx.update(taskInboxEvents)
            .set({
              deliveredContextId: input.runnerContextId,
              deliveredRunId: input.runId,
              deliveredAt: now,
            })
            .where(eq(taskInboxEvents.id, row.id))
            .run();
        }
      }
      return pending;
    });
  }

  /**
   * Marks undelivered inbox events matching `(taskId, correlationId)` as delivered
   * when an active Task Runner already received a settled `Request` synchronously via `--wait`.
   */
  markDeliveredForCorrelation(input: {
    readonly taskId: string;
    readonly correlationId: string;
    readonly runnerContextId: string;
    readonly runId: string;
    readonly now?: number | undefined;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .update(taskInboxEvents)
      .set({
        deliveredContextId: input.runnerContextId,
        deliveredRunId: input.runId,
        deliveredAt: now,
      })
      .where(
        and(
          eq(taskInboxEvents.taskId, input.taskId),
          eq(taskInboxEvents.correlationId, input.correlationId),
          isNull(taskInboxEvents.deliveredContextId),
        ),
      )
      .run();
  }
}
