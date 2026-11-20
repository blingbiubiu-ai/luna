import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { SessionQueue } from "../../src/sessions/session-queue";
import { AgentSettingsStore } from "../../src/agents/agent-settings-store";
import { eq } from "drizzle-orm";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionTurnStore } from "../../src/sessions/session-turn-store";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { DataConnection } from "../../src/data";
import {
  sessionInbox,
  sessionTimelineEntries,
  sessionTurnEntries,
  sessions,
  sessionTurns,
} from "../../src/data/schema";
import * as lunaSchema from "../../src/data/schema";
import { type SessionConfig, setLunaHome } from "../../src/shared";
import { fixtureOwnerUserId, fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-turn-queue-test-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main");
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("session turn queue stores", () => {
  test("enqueueOnce creates one inbox row per timeline entry", () => {
    const session = createSession();
    const message = createUserMessage(session.id, {
      channelMessageKey: "message-queue-1",
      text: "please check this issue",
    });
    const entry = findMessageEntry(session.id, message.id);
    const inboxStore = new SessionInboxStore(database.db);

    const first = inboxStore.enqueueOnce({ sessionId: session.id, entryId: entry.id, message });
    const second = inboxStore.enqueueOnce({ sessionId: session.id, entryId: entry.id, message });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(first.row).toMatchObject({
      session_id: session.id,
      entry_id: entry.id,
      message_id: message.id,
      received_at: message.created_at,
      status: "pending",
      turn_id: null,
    });
    expect(inboxStore.listPendingForSession(session.id)).toEqual([
      first.row,
    ]);
  });

  test("append updates session activity timestamp", () => {
    const session = createSession();
    database.db
      .update(sessions)
      .set({ updated_at: 1 })
      .where(sql`${sessions.id} = ${session.id}`)
      .run();

    const message = createUserMessage(session.id, {
      channelMessageKey: "message-activity-refresh",
      text: "refresh activity",
    });

    const updated = database.db
      .select()
      .from(sessions)
      .where(sql`${sessions.id} = ${session.id}`)
      .get();

    expect(updated?.updated_at).toBe(message.created_at);
  });

  test("enqueueOnce requeues failed inbox rows for redelivery", () => {
    const session = createSession();
    const message = createUserMessage(session.id, {
      channelMessageKey: "message-redelivery-1",
      text: "retry this failed turn",
    });
    const inboxStore = new SessionInboxStore(database.db);
    const first = inboxStore.enqueueOnce({ sessionId: session.id, message });

    inboxStore.claimBatch({ turnId: "turn-redelivery-failed", inboxIds: [first.row.id] });
    inboxStore.markFailed({
      turnId: "turn-redelivery-failed",
      inboxIds: [first.row.id],
      error: "temporary failure",
    });

    const redelivery = inboxStore.enqueueOnce({
      sessionId: session.id,
      message,
    });

    expect(redelivery.created).toBe(false);
    expect(redelivery.row).toMatchObject({
      id: first.row.id,
      status: "pending",
      turn_id: null,
      error: null,
    });
    expect(inboxStore.listPendingForSession(session.id)).toMatchObject([
      { id: first.row.id, status: "pending" },
    ]);
  });

  test("claim only pending rows and completed rows cannot be reclaimed", () => {
    const { inboxStore, firstInbox, secondInbox } = createTwoMessageInbox();

    const claimed = inboxStore.claimBatch({
      turnId: "turn-claim-1",
      inboxIds: [firstInbox.id, secondInbox.id],
    });
    expect(new Set(claimed.map((row) => row.id))).toEqual(
      new Set([firstInbox.id, secondInbox.id]),
    );
    const completed = inboxStore.markCompleted({
      turnId: "turn-claim-1",
      inboxIds: [firstInbox.id],
    });
    expect(completed.map((row) => row.id)).toEqual([firstInbox.id]);

    const reclaimed = inboxStore.claimBatch({
      turnId: "turn-claim-2",
      inboxIds: [firstInbox.id, secondInbox.id],
    });

    expect(reclaimed).toHaveLength(0);
    const rows = database.db
      .select()
      .from(sessionInbox)
      .orderBy(sessionInbox.received_at, sessionInbox.id)
      .all();
    expect(rows.find((row) => row.id === firstInbox.id)).toMatchObject({
      status: "completed",
      turn_id: "turn-claim-1",
    });
    expect(rows.find((row) => row.id === secondInbox.id)).toMatchObject({
      status: "claimed",
      turn_id: "turn-claim-1",
    });
  });

  test("complete and fail require matching turn id for inbox rows", () => {
    const { inboxStore, firstInbox, secondInbox } = createTwoMessageInbox();
    inboxStore.claimBatch({
      turnId: "turn-inbox-1",
      inboxIds: [firstInbox.id, secondInbox.id],
    });

    expect(
      inboxStore.markCompleted({
        turnId: "wrong-turn",
        inboxIds: [firstInbox.id],
      }),
    ).toHaveLength(0);
    expect(
      inboxStore.markFailed({
        turnId: "wrong-turn",
        inboxIds: [secondInbox.id],
        error: "wrong turn",
      }),
    ).toHaveLength(0);

    const failed = inboxStore.markFailed({
      turnId: "turn-inbox-1",
      inboxIds: [secondInbox.id],
      error: "runner failed",
    });
    const completed = inboxStore.markCompleted({
      turnId: "turn-inbox-1",
      inboxIds: [firstInbox.id],
    });

    expect(failed).toMatchObject([
      { id: secondInbox.id, status: "failed", turn_id: "turn-inbox-1", error: "runner failed" },
    ]);
    expect(completed).toMatchObject([
      { id: firstInbox.id, status: "completed", turn_id: "turn-inbox-1", error: null },
    ]);
  });

  test("stale claim recovery resets old claimed rows", () => {
    const { inboxStore, firstInbox, secondInbox } = createTwoMessageInbox();
    inboxStore.claimBatch({
      turnId: "turn-stale",
      inboxIds: [firstInbox.id, secondInbox.id],
    });
    database.db.run(
      sql`UPDATE session_inbox SET claimed_at = 100 WHERE id = ${firstInbox.id}`,
    );
    database.db.run(
      sql`UPDATE session_inbox SET claimed_at = 300 WHERE id = ${secondInbox.id}`,
    );

    const recovered = inboxStore.recoverStaleClaims({ olderThan: 200 });

    expect(recovered).toMatchObject([
      {
        id: firstInbox.id,
        status: "pending",
        turn_id: null,
        claimed_at: null,
        completed_at: null,
        error: null,
      },
    ]);
    const rows = database.db
      .select()
      .from(sessionInbox)
      .orderBy(sessionInbox.received_at, sessionInbox.id)
      .all();
    expect(rows.find((row) => row.id === firstInbox.id)).toMatchObject({
      status: "pending",
      turn_id: null,
    });
    expect(rows.find((row) => row.id === secondInbox.id)).toMatchObject({
      status: "claimed",
      turn_id: "turn-stale",
    });
  });

  test("turn store creates immutable running turn and completes it", () => {
    const session = createSession();
    const message = createUserMessage(session.id, {
      channelMessageKey: "message-turn-1",
      text: "uid=123 failed playback",
    });
    const inboxStore = new SessionInboxStore(database.db);
    const inboxRow = inboxStore.enqueueOnce({
      sessionId: session.id,
      message,
    }).row;
    const turnStore = new SessionTurnStore(database.db);

    const runningTurn = turnStore.createRunningTurn({
      sessionId: session.id,
      inboxRows: [inboxRow],
      messageRows: [message],
    });
    const completedTurn = turnStore.markCompleted(runningTurn.id);

    expect(completedTurn).toMatchObject({
      id: runningTurn.id,
      sessionId: session.id,
      status: "completed",
      turnKind: "execution",
      runnerInvoked: true,
      messageIds: [message.id],
      latestMessageId: message.id,
      error: null,
    });
    expect(turnStore.listEntries(runningTurn.id).map((row) => row.role)).toEqual([
      "trigger",
    ]);
    expect(turnStore.getById(runningTurn.id)).toEqual(completedTurn);
  });

  test("turn terminal transitions are protected and idempotent", () => {
    const { turnStore, turn } = createRunningTurn("terminal");

    expect(() => turnStore.markCompleted("missing-turn")).toThrow(
      'Session Turn "missing-turn" was not found.',
    );

    const completed = turnStore.markCompleted(turn.id);
    const completedAgain = turnStore.markCompleted(turn.id);
    expect(completedAgain).toEqual(completed);
    expect(() => turnStore.markFailed(turn.id, "too late")).toThrow(
      'Session Turn "' + turn.id + '" cannot transition from completed to failed.',
    );

    const { turn: failedTurn } = createRunningTurn("failed-terminal");
    const failed = turnStore.markFailed(failedTurn.id, "runner failed");
    expect(turnStore.markFailed(failedTurn.id, "new error")).toEqual(failed);
    expect(() => turnStore.markCompleted(failedTurn.id)).toThrow(
      'Session Turn "' + failedTurn.id + '" cannot transition from failed to completed.',
    );
  });

  test("findCompletedTurnForMessage finds a multi-message turn", () => {
    const { turnStore, turn, messages } = createRunningTurn("multi-message", 2);
    turnStore.markCompleted(turn.id);

    const found = turnStore.findCompletedTurnForMessage(messages[1]!.id);

    expect(found).toMatchObject({
      id: turn.id,
      status: "completed",
      messageIds: [messages[0]!.id, messages[1]!.id],
    });
  });

  test("turn entries record trigger and coalesced inputs", () => {
    const { turnStore, turn } = createRunningTurn("turn-entries", 2);

    expect(turnStore.listEntries(turn.id).map((row) => row.role)).toEqual([
      "trigger",
      "coalesced_input",
    ]);
    expect(database.db.select().from(sessionTurnEntries).all()).toHaveLength(2);
  });
});

describe("SessionQueue", () => {
  test("batches same sender consecutive messages and stops at different sender", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-batch-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1,
    });
    const secondA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-batch-a-2",
      senderUserId: "user-a",
      text: "A2",
      receivedAt: 2,
    });
    const firstB = enqueueUserMessage(session.id, {
      channelMessageKey: "message-batch-b-1",
      senderUserId: "user-b",
      text: "B1",
      receivedAt: 3,
    });
    const thirdA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-batch-a-3",
      senderUserId: "user-a",
      text: "A3",
      receivedAt: 4,
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 1,
        max_batch_size: 8,
      }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
      },
    });

    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([
      [firstA.message.id, secondA.message.id],
      [firstB.message.id],
      [thirdA.message.id],
    ]);
  });

  test("batches by the session's Agent message settings, read when the turn starts", async () => {
    const session = createSession();
    const rows = [1, 2, 3].map(n => enqueueUserMessage(session.id, {
      channelMessageKey: `message-agent-batch-${n}`, senderUserId: "user-a", text: `A${n}`, receivedAt: n }));
    const owner = database.db.select().from(lunaSchema.lunaAgents).where(eq(lunaSchema.lunaAgents.id, session.agent_id)).get()!.ownerAccountId;
    new AgentSettingsStore(database.db).save(owner, session.agent_id, { messages: { maxBatchSize: 2 } });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({ coalesce_idle_ms: 1, max_batch_size: 8 }),
      executeTurn: async (input) => { batches.push(input.messageRows.map((message) => message.id)); },
    });
    queue.schedule(session.id);
    await queue.waitForIdle();
    expect(batches).toEqual([[rows[0]!.message.id, rows[1]!.message.id], [rows[2]!.message.id]]);
  });

  test("does not batch across max batch size", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-max-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1,
    });
    const secondA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-max-a-2",
      senderUserId: "user-a",
      text: "A2",
      receivedAt: 2,
    });
    const thirdA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-max-a-3",
      senderUserId: "user-a",
      text: "A3",
      receivedAt: 3,
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 1,
        max_batch_size: 2,
      }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
      },
    });

    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([
      [firstA.message.id, secondA.message.id],
      [thirdA.message.id],
    ]);
  });

  test("different sessions drain concurrently", async () => {
    const sessionA = createSession({ groupId: "group-concurrent-a" });
    const sessionB = createSession({ groupId: "group-concurrent-b" });
    enqueueUserMessage(sessionA.id, {
      channelMessageKey: "message-concurrent-a",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1,
    });
    enqueueUserMessage(sessionB.id, {
      channelMessageKey: "message-concurrent-b",
      senderUserId: "user-b",
      text: "B1",
      receivedAt: 1,
    });
    const started: string[] = [];
    const blockers = new Map<string, () => void>();
    const bothStarted = createDeferred<void>();
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({ coalesce_idle_ms: 1 }),
      executeTurn: async (input) => {
        started.push(input.turn.sessionId);
        if (started.length === 2) {
          bothStarted.resolve();
        }
        await new Promise<void>((resolve) => {
          blockers.set(input.turn.sessionId, resolve);
        });
      },
    });

    queue.schedule(sessionA.id);
    queue.schedule(sessionB.id);
    await bothStarted.promise;

    expect(new Set(started)).toEqual(new Set([sessionA.id, sessionB.id]));
    for (const release of blockers.values()) {
      release();
    }
    await queue.waitForIdle();
  });

  test("second message inside idle window batches", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-idle-inside-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1000,
    });
    const secondA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-idle-inside-a-2",
      senderUserId: "user-a",
      text: "A2",
      receivedAt: 1040,
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 50,
        coalesce_max_wait_ms: 1000,
      }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
      },
    });

    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([[firstA.message.id, secondA.message.id]]);
    const turn = database.db.select().from(sessionTurns).get();
    expect(turn).toBeDefined();
    expect(
      new SessionTurnStore(database.db)
        .listEntries(turn!.id)
        .map((entry) => entry.role),
    ).toEqual(["trigger", "coalesced_input"]);
  });

  test("pending messages after idle window split even within max wait window", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-idle-after-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1000,
    });
    const secondA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-idle-after-a-2",
      senderUserId: "user-a",
      text: "A2",
      receivedAt: 1051,
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 50,
        coalesce_max_wait_ms: 1000,
      }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
      },
    });

    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([[firstA.message.id], [secondA.message.id]]);
  });

  test("next queued head after active turn drains without waiting for later messages", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-active-head-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: Date.now(),
    });
    let secondA: ReturnType<typeof enqueueUserMessage> | undefined;
    let thirdA: ReturnType<typeof enqueueUserMessage> | undefined;
    const batches: string[][] = [];
    let queue!: SessionQueue;
    queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 10,
        coalesce_max_wait_ms: 80,
      }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
        if (input.messageRows[0]?.id !== firstA.message.id) {
          return;
        }
        secondA = enqueueUserMessage(session.id, {
          channelMessageKey: "message-active-head-a-2",
          senderUserId: "user-a",
          text: "A2",
          receivedAt: Date.now(),
        });
        queue.schedule(session.id);
        setTimeout(() => {
          thirdA = enqueueUserMessage(session.id, {
            channelMessageKey: "message-active-head-a-3",
            senderUserId: "user-a",
            text: "A3",
            receivedAt: Date.now(),
          });
          queue.schedule(session.id);
        }, 20);
      },
    });

    queue.schedule(session.id);
    await queue.waitForIdle();
    await sleep(100);
    await queue.waitForIdle();

    expect(secondA).toBeDefined();
    expect(thirdA).toBeDefined();
    expect(batches).toEqual([
      [firstA.message.id],
      [secondA!.message.id],
      [thirdA!.message.id],
    ]);
  });

  test("messages queued during a turn go together into the next one however far apart they arrived", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, { channelMessageKey: "backlog-a-1", senderUserId: "user-a", text: "A1", receivedAt: Date.now() });
    const queued: string[] = [];
    const batches: string[][] = [];
    let queue!: SessionQueue;
    queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({ coalesce_idle_ms: 10, coalesce_max_wait_ms: 30 }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
        if (input.messageRows[0]?.id !== firstA.message.id) return;
        // While A1 runs, user A sends two messages well apart, then user B writes.
        for (const [key, sender] of [["backlog-a-2", "user-a"], ["backlog-a-3", "user-a"], ["backlog-b-1", "user-b"]] as const) {
          queued.push(enqueueUserMessage(session.id, { channelMessageKey: key, senderUserId: sender, text: key, receivedAt: Date.now() }).message.id);
          queue.schedule(session.id);
          await sleep(60);
        }
      },
    });

    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([
      [firstA.message.id],
      [queued[0]!, queued[1]!],
      [queued[2]!],
    ]);
  });

  test("old head row does not wait another full max coalesce window", async () => {
    const session = createSession();
    const oldReceivedAt = Date.now() - 1000;
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-old-head-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: oldReceivedAt,
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 500,
        coalesce_max_wait_ms: 500,
      }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
      },
    });

    const startedAt = Date.now();
    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([[firstA.message.id]]);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test("recoverPending fails stale running turns and restores inbox rows", async () => {
    const session = createSession();
    const { inbox, message } = enqueueUserMessage(session.id, {
      channelMessageKey: "message-stale-recovery",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1,
    });
    const inboxStore = new SessionInboxStore(database.db);
    const turnStore = new SessionTurnStore(database.db);
    const staleTurn = turnStore.createRunningTurn({
      sessionId: session.id,
      inboxRows: [inbox],
      messageRows: [message],
    });
    inboxStore.claimBatch({ turnId: staleTurn.id, inboxIds: [inbox.id] });
    database.db.run(
      sql`UPDATE session_inbox SET claimed_at = 1 WHERE id = ${inbox.id}`,
    );
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({
        coalesce_idle_ms: 50,
        stale_claim_ms: 1,
      }),
      executeTurn: async () => {},
    });
    const scheduledSessionIds: string[] = [];
    queue.schedule = (sessionId) => {
      scheduledSessionIds.push(sessionId);
    };

    await queue.recoverPending();

    expect(turnStore.getById(staleTurn.id)).toMatchObject({
      id: staleTurn.id,
      status: "failed",
      error: "Runtime recovered an interrupted session turn.",
    });
    expect(readInboxRow(inbox.id)).toMatchObject({
      id: inbox.id,
      status: "pending",
      turn_id: null,
      claimed_at: null,
    });
    expect(scheduledSessionIds).toEqual([session.id]);
  });

  test("recoverPending fails orphan running turn with pending inbox rows", async () => {
    const session = createSession();
    const { inbox, message } = enqueueUserMessage(session.id, {
      channelMessageKey: "message-orphan-turn",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1,
    });
    const turnStore = new SessionTurnStore(database.db);
    const orphanTurn = turnStore.createRunningTurn({
      sessionId: session.id,
      inboxRows: [inbox],
      messageRows: [message],
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({ coalesce_idle_ms: 1 }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((row) => row.id));
      },
    });

    await queue.recoverPending();

    expect(turnStore.getById(orphanTurn.id)).toMatchObject({
      id: orphanTurn.id,
      status: "failed",
      error: "Runtime recovered an unclaimed session turn.",
    });
    await queue.waitForIdle();
    expect(batches).toEqual([[message!.id]]);
  });

  test("partial guarded claim race requeues claimed subset instead of dropping it", async () => {
    const session = createSession();
    const firstA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-race-a-1",
      senderUserId: "user-a",
      text: "A1",
      receivedAt: 1,
    });
    const secondA = enqueueUserMessage(session.id, {
      channelMessageKey: "message-race-a-2",
      senderUserId: "user-a",
      text: "A2",
      receivedAt: 2,
    });
    const batches: string[][] = [];
    const queue = new SessionQueue({
      db: database.db,
      config: createSessionQueueConfig({ coalesce_idle_ms: 1 }),
      executeTurn: async (input) => {
        batches.push(input.messageRows.map((message) => message.id));
      },
    });
    const queueInternals = queue as unknown as {
      readonly _inboxStore: SessionInboxStore;
    };
    const originalClaimBatch = queueInternals._inboxStore.claimBatch.bind(
      queueInternals._inboxStore,
    );
    let raced = false;
    queueInternals._inboxStore.claimBatch = (input) => {
      if (!raced) {
        raced = true;
        new SessionInboxStore(database.db).claimBatch({
          turnId: "external-race-turn",
          inboxIds: [secondA.inbox.id],
        });
      }
      return originalClaimBatch(input);
    };

    queue.schedule(session.id);
    await queue.waitForIdle();

    expect(batches).toEqual([[firstA.message.id]]);
    expect(readInboxRow(firstA.inbox.id)).toMatchObject({
      id: firstA.inbox.id,
      status: "completed",
    });
    expect(readInboxRow(secondA.inbox.id)).toMatchObject({
      id: secondA.inbox.id,
      status: "claimed",
      turn_id: "external-race-turn",
    });
    const failedRaceTurn = database.db
      .select()
      .from(sessionTurns)
      .where(sql`${sessionTurns.status} = ${"failed"}`)
      .get();
    expect(failedRaceTurn).toBeUndefined();
    expect(database.db.select().from(sessionTurnEntries).all()).toHaveLength(1);
  });
});

function createSession(
  input: { readonly groupId?: string; readonly rootMessageId?: string } = {},
) {
  return new SessionStore(database.db).resolveByChannelSurface({
    channelType: "feishu",
    channelId: "feishu-main",
    groupId: input.groupId ?? "group-alpha",
    rootMessageId: input.rootMessageId ?? "message-root-1",
  });
}

function createUserMessage(
  sessionId: string,
  input: {
    readonly channelMessageKey: string;
    readonly text: string;
    readonly senderUserId?: string;
    readonly receivedAt?: number;
  },
) {
  const message = new MessageStore(database.db).append({
    sessionId,
    channelMessageKey: input.channelMessageKey,
    senderUserId: input.senderUserId ?? "user-1",
    role: "user",
    content: [{ type: "text", text: input.text }],
    channel: { type: "feishu", id: "feishu-main" },
    sender: {
      externalId: input.senderUserId ?? "user-1",
      kind: "user",
    },
    rawPayload: {
      id: input.channelMessageKey,
      text: input.text,
      senderUserId: input.senderUserId ?? "user-1",
    },
    ...(input.receivedAt !== undefined ? { createdAt: input.receivedAt } : {}),
  });
  return message;
}

function enqueueUserMessage(
  sessionId: string,
  input: {
    readonly channelMessageKey: string;
    readonly text: string;
    readonly senderUserId: string;
    readonly receivedAt: number;
  },
) {
  const message = createUserMessage(sessionId, input);
  const inbox = new SessionInboxStore(database.db).enqueueOnce({
    sessionId,
    message,
  }).row;
  return { message, inbox };
}

function createSessionQueueConfig(
  overrides: Partial<SessionConfig> = {},
): SessionConfig {
  return {
    coalesce_idle_ms: 1200,
    coalesce_max_wait_ms: 5000,
    max_batch_size: 8,
    stale_claim_ms: 120000,
    activation_context_window_ms: 300000,
    activation_context_max_messages: 12,
    activation_context_max_chars: 6000,
    activation_context_recent_unprocessed_messages: 10,
    group_bot_aliases: [],
    group_activation_followup_window_ms: 300000,
    group_activation_followup_senders: "requester_and_reporters",
    group_activation_followup_max_messages: 8,
    group_activation_followup_recent_messages: 3,
    group_activation_followup_interrupt_on_other_user: true,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function readInboxRow(inboxId: string) {
  const row = database.db
    .select()
    .from(sessionInbox)
    .where(sql`${sessionInbox.id} = ${inboxId}`)
    .get();
  expect(row).toBeDefined();
  return row!;
}

function findMessageEntry(sessionId: string, messageId: string) {
  const row = database.db
    .select()
    .from(sessionTimelineEntries)
    .where(
      sql`${sessionTimelineEntries.sessionId} = ${sessionId} AND ${sessionTimelineEntries.messageId} = ${messageId} AND ${sessionTimelineEntries.entryKind} = ${"message"}`,
    )
    .get();
  expect(row).toBeDefined();
  return row!;
}

function createTwoMessageInbox() {
  const session = createSession();
  const firstMessage = createUserMessage(session.id, {
    channelMessageKey: "message-inbox-1",
    text: "first message",
  });
  const secondMessage = createUserMessage(session.id, {
    channelMessageKey: "message-inbox-2",
    text: "second message",
  });
  const inboxStore = new SessionInboxStore(database.db);
  const firstInbox = inboxStore.enqueueOnce({
    sessionId: session.id,
    message: firstMessage,
  }).row;
  const secondInbox = inboxStore.enqueueOnce({
    sessionId: session.id,
    message: secondMessage,
  }).row;

  return { session, inboxStore, firstInbox, secondInbox };
}

function createRunningTurn(label: string, messageCount = 1) {
  const session = createSession();
  const inboxStore = new SessionInboxStore(database.db);
  const messages = Array.from({ length: messageCount }, (_, index) =>
    createUserMessage(session.id, {
      channelMessageKey: `message-${label}-${index + 1}`,
      text: `turn message ${index + 1}`,
    }),
  );
  const inboxRows = messages.map(
    (message) => inboxStore.enqueueOnce({ sessionId: session.id, message }).row,
  );
  const turnStore = new SessionTurnStore(database.db);
  const turn = turnStore.createRunningTurn({
    sessionId: session.id,
    inboxRows,
    messageRows: messages,
  });

  return { session, inboxStore, turnStore, turn, messages, inboxRows };
}

test("session queue shares the task-result execution lane", async () => {
  const { sessionDispatcherFor } = await import("../../src/sessions/session-dispatcher");
  const { session } = createTwoMessageInbox();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let executed = false;
  const result = sessionDispatcherFor(database.db).dispatch({ kind: "task_result", sessionId: session.id }, () => gate);
  const queue = new SessionQueue({ db: database.db, config: createSessionQueueConfig({ coalesce_idle_ms: 1 }), executeTurn: async () => { executed = true; } });
  queue.schedule(session.id);
  await Promise.resolve();
  expect(executed).toBe(false);
  release(); await result; await queue.waitForIdle();
  expect(executed).toBe(true);
});

test("Runtime recovery retains the claimed turn and session lane instead of requeuing a new turn", async () => {
  const { config } = await import("../../src/shared");
  const { InvocationStore } = await import("../../src/runners/invocation-store");
  const descriptor = Object.getOwnPropertyDescriptor(config, "sandbox")!;
  const sandbox = config.sandbox;
  Object.defineProperty(config, "sandbox", { configurable: true, get: () => ({ ...sandbox, runtimeConfigFile: "/test/runtime.json" }) });
  const gate = createDeferred<void>();
  try {
    const { session, turn, inboxRows, inboxStore, turnStore } = createRunningTurn("runtime-resume");
    inboxStore.claimBatch({ turnId: turn.id, inboxIds: inboxRows.map(row => row.id) });
    database.db.run(sql`UPDATE session_inbox SET claimed_at = 1 WHERE turn_id = ${turn.id}`);
    const context = new RunnerContextStore(database.db).resolveForSession(session.id, "mock");
    new InvocationStore(database.db).register({ id: "inv_resume", runnerKind: "work", actorUserId: fixtureOwnerUserId("fixture-owner"), runnerContextId: context.id, sessionId: session.id, taskId: null, taskRunId: null, originId: turn.id,
      inputSnapshot: { version: 1, kind: "work", input: { sessionId: session.id, turnId: turn.id, runnerContextId: context.id } } as never, contextPackIds: [] });
    const turns: string[] = [];
    const queue = new SessionQueue({ db: database.db, config: createSessionQueueConfig({ stale_claim_ms: 1 }), executeTurn: async input => { turns.push(input.turn.id); await gate.promise; } });
    await queue.recoverPending();
    await Promise.resolve();
    expect(turns).toEqual([turn.id]);
    expect(turnStore.getById(turn.id)?.status).toBe("running");
    expect(readInboxRow(inboxRows[0]!.id)?.turn_id).toBe(turn.id);
    expect(readInboxRow(inboxRows[0]!.id)?.status).toBe("claimed");
    gate.resolve(); await queue.waitForIdle();
    expect(turnStore.getById(turn.id)?.status).toBe("completed");
    expect(turns).toHaveLength(1);
  } finally { gate.resolve(); Object.defineProperty(config, "sandbox", descriptor); }
});
