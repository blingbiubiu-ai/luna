import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {config, setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {AgentMemoryStore, type MemoryWriter} from "@/agents/agent-memory-store";
import {memoryInjection} from "@/agents/agent-memory-injection";
import {RunnerContextStore} from "@/runners/runner-context-store";
import {AuthorizationRuleStore} from "@/server/policy/authorization-rule-store";
import {fixtureNamedSession} from "../helpers/platform-fixtures";
import {MessageStore} from "@/sessions/message-store";

let home: string, db: DataConnection<typeof schema>, store: AgentMemoryStore, contexts: RunnerContextStore;
let scope: ReturnType<typeof fixtureNamedSession>, contextId: string, sibling: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-memory-injection-")); setLunaHome(home); db = new DataConnection(schema);
  scope = fixtureNamedSession(db.db, "session", "alice");
  sibling = new AgentStore(db.db).createShadow("alice", scope.agentId, {name: "sibling"}, "sibling").id;
  store = new AgentMemoryStore(db.db); contexts = new RunnerContextStore(db.db);
  contextId = contexts.resolveForSession("session", "codex").id;
});
afterEach(() => { db.close(); rmSync(home, {recursive: true, force: true}); });

const here = (): MemoryWriter => ({agentId: scope.agentId, kind: "inline", trusted: true, userId: "alice", shadowId: scope.shadowId, sessionId: "session", contextId});
const elsewhere = (): MemoryWriter => ({agentId: scope.agentId, kind: "inline", trusted: true, userId: "alice", shadowId: sibling, sessionId: "other-session", contextId: "other-context"});
const all = {get agentId() { return scope.agentId; }, all: true as const};
const inject = (message?: string) => memoryInjection(db.db, {...scope, actorUserId: "alice", sessionId: "session", taskId: null, runnerContextId: contextId}, message);
const rule = {type: "feedback" as const, title: "回复语言", description: "对外回复一律用中文", body: "中文", core: true};
const weekly = {type: "feedback" as const, title: "周报格式", description: "周报不要用表格", body: "用列表"};
const freeze = {type: "project" as const, title: "发布冻结", description: "11-20 前冻结发布", body: "不合并功能分支"};
/** One completed turn: the provider reports its session id, then the turn is committed. */
const turn = (message?: string, sessionId = "provider-1") => { const injection = inject(message); contexts.persistRunnerSessionId(contextId, sessionId); injection.commit(); return injection.text; };

test("a conversation starts with core entries and entries about the people present, not the whole memory", () => {
  expect(inject("你好").text).toBeUndefined();
  const core = store.add(elsewhere(), rule);
  store.add(elsewhere(), weekly); store.add(elsewhere(), freeze);
  const me = store.add(elsewhere(), {type: "person", title: "Alice", description: "只要结论", body: "b", subjectUserId: "alice"});
  store.add(elsewhere(), {type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan"});
  const first = turn("你好")!;
  expect(first).toContain("## Agent memory: always in effect");
  expect(first).toContain(`- [${core.id}] (feedback) 回复语言: 对外回复一律用中文 (from alice, `);
  expect(first).toContain(`[${me.id}] (person) Alice`);
  expect(first).not.toContain("张三");
  expect(first).not.toContain("周报格式");
  expect(first).not.toContain("发布冻结");
  expect(first).not.toContain("possibly relevant");
  expect(turn("你好")).toBeUndefined();
});

test("each turn recalls what the message brings to mind, once per conversation and within the limit", () => {
  const entry = store.add(elsewhere(), weekly);
  store.add(elsewhere(), freeze);
  expect(turn("今天天气怎么样")).toBeUndefined();
  const recalled = turn("帮我按周报格式写一下这周的周报")!;
  expect(recalled).toContain("## Agent memory: possibly relevant");
  expect(recalled).toContain(`[${entry.id}] (feedback) 周报格式`);
  expect(recalled).not.toContain("发布冻结");
  expect(recalled).not.toContain("用列表");
  expect(turn("再按周报格式写一份周报")).toBeUndefined();
  expect(turn()).toBeUndefined();
  for (let i = 0; i < config.memory.recall_limit + 3; i++) store.add(elsewhere(), {...freeze, title: `冻结安排 ${i}`, description: `第 ${i} 次发布冻结安排`}, );
  expect(turn("发布冻结安排是什么")!.split("\n").filter(line => line.startsWith("- ["))).toHaveLength(config.memory.recall_limit);
});

test("later turns report changes made elsewhere only for entries this conversation was shown, and for core and person entries", () => {
  const core = store.add(elsewhere(), rule), shown = store.add(elsewhere(), weekly), unseen = store.add(elsewhere(), freeze);
  turn("帮我按周报格式写周报");
  store.update(elsewhere(), all, unseen.id, {expectedRevision: 1, description: "改到 11-25 冻结"});
  store.add(elsewhere(), {type: "reference", title: "看板", description: "项目看板地址", body: "b"});
  store.add(here(), {...freeze, title: "本会话写的", core: true, type: "feedback"});
  expect(turn("继续")).toBeUndefined();
  store.update(elsewhere(), all, shown.id, {expectedRevision: 1, description: "周报改用表格"});
  store.remove(elsewhere(), all, core.id, 1);
  const added = store.add(elsewhere(), {...rule, title: "新规则", description: "线上操作先确认"});
  const person = store.add(elsewhere(), {type: "person", title: "Alice", description: "只要结论", body: "b", subjectUserId: "alice"});
  const delta = turn("继续")!;
  expect(delta).toContain("## Agent memory updates");
  expect(delta).toContain("周报改用表格");
  expect(delta).toContain(`- removed [${core.id}] 回复语言`);
  expect(delta).toContain(`[${added.id}] (feedback) 新规则`);
  expect(delta).toContain(`[${person.id}] (person) Alice`);
  expect(delta).not.toContain("11-25");
  expect(delta).not.toContain("看板");
  expect(delta).not.toContain("本会话写的");
  expect(turn("继续")).toBeUndefined();
  db.db.update(schema.agentMemories).set({expiresAt: 1}).run();
  store.forget(0);
  expect(turn("继续")).toContain(`- removed [${shown.id}] 周报格式`);
});

test("an uncommitted injection is repeated, and a new provider session starts over", () => {
  const core = store.add(elsewhere(), rule), entry = store.add(elsewhere(), weekly);
  expect(inject("写周报格式的周报").text).toContain(core.id);
  expect(inject("写周报格式的周报").text).toContain(entry.id);
  turn("写周报格式的周报");
  expect(inject("写周报格式的周报").text).toBeUndefined();
  contexts.clearRunnerSessionId(contextId);
  const fresh = inject("写周报格式的周报").text!;
  expect(fresh).toContain("## Agent memory: always in effect");
  expect(fresh).toContain(entry.id);
  expect(turn("写周报格式的周报", "provider-2")).toContain(entry.id);
  expect(turn("写周报格式的周报", "provider-2")).toBeUndefined();
});

test("injection respects visibility and an explicit deny of memory.read", () => {
  store.add(elsewhere(), {...rule, title: "分身私有规则", visibility: "shadow"});
  store.add(elsewhere(), {...weekly, visibility: "shadow"});
  expect(inject("写周报格式的周报").text).toBeUndefined();
  store.add(elsewhere(), rule);
  expect(inject("你好").text).toContain("回复语言");
  new AuthorizationRuleStore(db.db, {kind: "agent", agentId: scope.agentId}).addGrant({subjectType: "user", subjectId: "alice", target: "memory.read", effect: "deny"});
  expect(inject("你好").text).toBeUndefined();
});

test("a conversation is told who this Shadow is in full, and later only when the owner changed it elsewhere", () => {
  const ownerHere: MemoryWriter = {...elsewhere(), shadowId: scope.shadowId, owner: true};
  const soul = store.add(ownerHere, {type: "persona", title: "身份", description: "名字和语气", body: "你叫小黑，语气活泼。\n遇到不确定的事先问清楚。"});
  store.add({...ownerHere, shadowId: sibling}, {type: "persona", title: "身份", description: "别的分身", body: "你叫小白。"});
  store.add(elsewhere(), rule);
  const first = turn("你好")!;
  expect(first.indexOf("## Who you are")).toBe(0);
  expect(first).toContain(`### 身份 [${soul.id}]\n你叫小黑，语气活泼。\n遇到不确定的事先问清楚。`);
  expect(first).not.toContain("小白");
  expect(first.indexOf("## Agent memory: always in effect")).toBeGreaterThan(first.indexOf("小黑"));
  expect(first.split("## Agent memory: always in effect")[1]).not.toContain("身份");
  expect(turn("你叫什么名字，语气是什么")).toBeUndefined();
  store.update(ownerHere, all, soul.id, {expectedRevision: 1, body: "你叫大黑。"});
  const delta = turn("继续")!;
  expect(delta).toContain("## Agent memory updates");
  expect(delta).toContain(`This part of who you are changed:\n### 身份 [${soul.id}]\n你叫大黑。`);
  store.remove(ownerHere, all, soul.id, 2);
  expect(turn("继续")).toContain(`- removed [${soul.id}] 身份`);
});

test("a conversation is told about people who join it later, and that an entry it was shown is no longer visible", () => {
  const shared = store.add(elsewhere(), weekly);
  turn("帮我按周报格式写周报");
  const bob = store.add(elsewhere(), {type: "person", title: "Bob", description: "喜欢先看结论", body: "b", subjectUserId: "bob"});
  expect(turn("继续")).toBeUndefined();
  // bob speaks in the session: what was known about him before is told now.
  db.db.insert(schema.users).values({id: "bob", kind: "human", displayName: "Bob", status: "active", createdAt: "now", updatedAt: "now"}).run();
  new MessageStore(db.db).appendOnce({sessionId: "session", channelMessageKey: "bob-1", role: "user", senderUserId: "bob",
    content: [{type: "text", text: "我也在"}], channel: {type: "dashboard", id: "dashboard"}});
  expect(turn("继续")).toContain(`[${bob.id}] (person) Bob`);
  expect(turn("继续")).toBeUndefined();
  // Made private to another Shadow: no longer visible here, so the conversation stops relying on it.
  store.update(elsewhere(), all, shared.id, {expectedRevision: 1, visibility: "shadow"});
  expect(turn("继续")).toContain(`- removed [${shared.id}] 周报格式`);
});

test("an entry recalled into a committed turn counts as used; standing entries do not", () => {
  const core = store.add(elsewhere(), rule), entry = store.add(elsewhere(), weekly);
  db.db.update(schema.agentMemories).set({lastUsedAt: 1}).run();
  inject("帮我按周报格式写周报");
  expect(store.page(scope.agentId, {limit: 200}).entries.map(row => row.lastUsedAt)).toEqual([1, 1]);
  turn("帮我按周报格式写周报");
  const used = Object.fromEntries(store.page(scope.agentId, {limit: 200}).entries.map(row => [row.id, row.lastUsedAt]));
  expect(used[entry.id]).toBeGreaterThan(1);
  expect(used[core.id]).toBe(1);
});
