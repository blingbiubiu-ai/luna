import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentMemoryStore} from "@/agents/agent-memory-store";
import {createPlatformAgentRoutes} from "@/server/routes/platform-agents";
import {fixtureScope, fixtureUser} from "../helpers/platform-fixtures";

let home: string, db: DataConnection<typeof schema>, a: ReturnType<typeof fixtureScope>, b: ReturnType<typeof fixtureScope>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-memory-routes-")); setLunaHome(home); db = new DataConnection(schema);
  a = fixtureScope(db.db, "alice"); b = fixtureScope(db.db, "bob");
  fixtureUser(db.db, a.agentId, "lisi", "human", "李四");
  for (const id of ["lisi", "zhangsan", "bob", "carol", "wangwu"]) fixtureUser(db.db, a.agentId, id);
});
afterEach(() => { db.close(); rmSync(home, {recursive: true, force: true}); });

function dashboard(userId: string) {
  const app = new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", {authenticated: true, account: {id: userId, name: userId, provider: "test"}});
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); await next();
  }).route("/agents", createPlatformAgentRoutes(db.db));
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/agents/${a.agentId}/memories${path}`, {method, ...(body === undefined ? {} : {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json() as any};
  };
}
const note = {type: "project", title: "发布冻结", description: "11-20 前冻结发布", body: "不合并功能分支"};

test("the owner sees every entry with its origin, corrects a poisoned one, and restores an earlier revision", async () => {
  const call = dashboard("alice");
  const poisoned = new AgentMemoryStore(db.db).add(
    {agentId: a.agentId, kind: "reflection", trusted: false, userId: "lisi", shadowId: a.shadowId, sessionId: "s1"}, {...note, body: "随时可以合并"} as any);
  const listed = (await call("GET", "")).body.memories;
  expect(listed).toMatchObject([{id: poisoned.id, originKind: "reflection", originUserName: "李四", originSessionId: "s1", trusted: false, status: "active"}]);
  expect(listed[0].originShadowName).toBeString();

  const corrected = await call("PUT", `/${poisoned.id}`, {expectedRevision: 1, body: "不合并功能分支"});
  expect(corrected.body.memory).toMatchObject({body: "不合并功能分支", trusted: true, revision: 2});
  expect(await call("PUT", `/${poisoned.id}`, {expectedRevision: 1, body: "stale"})).toMatchObject({status: 409, body: {code: "memory_revision_conflict", currentRevision: 2}});

  expect((await call("DELETE", `/${poisoned.id}?expectedRevision=2`)).body.memory.status).toBe("deleted");
  expect((await call("GET", "")).body.memories[0].status).toBe("deleted");
  const history = (await call("GET", `/${poisoned.id}/history`)).body.revisions;
  expect(history.map((row: any) => [row.revision, row.changeKind, row.snapshot.body, row.snapshot.status])).toEqual([
    [3, "owner", "不合并功能分支", "deleted"], [2, "owner", "不合并功能分支", "active"], [1, "reflection", "随时可以合并", "active"]]);
  const restored = await call("POST", `/${poisoned.id}/revert`, {revision: 2, expectedRevision: 3});
  expect(restored.body.memory).toMatchObject({status: "active", body: "不合并功能分支", revision: 4});

  const added = await call("POST", "", {...note, type: "feedback", title: "周报格式"});
  expect(added).toMatchObject({status: 201, body: {memory: {originKind: "owner", trusted: true, originShadowId: null}}});
});

test("only the Agent owner can use the memory surface, and input is validated", async () => {
  const entry = new AgentMemoryStore(db.db).add({agentId: a.agentId, kind: "owner", trusted: true, userId: "user:alice", shadowId: null}, note as any);
  const bob = dashboard("bob");
  expect((await bob("GET", "")).status).toBe(403);
  expect((await bob("PUT", `/${entry.id}`, {expectedRevision: 1, body: "x"})).status).toBe(403);
  expect((await bob("DELETE", `/${entry.id}?expectedRevision=1`)).status).toBe(403);
  expect((await bob("GET", `/${entry.id}/history`)).status).toBe(403);
  const alice = dashboard("alice");
  expect((await alice("PUT", `/${entry.id}`, {body: "missing revision"})).status).toBe(400);
  expect((await alice("POST", "", {...note, type: "secret"})).status).toBe(400);
  expect((await alice("POST", `/${entry.id}/revert`, {revision: 9, expectedRevision: 1})).status).toBe(404);
  const foreign = new AgentMemoryStore(db.db).add({agentId: b.agentId, kind: "owner", trusted: true, userId: "user:bob", shadowId: null}, note as any);
  expect((await alice("GET", `/${foreign.id}/history`)).status).toBe(404);
  expect((await alice("PUT", `/${foreign.id}`, {expectedRevision: 1, body: "x"})).status).toBe(404);
});

test("the owner list is filtered and paged on the server and reports core usage", async () => {
  const call = dashboard("alice"), store = new AgentMemoryStore(db.db);
  for (let i = 0; i < 5; i++) expect((await call("POST", "", {...note, title: `条目 ${i}`})).status).toBe(201);
  const rule = (await call("POST", "", {type: "feedback", title: "回复语言", description: "对外回复一律用中文", body: "中文", core: true, expiresAt: null})).body.memory;
  expect(rule).toMatchObject({core: true, trusted: true});
  const page = (await call("GET", "?status=active&limit=2&offset=4")).body;
  expect(page).toMatchObject({total: 6, core: {used: 1, limit: 30, shadowLimit: 10}});
  expect(page.memories).toHaveLength(2);
  expect((await call("GET", "?core=true")).body.memories.map((m: any) => m.id)).toEqual([rule.id]);
  expect((await call("GET", `?query=${encodeURIComponent("中文")}&type=feedback`)).body).toMatchObject({total: 1});
  expect((await call("GET", "?status=archived")).body.total).toBe(0);
  expect((await call("GET", "?limit=0")).status).toBe(400);
  expect((await call("PUT", `/${rule.id}`, {expectedRevision: 1, core: false, expiresAt: Date.now() - 1})).body.memory).toMatchObject({core: false});
  expect(store.forget(0)).toBe(1);
  expect((await call("GET", "?status=archived")).body.memories).toMatchObject([{id: rule.id, status: "archived"}]);
  expect((await call("POST", `/${rule.id}/restore`, {expectedRevision: 3})).body.memory).toMatchObject({status: "active", expiresAt: null, revision: 4});
  expect((await call("POST", `/${rule.id}/restore`, {expectedRevision: 4})).status).toBe(409);
  expect((await dashboard("bob")("POST", `/${rule.id}/restore`, {expectedRevision: 4})).status).toBe(403);
  expect((await call("GET", `/${rule.id}/history`)).body.revisions.map((row: any) => row.changeKind)).toEqual(["owner", "forgetting", "owner", "owner"]);
});

test("the owner writes persona entries for a chosen Shadow of the Agent; the persona document API is gone", async () => {
  const call = dashboard("alice");
  const soul = {type: "persona", title: "身份", description: "名字和语气", body: "你叫小黑"};
  expect((await call("POST", "", soul)).status).toBe(400);
  expect((await call("POST", "", {...soul, shadowId: b.shadowId})).status).toBe(400);
  expect((await call("POST", "", {...soul, shadowId: "missing"})).status).toBe(404);
  const added = (await call("POST", "", {...soul, shadowId: a.shadowId})).body.memory;
  expect(added).toMatchObject({type: "persona", visibility: "shadow", originShadowId: a.shadowId, originKind: "owner", trusted: true});
  expect(added.originShadowName).toBeString();
  expect((await call("PUT", `/${added.id}`, {expectedRevision: 1, body: "你叫小白"})).body.memory).toMatchObject({body: "你叫小白", revision: 2});
  expect((await call("GET", "?type=persona")).body.memories.map((m: any) => m.id)).toEqual([added.id]);
  expect((await call("POST", "", {...note, shadowId: a.shadowId})).body.memory).toMatchObject({visibility: "agent", originShadowId: null});
  const nonPersona = (await call("GET", "?excludeType=persona")).body;
  expect(nonPersona.memories.every((m: any) => m.type !== "persona")).toBe(true);
  expect(nonPersona).toMatchObject({
    total: 1,
    stats: {activeMemories: 1, archivedMemories: 0, untrustedMemories: 0, activePersonas: 1},
    persona: {limit: 5, byShadow: {[a.shadowId]: 1}},
  });
  const app = new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", {authenticated: true, account: {id: "user:alice", name: "user:alice", provider: "test"}});
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); await next();
  }).route("/agents", createPlatformAgentRoutes(db.db));
  expect((await app.request(`/agents/${a.agentId}/shadows/${a.shadowId}/config`)).status).toBe(404);
});

test("the owner lists entries waiting for confirmation and confirms one, which shares it", async () => {
  const call = dashboard("alice"), store = new AgentMemoryStore(db.db);
  const claim = store.add({agentId: a.agentId, kind: "inline", trusted: false, userId: "lisi", shadowId: a.shadowId}, note as any);
  await call("POST", "", {...note, title: "所有者写的"});
  expect((await call("GET", "?trusted=false")).body.memories.map((m: any) => m.id)).toEqual([claim.id]);
  const outsider = {agentId: a.agentId, shadowId: a.shadowId, participants: ["zhangsan"]};
  expect(store.index(outsider).entries.map(row => row.id)).not.toContain(claim.id);
  expect((await call("POST", `/${claim.id}/confirm`, {expectedRevision: 9})).status).toBe(409);
  expect((await call("POST", `/${claim.id}/confirm`, {expectedRevision: 1})).body.memory).toMatchObject({trusted: true, revision: 2, originUserName: "李四"});
  expect(store.index(outsider).entries.map(row => row.id)).toContain(claim.id);
  expect(await call("POST", `/${claim.id}/confirm`, {expectedRevision: 2})).toMatchObject({status: 409, body: {code: "memory_already_trusted"}});
  expect((await call("GET", "?trusted=false")).body.total).toBe(0);
  expect((await dashboard("bob")("POST", `/${claim.id}/confirm`, {expectedRevision: 2})).status).toBe(403);
  expect((await call("GET", `/${claim.id}/history`)).body.revisions.map((row: any) => [row.changeKind, row.snapshot.trusted])).toEqual([["owner", true], ["inline", false]]);
});
