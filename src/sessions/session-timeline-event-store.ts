import { and, asc, desc, eq, lt } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { sessionTimelineEvents } from "@/data/schema";
import { uuid } from "@/shared";

export type SessionConversationControlEventType = "conversation_control";
export type SessionConversationControlKind =
  | "followup_interrupted"
  | "outbound_throttled"
  | "outbound_deferred";
export type SessionConversationControlReasonKind =
  | "focus_shifted"
  | "duplicate_content"
  | "session_hourly_limit"
  | "recipient_daily_limit"
  | "quiet_hours";

export type SessionTimelineEventRow =
  typeof sessionTimelineEvents.$inferSelect;

let lastSessionTimelineEventCreatedAt = 0;

export class SessionTimelineEventStore {
  constructor(private readonly _db: DrizzleDB) {}

  appendConversationControl(input: {
    readonly sessionId: string;
    readonly eventType: SessionConversationControlEventType;
    readonly controlKind: SessionConversationControlKind;
    readonly reasonKind: SessionConversationControlReasonKind;
    readonly sourceMessageId: string;
    readonly anchorMessageId: string;
    readonly sessionSourceMessageId: string;
    readonly turnId: string;
    readonly summary: string;
    readonly payloadJson?: Record<string, unknown>;
  }): SessionTimelineEventRow {
    const existing = this._findExistingConversationControl(input);
    if (existing !== undefined) {
      return existing;
    }

    const createdAt = nextSessionTimelineEventCreatedAt(this._db);
    const id = uuid();
    const row: typeof sessionTimelineEvents.$inferInsert = {
      id,
      sessionId: input.sessionId,
      entryId: id,
      eventType: input.eventType,
      controlKind: input.controlKind,
      reasonKind: input.reasonKind,
      sourceMessageId: input.sourceMessageId,
      anchorMessageId: input.anchorMessageId,
      sessionSourceMessageId: input.sessionSourceMessageId,
      turnId: input.turnId,
      summary: input.summary,
      payloadJson: input.payloadJson ?? null,
      createdAt,
    };

    this._db
      .insert(sessionTimelineEvents)
      .values(row)
      .onConflictDoNothing({
        target: [
          sessionTimelineEvents.sessionId,
          sessionTimelineEvents.sourceMessageId,
          sessionTimelineEvents.controlKind,
          sessionTimelineEvents.reasonKind,
        ],
      })
      .run();

    return this._findExistingConversationControl(input) ?? {
      ...row,
      payloadJson: row.payloadJson ?? null,
    };
  }

  listForSession(sessionId: string): SessionTimelineEventRow[] {
    return this._db
      .select()
      .from(sessionTimelineEvents)
      .where(eq(sessionTimelineEvents.sessionId, sessionId))
      .orderBy(
        asc(sessionTimelineEvents.createdAt),
        asc(sessionTimelineEvents.id),
      )
      .all();
  }

  hasFollowupInterruptedSinceAnchor(input: {
    readonly sessionId: string;
    readonly anchorMessageId: string;
    readonly beforeCreatedAt: number;
  }): boolean {
    return this._db
      .select({ id: sessionTimelineEvents.id })
      .from(sessionTimelineEvents)
      .where(
        and(
          eq(sessionTimelineEvents.sessionId, input.sessionId),
          eq(sessionTimelineEvents.eventType, "conversation_control"),
          eq(sessionTimelineEvents.controlKind, "followup_interrupted"),
          eq(sessionTimelineEvents.reasonKind, "focus_shifted"),
          eq(sessionTimelineEvents.anchorMessageId, input.anchorMessageId),
          lt(sessionTimelineEvents.createdAt, input.beforeCreatedAt),
        ),
      )
      .orderBy(
        desc(sessionTimelineEvents.createdAt),
        desc(sessionTimelineEvents.id),
      )
      .get() !== undefined;
  }

  private _findExistingConversationControl(input: {
    readonly sessionId: string;
    readonly controlKind: SessionConversationControlKind;
    readonly reasonKind: SessionConversationControlReasonKind;
    readonly sourceMessageId: string;
  }): SessionTimelineEventRow | undefined {
    return this._db
      .select()
      .from(sessionTimelineEvents)
      .where(
        and(
          eq(sessionTimelineEvents.sessionId, input.sessionId),
          eq(sessionTimelineEvents.sourceMessageId, input.sourceMessageId),
          eq(sessionTimelineEvents.controlKind, input.controlKind),
          eq(sessionTimelineEvents.reasonKind, input.reasonKind),
        ),
      )
      .get();
  }
}

function nextSessionTimelineEventCreatedAt(db: DrizzleDB): number {
  const latestPersisted = db
    .select({ createdAt: sessionTimelineEvents.createdAt })
    .from(sessionTimelineEvents)
    .orderBy(desc(sessionTimelineEvents.createdAt))
    .limit(1)
    .get();
  const now = Date.now();
  lastSessionTimelineEventCreatedAt = Math.max(
    now,
    lastSessionTimelineEventCreatedAt + 1,
    (latestPersisted?.createdAt ?? 0) + 1,
  );
  return lastSessionTimelineEventCreatedAt;
}
