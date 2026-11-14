import { and, asc, eq, inArray, lt } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { sessionInbox, sessionTimelineEntries } from "@/data/schema";
import { uuid } from "@/shared";

import type { MessageRow } from "./message-store";

export type SessionInboxStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "failed";
export type SessionInboxRow = typeof sessionInbox.$inferSelect;

export interface EnqueueInboxResult {
  readonly row: SessionInboxRow;
  readonly created: boolean;
  readonly requeued: boolean;
}

export class SessionInboxStore {
  constructor(private readonly _db: DrizzleDB) {}

  enqueueOnce(input: {
    readonly sessionId: string;
    readonly entryId?: string;
    readonly message: MessageRow;
  }): EnqueueInboxResult {
    const entryId = input.entryId ?? this._findMessageEntryId(input);
    const existing = this._findByEntryId(entryId);
    if (existing) {
      if (existing.status === "failed") {
        const now = Date.now();
        this._db
          .update(sessionInbox)
          .set({
            status: "pending",
            turn_id: null,
            claimed_at: null,
            completed_at: null,
            error: null,
            updated_at: now,
          })
          .where(
            and(
              eq(sessionInbox.id, existing.id),
              eq(sessionInbox.status, "failed"),
            ),
          )
          .run();
        const row = this._findByEntryId(entryId);
        if (row) {
          return { row, created: false, requeued: true };
        }
      }
      return { row: existing, created: false, requeued: false };
    }

    const now = Date.now();
    const row = {
      id: uuid(),
      session_id: input.sessionId,
      entry_id: entryId,
      message_id: input.message.id,
      sender_identity_id: input.message.senderIdentityId ?? null,
      received_at: input.message.created_at,
      status: "pending",
      turn_id: null,
      claimed_at: null,
      completed_at: null,
      error: null,
      created_at: now,
      updated_at: now,
    } satisfies SessionInboxRow;

    this._db.insert(sessionInbox).values(row).run();
    return { row, created: true, requeued: false };
  }

  listPendingForSession(sessionId: string): SessionInboxRow[] {
    return this._db
      .select()
      .from(sessionInbox)
      .where(
        and(
          eq(sessionInbox.session_id, sessionId),
          eq(sessionInbox.status, "pending"),
        ),
      )
      .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
      .all();
  }

  claimBatch(input: {
    readonly turnId: string;
    readonly inboxIds: readonly string[];
  }): SessionInboxRow[] {
    if (input.inboxIds.length === 0) {
      return [];
    }

    return this._db.transaction((tx) => {
      const pendingRows = tx
        .select()
        .from(sessionInbox)
        .where(
          and(
            inArray(sessionInbox.id, [...input.inboxIds]),
            eq(sessionInbox.status, "pending"),
          ),
        )
        .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
        .all();
      if (pendingRows.length === 0) {
        return [];
      }

      const now = Date.now();
      const ids = pendingRows.map((row) => row.id);
      tx.update(sessionInbox)
        .set({
          status: "claimed",
          turn_id: input.turnId,
          claimed_at: now,
          completed_at: null,
          error: null,
          updated_at: now,
        })
        .where(
          and(
            inArray(sessionInbox.id, ids),
            eq(sessionInbox.status, "pending"),
          ),
        )
        .run();
      return _readClaimedRowsByIds(tx as unknown as DrizzleDB, input.turnId, ids);
    }) as SessionInboxRow[];
  }

  markCompleted(input: {
    readonly turnId: string;
    readonly inboxIds: readonly string[];
  }): SessionInboxRow[] {
    if (input.inboxIds.length === 0) {
      return [];
    }

    return this._markTerminal(input, {
      status: "completed",
      error: null,
    });
  }

  markFailed(input: {
    readonly turnId: string;
    readonly inboxIds: readonly string[];
    readonly error: string;
  }): SessionInboxRow[] {
    if (input.inboxIds.length === 0) {
      return [];
    }

    return this._markTerminal(input, {
      status: "failed",
      error: input.error,
    });
  }

  recoverStaleClaims(input: { readonly olderThan: number; readonly excludeTurnIds?: readonly string[] }): SessionInboxRow[] {
    return this._db.transaction((tx) => {
      const staleRows = tx
        .select()
        .from(sessionInbox)
        .where(
          and(
            eq(sessionInbox.status, "claimed"),
            lt(sessionInbox.claimed_at, input.olderThan),
          ),
        )
        .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
        .all();
      const recoverableRows = staleRows.filter(row => !row.turn_id || !input.excludeTurnIds?.includes(row.turn_id));
      if (recoverableRows.length === 0) {
        return [];
      }

      const ids = recoverableRows.map((row) => row.id);
      tx.update(sessionInbox)
        .set({
          status: "pending",
          turn_id: null,
          claimed_at: null,
          completed_at: null,
          error: null,
          updated_at: Date.now(),
        })
        .where(
          and(
            inArray(sessionInbox.id, ids),
            eq(sessionInbox.status, "claimed"),
          ),
        )
        .run();
      return _readPendingRowsByIds(tx as unknown as DrizzleDB, ids);
    }) as SessionInboxRow[];
  }

  listSessionsWithPending(): string[] {
    const rows = this._db
      .select({ sessionId: sessionInbox.session_id })
      .from(sessionInbox)
      .where(eq(sessionInbox.status, "pending"))
      .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
      .all();

    const sessionIds: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.sessionId)) {
        continue;
      }
      seen.add(row.sessionId);
      sessionIds.push(row.sessionId);
    }
    return sessionIds;
  }

  private _markTerminal(
    input: { readonly turnId: string; readonly inboxIds: readonly string[] },
    terminal: { readonly status: "completed" | "failed"; readonly error: string | null },
  ): SessionInboxRow[] {
    return this._db.transaction((tx) => {
      const claimedRows = tx
        .select()
        .from(sessionInbox)
        .where(
          and(
            inArray(sessionInbox.id, [...input.inboxIds]),
            eq(sessionInbox.status, "claimed"),
            eq(sessionInbox.turn_id, input.turnId),
          ),
        )
        .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
        .all();
      if (claimedRows.length === 0) {
        return [];
      }

      const now = Date.now();
      const ids = claimedRows.map((row) => row.id);
      tx.update(sessionInbox)
        .set({
          status: terminal.status,
          completed_at: now,
          error: terminal.error,
          updated_at: now,
        })
        .where(
          and(
            inArray(sessionInbox.id, ids),
            eq(sessionInbox.status, "claimed"),
            eq(sessionInbox.turn_id, input.turnId),
          ),
        )
        .run();
      return _readTerminalRowsByIds(
        tx as unknown as DrizzleDB,
        input.turnId,
        ids,
        terminal.status,
      );
    }) as SessionInboxRow[];
  }

  private _findMessageEntryId(input: {
    readonly sessionId: string;
    readonly message: MessageRow;
  }): string {
    const row = this._db
      .select({
        id: sessionTimelineEntries.id,
        entryKind: sessionTimelineEntries.entryKind,
      })
      .from(sessionTimelineEntries)
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(sessionTimelineEntries.messageId, input.message.id),
        ),
      )
      .orderBy(asc(sessionTimelineEntries.entryKind))
      .get();
    if (row === undefined) {
      throw new Error(
        `Timeline entry for session "${input.sessionId}" and message "${input.message.id}" was not found.`,
      );
    }
    return row.id;
  }

  private _findByEntryId(entryId: string): SessionInboxRow | undefined {
    return this._db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.entry_id, entryId))
      .get();
  }
}

function _readClaimedRowsByIds(
  db: DrizzleDB,
  turnId: string,
  ids: readonly string[],
): SessionInboxRow[] {
  return _readRowsByIds(db, ids, [
    eq(sessionInbox.status, "claimed"),
    eq(sessionInbox.turn_id, turnId),
  ]);
}

function _readPendingRowsByIds(
  db: DrizzleDB,
  ids: readonly string[],
): SessionInboxRow[] {
  return _readRowsByIds(db, ids, [eq(sessionInbox.status, "pending")]);
}

function _readTerminalRowsByIds(
  db: DrizzleDB,
  turnId: string,
  ids: readonly string[],
  status: "completed" | "failed",
): SessionInboxRow[] {
  return _readRowsByIds(db, ids, [
    eq(sessionInbox.status, status),
    eq(sessionInbox.turn_id, turnId),
  ]);
}

function _readRowsByIds(
  db: DrizzleDB,
  ids: readonly string[],
  extraPredicates: ReturnType<typeof eq>[],
): SessionInboxRow[] {
  if (ids.length === 0) {
    return [];
  }
  return db
    .select()
    .from(sessionInbox)
    .where(and(inArray(sessionInbox.id, [...ids]), ...extraPredicates))
    .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
    .all();
}
