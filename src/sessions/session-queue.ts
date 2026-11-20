import { InvocationStore } from "@/runners/invocation-store";
import { decodeInvocation } from "@/runners/invocation-codec";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { sessionDispatcherFor } from "./session-dispatcher";
import { sessionConfigForSession } from "@/agents/agent-settings-store";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  messages,
  sessionInbox,
  sessionTurnEntries,
  sessionTurns,
} from "@/data/schema";
import { uuid, type SessionConfig } from "@/shared";

import {
  SessionInboxStore,
  type SessionInboxRow,
} from "./session-inbox-store";
import {
  SessionTurnStore,
  type SessionTurnView,
} from "./session-turn-store";
import type { MessageRow } from "./message-store";
import type {
  MessageContentBlock,
  MessageContentKind,
  MessagePresentationKind,
  SessionMessageKind,
  SessionMessageRole,
} from "./types";

export interface SessionTurnExecutionInput {
  readonly turn: SessionTurnView;
  readonly inboxRows: readonly SessionInboxRow[];
  readonly messageRows: readonly MessageRow[];
}

export interface SessionQueueOptions {
  readonly db: DrizzleDB;
  readonly config: SessionConfig;
  readonly executeTurn: (input: SessionTurnExecutionInput, signal: AbortSignal) => Promise<void>;
}

interface BatchOptions {
  readonly enforceIdleGap: boolean;
  readonly waitForIdle: boolean;
  /**
   * The rows queued while the previous turn ran. They all waited, so the time between
   * them does not separate them: the max-wait window applies only to an idle session.
   */
  readonly backlog?: boolean;
}

export class SessionQueue {
  private readonly _inboxStore: SessionInboxStore;
  private readonly _turnStore: SessionTurnStore;
  private readonly _activeWorkers = new Map<string, Promise<void>>();
  private readonly _reschedule = new Set<string>();
  private readonly _abortControllers = new Map<string, AbortController>();
  private readonly _requeueAbortedRows = new Set<string>();
  private readonly _workerErrors: unknown[] = [];
  private readonly _resumeTurns = new Map<string, SessionTurnView[]>();
  private _stopped = false;

  constructor(private readonly _options: SessionQueueOptions) {
    this._inboxStore = new SessionInboxStore(_options.db);
    this._turnStore = new SessionTurnStore(_options.db);
  }

  schedule(sessionId: string): void {
    if (this._stopped) {
      return;
    }
    if (this._activeWorkers.has(sessionId)) {
      this._reschedule.add(sessionId);
      return;
    }

    const worker = this._runSessionWorker(sessionId)
      .catch((error) => {
        this._workerErrors.push(error);
      })
      .finally(() => {
        this._activeWorkers.delete(sessionId);
        if (!this._stopped && this._reschedule.delete(sessionId)) {
          this.schedule(sessionId);
        }
      });
    this._activeWorkers.set(sessionId, worker);
  }

  abort(
    sessionId: string,
    options: { readonly requeueActiveRows?: boolean } = {},
  ): void {
    const controller = this._abortControllers.get(sessionId);
    if (!controller) {
      return;
    }
    if (options.requeueActiveRows === true) {
      this._requeueAbortedRows.add(sessionId);
    }
    controller.abort();
  }

  async recoverPending(): Promise<void> {
    const protectedTurns = new Set<string>();
    for (const invocation of new InvocationStore(this._options.db).pending()) {
      const snapshot = decodeInvocation(invocation.inputSnapshot);
      const turnId = snapshot.kind === "task" ? undefined : snapshot.input.turnId;
      if (!turnId) continue;
      protectedTurns.add(turnId);
      if (invocation.state !== "active") continue;
      const turn = this._turnStore.getById(turnId);
      const claimed = this._claimedRows(turnId);
      if (turn?.status !== "running" || !claimed.length) continue;
      const pending = this._resumeTurns.get(turn.sessionId) ?? [];
      if (!pending.some(item => item.id === turn.id)) pending.push(turn);
      this._resumeTurns.set(turn.sessionId, pending);
    }
    const olderThan = Date.now() - this._options.config.stale_claim_ms;
    const staleRows = this._readStaleClaimRows(olderThan);
    const turnIdsByInboxId = new Map(
      staleRows
        .filter((row) => row.turn_id !== null)
        .map((row) => [row.id, row.turn_id as string]),
    );
    const recoveredRows = this._inboxStore.recoverStaleClaims({ olderThan, excludeTurnIds: [...protectedTurns] });
    const recoveredTurnIds = new Set<string>();
    for (const row of recoveredRows) {
      const turnId = turnIdsByInboxId.get(row.id);
      if (turnId) {
        recoveredTurnIds.add(turnId);
      }
    }
    for (const turnId of recoveredTurnIds) {
      const turn = this._turnStore.getById(turnId);
      if (turn?.status === "running") {
        this._turnStore.markFailed(
          turnId,
          "Runtime recovered an interrupted session turn.",
        );
      }
    }
    this._recoverUnclaimedRunningTurns(protectedTurns);
    for (const sessionId of this._resumeTurns.keys()) this.schedule(sessionId);
    for (const sessionId of this._inboxStore.listSessionsWithPending()) {
      this.schedule(sessionId);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this._activeWorkers.size > 0) {
      await Promise.allSettled([...this._activeWorkers.values()]);
    }
    this._throwWorkerErrorsIfAny();
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._reschedule.clear();
    await this.waitForIdle();
  }

  private _throwWorkerErrorsIfAny(): void {
    if (this._workerErrors.length === 0) {
      return;
    }
    const errors = this._workerErrors.splice(0);
    throw new AggregateError(errors, "Session queue worker failed.");
  }

  private async _runSessionWorker(sessionId: string): Promise<void> {
    let isInitialWorkerPass = true;
    while (!this._stopped) {
      const resume = this._resumeTurns.get(sessionId)?.shift();
      if (resume) {
        await sessionDispatcherFor(this._options.db).dispatch({ kind: "user_messages", sessionId }, () => this._executeClaimedTurn(resume, this._claimedRows(resume.id)));
        continue;
      }
      const pendingRows = this._inboxStore.listPendingForSession(sessionId);
      if (pendingRows.length === 0) {
        return;
      }
      await sessionDispatcherFor(this._options.db).dispatch({ kind: "user_messages", sessionId }, () => this._executeNextBatch(sessionId, {
        enforceIdleGap: isInitialWorkerPass,
        waitForIdle: isInitialWorkerPass && pendingRows.length === 1,
        backlog: !isInitialWorkerPass,
      }));
      isInitialWorkerPass = false;
    }
  }

  private async _executeNextBatch(
    sessionId: string,
    options: BatchOptions,
  ): Promise<void> {
    const inboxRows = await this._selectBatch(sessionId, options);
    if (inboxRows.length === 0) {
      return;
    }

    const turnId = uuid();
    const claimedRows = this._inboxStore.claimBatch({
      turnId,
      inboxIds: inboxRows.map((row) => row.id),
    });
    if (claimedRows.length !== inboxRows.length) {
      this._releaseClaimedRows(turnId, claimedRows.map((row) => row.id));
      return;
    }

    const turn = this._turnStore.createExecutionTurn({
      id: turnId,
      sessionId,
      triggerEntryId: claimedRows[0]!.entry_id,
      reason: "addressed",
    });
    this._turnStore.attachEntries(
      turn.id,
      claimedRows.slice(1).map((row) => ({
        entryId: row.entry_id,
        role: "coalesced_input",
      })),
    );

    await this._executeClaimedTurn(turn, claimedRows);
  }

  private _claimedRows(turnId: string): SessionInboxRow[] {
    return this._options.db.select().from(sessionInbox).where(and(eq(sessionInbox.turn_id, turnId), eq(sessionInbox.status, "claimed")))
      .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id)).all();
  }

  private async _executeClaimedTurn(turn: SessionTurnView, claimedRows: SessionInboxRow[]): Promise<void> {
    const sessionId = turn.sessionId;
    const messageRows = this._readMessageRows(claimedRows.map(row => row.message_id));
    const controller = new AbortController();
    this._abortControllers.set(sessionId, controller);
    try {
      await this._options.executeTurn(
        { turn, inboxRows: claimedRows, messageRows },
        controller.signal,
      );
      if (controller.signal.aborted && this._requeueAbortedRows.delete(sessionId)) {
        this._settleTurn(turn, () => {
          this._turnStore.markFailed(turn.id, "Session turn interrupted by #steer.");
          this._releaseClaimedRows(turn.id, claimedRows.map((row) => row.id));
        });
        return;
      }
      this._settleTurn(turn, () => {
        this._turnStore.markCompleted(turn.id);
        this._inboxStore.markCompleted({
        turnId: turn.id,
        inboxIds: claimedRows.map((row) => row.id),
        });
      });
    } catch (error) {
      if (error instanceof RuntimeDetachedError) { this._stopped = true; return; }
      if (controller.signal.aborted && this._requeueAbortedRows.delete(sessionId)) {
        this._settleTurn(turn, () => {
          this._turnStore.markFailed(turn.id, "Session turn interrupted by #steer.");
          this._releaseClaimedRows(turn.id, claimedRows.map((row) => row.id));
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this._settleTurn(turn, () => {
        this._turnStore.markFailed(turn.id, message);
        this._inboxStore.markFailed({
        turnId: turn.id,
        inboxIds: claimedRows.map((row) => row.id),
        error: message,
        });
      });
    } finally {
      this._abortControllers.delete(sessionId);
    }
  }

  private _settleTurn(turn: SessionTurnView, complete: () => void): void {
    new InvocationStore(this._options.db).finishOrigin({ originId: turn.id, sessionId: turn.sessionId }, complete);
  }

  private async _selectBatch(
    sessionId: string,
    options: BatchOptions,
  ): Promise<SessionInboxRow[]> {
    const firstRows = this._inboxStore.listPendingForSession(sessionId);
    const firstRow = firstRows[0];
    if (!firstRow) {
      return [];
    }

    // The session's Agent may set its own batching; it is read per turn so a change applies to the next one.
    const config = sessionConfigForSession(this._options.db, sessionId, this._options.config);
    const selected = [firstRow];
    const selectedIds = new Set([firstRow.id]);
    const senderIdentityId = firstRow.sender_identity_id;
    const maxWaitDeadline = firstRow.received_at +
      config.coalesce_max_wait_ms;
    let lastSelectedRow = firstRow;

    while (selected.length < config.max_batch_size) {
      const nextRow = this._findNextPendingRow(sessionId, selectedIds);
      if (nextRow) {
        if (nextRow.sender_identity_id !== senderIdentityId) {
          break;
        }
        if (!options.backlog && nextRow.received_at > maxWaitDeadline) {
          break;
        }
        if (
          options.enforceIdleGap &&
          nextRow.received_at >
            lastSelectedRow.received_at + config.coalesce_idle_ms
        ) {
          break;
        }
        selected.push(nextRow);
        selectedIds.add(nextRow.id);
        lastSelectedRow = nextRow;
        continue;
      }

      if (!options.waitForIdle) {
        break;
      }
      const waitDeadline = Math.min(
        maxWaitDeadline,
        lastSelectedRow.received_at + config.coalesce_idle_ms,
      );
      const remainingMs = waitDeadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await _sleep(remainingMs);
      if (!this._findNextPendingRow(sessionId, selectedIds)) {
        break;
      }
    }

    return selected;
  }

  private _findNextPendingRow(
    sessionId: string,
    selectedIds: ReadonlySet<string>,
  ): SessionInboxRow | undefined {
    for (const row of this._inboxStore.listPendingForSession(sessionId)) {
      if (!selectedIds.has(row.id)) {
        return row;
      }
    }
    return undefined;
  }

  private _readMessageRows(messageIds: readonly string[]): MessageRow[] {
    if (messageIds.length === 0) {
      return [];
    }
    const rows = this._options.db
      .select()
      .from(messages)
      .where(inArray(messages.id, [...messageIds]))
      .orderBy(asc(messages.occurredAt), asc(messages.id))
      .all();
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return messageIds.map((messageId) => {
      const row = rowsById.get(messageId);
      if (!row) {
        throw new Error(`Message "${messageId}" was not found.`);
      }
      const senderUserId = row.senderUserId;
      const role = asRole(row.role);
      const messageKind = defaultMessageKind(role);
      const contentJson = asMessageContentBlocks(row.contentJson);
      return {
        id: row.id,
        sessionId: "",
        channelType: row.channelType,
        channelId: row.channelId,
        externalMessageId: row.externalMessageId,
        channelMessageKey: row.externalMessageId,
        senderIdentityId: row.senderIdentityId,
        senderUserId,
        role,
        messageKind,
        contentKind: asContentKind(row.contentKind),
        presentationKind: asPresentationKind(row.presentationKind),
        providerMessageType: row.providerMessageType,
        contentJson,
        rawPayloadJson: row.rawPayloadJson,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
        session_id: "",
        channel_message_key: row.externalMessageId,
        sender_user_id: senderUserId,
        message_kind: messageKind,
        content_json: contentJson,
        raw_payload_json: row.rawPayloadJson,
        created_at: row.occurredAt,
      } satisfies MessageRow;
    });
  }

  private _readStaleClaimRows(olderThan: number): SessionInboxRow[] {
    return this._options.db
      .select()
      .from(sessionInbox)
      .where(
        and(
          eq(sessionInbox.status, "claimed"),
          lt(sessionInbox.claimed_at, olderThan),
        ),
      )
      .orderBy(asc(sessionInbox.received_at), asc(sessionInbox.id))
      .all();
  }

  private _recoverUnclaimedRunningTurns(protectedTurns: ReadonlySet<string>): void {
    const runningTurns = this._options.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.status, "running"))
      .orderBy(asc(sessionTurns.started_at), asc(sessionTurns.id))
      .all();

    for (const turn of runningTurns) {
      if (protectedTurns.has(turn.id)) continue;
      const entryIds = this._options.db
        .select({ entryId: sessionTurnEntries.entry_id })
        .from(sessionTurnEntries)
        .where(eq(sessionTurnEntries.turn_id, turn.id))
        .all()
        .map((row) => row.entryId);
      if (entryIds.length === 0) {
        continue;
      }
      const inboxRows = this._options.db
        .select()
        .from(sessionInbox)
        .where(inArray(sessionInbox.entry_id, entryIds))
        .all();
      if (
        inboxRows.length === entryIds.length &&
        inboxRows.every(
          (row) => row.status === "pending" && row.turn_id === null,
        )
      ) {
        this._turnStore.markFailed(
          turn.id,
          "Runtime recovered an unclaimed session turn.",
        );
      }
    }
  }

  private _releaseClaimedRows(
    turnId: string,
    inboxIds: readonly string[],
  ): void {
    if (inboxIds.length === 0) {
      return;
    }

    this._options.db
      .update(sessionInbox)
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
          inArray(sessionInbox.id, [...inboxIds]),
          eq(sessionInbox.status, "claimed"),
          eq(sessionInbox.turn_id, turnId),
        ),
      )
      .run();
  }
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultMessageKind(role: SessionMessageRole): SessionMessageKind {
  return role === "user" ? "user_message" : "assistant_message";
}

function asMessageContentBlocks(value: unknown): readonly MessageContentBlock[] {
  return Array.isArray(value) ? (value as MessageContentBlock[]) : [];
}

function asRole(value: string): SessionMessageRole {
  return value === "assistant" ? "assistant" : "user";
}

function asContentKind(value: string): MessageContentKind {
  switch (value) {
    case "text":
    case "rich_text":
    case "image":
    case "file":
    case "mixed":
    case "card":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function asPresentationKind(value: string): MessagePresentationKind {
  switch (value) {
    case "plain":
    case "rich_markdown":
    case "image_gallery":
    case "file_attachment":
    case "status_card":
    case "task_result_card":
    case "provider_rich_card":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}
