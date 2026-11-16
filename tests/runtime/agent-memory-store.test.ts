import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {eq, sql} from "drizzle-orm";
import {AgentMemoryStore, MemoryConflictError, MemoryDuplicateError, memoryTerms, type MemoryViewer, type MemoryWriter} from "@/agents/agent-memory-store";
import {fixtureScope} from "../helpers/platform-fixtures";

let home: string, db: DataConnection<typeof schema>, store: AgentMemoryStore;
let a: ReturnType<typeof fixtureScope>, b: ReturnType<typeof fixtureScope>, sibling: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-memory-")); setLunaHome(home); db = new DataConnection(schema);
  a = fixtureScope(db.db, "alice"); b = fixtureScope(db.db, "bob");
  sibling = new AgentStore(db.db).createShadow("alice", a.agentId, {name: "sibling"}, "sibling").id;
  store = new AgentMemoryStore(db.db);
});
afterEach(() => { db.close(); rmSync(home, {recursive: true, force: true}); });

const owner = (shadowId = a.shadowId): MemoryWriter => ({agentId: a.agentId, kind: "inline", trusted: true, userId: "alice", shadowId});
const member = (userId: string, shadowId = a.shadowId): MemoryWriter => ({agentId: a.agentId, kind: "inline", trusted: false, userId, shadowId});
const viewer = (shadowId: string, ...participants: string[]): MemoryViewer => ({agentId: a.agentId, shadowId, participants});
const note = {type: "project" as const, title: "发布冻结", description: "11-20 前冻结发布", body: "11-20 前不合并功能分支"};

test("entries are shared across Shadows of one Agent and isolated between Agents", () => {
  const entry = store.add(owner(), note);
  expect(store.get(viewer(sibling), entry.id).title).toBe("发布冻结");
  expect(() => store.get({agentId: b.agentId, shadowId: b.shadowId, participants: []}, entry.id)).toThrow("memory_not_found");
  expect(store.index({agentId: b.agentId, all: true}).entries).toEqual([]);
});

test("shadow-only entries stay with their origin Shadow", () => {
  const entry = store.add(owner(), {...note, visibility: "shadow"});
  expect(store.get(viewer(a.shadowId), entry.id).id).toBe(entry.id);
  expect(() => store.get(viewer(sibling), entry.id)).toThrow("memory_not_found");
  expect(store.search(viewer(sibling), "冻结")).toEqual([]);
  expect(() => store.add({...owner(), shadowId: null}, {...note, visibility: "shadow"})).toThrow("invalid_memory_visibility");
});

test("person entries are visible only while their subject participates", () => {
  const entry = store.add(owner(), {type: "person", title: "张三", description: "只要结论", body: "不要过程", subjectUserId: "zhangsan"});
  expect(store.index(viewer(sibling, "zhangsan")).entries.map(row => row.id)).toEqual([entry.id]);
  expect(store.index(viewer(sibling, "lisi")).entries).toEqual([]);
  expect(store.index(viewer(sibling)).entries).toEqual([]);
  expect(store.search(viewer(sibling, "lisi"), "结论")).toEqual([]);
  expect(() => store.get(viewer(sibling, "lisi"), entry.id)).toThrow("memory_not_found");
  expect(() => store.add(owner(), {...note, type: "person"})).toThrow("invalid_memory_subject");
  expect(() => store.add(owner(), {...note, subjectUserId: "zhangsan"})).toThrow("invalid_memory_subject");
});

test("untrusted writers cannot change how the Agent works or describe other people", () => {
  for (const type of ["feedback", "procedure"] as const) expect(() => store.add(member("lisi"), {...note, type})).toThrow("memory_write_forbidden");
  expect(() => store.add(member("lisi"), {type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan"})).toThrow("memory_write_forbidden");
  const self = store.add(member("lisi"), {type: "person", title: "李四", description: "d", body: "b", subjectUserId: "lisi"});
  expect(self.trusted).toBe(false);
  const fact = store.add(member("lisi"), note);
  expect(() => store.update(member("lisi"), viewer(a.shadowId), fact.id, {expectedRevision: 1, type: "feedback"})).toThrow("memory_write_forbidden");
});

test("untrusted writers cannot overwrite or delete trusted entries, and a trusted correction protects the entry", () => {
  const trusted = store.add(owner(), note);
  expect(() => store.update(member("lisi"), viewer(a.shadowId), trusted.id, {expectedRevision: 1, body: "poison"})).toThrow("memory_protected");
  expect(() => store.remove(member("lisi"), viewer(a.shadowId), trusted.id, 1)).toThrow("memory_protected");
  const poisoned = store.add(member("lisi"), {...note, body: "poison"});
  const corrected = store.update(owner(sibling), viewer(sibling), poisoned.id, {expectedRevision: 1, body: "corrected"});
  expect(corrected).toMatchObject({body: "corrected", trusted: true, revision: 2});
  expect(() => store.update(member("lisi"), viewer(a.shadowId), poisoned.id, {expectedRevision: 2, body: "poison again"})).toThrow("memory_protected");
});

test("each entry has its own revision; stale writes fail without affecting other entries", () => {
  const first = store.add(owner(), note), second = store.add(owner(sibling), {...note, title: "另一条"});
  store.update(owner(), viewer(a.shadowId), first.id, {expectedRevision: 1, body: "v2"});
  expect(store.update(owner(sibling), viewer(sibling), second.id, {expectedRevision: 1, body: "independent"}).revision).toBe(2);
  let conflict: unknown;
  try { store.update(owner(sibling), viewer(sibling), first.id, {expectedRevision: 1, body: "lost update"}); } catch (error) { conflict = error; }
  expect(conflict).toBeInstanceOf(MemoryConflictError);
  expect((conflict as MemoryConflictError).currentRevision).toBe(2);
  expect(store.get(viewer(a.shadowId), first.id).body).toBe("v2");
});

test("deleted and superseded entries leave the index but keep history, and a revision can be restored", () => {
  const old = store.add(owner(), note), replacement = store.add(owner(), {...note, title: "新冻结日期"});
  store.update(owner(), viewer(a.shadowId), old.id, {expectedRevision: 1, body: "v2"});
  store.remove(owner(), viewer(a.shadowId), old.id, 2, replacement.id);
  expect(store.index(viewer(a.shadowId)).entries.map(row => row.id)).toEqual([replacement.id]);
  expect(store.listAll(a.agentId).find(row => row.id === old.id)).toMatchObject({status: "superseded", supersededBy: replacement.id});
  expect(store.history(a.agentId, old.id).map(row => row.revision)).toEqual([3, 2, 1]);
  expect(() => store.history(b.agentId, old.id)).toThrow("memory_not_found");
  const dashboard: MemoryWriter = {agentId: a.agentId, kind: "owner", trusted: true, userId: "alice", shadowId: null};
  const restored = store.restore(dashboard, old.id, 1, 3);
  expect(restored).toMatchObject({status: "active", body: note.body, revision: 4, supersededBy: null});
  expect(store.history(a.agentId, old.id)).toHaveLength(4);
  store.remove(owner(), viewer(a.shadowId), replacement.id, 1);
  expect(() => store.get(viewer(a.shadowId), replacement.id)).toThrow("memory_not_found");
});

test("search ranks title over description over body and matches short Chinese words", () => {
  const body = store.add(owner(), {...note, title: "其他", description: "无关", body: "这里提到周报"});
  const title = store.add(owner(), {type: "feedback", title: "周报格式", description: "不要用表格", body: "用列表"});
  const description = store.add(owner(), {...note, title: "汇报", description: "周报每周五发", body: "发给负责人"});
  expect(store.search(viewer(a.shadowId), "周报").map(row => row.id)).toEqual([title.id, description.id, body.id]);
  expect(store.search(viewer(a.shadowId), "周报", {type: "feedback"}).map(row => row.id)).toEqual([title.id]);
  expect(store.search(viewer(a.shadowId), "100%_")).toEqual([]);
  expect(() => store.search(viewer(a.shadowId), "  ")).toThrow("memory_query_required");
});

test("index puts person and behavior entries first and reports what the limit left out", () => {
  const project = store.add(owner(), note);
  const reference = store.add(owner(), {...note, type: "reference", title: "看板"});
  const feedback = store.add(owner(), {...note, type: "feedback", title: "周报格式"});
  const person = store.add(owner(), {type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan"});
  const all = store.index(viewer(a.shadowId, "zhangsan"));
  expect(all.entries.map(row => row.id)).toEqual([person.id, feedback.id, project.id, reference.id]);
  expect(store.index(viewer(a.shadowId, "zhangsan"), {limit: 2})).toMatchObject({omitted: 2, entries: [{id: person.id}, {id: feedback.id}]});
});

test("input limits are enforced", () => {
  expect(() => store.add(owner(), {...note, title: "x".repeat(121)})).toThrow("invalid_memory_title");
  expect(() => store.add(owner(), {...note, description: "x".repeat(201)})).toThrow("invalid_memory_description");
  expect(() => store.add(owner(), {...note, body: "x".repeat(8 * 1024 + 1)})).toThrow("invalid_memory_body");
  expect(() => store.add(owner(), {...note, body: "  "})).toThrow("invalid_memory_body");
});

test("changes report what other sessions changed or removed, and skip a Runner context's own writes", () => {
  const before = store.latestSeq();
  const mine = store.add({...owner(), contextId: "c1"}, note);
  const theirs = store.add({...owner(sibling), contextId: "c2"}, {...note, title: "别处新增"});
  const gone = store.add({...owner(sibling), contextId: "c2"}, {...note, title: "被删除"});
  store.remove({...owner(sibling), contextId: "c2"}, viewer(sibling), gone.id, 1);
  const hidden = store.add({...owner(sibling), contextId: "c2"}, {type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan"});
  const seen = store.changes(viewer(a.shadowId), before, "c1");
  expect(seen.changed.map(row => row.id)).toEqual([theirs.id]);
  expect(seen.removed.map(row => row.id)).toEqual([gone.id]);
  expect(store.changes(viewer(a.shadowId), before, null).changed.map(row => row.id).sort()).toEqual([mine.id, theirs.id].sort());
  expect(store.changes(viewer(a.shadowId, "zhangsan"), before, "c1").changed.map(row => row.id)).toContain(hidden.id);
  expect(store.changes(viewer(a.shadowId), store.latestSeq(), "c1")).toEqual({changed: [], removed: []});
});

test("index pages cover every entry exactly once", () => {
  const ids = Array.from({length: 7}, (_, i) => store.add(owner(), {...note, title: `条目 ${i}`}).id);
  const seen: string[] = [];
  for (let offset = 0; ;) {
    const page = store.index(viewer(a.shadowId), {limit: 3, offset});
    expect(page.total).toBe(7);
    seen.push(...page.entries.map(row => row.id));
    offset += page.entries.length;
    expect(page.omitted).toBe(7 - offset);
    if (!page.omitted) break;
  }
  expect(seen.sort()).toEqual([...ids].sort());
  expect(store.index(viewer(a.shadowId), {limit: 3, offset: 9})).toMatchObject({entries: [], omitted: 0, total: 7});
});

const DAY = 24 * 60 * 60 * 1000;
const everything = (): MemoryViewer => ({agentId: a.agentId, all: true});

test("terms are words for spaced scripts and two-character pieces for Chinese", () => {
  expect(memoryTerms("帮我写周报 Release v2")).toEqual(["帮我", "我写", "写周", "周报", "release", "v2"]);
  expect(memoryTerms("  ，。 ")).toEqual([]);
});

test("recall finds entries from a whole Chinese sentence and ignores weak, excluded or archived matches", () => {
  const weekly = store.add(owner(), {type: "feedback", title: "周报格式", description: "周报不要用表格", body: "用列表"});
  const freeze = store.add(owner(), note);
  store.add(owner(), {...note, title: "看板", description: "项目看板地址", body: "正文里才提到周报格式"});
  expect(store.recall(viewer(a.shadowId), "帮我按周报格式写一下这周的周报", {limit: 8}).map(row => row.id)).toEqual([weekly.id]);
  expect(store.recall(viewer(a.shadowId), "发布什么时候冻结发布", {limit: 8}).map(row => row.id)).toEqual([freeze.id]);
  expect(store.recall(viewer(a.shadowId), "今天天气怎么样", {limit: 8})).toEqual([]);
  expect(store.recall(viewer(a.shadowId), "帮我按周报格式写周报", {limit: 8, exclude: [weekly.id]})).toEqual([]);
  expect(store.recall(viewer(a.shadowId), "帮我按周报格式写周报", {limit: 0})).toEqual([]);
  expect(store.recall(viewer(sibling), "帮我按周报格式写周报", {limit: 8}).map(row => row.id)).toEqual([weekly.id]);
  db.db.update(schema.agentMemories).set({status: "archived"}).where(eq(schema.agentMemories.id, weekly.id)).run();
  expect(store.recall(viewer(a.shadowId), "帮我按周报格式写周报", {limit: 8})).toEqual([]);
  expect(store.search(viewer(a.shadowId), "周报格式", {archived: true}).map(row => row.id)).toEqual([weekly.id]);
});

test("adding what an existing entry already says is rejected with the candidates unless forced", () => {
  const first = store.add(owner(), {type: "feedback", title: "周报格式", description: "周报不要用表格", body: "用列表"});
  const again = {type: "feedback" as const, title: "周报的格式", description: "周报不要用表格", body: "别用表格"};
  let error: unknown;
  try { store.add(owner(sibling), again, {duplicatesFor: viewer(sibling)}); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(MemoryDuplicateError);
  expect((error as MemoryDuplicateError).candidates.map(row => row.id)).toEqual([first.id]);
  expect(store.add(owner(sibling), again, {duplicatesFor: viewer(sibling), force: true}).id).not.toBe(first.id);
  expect(() => store.add(owner(), {...again, type: "procedure"}, {duplicatesFor: viewer(a.shadowId)})).not.toThrow();
  expect(() => store.add(owner(), {type: "feedback", title: "回复语言", description: "对外回复一律用中文", body: "中文"}, {duplicatesFor: viewer(a.shadowId)})).not.toThrow();
  const hidden = store.add(owner(), {...note, visibility: "shadow"});
  expect(() => store.add(owner(sibling), note, {duplicatesFor: viewer(sibling)})).not.toThrow();
  expect(hidden.visibility).toBe("shadow");
});

test("core entries need a trusted writer, cannot be person entries and are capped per Agent", () => {
  const capped = new AgentMemoryStore(db.db, {core: 2, shadowCore: 1});
  const rule = {type: "feedback" as const, description: "d", body: "b", core: true};
  const first = capped.add(owner(), {...rule, title: "规则一"}), second = capped.add(owner(), {...rule, title: "规则二"});
  expect(() => capped.add(owner(), {...rule, title: "规则三"})).toThrow("memory_core_full");
  const plain = capped.add(owner(), {...rule, title: "规则三", core: false});
  expect(() => capped.update(owner(), viewer(a.shadowId), plain.id, {expectedRevision: 1, core: true})).toThrow("memory_core_full");
  capped.update(owner(), viewer(a.shadowId), first.id, {expectedRevision: 1, core: false});
  expect(capped.update(owner(), viewer(a.shadowId), plain.id, {expectedRevision: 1, core: true}).core).toBe(true);
  expect(capped.update(owner(), viewer(a.shadowId), second.id, {expectedRevision: 1, body: "改正文不占新名额"}).core).toBe(true);
  expect(() => capped.add(member("lisi"), {...note, core: true})).toThrow("memory_write_forbidden");
  expect(() => capped.add(owner(), {type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan", core: true})).toThrow("invalid_memory_core");
  const person = capped.add(owner(), {type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan"});
  const standing = capped.standing(viewer(a.shadowId, "zhangsan")).map(row => row.id);
  expect(standing.slice(0, 2).sort()).toEqual([second.id, plain.id].sort());
  expect(standing.slice(2)).toEqual([person.id]);
  expect(capped.standing(viewer(a.shadowId)).some(row => row.id === person.id)).toBe(false);
  expect(new AgentMemoryStore(db.db, {core: 2, shadowCore: 1}).add({...owner(), agentId: b.agentId, shadowId: b.shadowId, userId: "bob"}, {...rule, title: "别的 Agent"}).core).toBe(true);
});

test("forgetting archives expired and long-unused entries, spares core ones, and reading keeps an entry alive", () => {
  const now = Date.now();
  const expiring = store.add(owner(), {...note, expiresAt: now + DAY});
  const unused = store.add(member("lisi"), {...note, title: "没人用"});
  const used = store.add(owner(), {...note, title: "常用"});
  const core = store.add(owner(), {type: "feedback", title: "规则", description: "d", body: "b", core: true});
  expect(store.forget(180 * DAY, now + 100 * DAY)).toBe(1);
  expect(store.listAll(a.agentId).find(row => row.id === expiring.id)).toMatchObject({status: "archived", revision: 2, trusted: true});
  expect(store.history(a.agentId, expiring.id)[0]).toMatchObject({changeKind: "forgetting", changedByUserId: null, snapshot: {status: "archived"}});
  store.use(viewer(a.shadowId), used.id, now + 150 * DAY);
  expect(store.forget(180 * DAY, now + 181 * DAY)).toBe(1);
  const after = Object.fromEntries(store.listAll(a.agentId).map(row => [row.id, row.status]));
  expect(after).toMatchObject({[unused.id]: "archived", [used.id]: "active", [core.id]: "active"});
  expect(store.listAll(a.agentId).find(row => row.id === unused.id)!.trusted).toBe(false);
  expect(store.forget(0, now + 9999 * DAY)).toBe(0);
  expect(store.index(viewer(a.shadowId)).entries.map(row => row.id).sort()).toEqual([used.id, core.id].sort());
  expect(() => store.add(owner(), {...note, expiresAt: -1})).toThrow("invalid_memory_expiry");
});

test("an archived entry can still be read and searched, and restoring it clears a passed expiry", () => {
  const now = Date.now();
  const entry = store.add(owner(), {...note, expiresAt: now - 1});
  store.forget(0, now);
  expect(store.get(viewer(sibling), entry.id).status).toBe("archived");
  expect(store.use(viewer(sibling), entry.id).lastUsedAt).toBe(entry.lastUsedAt);
  expect(store.search(viewer(sibling), "冻结")).toEqual([]);
  expect(store.search(viewer(sibling), "冻结", {archived: true}).map(row => row.id)).toEqual([entry.id]);
  expect(() => store.unarchive(member("lisi"), viewer(a.shadowId), entry.id, 2)).toThrow("memory_protected");
  const restored = store.unarchive(owner(sibling), viewer(sibling), entry.id, 2);
  expect(restored).toMatchObject({status: "active", revision: 3, expiresAt: null});
  expect(restored.lastUsedAt).toBeGreaterThanOrEqual(now);
  expect(() => store.unarchive(owner(), viewer(a.shadowId), entry.id, 3)).toThrow("memory_not_archived");
  expect(store.forget(180 * DAY, now + 3 * DAY)).toBe(0);
});

test("the owner page filters, searches and pages on the server", () => {
  for (let i = 0; i < 5; i++) store.add(owner(), {...note, title: `条目 ${i}`});
  const feedback = store.add(owner(sibling), {type: "feedback", title: "周报格式", description: "不要用表格", body: "100% 用列表", core: true});
  const gone = store.add(owner(), {...note, title: "删掉的"}); store.remove(owner(), viewer(a.shadowId), gone.id, 1);
  expect(store.page(a.agentId)).toMatchObject({total: 7});
  expect(store.page(a.agentId, {status: "active", limit: 2, offset: 4})).toMatchObject({total: 6, entries: [{}, {}]});
  expect(store.page(a.agentId, {status: "active", limit: 2, offset: 6}).entries).toEqual([]);
  expect(store.page(a.agentId, {type: "feedback"}).entries.map(row => row.id)).toEqual([feedback.id]);
  expect(store.page(a.agentId, {core: true, originShadowId: sibling}).entries.map(row => row.id)).toEqual([feedback.id]);
  expect(store.page(a.agentId, {status: "deleted"}).entries.map(row => row.id)).toEqual([gone.id]);
  expect(store.page(a.agentId, {query: "100%"}).entries.map(row => row.id)).toEqual([feedback.id]);
  expect(store.page(a.agentId, {query: "%"}).total).toBe(1);
  expect(store.page(b.agentId).total).toBe(0);
});

test("changedSince lists what consolidation has not covered, and reindex repairs entries without terms", () => {
  const first = store.add(owner(), note), second = store.add(owner(), {...note, title: "第二条"});
  store.update({...owner(), kind: "consolidation"}, everything(), first.id, {expectedRevision: 1, body: "tidied"});
  expect(store.changedSince(a.agentId, 0, 10).map(row => row.id)).toEqual([second.id]);
  expect(store.changedSince(a.agentId, second.changeSeq, 10)).toEqual([]);
  const third = store.add(owner(), {...note, title: "第三条"});
  expect(store.changedSince(a.agentId, 0, 1).map(row => row.id)).toEqual([second.id]);
  expect(store.changedSince(a.agentId, second.changeSeq, 10).map(row => row.id)).toEqual([third.id]);
  db.db.run(sql`DELETE FROM agent_memory_terms`);
  expect(store.search(viewer(a.shadowId), "冻结")).toEqual([]);
  expect(store.reindex()).toBe(3);
  expect(store.reindex()).toBe(0);
  expect(store.search(viewer(a.shadowId), "冻结")).toHaveLength(3);
});

test("Shadow-private core entries use that Shadow's own allowance, not the Agent's shared one", () => {
  const capped = new AgentMemoryStore(db.db, {core: 1, shadowCore: 1});
  const rule = {type: "feedback" as const, description: "d", body: "b", core: true};
  const shared = capped.add(owner(), {...rule, title: "共享规则"});
  const mine = capped.add(owner(), {...rule, title: "本体规则", visibility: "shadow"});
  const theirs = capped.add(owner(sibling), {...rule, title: "分身规则", visibility: "shadow"});
  expect(() => capped.add(owner(), {...rule, title: "本体规则二", visibility: "shadow"})).toThrow("memory_core_full");
  expect(() => capped.add(owner(sibling), {...rule, title: "共享规则二"})).toThrow("memory_core_full");
  expect([capped.coreUsed(a.agentId, null), capped.coreUsed(a.agentId, a.shadowId), capped.coreUsed(a.agentId, sibling)]).toEqual([1, 1, 1]);
  // Moving between allowances needs room in the target one.
  expect(() => capped.update(owner(), viewer(a.shadowId), mine.id, {expectedRevision: 1, visibility: "agent"})).toThrow("memory_core_full");
  capped.update(owner(), viewer(a.shadowId), shared.id, {expectedRevision: 1, core: false});
  expect(capped.update(owner(), viewer(a.shadowId), mine.id, {expectedRevision: 1, visibility: "agent"})).toMatchObject({core: true, visibility: "agent"});
  expect(capped.standing(viewer(a.shadowId)).map(row => row.id)).toEqual([mine.id]);
  expect(capped.standing(viewer(sibling)).map(row => row.id).sort()).toEqual([mine.id, theirs.id].sort());
});

test("persona entries belong to one Shadow, are written only for the Agent owner, and stay out of forgetting, recall and consolidation", () => {
  const forOwner = (shadowId = a.shadowId): MemoryWriter => ({...owner(shadowId), owner: true});
  const soul = {type: "persona" as const, title: "身份", description: "名字和语气", body: "你叫小黑，语气活泼。"};
  const mine = store.add(forOwner(), soul);
  expect(mine).toMatchObject({type: "persona", visibility: "shadow", originShadowId: a.shadowId, core: false, trusted: true});
  // A trusted writer who is not the owner, and an untrusted one, cannot write or touch identity.
  expect(() => store.add(owner(), soul)).toThrow("memory_write_forbidden");
  expect(() => store.add(member("lisi"), soul)).toThrow("memory_write_forbidden");
  expect(() => store.update(owner(), viewer(a.shadowId), mine.id, {expectedRevision: 1, body: "你叫小白"})).toThrow("memory_protected");
  expect(() => store.remove(owner(), viewer(a.shadowId), mine.id, 1)).toThrow("memory_protected");
  expect(() => store.add(forOwner(), {...soul, visibility: "agent"})).toThrow("invalid_memory_persona");
  expect(() => store.add(forOwner(), {...soul, core: true})).toThrow("invalid_memory_core");
  expect(() => store.add(forOwner(), {...soul, expiresAt: Date.now() + DAY})).toThrow("invalid_memory_persona");
  expect(() => store.add({...forOwner(), shadowId: null}, soul)).toThrow("invalid_memory_visibility");
  expect(() => store.update(forOwner(), viewer(a.shadowId), mine.id, {expectedRevision: 1, type: "feedback"})).toThrow("invalid_memory_type");
  const plain = store.add(forOwner(), note);
  expect(() => store.update(forOwner(), viewer(a.shadowId), plain.id, {expectedRevision: 1, type: "persona"})).toThrow("invalid_memory_type");
  // Only its own Shadow sees it; a second identical entry for another Shadow is not a duplicate.
  expect(store.standing(viewer(a.shadowId)).map(row => row.id)).toEqual([mine.id]);
  expect(store.standing(viewer(sibling))).toEqual([]);
  expect(() => store.get(viewer(sibling), mine.id)).toThrow("memory_not_found");
  expect(() => store.add(forOwner(), soul, {duplicatesFor: viewer(a.shadowId)})).not.toThrow();
  expect(store.add(forOwner(sibling), soul, {duplicatesFor: viewer(sibling)}).originShadowId).toBe(sibling);
  expect(store.recall(viewer(a.shadowId), "你叫什么名字 语气", {limit: 8})).toEqual([]);
  expect(store.changedSince(a.agentId, 0, 10).map(row => row.id)).toEqual([plain.id]);
  expect(store.similar(everything(), {...note, type: "feedback", subjectUserId: null, title: "名字和语气", description: "身份 名字和语气"}, {anyType: true})).toEqual([]);
  expect(store.forget(DAY, Date.now() + 400 * DAY)).toBe(1);
  expect(store.get(viewer(a.shadowId), mine.id).status).toBe("active");
  const changed = store.update(forOwner(), viewer(a.shadowId), mine.id, {expectedRevision: 1, body: "你叫小白。"});
  expect(changed).toMatchObject({body: "你叫小白。", revision: 2});
});

test("a Shadow holds a limited number of persona entries", () => {
  const capped = new AgentMemoryStore(db.db, {persona: 2});
  const forOwner = (shadowId = a.shadowId): MemoryWriter => ({...owner(shadowId), owner: true});
  const soul = {type: "persona" as const, description: "d", body: "b"};
  const first = capped.add(forOwner(), {...soul, title: "身份"}); capped.add(forOwner(), {...soul, title: "原则"});
  expect(() => capped.add(forOwner(), {...soul, title: "第三条"})).toThrow("memory_persona_full");
  expect(capped.add(forOwner(sibling), {...soul, title: "分身的身份"}).type).toBe("persona");
  capped.remove(forOwner(), viewer(a.shadowId), first.id, 1);
  capped.add(forOwner(), {...soul, title: "第三条"});
  expect(() => capped.restore(forOwner(), first.id, 1, 2)).toThrow("memory_persona_full");
});
