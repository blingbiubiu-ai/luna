import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {RunnerContextStore} from "@/runners/runner-context-store";
import {memoryAccess} from "@/agents/agent-memory-access";
import {AgentMemoryStore, type MemoryWriter} from "@/agents/agent-memory-store";
import {SessionCommandService} from "@/messaging/session-command-service";
import {MessageStore} from "@/sessions/message-store";
import {SessionTimelineStore} from "@/sessions/session-timeline-store";
import {SessionTurnStore} from "@/sessions/session-turn-store";
import {ContextPackStore} from "@/context/context-pack-store";
import {maintainMemory, memoryOriginOfTrigger, prepareMemoryConsolidationRun, scheduleMemoryConsolidations, scheduleMemoryReflections} from "@/agents/agent-memory-maintenance";
import {fixtureNamedSession, fixtureUser} from "../helpers/platform-fixtures";

const MIN = 60_000, IDLE = 30 * MIN, NOW = 1_800_000_000_000;
let home: string, db: DataConnection<typeof schema>, commands: SessionCommandService, sequence = 0;
let scope: ReturnType<typeof fixtureNamedSession>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-memory-maintenance-")); setLunaHome(home); db = new DataConnection(schema);
  scope = fixtureNamedSession(db.db, "session", "alice");
  for (const id of ["lisi", "zhangsan", "bob", "carol", "wangwu", "wangfang"]) fixtureUser(db.db, scope.agentId, id);
  commands = new SessionCommandService({db: db.db, channelFor: () => undefined});
});
afterEach(() => { db.close(); rmSync(home, {recursive: true, force: true}); });

function human(id: string) {
  fixtureUser(db.db, scope.agentId, id);
}
/** A message in the session, `agoMs` before NOW. */
function say(senderUserId: string, agoMs: number, role: "user" | "assistant" = "user", sessionId = "session") {
  const row = new MessageStore(db.db).appendOnce({sessionId, channelMessageKey: `m-${++sequence}`, role, senderUserId,
    content: [{type: "text", text: "hello"}], channel: {type: "dashboard", id: "dashboard"}}).row;
  db.db.update(schema.messages).set({createdAt: NOW - agoMs}).where(eq(schema.messages.id, row.id)).run();
  return row.id;
}
/** A Main Runner turn that took these messages in: the first as its trigger, the rest in `role`. */
function turn(messageIds: string[], options: {status?: "completed" | "running" | "failed"; role?: "coalesced_input" | "context" | "launch_context"} = {}) {
  const timeline = new SessionTimelineStore(db.db), turns = new SessionTurnStore(db.db);
  const entries = messageIds.map(messageId => timeline.appendMessage({sessionId: "session", messageId}).id);
  const created = turns.createExecutionTurn({sessionId: "session", triggerEntryId: entries[0]!, reason: "addressed"});
  turns.attachEntries(created.id, entries.slice(1).map(entryId => ({entryId, role: options.role ?? "coalesced_input"})));
  db.db.update(schema.sessionTurns).set({status: options.status ?? "completed"}).where(eq(schema.sessionTurns.id, created.id)).run();
  return created.id;
}
/** A human message that a completed Main Runner turn answered. */
const ask = (senderUserId: string, agoMs: number) => { const id = say(senderUserId, agoMs); turn([id]); return id; };
const schedule = (now = NOW) => scheduleMemoryReflections(db.db, commands, IDLE, now);
const command = (id: string) => db.db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, id)).get()!;

test("an idle session with unreflected human messages gets exactly one silent reflection turn", () => {
  ask("user:alice", 40 * MIN);
  const [id] = schedule();
  expect(command(id!)).toMatchObject({kind: "session.invoke", sessionId: "session", sourceSessionId: "session", actorUserId: "user:alice", status: "pending"});
  expect(String(command(id!).payload.content)).toContain("Do not send any message");
  expect(String(command(id!).payload.content)).not.toContain("LUNA_NOTHING_TO_SEND");
  expect(memoryOriginOfTrigger(db.db, id!)).toBe("reflection");
  expect(memoryOriginOfTrigger(db.db, "unrelated")).toBe("inline");
  expect(schedule()).toEqual([]);
  db.db.update(schema.sessionCommands).set({status: "completed"}).where(eq(schema.sessionCommands.id, id!)).run();
  expect(schedule(NOW + 2 * IDLE)).toEqual([]);
});

test("a session that is still active, or only has Agent replies, is left alone until it goes quiet", () => {
  ask("user:alice", 10 * MIN);
  expect(schedule()).toEqual([]);
  expect(schedule(NOW + 25 * MIN)).toHaveLength(1);
  const reply = new MessageStore(db.db).appendOnce({sessionId: "session", channelMessageKey: "reply", role: "assistant",
    senderUserId: db.db.select().from(schema.sessions).where(eq(schema.sessions.id, "session")).get()!.bot_user_id!,
    content: [{type: "text", text: "done"}], channel: {type: "dashboard", id: "dashboard"}}).row;
  db.db.update(schema.messages).set({createdAt: NOW + 26 * MIN}).where(eq(schema.messages.id, reply.id)).run();
  db.db.update(schema.sessionCommands).set({status: "completed"}).run();
  expect(schedule(NOW + 3 * IDLE)).toEqual([]);
});

test("new human messages after a reflection are reflected on again", () => {
  ask("user:alice", 40 * MIN);
  expect(schedule()).toHaveLength(1);
  db.db.update(schema.sessionCommands).set({status: "completed"}).run();
  ask("user:alice", -5 * MIN);
  expect(schedule(NOW + 10 * MIN)).toEqual([]);
  expect(schedule(NOW + 40 * MIN)).toHaveLength(1);
});

test("reflection runs as the owner only when nobody else spoke, otherwise as the latest other speaker", () => {
  human("bob"); human("carol");
  ask("bob", 50 * MIN); ask("carol", 45 * MIN); ask("user:alice", 40 * MIN);
  expect(command(schedule()[0]!).actorUserId).toBe("carol");
});

test("history from before the lookback window, inactive sessions and disabled reflection are skipped", () => {
  ask("user:alice", 25 * 60 * MIN);
  expect(schedule()).toEqual([]);
  ask("user:alice", 40 * MIN);
  expect(scheduleMemoryReflections(db.db, commands, 0, NOW)).toEqual([]);
  db.db.update(schema.sessions).set({status: "archived"}).where(eq(schema.sessions.id, "session")).run();
  expect(schedule()).toEqual([]);
});

test("only messages a completed Main Runner turn took in, as input or as context, are reflected on", () => {
  human("bob"); human("carol");
  // Group chatter nobody addressed to the bot never reaches a Main Runner turn.
  say("bob", 50 * MIN); say("carol", 45 * MIN);
  expect(schedule()).toEqual([]);
  // A turn still running, or one that failed, does not count yet.
  const pending = say("user:alice", 40 * MIN);
  const running = turn([pending], {status: "running"});
  expect(schedule()).toEqual([]);
  db.db.update(schema.sessionTurns).set({status: "failed"}).where(eq(schema.sessionTurns.id, running)).run();
  expect(schedule()).toEqual([]);
  // Chatter later taken in as context counts, and its speaker is who the reflection runs as.
  const chatter = say("carol", 38 * MIN), addressed = say("user:alice", 35 * MIN);
  turn([addressed, chatter], {role: "context"});
  const [id] = schedule();
  expect(command(id!).actorUserId).toBe("carol");
  expect(db.db.select().from(schema.memoryReflectionCheckpoints).get()!.reflectedThrough).toBe(NOW - 35 * MIN);
});

test("a Service-queued turn counts its context, except a memory maintenance turn's own", () => {
  human("bob");
  const chatter = say("bob", 40 * MIN);
  const contextOf = (originId: string) => {
    const queued = commands.accept({userId: "user:alice", sourceSessionId: "session", originId}, "session", "session.invoke", originId, {content: "do it", purpose: "notification"});
    const packs = new ContextPackStore(db.db);
    const pack = packs.createPack({ownerType: "session", ownerId: "session", kind: "turn_delta", selectionStrategy: "trigger_recent_context", createdForInvocationId: queued.id});
    packs.addItems(pack.id, [{itemKind: "message", itemId: chatter, sourceSessionId: "session", sourceMessageId: chatter, role: "delta_context", reason: "trigger_recent_context"}]);
    db.db.insert(schema.sessionTurns).values({id: queued.id, session_id: "session", turn_kind: "execution", status: "completed", runner_invoked: true, reason: "session_trigger", started_at: NOW, created_at: NOW, updated_at: NOW}).run();
    db.db.update(schema.sessionCommands).set({status: "completed"}).where(eq(schema.sessionCommands.id, queued.id)).run();
  };
  contextOf("memory-reflection:earlier");
  expect(schedule()).toEqual([]);
  contextOf("schedule:daily");
  expect(command(schedule()[0]!).actorUserId).toBe("bob");
});

test("a session with queued or running work waits for the next pass", () => {
  const id = ask("user:alice", 40 * MIN);
  const entry = db.db.select().from(schema.sessionTimelineEntries).where(eq(schema.sessionTimelineEntries.messageId, id)).get()!;
  db.db.insert(schema.sessionInbox).values({id: "inbox", session_id: "session", entry_id: `${entry.id}-next`, message_id: id, received_at: NOW, status: "pending", created_at: NOW, updated_at: NOW}).run();
  expect(schedule()).toEqual([]);
  db.db.update(schema.sessionInbox).set({status: "completed"}).run();
  expect(schedule()).toHaveLength(1);
  // The queued reflection itself keeps a second one from being queued.
  db.db.delete(schema.memoryReflectionCheckpoints).run();
  expect(schedule()).toEqual([]);
});

const DAY = 24 * 60 * MIN;
const consolidate = (now = NOW) => scheduleMemoryConsolidations(db.db, commands, DAY, now);
const writer = (kind: MemoryWriter["kind"] = "inline"): MemoryWriter => ({agentId: scope.agentId, kind, trusted: true, userId: "user:alice", shadowId: scope.shadowId});
const note = {type: "project" as const, title: "发布冻结", description: "2026-11-20 前冻结发布", body: "2026-11-20 前不合并功能分支"};
/** Marks every queued turn as ended with `status`. */
const finish = (status = "completed") => db.db.update(schema.sessionCommands).set({status}).run();

test("consolidation runs once per interval for an Agent whose memory changed, in a dedicated owner session", () => {
  expect(consolidate()).toEqual([]);
  const store = new AgentMemoryStore(db.db);
  const entry = store.add(writer(), note);
  const [id] = consolidate();
  const first = command(id!);
  expect(first).toMatchObject({kind: "session.invoke", actorUserId: "user:alice", status: "pending"});
  expect(first.sessionId).not.toBe("session");
  expect(db.db.select().from(schema.sessions).where(eq(schema.sessions.id, first.sessionId)).get()).toMatchObject({title: "记忆整理", channel_type: "dashboard", shadow_id: scope.shadowId, created_by_user_id: "user:alice"});
  expect(String(first.payload.content)).toContain(`1. [${entry.id}] (project, trusted, origin inline, revision 1`);
  expect(String(first.payload.content)).toContain(`Today is ${new Date(NOW).toISOString().slice(0, 10)}`);
  expect(memoryOriginOfTrigger(db.db, id!)).toBe("consolidation");
  expect(consolidate()).toEqual([]);
  expect(consolidate(NOW + 2 * DAY)).toEqual([]);
  store.update(writer("consolidation"), {agentId: scope.agentId, all: true}, entry.id, {expectedRevision: 1, body: "tidied"});
  expect(consolidate(NOW + 2 * DAY)).toEqual([]);
  store.add(writer(), {...note, title: "新事实"});
  expect(consolidate(NOW + DAY / 2)).toEqual([]);
  expect(consolidate(NOW + 2 * DAY)).toEqual([]);
  finish();
  const again = command(consolidate(NOW + 2 * DAY)[0]!);
  expect(again.sessionId).toBe(first.sessionId);
  expect(scheduleMemoryConsolidations(db.db, commands, 0, NOW + 9 * DAY)).toEqual([]);
});

test("only a consolidation turn of the Agent owner sees every entry", () => {
  human("bob");
  const invocation = {...scope, actorUserId: "user:alice", sessionId: "session", taskId: null, runnerContextId: "context"};
  expect(memoryAccess(db.db, invocation, "consolidation").viewer).toEqual({agentId: scope.agentId, all: true});
  expect(memoryAccess(db.db, invocation, "consolidation").writer()).toMatchObject({kind: "consolidation", trusted: true});
  expect(memoryAccess(db.db, invocation, "reflection").viewer).toMatchObject({shadowId: scope.shadowId, participants: ["user:alice"]});
  expect(memoryAccess(db.db, {...invocation, actorUserId: "bob"}, "consolidation").viewer).toMatchObject({shadowId: scope.shadowId});
});

test("a consolidation turn is handed only what changed since the last one, each with the entries it resembles", () => {
  const store = new AgentMemoryStore(db.db);
  const old = store.add(writer(), {type: "feedback", title: "周报格式", description: "周报不要用表格", body: "用列表"});
  const unrelated = store.add(writer(), note);
  const first = String(command(consolidate()[0]!).payload.content);
  expect(first).toContain(`[${old.id}]`);
  expect(first).toContain(`[${unrelated.id}]`);
  expect(first).not.toContain("similar:");
  const duplicate = store.add({...writer(), trusted: false, userId: "user:alice"}, {type: "project", title: "周报的格式", description: "周报不要用表格 改用列表", body: "b", expiresAt: NOW + 30 * DAY});
  store.update(writer(), {agentId: scope.agentId, all: true}, duplicate.id, {expectedRevision: 1, type: "feedback"});
  finish();
  const second = String(command(consolidate(NOW + 2 * DAY)[0]!).payload.content);
  expect(second).toContain(`1. [${duplicate.id}] (feedback, trusted, origin inline, revision 2`);
  expect(second).toContain(`expires ${new Date(NOW + 30 * DAY).toISOString().slice(0, 10)}`);
  expect(second).toContain(`   - similar: [${old.id}] (feedback, trusted`);
  expect(second).not.toContain(unrelated.id);
  expect(second).not.toContain("2. [");
});

test("each consolidation starts from a fresh provider context, and a backlog is continued without waiting a day", () => {
  const store = new AgentMemoryStore(db.db);
  for (let i = 0; i < 103; i++) store.add(writer(), {...note, title: `条目 ${i}`, description: `第 ${i} 条`});
  const firstRun = command(consolidate()[0]!);
  expect(String(firstRun.payload.content)).toContain("100. [");
  expect(String(firstRun.payload.content)).not.toContain("101. [");
  const contexts = new RunnerContextStore(db.db), context = contexts.resolveForSession(firstRun.sessionId, "codex");
  contexts.persistRunnerSessionId(context.id, "provider-session");
  const sessionOf = () => db.db.select().from(schema.runnerContexts).where(eq(schema.runnerContexts.id, context.id)).get()!.runner_session_id;
  // A queued run does not touch the context; the next batch waits until this run has ended.
  expect(consolidate(NOW + 11 * MIN)).toEqual([]);
  expect(sessionOf()).toBe("provider-session");
  // The context is cleared when a run starts, unless it is a recovered run.
  prepareMemoryConsolidationRun(db.db, firstRun, true);
  expect(sessionOf()).toBe("provider-session");
  prepareMemoryConsolidationRun(db.db, firstRun, false);
  expect(sessionOf()).toBeNull();
  contexts.persistRunnerSessionId(context.id, "provider-session");
  prepareMemoryConsolidationRun(db.db, {id: "not-a-consolidation", sessionId: firstRun.sessionId}, false);
  expect(sessionOf()).toBe("provider-session");
  finish();
  expect(consolidate(NOW + 5 * MIN)).toEqual([]);
  const rest = String(command(consolidate(NOW + 11 * MIN)[0]!).payload.content);
  expect(rest).toContain("3. [");
  expect(rest).not.toContain("4. [");
  finish();
  expect(consolidate(NOW + 30 * MIN)).toEqual([]);
});

test("a run that did not complete is handed the same changes again", () => {
  const store = new AgentMemoryStore(db.db);
  const first = store.add(writer(), note);
  consolidate();
  finish("failed");
  const second = store.add(writer(), {...note, title: "新事实", description: "另一条事实"});
  const retry = String(command(consolidate(NOW + DAY)[0]!).payload.content);
  expect(retry).toContain(`[${first.id}]`);
  expect(retry).toContain(`[${second.id}]`);
  finish();
  store.add(writer(), {...note, title: "第三条", description: "第三条事实"});
  expect(String(command(consolidate(NOW + 2 * DAY)[0]!).payload.content)).not.toContain(first.id);
});

test("memory text never forms an Artifact reference, and a turn that cannot be queued leaves no session behind", () => {
  const store = new AgentMemoryStore(db.db);
  store.add({...writer(), trusted: false}, {...note, title: "报告见 artifact:missing", description: "引用 artifact:missing-too"});
  const [id] = consolidate();
  const queued = command(id!);
  expect(String(queued.payload.content)).not.toContain("artifact:");
  expect(queued.payload.contextRefs).toEqual([]);
  db.db.delete(schema.memoryConsolidations).run();
  const failing = {accept: () => { throw new Error("unavailable"); }};
  scheduleMemoryConsolidations(db.db, failing, DAY, NOW);
  scheduleMemoryConsolidations(db.db, failing, DAY, NOW + MIN);
  expect(db.db.select().from(schema.sessions).where(eq(schema.sessions.title, "记忆整理")).all()).toHaveLength(2);
});

test("a maintenance pass forgets first, so expired entries are neither reflected into context nor consolidated", () => {
  const store = new AgentMemoryStore(db.db);
  const expired = store.add(writer(), {...note, expiresAt: NOW - 1});
  const kept = store.add(writer(), {...note, title: "保留"});
  maintainMemory(db.db, commands, {reflectionIdleMs: 0, consolidationIntervalMs: DAY, forgetUnusedMs: 0}, NOW);
  expect(store.page(scope.agentId, {limit: 200}).entries.find(row => row.id === expired.id)!.status).toBe("archived");
  const [queued] = db.db.select().from(schema.sessionCommands).all();
  expect(String(queued!.payload.content)).toContain(kept.id);
  expect(String(queued!.payload.content)).not.toContain(expired.id);
});

test("consolidation shows a duplicate filed under another type and restated inside a longer entry", () => {
  const store = new AgentMemoryStore(db.db);
  const long = store.add(writer(), {type: "project", title: "发布冻结后的接口负责人王芳", description: "用户说明2026-12-05发布冻结后，接口问题找接口负责人王芳。", body: "b"});
  const short = store.add(writer(), {type: "reference", title: "接口问题联系王芳", description: "接口问题找王芳 她是接口负责人", body: "名单见《接口负责人表》"});
  const unrelated = store.add(writer(), {type: "feedback", title: "周报格式", description: "周报不要用表格", body: "b"});
  const person = store.add(writer(), {type: "person", title: "王芳", description: "接口负责人王芳 接口问题找她", body: "b", subjectId: "wangfang"});
  const text = String(command(consolidate()[0]!).payload.content);
  expect(text).toContain(`1. [${long.id}] (project`);
  expect(text.split("\n")[text.split("\n").findIndex(line => line.startsWith("1. [")) + 1]).toContain(`- similar: [${short.id}] (reference`);
  expect(text).toContain(`   - similar: [${long.id}] (project`);
  expect(text).not.toContain(`similar: [${unrelated.id}]`);
  expect(text).not.toContain(`similar: [${person.id}]`);
  expect(text).toContain("even under different titles, wording or types");
});


test("reflection asks for one episode, and maintenance fades old episodes", () => {
  ask("user:alice", 40 * MIN);
  const text = String(command(schedule()[0]!).payload.content);
  expect(text).toContain("luna memory add --type episode");
  const store = new AgentMemoryStore(db.db);
  const old = store.add(writer(), {type: "episode", title: "旧事", description: "d", body: "b", occurredAt: NOW - 100 * DAY}, {participants: ["user:alice"]});
  db.db.update(schema.agentMemories).set({lastUsedAt: NOW - 100 * DAY}).run();
  maintainMemory(db.db, commands, {reflectionIdleMs: 0, consolidationIntervalMs: 0, forgetUnusedMs: 0, episodeRetentionMs: 90 * DAY}, NOW);
  expect(store.page(scope.agentId, {limit: 200}).entries.find(row => row.id === old.id)!.status).toBe("archived");
});

test("a Work session is reflected on too, and its reflection runs with the Work Runner, not Main", async () => {
  const {createSessionTriggerExecutor} = await import("@/sessions/trigger-executor");
  db.db.update(schema.sessions).set({kind: "work"}).where(eq(schema.sessions.id, "session")).run();
  ask("user:alice", 40 * MIN);
  const [id] = schedule();
  expect(memoryOriginOfTrigger(db.db, id!)).toBe("reflection");
  const calls: {sessionId: string; actorUserId: string; instruction: string}[] = [];
  const execute = createSessionTriggerExecutor(db.db, () => { throw new Error("Main must not run a Work session's reflection"); }, () => "codex",
    async (session, turn) => { calls.push({sessionId: session.id, actorUserId: turn.actorUserId, instruction: turn.instruction}); });
  await execute(command(id!), new AbortController().signal);
  expect(calls).toMatchObject([{sessionId: "session", actorUserId: "user:alice"}]);
  expect(calls[0]!.instruction).toContain("luna memory add --type episode");
  expect(db.db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, id!)).get()).toMatchObject({status: "completed", reason: "session_trigger"});
  // A failing maintenance turn is recorded as failed and reported to the command worker.
  db.db.update(schema.sessionCommands).set({status: "completed"}).where(eq(schema.sessionCommands.id, id!)).run();
  ask("user:alice", -5 * MIN);
  const [next] = schedule(NOW + 60 * MIN);
  const failing = createSessionTriggerExecutor(db.db, () => { throw new Error("unused"); }, () => "codex", async () => { throw new Error("model unavailable"); });
  await expect(failing(command(next!), new AbortController().signal)).rejects.toThrow("model unavailable");
  expect(db.db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, next!)).get()).toMatchObject({status: "failed"});
});



const fixtureTaskResult = (id: string, agoMs: number, creator = "user:alice") => {
  db.db.insert(schema.tasks).values({id: `task-${id}`, agent_id: scope.agentId, shadow_id: scope.shadowId, type: "task", title: "统计质数", summary: "1 到 100",
    status: "completed", creator_user_id: creator, primary_session_id: "session", created_at: 1, updated_at: 1, last_activity_at: 1}).onConflictDoNothing().run();
  db.db.insert(schema.sessionTriggers).values({id: `trigger-${id}`, sessionId: "session", kind: "task_result", dedupeKey: `dedupe-${id}`,
    payload: {result: {taskId: `task-${id}`} as never, subscriptionId: "sub"}, status: "completed", createdAt: NOW - agoMs, updatedAt: NOW - agoMs}).run();
};

test("a Task result handled in the session starts a reflection, as whoever created the Task", () => {
  human("bob");
  fixtureTaskResult("a", 40 * MIN, "bob");
  const [id] = schedule();
  expect(command(id!)).toMatchObject({kind: "session.invoke", actorUserId: "bob"});
  expect(schedule(NOW + 2 * IDLE)).toEqual([]);
  db.db.update(schema.sessionCommands).set({status: "completed"}).where(eq(schema.sessionCommands.id, id!)).run();
  // A result still being handled, or too recent, waits.
  db.db.insert(schema.sessionTriggers).values({id: "pending", sessionId: "session", kind: "task_result", dedupeKey: "p",
    payload: {result: {taskId: "task-a"} as never, subscriptionId: "sub"}, status: "running", createdAt: NOW, updatedAt: NOW}).run();
  fixtureTaskResult("b", -10 * MIN);
  expect(schedule(NOW)).toEqual([]);
  expect(schedule(NOW + 45 * MIN)).toHaveLength(1);
});

test("reflection is told the conversation's latest episode so it can extend it", () => {
  const store = new AgentMemoryStore(db.db);
  ask("user:alice", 40 * MIN);
  const first = schedule()[0]!;
  expect(String(command(first).payload.content)).not.toContain("latest episode");
  db.db.update(schema.sessionCommands).set({status: "completed"}).where(eq(schema.sessionCommands.id, first)).run();
  const started = store.add({...writer(), kind: "reflection", sessionId: "session"}, {type: "episode", title: "发起质数统计", description: "用户让我统计 1 到 100 的质数，任务已发起", body: "b", occurredAt: NOW - 30 * MIN}, {participants: ["user:alice"]});
  fixtureTaskResult("a", -5 * MIN);
  const text = String(command(schedule(NOW + 40 * MIN)[0]!).payload.content);
  expect(text).toContain(`This conversation's latest episode is [${started.id}] (revision 1) 发起质数统计: 用户让我统计 1 到 100 的质数，任务已发起`);
  expect(text).toContain(`luna memory update ${started.id} --expected-revision N`);
  expect(text).not.toContain("Luna records every Task Run");
});

test("a reflection extending an episode dates it to now and adds who took part", () => {
  const store = new AgentMemoryStore(db.db), all = {agentId: scope.agentId, all: true as const};
  const episode = store.add({...writer(), kind: "reflection"}, {type: "episode", title: "发起统计", description: "d", body: "b", occurredAt: NOW - DAY}, {participants: ["user:alice"]});
  const extended = store.update({...writer(), kind: "reflection"}, all, episode.id, {expectedRevision: 1, body: "上午发起，下午完成，共 25 个"}, {participants: ["user:alice", "bob"]});
  expect(Math.abs(extended.occurredAt! - Date.now())).toBeLessThan(5000);
  expect(extended.participants).toEqual(["user:alice", "bob"]);
  // An owner's edit keeps the date; an explicit date wins.
  expect(store.update({...writer(), kind: "owner"}, all, episode.id, {expectedRevision: 2, body: "改正文"}).occurredAt).toBe(extended.occurredAt);
  expect(store.update({...writer(), kind: "reflection"}, all, episode.id, {expectedRevision: 3, occurredAt: NOW - 2 * DAY}).occurredAt).toBe(NOW - 2 * DAY);
  // Participants never join an ordinary entry.
  const plain = store.add(writer(), note);
  expect(store.update(writer(), all, plain.id, {expectedRevision: 1, body: "x"}, {participants: ["bob"]}).participants).toEqual([]);
});

test("participants leave out the Agent's own reply identity", async () => {
  const {memoryParticipants} = await import("@/agents/agent-memory-access");
  ask("user:alice", 60 * MIN);
  const bot = db.db.select().from(schema.sessions).where(eq(schema.sessions.id, "session")).get()!.bot_user_id!;
  say(bot, 59 * MIN, "assistant");
  expect(memoryParticipants(db.db, {actorUserId: "user:alice", sessionId: "session", taskId: null})).toEqual(["user:alice"]);
});

test("reflection rechecks the entries this conversation wrote or was shown, and is told to evolve them", () => {
  const store = new AgentMemoryStore(db.db);
  const written = store.add({...writer("reflection"), sessionId: "session"}, {type: "project", title: "ccli hook 因 frida 拿不到不可用", description: "frida 预编译包下载不到", body: "2026-11-18 起不可用"});
  const shown = store.add({...writer(), sessionId: "elsewhere"}, {type: "reference", title: "VQoS 只认 sso_session.json", description: "auth status 不代表可用", body: "b"});
  const unrelated = store.add({...writer(), sessionId: "elsewhere"}, {type: "reference", title: "别的会话的条目", description: "从没在这里出现过", body: "https://elsewhere.example"});
  const context = new RunnerContextStore(db.db).resolveForSession("session", "codex");
  db.db.insert(schema.memoryInjectedEntries).values({runnerContextId: context.id, memoryId: shown.id}).run();
  ask("user:alice", 40 * MIN);
  const text = String(command(schedule()[0]!).payload.content);
  expect(text).toContain(`- [${written.id}] (project, revision 1) ccli hook 因 frida 拿不到不可用: frida 预编译包下载不到`);
  expect(text).toContain(`- [${shown.id}] (reference, revision 1) VQoS 只认 sso_session.json`);
  expect(text).not.toContain(unrelated.id);
  expect(text).toContain("update that entry instead of adding another");
  expect(text).toContain("Put the current conclusion first");
});

test("a conversation that wrote and was shown nothing gets no entry list", () => {
  ask("user:alice", 40 * MIN);
  expect(String(command(schedule()[0]!).payload.content)).not.toContain("Entries this conversation wrote or was shown");
});

test("Main reflection and inline triggers do not re-inject <history> into an existing provider session", async () => {
  const {createSessionTriggerExecutor} = await import("@/sessions/trigger-executor");
  const {MainRunnerFreshLaunchReplayRequiredError, renderMainRunnerPrompt} = await import("@/main-runner/main-runner");
  type RunInput = import("@/main-runner/main-runner").MainRunnerRunInput;

  const contextStore = new RunnerContextStore(db.db);
  const resolved = contextStore.resolveForSession("session", "codex");
  contextStore.persistRunnerSessionId(resolved.id, "provider-session-1");

  const handledId = ask("user:alice", 40 * MIN);
  const packs = new ContextPackStore(db.db);
  const seedPack = packs.createPack({ownerType: "session", ownerId: "session", kind: "session_launch", selectionStrategy: "deterministic_window", createdForInvocationId: "init"});
  packs.addItems(seedPack.id, [{itemKind: "message", itemId: handledId, sourceSessionId: "session", sourceMessageId: handledId, role: "launch_context", reason: "seed"}]);
  db.db.insert(schema.sessionRunnerAttempts).values({
    id: "attempt-1", sessionId: "session", turnId: "turn-init", runnerContextId: resolved.id,
    runnerType: "container", runnerSessionId: "provider-session-1", attemptKind: "primary", attemptIndex: 0,
    status: "parsed", inputPrompt: "<messages/>", rawOutput: "ok", rawOutputTruncated: false,
    startedAt: NOW - 39 * MIN, completedAt: NOW - 39 * MIN, createdAt: NOW - 39 * MIN, updatedAt: NOW - 39 * MIN,
  }).run();

  // 1) Reflection on an existing provider session sends zero <history>.
  const [reflectId] = schedule();
  const capturedPrompts: string[] = [];
  const execReflection = createSessionTriggerExecutor(db.db, () => ({
    run: async (input: RunInput) => {
      capturedPrompts.push(renderMainRunnerPrompt(input.input));
      return {status: "completed", followupReleased: false};
    },
  } as never), () => "codex");
  await execReflection(command(reflectId!), new AbortController().signal);
  expect(capturedPrompts).toHaveLength(1);
  expect(capturedPrompts[0]).not.toContain("<history>");
  expect(capturedPrompts[0]).toContain("<events>");

  // 2) Inline trigger on an existing provider session with no unseen messages also sends zero <history>.
  const quietInline = commands.accept({userId: "user:alice", sourceSessionId: "session", originId: "schedule:daily-1"}, "session", "session.invoke", "daily-1", {content: "daily check", purpose: "notification"});
  capturedPrompts.length = 0;
  await execReflection(command(quietInline.id), new AbortController().signal);
  expect(capturedPrompts).toHaveLength(1);
  expect(capturedPrompts[0]).not.toContain("<history>");

  // 3) Unaddressed user chatter arriving after the last attempt IS included for inline triggers, without launchSeed or handled messages.
  const unseenId = say("bob", 10 * MIN);
  new SessionTimelineStore(db.db).appendMessage({sessionId: "session", messageId: unseenId});
  db.db.update(schema.sessionTimelineEntries).set({createdAt: NOW - 10 * MIN}).where(eq(schema.sessionTimelineEntries.messageId, unseenId)).run();
  const deltaInline = commands.accept({userId: "user:alice", sourceSessionId: "session", originId: "schedule:daily-2"}, "session", "session.invoke", "daily-2", {content: "daily check 2", purpose: "notification"});
  capturedPrompts.length = 0;
  await execReflection(command(deltaInline.id), new AbortController().signal);
  expect(capturedPrompts).toHaveLength(1);
  expect(capturedPrompts[0]).toContain("<history>");
  expect(capturedPrompts[0]).toContain(unseenId);
  expect(capturedPrompts[0]).not.toContain(handledId);
  expect(capturedPrompts[0]).not.toContain("launchSeed");

  // 4) If MainRunner invalidates the provider session (e.g. instructions changed), replay rebuilds fresh-launch context.
  const replayCmd = commands.accept({userId: "user:alice", sourceSessionId: "session", originId: "memory-reflection:replay"}, "session", "session.invoke", "reflect-replay", {content: "reflect", purpose: "notification"});
  let calls = 0;
  capturedPrompts.length = 0;
  const execReplay = createSessionTriggerExecutor(db.db, () => ({
    run: async (input: RunInput) => {
      calls += 1;
      capturedPrompts.push(renderMainRunnerPrompt(input.input));
      if (calls === 1) {
        contextStore.clearRunnerSessionId(resolved.id);
        throw new MainRunnerFreshLaunchReplayRequiredError();
      }
      return {status: "completed", followupReleased: false};
    },
  } as never), () => "codex");
  await execReplay(command(replayCmd.id), new AbortController().signal);
  expect(calls).toBe(2);
  expect(capturedPrompts[0]).not.toContain("<history>");
  expect(capturedPrompts[1]).toContain("<history>");
});
