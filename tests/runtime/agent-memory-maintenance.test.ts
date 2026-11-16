import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {maintainMemory, memoryOriginOfTrigger, scheduleMemoryConsolidations, scheduleMemoryReflections} from "@/agents/agent-memory-maintenance";
import {RunnerContextStore} from "@/runners/runner-context-store";
import {memoryAccess} from "@/agents/agent-memory-access";
import {AgentMemoryStore, type MemoryWriter} from "@/agents/agent-memory-store";
import {SessionCommandService} from "@/messaging/session-command-service";
import {MessageStore} from "@/sessions/message-store";
import {fixtureNamedSession} from "../helpers/platform-fixtures";

const MIN = 60_000, IDLE = 30 * MIN, NOW = 1_800_000_000_000;
let home: string, db: DataConnection<typeof schema>, commands: SessionCommandService, sequence = 0;
let scope: ReturnType<typeof fixtureNamedSession>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-memory-maintenance-")); setLunaHome(home); db = new DataConnection(schema);
  scope = fixtureNamedSession(db.db, "session", "alice");
  commands = new SessionCommandService({db: db.db, channelFor: () => undefined});
});
afterEach(() => { db.close(); rmSync(home, {recursive: true, force: true}); });

function human(id: string) {
  db.db.insert(schema.users).values({id, kind: "human", displayName: id, status: "active", createdAt: "now", updatedAt: "now"}).onConflictDoNothing().run();
}
/** A message in the session, `agoMs` before NOW. */
function say(senderUserId: string, agoMs: number, role: "user" | "assistant" = "user", sessionId = "session") {
  const row = new MessageStore(db.db).appendOnce({sessionId, channelMessageKey: `m-${++sequence}`, role, senderUserId,
    content: [{type: "text", text: "hello"}], channel: {type: "dashboard", id: "dashboard"}}).row;
  db.db.update(schema.messages).set({createdAt: NOW - agoMs}).where(eq(schema.messages.id, row.id)).run();
  return row.id;
}
const schedule = (now = NOW) => scheduleMemoryReflections(db.db, commands, IDLE, now);
const command = (id: string) => db.db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, id)).get()!;

test("an idle session with unreflected human messages gets exactly one silent reflection turn", () => {
  say("alice", 40 * MIN);
  const [id] = schedule();
  expect(command(id!)).toMatchObject({kind: "session.invoke", sessionId: "session", sourceSessionId: "session", actorUserId: "alice", status: "pending"});
  expect(String(command(id!).payload.content)).toContain("LUNA_NOTHING_TO_SEND");
  expect(memoryOriginOfTrigger(db.db, id!)).toBe("reflection");
  expect(memoryOriginOfTrigger(db.db, "unrelated")).toBe("inline");
  expect(schedule()).toEqual([]);
  expect(schedule(NOW + 2 * IDLE)).toEqual([]);
});

test("a session that is still active, or only has Agent replies, is left alone until it goes quiet", () => {
  say("alice", 10 * MIN);
  expect(schedule()).toEqual([]);
  expect(schedule(NOW + 25 * MIN)).toHaveLength(1);
  const reply = new MessageStore(db.db).appendOnce({sessionId: "session", channelMessageKey: "reply", role: "assistant",
    senderUserId: db.db.select().from(schema.sessions).where(eq(schema.sessions.id, "session")).get()!.bot_user_id!,
    content: [{type: "text", text: "done"}], channel: {type: "dashboard", id: "dashboard"}}).row;
  db.db.update(schema.messages).set({createdAt: NOW + 26 * MIN}).where(eq(schema.messages.id, reply.id)).run();
  expect(schedule(NOW + 3 * IDLE)).toEqual([]);
});

test("new human messages after a reflection are reflected on again", () => {
  say("alice", 40 * MIN);
  expect(schedule()).toHaveLength(1);
  say("alice", -5 * MIN);
  expect(schedule(NOW + 10 * MIN)).toEqual([]);
  expect(schedule(NOW + 40 * MIN)).toHaveLength(1);
});

test("reflection runs as the owner only when nobody else spoke, otherwise as the latest other speaker", () => {
  human("bob"); human("carol");
  say("bob", 50 * MIN); say("carol", 45 * MIN); say("alice", 40 * MIN);
  expect(command(schedule()[0]!).actorUserId).toBe("carol");
});

test("history from before the lookback window, inactive sessions and disabled reflection are skipped", () => {
  say("alice", 25 * 60 * MIN);
  expect(schedule()).toEqual([]);
  say("alice", 40 * MIN);
  expect(scheduleMemoryReflections(db.db, commands, 0, NOW)).toEqual([]);
  db.db.update(schema.sessions).set({status: "archived"}).where(eq(schema.sessions.id, "session")).run();
  expect(schedule()).toEqual([]);
});

const DAY = 24 * 60 * MIN;
const consolidate = (now = NOW) => scheduleMemoryConsolidations(db.db, commands, DAY, now);
const writer = (kind: MemoryWriter["kind"] = "inline"): MemoryWriter => ({agentId: scope.agentId, kind, trusted: true, userId: "alice", shadowId: scope.shadowId});
const note = {type: "project" as const, title: "发布冻结", description: "11-20 前冻结发布", body: "不合并功能分支"};

test("consolidation runs once per interval for an Agent whose memory changed, in a dedicated owner session", () => {
  expect(consolidate()).toEqual([]);
  const store = new AgentMemoryStore(db.db);
  const entry = store.add(writer(), note);
  const [id] = consolidate();
  const first = command(id!);
  expect(first).toMatchObject({kind: "session.invoke", actorUserId: "alice", status: "pending"});
  expect(first.sessionId).not.toBe("session");
  expect(db.db.select().from(schema.sessions).where(eq(schema.sessions.id, first.sessionId)).get()).toMatchObject({title: "记忆整理", channel_type: "dashboard", shadow_id: scope.shadowId, created_by_user_id: "alice"});
  expect(String(first.payload.content)).toContain(`1. [${entry.id}] (project, trusted, origin inline, revision 1`);
  expect(String(first.payload.content)).toContain(`Today is ${new Date(NOW).toISOString().slice(0, 10)}`);
  expect(memoryOriginOfTrigger(db.db, id!)).toBe("consolidation");
  expect(consolidate()).toEqual([]);
  expect(consolidate(NOW + 2 * DAY)).toEqual([]);
  store.update(writer("consolidation"), {agentId: scope.agentId, all: true}, entry.id, {expectedRevision: 1, body: "tidied"});
  expect(consolidate(NOW + 2 * DAY)).toEqual([]);
  store.add(writer(), {...note, title: "新事实"});
  expect(consolidate(NOW + DAY / 2)).toEqual([]);
  const again = command(consolidate(NOW + 2 * DAY)[0]!);
  expect(again.sessionId).toBe(first.sessionId);
  expect(scheduleMemoryConsolidations(db.db, commands, 0, NOW + 9 * DAY)).toEqual([]);
});

test("only a consolidation turn of the Agent owner sees every entry", () => {
  human("bob");
  const invocation = {...scope, actorUserId: "alice", sessionId: "session", taskId: null, runnerContextId: "context"};
  expect(memoryAccess(db.db, invocation, "consolidation").viewer).toEqual({agentId: scope.agentId, all: true});
  expect(memoryAccess(db.db, invocation, "consolidation").writer()).toMatchObject({kind: "consolidation", trusted: true});
  expect(memoryAccess(db.db, invocation, "reflection").viewer).toMatchObject({shadowId: scope.shadowId, participants: ["alice"]});
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
  const duplicate = store.add({...writer(), trusted: false, userId: "alice"}, {type: "project", title: "周报的格式", description: "周报不要用表格 改用列表", body: "b", expiresAt: NOW + 30 * DAY});
  store.update(writer(), {agentId: scope.agentId, all: true}, duplicate.id, {expectedRevision: 1, type: "feedback"});
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
  expect(consolidate(NOW + 5 * MIN)).toEqual([]);
  const rest = String(command(consolidate(NOW + 11 * MIN)[0]!).payload.content);
  expect(rest).toContain("3. [");
  expect(rest).not.toContain("4. [");
  expect(db.db.select().from(schema.runnerContexts).where(eq(schema.runnerContexts.id, context.id)).get()!.runner_session_id).toBeNull();
  expect(consolidate(NOW + 30 * MIN)).toEqual([]);
});

test("a maintenance pass forgets first, so expired entries are neither reflected into context nor consolidated", () => {
  const store = new AgentMemoryStore(db.db);
  const expired = store.add(writer(), {...note, expiresAt: NOW - 1});
  const kept = store.add(writer(), {...note, title: "保留"});
  maintainMemory(db.db, commands, {reflectionIdleMs: 0, consolidationIntervalMs: DAY, forgetUnusedMs: 0}, NOW);
  expect(store.listAll(scope.agentId).find(row => row.id === expired.id)!.status).toBe("archived");
  const [queued] = db.db.select().from(schema.sessionCommands).all();
  expect(String(queued!.payload.content)).toContain(kept.id);
  expect(String(queued!.payload.content)).not.toContain(expired.id);
});

test("consolidation shows a duplicate filed under another type and restated inside a longer entry", () => {
  const store = new AgentMemoryStore(db.db);
  const long = store.add(writer(), {type: "project", title: "发布冻结后的接口负责人王芳", description: "用户说明2026-12-05发布冻结后，接口问题找接口负责人王芳。", body: "b"});
  const short = store.add(writer(), {type: "reference", title: "接口问题联系王芳", description: "接口问题找王芳 她是接口负责人", body: "b"});
  const unrelated = store.add(writer(), {type: "feedback", title: "周报格式", description: "周报不要用表格", body: "b"});
  const person = store.add(writer(), {type: "person", title: "王芳", description: "接口负责人王芳 接口问题找她", body: "b", subjectUserId: "wangfang"});
  const text = String(command(consolidate()[0]!).payload.content);
  expect(text).toContain(`1. [${long.id}] (project`);
  expect(text.split("\n")[text.split("\n").findIndex(line => line.startsWith("1. [")) + 1]).toContain(`- similar: [${short.id}] (reference`);
  expect(text).toContain(`   - similar: [${long.id}] (project`);
  expect(text).not.toContain(`similar: [${unrelated.id}]`);
  expect(text).not.toContain(`similar: [${person.id}]`);
  expect(text).toContain("even under different titles, wording or types");
});
