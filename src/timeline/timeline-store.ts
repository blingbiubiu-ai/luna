import { and, desc, eq, sql } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { timelineEvents } from "@/data/schema";
import { uuid } from "@/shared";

import type { TimelineEvent } from "@/tasks/types";

/**
 * Input contract for and artifact persistence append timeline event operations in timeline.
 */
export interface AppendTimelineEventInput {
  readonly taskId: string;
  readonly sessionId?: string;
  readonly messageId?: string;
  readonly type: string;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
  readonly visibility?: string;
}

/**
 * Persists and reads Timeline Store records for timeline and artifact persistence.
 */
export class TimelineStore {
  private _lastTimestamp = 0;

  constructor(private readonly _db: DrizzleDB) {}

  append(input: AppendTimelineEventInput): TimelineEvent {
    const existing = this._findExistingMessageEvent(input);
    if (existing) {
      return existing;
    }

    const createdAt = this._nextTimestamp();
    const row = {
      id: uuid(),
      task_id: input.taskId,
      session_id: input.sessionId ?? null,
      message_id: input.messageId ?? null,
      actor_user_id: null,
      source_message_id: null,
      type: input.type,
      summary: input.summary,
      data: input.data ?? null,
      visibility: input.visibility ?? "full",
      created_at: createdAt,
    } satisfies TimelineEvent;
    this._db.insert(timelineEvents).values(row).run();
    return row;
  }

  hasMessageEvent(input: {
    readonly taskId: string;
    readonly messageId: string;
    readonly type: string;
  }): boolean {
    return this._findExistingMessageEvent({
      taskId: input.taskId,
      messageId: input.messageId,
      type: input.type,
      summary: "",
    }) !== undefined;
  }

  private _findExistingMessageEvent(
    input: AppendTimelineEventInput,
  ): TimelineEvent | undefined {
    const operationId = input.data?.operationId;
    if (typeof operationId === "string") {
      return this._db.select().from(timelineEvents).where(and(
        eq(timelineEvents.task_id, input.taskId), eq(timelineEvents.type, input.type),
        sql`json_extract(${timelineEvents.data}, '$.operationId') = ${operationId}`)).get();
    }
    if (input.messageId === undefined) {
      return undefined;
    }

    return this._db
      .select()
      .from(timelineEvents)
      .where(
        and(
          eq(timelineEvents.task_id, input.taskId),
          eq(timelineEvents.message_id, input.messageId),
          eq(timelineEvents.type, input.type),
        ),
      )
      .get();
  }

  private _nextTimestamp(): number {
    const latestPersisted = this._db
      .select({ createdAt: timelineEvents.created_at })
      .from(timelineEvents)
      .orderBy(desc(timelineEvents.created_at))
      .limit(1)
      .get();
    const now = Date.now();
    this._lastTimestamp = Math.max(
      now,
      this._lastTimestamp + 1,
      (latestPersisted?.createdAt ?? 0) + 1,
    );
    return this._lastTimestamp;
  }
}
