import { registerTestRunnerJob } from "./support/runner-job";
import { encodeInvocation } from "../../src/runners/invocation-codec";
import { InvocationStore } from "../../src/runners/invocation-store";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { setLunaHome } from "../../src/shared";
import { SessionResolver } from "../../src/sessions/session-resolver";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { mainInvocations } from "../../src/runners/main-invocation-registry";
import { runnerMessageEnvelopeFromRow } from "../../src/runners/message-envelope";
import { createRunnerMemoryRoutes } from "../../src/server/routes/runner-memory";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { AgentMemoryStore } from "../../src/agents/agent-memory-store";
import type { LunaAccessTokenClaims } from "../../src/server/auth/access-token-service";
import type { NormalizedInboundMessage } from "../../src/channels";
import { fixtureSessionOwnership } from "../helpers/platform-fixtures";

let home: string;
let connection: DataConnection<typeof schema>;
afterEach(() => { connection?.close(); if (home) rmSync(home, { recursive: true, force: true }); });

/** A Main invocation in a Feishu session, triggered by "user", who is not the Agent owner. */
function fixture() {
  home = mkdtempSync(join(tmpdir(), "luna-memory-api-")); setLunaHome(home);
  connection = new DataConnection(schema); const db = connection.db;
  db.insert(schema.users).values({id:"user",kind:"human",displayName:"User",status:"active",createdAt:"now",updatedAt:"now"}).run();
  fixtureSessionOwnership(db, "feishu", "test");
  const inbound: NormalizedInboundMessage = { id: "external-1", channel: { id: "test", type: "feishu" }, surface: { externalId: "chat", kind: "p2p" }, sender: { externalId: "user", kind: "user" }, text: "hello", mentions: [], addressing: { addressedToBot: true, reason: "p2p" } };
  const session = new SessionResolver(new SessionStore(db)).resolveFromNormalizedInbound(inbound);
  const row = new MessageStore(db).appendOnce({ sessionId: session.id, channelMessageKey: inbound.id, role: "user", senderUserId: "user", content: [{ type: "text", text: "hello" }], inbound, channel: inbound.channel, surface: inbound.surface, sender: inbound.sender }).row;
  const context = new RunnerContextStore(db).resolveForSession(session.id, "codex");
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => new InvocationStore(db).revoke("invocation", "test cancelled"));
  mainInvocations(db).set("invocation", { invocationId: "invocation", turnId: "logical-turn", runnerContext: context, signal: controller.signal, input: { type: "user_messages", messages: [{ ...runnerMessageEnvelopeFromRow({ row, rawMessage: inbound }), rawMessage: inbound }], latestMessage: inbound, context: { sessionId: session.id, candidateOpenTasks: [] } } });
  const claims: LunaAccessTokenClaims = { tokenId: "token", actorUserId: "user", source: "runner", role: "runner", runnerKind: "main", agentId: session.agent_id, shadowId: session.shadow_id, sessionId: session.id, runnerJobId: context.id, issuedAt: 1, expiresAt: Date.now() + 10000 };
  db.insert(schema.accessTokens).values({ id: "token", tokenHash: "hash", userId: "user", source: "runner", name: "test", role: "runner", issuedAt: 1, expiresAt: Date.now() + 10000, createdAt: 1, metadataJson: { invocationId: "invocation" } }).run();
  registerTestRunnerJob(db, "invocation", claims, encodeInvocation("main", mainInvocations(db).get("invocation")!), "logical-turn");
  let current: LunaAccessTokenClaims | undefined = claims;
  const app = new Hono<{ Variables: { lunaAccessTokenClaims: LunaAccessTokenClaims | undefined } }>();
  app.use("*", async (c, next) => { c.set("lunaAccessTokenClaims", current); await next(); });
  app.route("/api/runner", createRunnerMemoryRoutes({ db }));
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api/runner/memory${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const grant = (effect: "allow" | "deny", target: string) => new AuthorizationRuleStore(db, {kind: "agent", agentId: session.agent_id}).addGrant({subjectType: "user", subjectId: "user", target, effect});
  return { db, call, grant, session, controller, useClaims: (next: LunaAccessTokenClaims | undefined) => { current = next; }, claims };
}
const project = { type: "project", title: "发布冻结", description: "11-20 前冻结发布", body: "不合并功能分支" };

test("a Runner adds, finds, reads, updates and deletes memory inside its invocation scope", async () => {
  const f = fixture();
  const added = await f.call("POST", "", project);
  expect(added.status).toBe(201);
  expect(added.body.memory).toMatchObject({ title: "发布冻结", revision: 1, trusted: false, originUserId: "user", originUserName: "User", body: "不合并功能分支" });
  const id = added.body.memory.id;
  expect(new AgentMemoryStore(f.db).page(f.session.agent_id, {limit: 200}).entries[0]).toMatchObject({ originKind: "inline", originShadowId: f.session.shadow_id, originSessionId: f.session.id });
  expect((await f.call("GET", "")).body).toMatchObject({ omitted: 0, memories: [{ id, description: "11-20 前冻结发布" }] });
  expect((await f.call("GET", "")).body.memories[0].body).toBeUndefined();
  expect((await f.call("GET", `/search?q=${encodeURIComponent("冻结")}`)).body.memories.map((m: any) => m.id)).toEqual([id]);
  expect((await f.call("GET", `/${id}`)).body.memory.body).toBe("不合并功能分支");
  expect((await f.call("PUT", `/${id}`, { expectedRevision: 1, body: "v2" })).body.memory).toMatchObject({ body: "v2", revision: 2 });
  expect(await f.call("PUT", `/${id}`, { expectedRevision: 1, body: "stale" })).toMatchObject({ status: 409, body: { error: "memory_revision_conflict", currentRevision: 2 } });
  expect((await f.call("DELETE", `/${id}?expectedRevision=2`)).body.memory).toMatchObject({ status: "deleted" });
  expect((await f.call("GET", `/${id}`)).status).toBe(404);
});

test("trust follows the invocation actor: untrusted by default, trusted with a memory.write rule", async () => {
  const f = fixture();
  const feedback = { ...project, type: "feedback" };
  expect(await f.call("POST", "", feedback)).toMatchObject({ status: 403, body: { error: "memory_write_forbidden" } });
  expect((await f.call("POST", "", { type: "person", title: "别人", description: "d", body: "b", subjectUserId: "someone-else" })).status).toBe(403);
  expect((await f.call("POST", "", { type: "person", title: "自己", description: "d", body: "b", subjectUserId: "user" })).status).toBe(201);
  f.grant("allow", "memory.write");
  expect((await f.call("POST", "", feedback)).body.memory).toMatchObject({ type: "feedback", trusted: true });
});

test("person entries about people outside the session and other Shadows' private entries are hidden", async () => {
  const f = fixture();
  const store = new AgentMemoryStore(f.db);
  const owner = { agentId: f.session.agent_id, kind: "owner" as const, trusted: true, userId: "fixture-owner", shadowId: null };
  const absent = store.add(owner, { type: "person", title: "张三", description: "d", body: "b", subjectUserId: "zhangsan" });
  const present = store.add(owner, { type: "person", title: "User", description: "d", body: "b", subjectUserId: "user" });
  const elsewhere = store.add({ ...owner, shadowId: "other-shadow" }, { ...project, visibility: "shadow" } as any);
  expect((await f.call("GET", "")).body.memories.map((m: any) => m.id)).toEqual([present.id]);
  expect((await f.call("GET", `/${absent.id}`)).status).toBe(404);
  expect((await f.call("GET", `/${elsewhere.id}`)).status).toBe(404);
  expect((await f.call("PUT", `/${elsewhere.id}`, { expectedRevision: 1, body: "x" })).status).toBe(404);
});

test("explicit deny rules, inactive invocations and non-Runner callers are rejected", async () => {
  const f = fixture();
  f.grant("deny", "memory.write");
  expect(await f.call("POST", "", project)).toMatchObject({ status: 403, body: { error: "memory_access_denied" } });
  expect((await f.call("GET", "")).status).toBe(200);
  f.grant("deny", "memory.read");
  expect((await f.call("GET", "")).status).toBe(403);
  f.useClaims(undefined);
  expect(await f.call("GET", "")).toMatchObject({ status: 403, body: { error: "runner_required" } });
  f.useClaims(f.claims); f.controller.abort();
  expect((await f.call("GET", "")).status).toBe(409);
  expect((await f.call("POST", "", { ...project, extra: 1 })).status).toBe(409);
});

test("invalid input is rejected before it reaches storage", async () => {
  const f = fixture();
  expect((await f.call("POST", "", { ...project, extra: 1 })).status).toBe(400);
  expect((await f.call("POST", "", { ...project, type: "secret" })).status).toBe(400);
  expect((await f.call("PUT", "/missing", { body: "x" })).status).toBe(400);
  expect((await f.call("GET", "/search?q=")).status).toBe(400);
});

test("list is capped and reports how many entries were left out", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) expect((await f.call("POST", "", { ...project, title: `条目 ${i}`, force: true })).status).toBe(201);
  const first = (await f.call("GET", "?limit=2")).body;
  expect(first.omitted).toBe(3);
  expect(first.memories).toHaveLength(2);
  expect((await f.call("GET", "")).body).toMatchObject({ omitted: 0 });
  expect((await f.call("GET", "?limit=0")).status).toBe(400);
});

test("a repeated fact is rejected with the existing candidates, and --force or an update gets through", async () => {
  const f = fixture();
  const first = (await f.call("POST", "", project)).body.memory;
  const repeated = await f.call("POST", "", { ...project, title: "发布的冻结", body: "另一种说法" });
  expect(repeated).toMatchObject({ status: 409, body: { error: "memory_duplicate", candidates: [{ id: first.id, title: "发布冻结", revision: 1 }] } });
  expect(repeated.body.candidates[0].body).toBeUndefined();
  expect((await f.call("POST", "", { ...project, title: "发布的冻结", force: true })).status).toBe(201);
  expect((await f.call("PUT", `/${first.id}`, { expectedRevision: 1, body: "合并进已有条目" })).status).toBe(200);
});

test("core needs a trusted actor; expiry is stored; reading an entry counts as use", async () => {
  const f = fixture();
  expect(await f.call("POST", "", { ...project, core: true })).toMatchObject({ status: 403, body: { error: "memory_write_forbidden" } });
  const expiresAt = Date.now() + 86_400_000;
  const added = (await f.call("POST", "", { ...project, expiresAt })).body.memory;
  expect(added).toMatchObject({ core: false, expiresAt, status: "active" });
  f.db.update(schema.agentMemories).set({ lastUsedAt: 1 }).run();
  await f.call("GET", ""); await f.call("GET", `/search?q=${encodeURIComponent("冻结")}`);
  expect(new AgentMemoryStore(f.db).page(f.session.agent_id, {limit: 200}).entries[0]!.lastUsedAt).toBe(1);
  await f.call("GET", `/${added.id}`);
  expect(new AgentMemoryStore(f.db).page(f.session.agent_id, {limit: 200}).entries[0]!.lastUsedAt).toBeGreaterThan(1);
  f.grant("allow", "memory.write");
  expect((await f.call("PUT", `/${added.id}`, { expectedRevision: 1, core: true, expiresAt: null })).body.memory).toMatchObject({ core: true, expiresAt: null });
  expect((await f.call("PUT", `/${added.id}`, { expectedRevision: 2, expiresAt: "tomorrow" })).status).toBe(400);
});

test("a forgotten entry is found only by an archived search and comes back with restore", async () => {
  const f = fixture();
  const added = (await f.call("POST", "", { ...project, expiresAt: Date.now() - 1 })).body.memory;
  expect(new AgentMemoryStore(f.db).forget(0)).toBe(1);
  const q = encodeURIComponent("冻结");
  expect((await f.call("GET", "")).body.memories).toEqual([]);
  expect((await f.call("GET", `/search?q=${q}`)).body.memories).toEqual([]);
  expect((await f.call("GET", `/search?q=${q}&archived=true`)).body.memories).toMatchObject([{ id: added.id, status: "archived", revision: 2 }]);
  expect((await f.call("GET", `/${added.id}`)).body.memory).toMatchObject({ status: "archived", body: "不合并功能分支" });
  expect((await f.call("POST", `/${added.id}/restore`, { expectedRevision: 1 })).status).toBe(409);
  expect((await f.call("POST", `/${added.id}/restore`, { expectedRevision: 2 })).body.memory).toMatchObject({ status: "active", expiresAt: null, revision: 3 });
  expect((await f.call("POST", `/${added.id}/restore`, { expectedRevision: 3 })).status).toBe(409);
  expect((await f.call("GET", "")).body.memories).toHaveLength(1);
});

test("a Runner cannot write persona for anyone but the Agent owner, even with memory.write", async () => {
  const f = fixture();
  const soul = { type: "persona", title: "身份", description: "名字和语气", body: "你叫小黑" };
  expect(await f.call("POST", "", soul)).toMatchObject({ status: 403, body: { error: "memory_write_forbidden" } });
  f.grant("allow", "memory.write");
  expect(await f.call("POST", "", soul)).toMatchObject({ status: 403, body: { error: "memory_write_forbidden" } });
  const mine = new AgentMemoryStore(f.db).add(
    { agentId: f.session.agent_id, kind: "owner", trusted: true, owner: true, userId: "fixture-owner", shadowId: f.session.shadow_id }, soul as any);
  expect((await f.call("GET", `/${mine.id}`)).body.memory).toMatchObject({ type: "persona", body: "你叫小黑", visibility: "shadow" });
  expect(await f.call("PUT", `/${mine.id}`, { expectedRevision: 1, body: "你叫小白" })).toMatchObject({ status: 403, body: { error: "memory_protected" } });
  expect((await f.call("DELETE", `/${mine.id}?expectedRevision=1`)).status).toBe(403);
});

test("a Runner records an episode with the invocation's participants and reads the timeline", async () => {
  const f = fixture();
  const added = await f.call("POST", "", { type: "episode", title: "帮用户查日志", description: "用户问登录失败，定位到配置过期", body: "已更新配置" });
  expect(added.status).toBe(201);
  expect(added.body.memory).toMatchObject({ type: "episode", core: false });
  expect(added.body.memory.occurredAt).toBeGreaterThan(0);
  expect(new AgentMemoryStore(f.db).page(f.session.agent_id, {limit: 200}).entries[0]!.participants).toEqual(["user"]);
  expect((await f.call("POST", "", { type: "episode", title: "帮用户查日志", description: "用户问登录失败，定位到配置过期", body: "又一次" })).status).toBe(201);
  const timeline = (await f.call("GET", "/timeline")).body.episodes;
  expect(timeline).toHaveLength(2);
  expect(timeline[0].body).toBeUndefined();
  expect((await f.call("GET", `/timeline?since=${Date.now() + 60_000}`)).body.episodes).toEqual([]);
  expect((await f.call("GET", "/timeline?with=someone-else")).body.episodes).toEqual([]);
  expect((await f.call("GET", "/timeline?with=user&limit=1")).body.episodes).toHaveLength(1);
  expect((await f.call("GET", "/timeline?limit=0")).status).toBe(400);
  expect((await f.call("GET", "")).body.memories).toEqual([]);
  // An episode someone else took part in is not on this actor's timeline.
  new AgentMemoryStore(f.db).add({ agentId: f.session.agent_id, kind: "owner", trusted: true, userId: "fixture-owner", shadowId: f.session.shadow_id },
    { type: "episode", title: "所有者的事", description: "d", body: "b" }, { participants: ["fixture-owner"] });
  expect((await f.call("GET", "/timeline")).body.episodes).toHaveLength(2);
});
