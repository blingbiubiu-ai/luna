import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { AgentSettingsStore } from "../../src/agents/agent-settings-store";
import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { ChatListeningStore } from "../../src/sessions/chat-listening-store";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionInboxStore } from "../../src/sessions/session-inbox-store";
import { SessionQueue, type SessionTurnExecutionInput } from "../../src/sessions/session-queue";
import { SessionStore, type SessionRow } from "../../src/sessions/session-store";
import { DEFAULT_SESSION_CONFIG, setLunaHome, uuid } from "../../src/shared";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";

let home: string;
let database: DataConnection<typeof lunaSchema>;
let session: SessionRow;
let listening: ChatListeningStore;
let queue: SessionQueue | undefined;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-listening-queue-"));
  mkdirSync(join(home, "data"), { recursive: true });
  setLunaHome(home);
  database = new DataConnection(lunaSchema);
  fixtureSessionOwnership(database.db, "feishu", "feishu-main");
  session = new SessionStore(database.db).resolveByChannelSurface({ channelType: "feishu", channelId: "feishu-main", groupId: "oc_group" });
  listening = new ChatListeningStore(database.db);
  listening.set(session.shadow_id, "oc_group", true, null);
});
afterEach(async () => {
  await queue?.stop(); queue = undefined;
  database.close();
  rmSync(home, { recursive: true, force: true });
});

const SECOND = 1000;
/** A message `agoMs` old from `sender`: overheard unless `direct`. */
function message(sender: string, agoMs: number, options: { direct?: boolean; dueNow?: boolean } = {}) {
  const key = `m-${++counter}`;
  const row = new MessageStore(database.db).append({
    sessionId: session.id, channelMessageKey: key, senderUserId: sender, role: "user",
    content: [{ type: "text", text: `${sender} says ${key}` }], channel: { type: "feishu", id: "feishu-main" },
    sender: { externalId: sender, kind: "user" }, rawPayload: { id: key }, createdAt: Date.now() - agoMs,
  });
  const inbox = new SessionInboxStore(database.db).enqueueOnce({
    sessionId: session.id, message: row, ...(options.direct ? {} : { lane: "ambient" as const, dueNow: options.dueNow ?? false }) }).row;
  return { id: row.id, inboxId: inbox.id };
}
/** Runs the queue until idle and returns the turns it executed. */
async function run(execute: (input: SessionTurnExecutionInput, signal: AbortSignal) => Promise<void> = async () => {}) {
  const turns: SessionTurnExecutionInput[] = [];
  queue = new SessionQueue({ db: database.db, config: { ...DEFAULT_SESSION_CONFIG, coalesce_idle_ms: 1 },
    executeTurn: async (input, signal) => { turns.push(input); await execute(input, signal); } });
  queue.schedule(session.id);
  await queue.waitForIdle();
  return turns;
}
const inboxStatus = (inboxId: string) => database.db.select().from(lunaSchema.sessionInbox).where(eq(lunaSchema.sessionInbox.id, inboxId)).get()!.status;
const ids = (rows: readonly { id: string }[] | undefined) => (rows ?? []).map(row => row.id);

test("overheard messages wait until the chat is quiet, then go to the Runner together whoever sent them", async () => {
  const early = [message("user-a", 2 * SECOND), message("user-b", 1 * SECOND)];
  expect(await run()).toEqual([]);
  expect(early.map(row => inboxStatus(row.inboxId))).toEqual(["pending", "pending"]);
  await queue!.stop();

  early.forEach((row, index) => database.db.update(lunaSchema.sessionInbox).set({ received_at: Date.now() - (32 - index) * SECOND })
    .where(eq(lunaSchema.sessionInbox.id, row.inboxId)).run());
  const turns = await run();
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ ambient: true, turn: { reason: "ambient" } });
  expect(ids(turns[0]!.messageRows)).toEqual(early.map(row => row.id));
  expect(early.map(row => inboxStatus(row.inboxId))).toEqual(["completed", "completed"]);
});

test("a full batch, a long wait or a message naming the Agent is due without the chat going quiet", async () => {
  for (let index = 0; index < 9; index++) message(`user-${index % 3}`, 0);
  expect(await run()).toHaveLength(0);
  await queue!.stop();
  message("user-a", 0);
  expect(ids((await run())[0]!.messageRows)).toHaveLength(10);
  await queue!.stop();
  listening.resetSilence(session.shadow_id, "oc_group");

  message("user-a", 181 * SECOND); message("user-b", 0);
  expect(ids((await run())[0]!.messageRows)).toHaveLength(2);
  await queue!.stop();

  // That listening turn ended in silence, which doubles the wait; a named message does not wait.
  message("user-a", 0, { dueNow: true });
  expect(await run()).toHaveLength(1);
});

test("each silent listening turn doubles the wait up to the limit; being addressed resets it", async () => {
  message("user-a", 31 * SECOND);
  expect(await run()).toHaveLength(1);
  expect(listening.silentStreak(session.shadow_id, "oc_group")).toBe(1);
  await queue!.stop();

  const waiting = message("user-a", 31 * SECOND);
  expect(await run()).toHaveLength(0);
  await queue!.stop();
  database.db.update(lunaSchema.sessionInbox).set({ received_at: Date.now() - 61 * SECOND }).where(eq(lunaSchema.sessionInbox.id, waiting.inboxId)).run();
  expect(await run()).toHaveLength(1);
  expect(listening.silentStreak(session.shadow_id, "oc_group")).toBe(2);
  await queue!.stop();

  // A long run of silence stops growing at the limit (10 minutes by default).
  for (let index = 0; index < 20; index++) listening.recordSilence(session.shadow_id, "oc_group");
  message("user-a", 601 * SECOND);
  expect(await run()).toHaveLength(1);
  await queue!.stop();

  message("user-a", 0, { direct: true });
  expect(await run()).toHaveLength(1);
  expect(listening.silentStreak(session.shadow_id, "oc_group")).toBe(0);
});

test("a chat gets a limited number of listening turns an hour, by the Agent's own settings", async () => {
  const owner = database.db.select().from(lunaSchema.lunaAgents).where(eq(lunaSchema.lunaAgents.id, session.agent_id)).get()!.ownerAccountId;
  new AgentSettingsStore(database.db).save(owner, session.agent_id, { listening: { maxTurnsPerHour: 2, quietMs: 5000 } });
  for (let round = 0; round < 2; round++) {
    message("user-a", 6 * SECOND);
    expect(await run(async () => { listening.resetSilence(session.shadow_id, "oc_group"); })).toHaveLength(1);
    await queue!.stop();
    listening.resetSilence(session.shadow_id, "oc_group");
  }
  const held = message("user-a", 6 * SECOND);
  expect(await run()).toHaveLength(0);
  expect(inboxStatus(held.inboxId)).toBe("pending");
  await queue!.stop();
  // The oldest of the two turns leaves the hour: the held batch is due again.
  database.db.update(lunaSchema.sessionTurns).set({ started_at: Date.now() - 3_700_000 }).run();
  expect(await run()).toHaveLength(1);
});

test("overheard messages of a chat that is no longer listened to are skipped, not run", async () => {
  const row = message("user-a", 31 * SECOND);
  listening.set(session.shadow_id, "oc_group", false, null);
  expect(await run()).toHaveLength(0);
  expect(inboxStatus(row.inboxId)).toBe("completed");
  expect(database.db.select().from(lunaSchema.sessionTurns).all().map(turn => [turn.turn_kind, turn.runner_invoked, turn.reason])).toEqual([["skip", false, "silent_group"]]);
});

test("a message addressed to the Agent takes the overheard messages still waiting along as context", async () => {
  const overheard = [message("user-a", 3 * SECOND), message("user-b", 2 * SECOND)];
  const direct = message("user-c", 1 * SECOND, { direct: true });
  const later = message("user-a", 0);
  const turns = await run();
  expect(turns).toHaveLength(1);
  expect(turns[0]!.ambient).toBeUndefined();
  expect(ids(turns[0]!.messageRows)).toEqual([direct.id]);
  expect(ids(turns[0]!.overheardMessageRows)).toEqual(overheard.map(row => row.id));
  expect([...overheard, direct].map(row => inboxStatus(row.inboxId))).toEqual(["completed", "completed", "completed"]);
  // What was said after the addressed message waits for the next listening turn.
  expect(inboxStatus(later.inboxId)).toBe("pending");
});

/** Runs a listening turn that is interrupted by an addressed message; `received` says whether the provider session took its input. */
async function interrupted(received: boolean) {
  const overheard = message("user-a", 31 * SECOND);
  let direct: ReturnType<typeof message> | undefined;
  const turns = await run(async (input, signal) => {
    if (!input.ambient) return;
    if (received) {
      const invocationId = uuid(), now = Date.now();
      database.db.insert(lunaSchema.runnerInvocations).values({ id: invocationId, agentId: session.agent_id, shadowId: session.shadow_id, runnerKind: "main",
        actorUserId: "user-a", runnerContextId: "context", sessionId: session.id, originId: input.turn.id, state: "active",
        inputSnapshot: { version: 1, input: {} }, contextPackIds: [], createdAt: now }).run();
      database.db.insert(lunaSchema.runnerJobs).values({ id: uuid(), runtimeId: "test", invocationId, request: {} as never, requestHash: "hash",
        state: "terminal", providerState: { sessionId: "provider-session" }, createdAt: now, updatedAt: now }).run();
    }
    direct = message("user-b", 0, { direct: true });
    queue!.preemptAmbient(session.id);
    queue!.schedule(session.id);
    expect(signal.aborted).toBe(true);
  });
  return { overheard, direct: direct!, turns };
}

test("an addressed message stops a running listening turn; what the provider session already holds is not sent again", async () => {
  const { overheard, direct, turns } = await interrupted(true);
  expect(turns.map(turn => turn.ambient ?? false)).toEqual([true, false]);
  expect(ids(turns[1]!.messageRows)).toEqual([direct.id]);
  expect(turns[1]!.overheardMessageRows).toBeUndefined();
  expect([overheard, direct].map(row => inboxStatus(row.inboxId))).toEqual(["completed", "completed"]);
  expect(database.db.select().from(lunaSchema.sessionTurns).all().map(turn => [turn.reason, turn.status]).sort())
    .toEqual([["addressed", "completed"], ["ambient", "failed"]]);
  // An interrupted turn is not a silent one.
  expect(listening.silentStreak(session.shadow_id, "oc_group")).toBe(0);
});

test("a listening turn stopped before the provider session took its input hands that input to the addressed turn", async () => {
  const { overheard, direct, turns } = await interrupted(false);
  expect(turns.map(turn => turn.ambient ?? false)).toEqual([true, false]);
  expect(ids(turns[1]!.messageRows)).toEqual([direct.id]);
  expect(ids(turns[1]!.overheardMessageRows)).toEqual([overheard.id]);
});

test("preempting leaves a turn that answers someone alone", async () => {
  message("user-a", 0, { direct: true });
  const turns = await run(async (_input, signal) => { queue!.preemptAmbient(session.id); expect(signal.aborted).toBe(false); });
  expect(turns).toHaveLength(1);
  expect(database.db.select().from(lunaSchema.sessionTurns).all().map(turn => turn.status)).toEqual(["completed"]);
});
