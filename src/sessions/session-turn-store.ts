import { and, asc, desc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  sessionInbox,
  sessionTimelineEntries,
  sessionTurnEntries,
  sessionTurns,
} from "@/data/schema";
import { uuid } from "@/shared";

import type { SessionInboxRow } from "./session-inbox-store";
import type { MessageRow } from "./message-store";

export type SessionTurnKind = "execution" | "skip";
export type SessionTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped";
export type SessionTurnEntryRole =
  | "trigger"
  | "coalesced_input"
  | "context"
  | "launch_context"
  | "output"
  | "skipped";

type SessionTurnRow = typeof sessionTurns.$inferSelect;
type SessionTurnTerminalStatus = Extract<SessionTurnStatus, "completed" | "failed">;

let lastTurnEntryCreatedAt = 0;

export interface SessionTurnEntryView {
  readonly id: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly role: SessionTurnEntryRole;
  readonly createdAt: number;
}

export interface SessionTurnView {
  readonly id: string;
  readonly sessionId: string;
  readonly turnKind: SessionTurnKind;
  readonly status: SessionTurnStatus;
  readonly runnerInvoked: boolean;
  readonly reason: string;
  readonly materializedPrompt: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;

  // Derived projections for callers that need message-level summaries.
  readonly messageIds: readonly string[];
  readonly inboxIds: readonly string[];
  readonly latestMessageId: string | null;
  readonly latestChannelMessageId: string | null;
  readonly senderUserId: string | null;
}

export class SessionTurnTransitionError extends Error {
  constructor(
    readonly id: string,
    readonly currentStatus: SessionTurnStatus | "missing",
    readonly targetStatus: SessionTurnTerminalStatus,
  ) {
    super(
      currentStatus === "missing"
        ? `Session Turn "${id}" was not found.`
        : `Session Turn "${id}" cannot transition from ${currentStatus} to ${targetStatus}.`,
    );
    this.name = "SessionTurnTransitionError";
  }
}

export class SessionTurnStore {
  constructor(private readonly _db: DrizzleDB) {}

  createExecutionTurn(input: {
    readonly id?: string;
    readonly sessionId: string;
    readonly triggerEntryId: string;
    readonly reason: string;
  }): SessionTurnView {
    const now = Date.now();
    const row = {
      id: input.id ?? uuid(),
      session_id: input.sessionId,
      turn_kind: "execution",
      status: "running",
      runner_invoked: true,
      reason: input.reason,
      materialized_prompt: null,
      started_at: now,
      completed_at: null,
      error: null,
      created_at: now,
      updated_at: now,
    } satisfies typeof sessionTurns.$inferInsert;

    this._db.insert(sessionTurns).values(row).run();
    this.attachEntries(row.id, [
      { entryId: input.triggerEntryId, role: "trigger" },
    ]);
    return this._toSessionTurnView(row as SessionTurnRow);
  }

  createSkipTurn(input: {
    readonly id?: string;
    readonly sessionId: string;
    readonly entryId: string;
    readonly reason: string;
  }): SessionTurnView {
    const existing = this._findTurnByEntryRole(input.entryId, "skipped");
    if (existing !== undefined) {
      return existing;
    }
    const now = Date.now();
    const row = {
      id: input.id ?? uuid(),
      session_id: input.sessionId,
      turn_kind: "skip",
      status: "skipped",
      runner_invoked: false,
      reason: input.reason,
      materialized_prompt: null,
      started_at: now,
      completed_at: now,
      error: null,
      created_at: now,
      updated_at: now,
    } satisfies typeof sessionTurns.$inferInsert;

    this._db.insert(sessionTurns).values(row).run();
    this.attachEntries(row.id, [
      { entryId: input.entryId, role: "skipped" },
    ]);
    return this._toSessionTurnView(row as SessionTurnRow);
  }

  createRunningTurn(input: {
    readonly sessionId: string;
    readonly inboxRows: readonly SessionInboxRow[];
    readonly messageRows: readonly MessageRow[];
  }): SessionTurnView {
    if (input.inboxRows.length === 0) {
      throw new Error("Cannot create a session turn for an empty batch.");
    }
    const [firstInbox] = input.inboxRows;
    const turn = this.createExecutionTurn({
      sessionId: input.sessionId,
      triggerEntryId: firstInbox!.entry_id,
      reason: "addressed",
    });
    this.attachEntries(
      turn.id,
      input.inboxRows.slice(1).map((row) => ({
        entryId: row.entry_id,
        role: "coalesced_input" as const,
      })),
    );
    return this.getById(turn.id) ?? turn;
  }

  attachEntries(
    turnId: string,
    entries: readonly { readonly entryId: string; readonly role: SessionTurnEntryRole }[],
  ): void {
    if (entries.length === 0) {
      return;
    }
    const turn = this._requireTurn(turnId);
    for (const entry of entries) {
      const existing = this._db
        .select({ id: sessionTurnEntries.id })
        .from(sessionTurnEntries)
        .where(
          and(
            eq(sessionTurnEntries.turn_id, turnId),
            eq(sessionTurnEntries.entry_id, entry.entryId),
            eq(sessionTurnEntries.role, entry.role),
          ),
        )
        .get();
      if (existing !== undefined) {
        continue;
      }
      this._db
        .insert(sessionTurnEntries)
        .values({
          id: uuid(),
          turn_id: turnId,
          session_id: turn.session_id,
          entry_id: entry.entryId,
          role: entry.role,
          created_at: nextTurnEntryCreatedAt(),
        })
        .run();
    }
  }

  listEntries(turnId: string): SessionTurnEntryView[] {
    return this._db
      .select()
      .from(sessionTurnEntries)
      .where(eq(sessionTurnEntries.turn_id, turnId))
      .orderBy(asc(sessionTurnEntries.created_at), asc(sessionTurnEntries.id))
      .all()
      .map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        sessionId: row.session_id,
        entryId: row.entry_id,
        role: row.role as SessionTurnEntryRole,
        createdAt: row.created_at,
      }));
  }

  getById(id: string): SessionTurnView | undefined {
    const row = this._db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.id, id))
      .get();
    return row ? this._toSessionTurnView(row) : undefined;
  }

  markCompleted(id: string): SessionTurnView {
    return this._markTerminal(id, "completed", {
      error: null,
    });
  }

  recordMaterializedPrompt(
    id: string,
    materializedPrompt: string,
  ): SessionTurnView {
    const now = Date.now();
    this._db.update(sessionTurns)
      .set({
        materialized_prompt: materializedPrompt,
        updated_at: now,
      })
      .where(eq(sessionTurns.id, id))
      .run();
    const updated = this.getById(id);
    if (updated === undefined) {
      throw new SessionTurnTransitionError(id, "missing", "failed");
    }
    return updated;
  }

  markFailed(id: string, error: string): SessionTurnView {
    return this._markTerminal(id, "failed", {
      error,
    });
  }

  findCompletedTurnForMessage(
    messageId: string,
  ): SessionTurnView | undefined {
    const row = this._db
      .select({ turn: sessionTurns })
      .from(sessionTurns)
      .innerJoin(
        sessionTurnEntries,
        eq(sessionTurnEntries.turn_id, sessionTurns.id),
      )
      .innerJoin(
        sessionTimelineEntries,
        eq(sessionTimelineEntries.id, sessionTurnEntries.entry_id),
      )
      .where(
        and(
          eq(sessionTurns.status, "completed"),
          eq(sessionTimelineEntries.messageId, messageId),
        ),
      )
      .orderBy(desc(sessionTurns.completed_at), desc(sessionTurns.started_at))
      .limit(1)
      .get();
    return row ? this._toSessionTurnView(row.turn) : undefined;
  }

  private _markTerminal(
    id: string,
    targetStatus: SessionTurnTerminalStatus,
    input: { readonly error: string | null },
  ): SessionTurnView {
    return this._db.transaction((tx) => {
      const current = tx
        .select()
        .from(sessionTurns)
        .where(eq(sessionTurns.id, id))
        .get();
      if (!current) {
        throw new SessionTurnTransitionError(id, "missing", targetStatus);
      }

      const currentStatus = current.status as SessionTurnStatus;
      if (currentStatus === targetStatus) {
        return this._toSessionTurnView(current);
      }
      if (currentStatus !== "running") {
        throw new SessionTurnTransitionError(id, currentStatus, targetStatus);
      }

      const now = Date.now();
      tx.update(sessionTurns)
        .set({
          status: targetStatus,
          completed_at: now,
          error: targetStatus === "failed" ? input.error : null,
          updated_at: now,
        })
        .where(
          and(
            eq(sessionTurns.id, id),
            eq(sessionTurns.status, "running"),
          ),
        )
        .run();

      const updated = tx
        .select()
        .from(sessionTurns)
        .where(eq(sessionTurns.id, id))
        .get();
      if (!updated) {
        throw new SessionTurnTransitionError(id, "missing", targetStatus);
      }
      const updatedStatus = updated.status as SessionTurnStatus;
      if (updatedStatus !== targetStatus) {
        throw new SessionTurnTransitionError(id, updatedStatus, targetStatus);
      }
      return this._toSessionTurnView(updated);
    }) as SessionTurnView;
  }

  private _requireTurn(turnId: string): SessionTurnRow {
    const turn = this._db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.id, turnId))
      .get();
    if (turn === undefined) {
      throw new SessionTurnTransitionError(turnId, "missing", "failed");
    }
    return turn;
  }

  private _findTurnByEntryRole(
    entryId: string,
    role: SessionTurnEntryRole,
  ): SessionTurnView | undefined {
    const row = this._db
      .select({ turn: sessionTurns })
      .from(sessionTurns)
      .innerJoin(
        sessionTurnEntries,
        eq(sessionTurnEntries.turn_id, sessionTurns.id),
      )
      .where(
        and(
          eq(sessionTurnEntries.entry_id, entryId),
          eq(sessionTurnEntries.role, role),
        ),
      )
      .orderBy(desc(sessionTurns.created_at), desc(sessionTurns.id))
      .get();
    return row === undefined ? undefined : this._toSessionTurnView(row.turn);
  }

  private _toSessionTurnView(row: SessionTurnRow): SessionTurnView {
    const entries = this._db
      .select({ entry: sessionTurnEntries, timeline: sessionTimelineEntries })
      .from(sessionTurnEntries)
      .innerJoin(
        sessionTimelineEntries,
        eq(sessionTimelineEntries.id, sessionTurnEntries.entry_id),
      )
      .where(eq(sessionTurnEntries.turn_id, row.id))
      .orderBy(asc(sessionTurnEntries.created_at), asc(sessionTurnEntries.id))
      .all();
    const inboxRows = this._db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.turn_id, row.id))
      .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
      .all();
    const messageIds = entries.map((entry) => entry.timeline.messageId);
    const latestMessageId = messageIds.at(-1) ?? null;
    return {
      id: row.id,
      sessionId: row.session_id,
      turnKind: row.turn_kind as SessionTurnKind,
      status: row.status as SessionTurnStatus,
      runnerInvoked: row.runner_invoked,
      reason: row.reason,
      materializedPrompt: row.materialized_prompt,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageIds,
      inboxIds: inboxRows.map((inbox) => inbox.id),
      latestMessageId,
      latestChannelMessageId: null,
      senderUserId: null,
    };
  }
}

function nextTurnEntryCreatedAt(): number {
  const now = Date.now();
  const createdAt = Math.max(now, lastTurnEntryCreatedAt + 1);
  lastTurnEntryCreatedAt = createdAt;
  return createdAt;
}
