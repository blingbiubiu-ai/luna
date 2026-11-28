import {fixtureArtifact} from "../helpers/platform-fixtures";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureScope} from "../helpers/platform-fixtures";
import { fixtureAccount, fixturePlatformAdmin, fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { ChannelDirectoryStore } from "../../src/channels/directory-store";
import { feishuIdentityMetadata } from "../../src/identity/feishu-identity-scopes";
import { config, setLunaHome } from "../../src/shared";
import { SessionStore } from "../../src/sessions/session-store";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import { createSessionsRoutes } from "../../src/server/routes/sessions";
import { createUsersRoutes } from "../../src/server/routes/users";
import { deleteDashboardSession } from "../../src/dashboard-api/deletion";

let home: string, previousHome: string, connection: DataConnection<typeof schema>, store: SessionStore;
beforeEach(() => {
  previousHome = config.paths.home;
  home = mkdtempSync(join(tmpdir(), "luna-delete-")); setLunaHome(home);
  connection = new DataConnection(schema); store = new SessionStore(connection.db);
  fixtureSessionOwnership(connection.db, "feishu", "test", "admin");
});
afterEach(() => { connection.close(); setLunaHome(previousHome); rmSync(home, { recursive: true, force: true }); });
function app(kind = "dashboard-cookie") {
  return new Hono<{ Variables: Record<string, unknown> }>().use("*", async (c, next) => {
    fixturePlatformAdmin(connection.db, "admin");
    c.set("lunaAuthorizationDb", connection.db);
    c.set("dashboardAuthSession", { authenticated: true, account: { id: "admin", name: "Admin", provider: "test" } });
    c.set("lunaRequestAuthKind", kind);
    if (kind !== "dashboard-cookie") c.set("lunaAccessTokenClaims", { source: "runner" });
    await next();
  }).route("/sessions", createSessionsRoutes({ db: connection.db })).route("/users", createUsersRoutes({ db: connection.db }));
}
const surface = { channelType: "feishu", channelId: "test", groupId: "chat", threadId: "thread", rootMessageId: "root", createThreadLaunchContext: false };
test("session deletion releases all routing keys, removes the session and starts a fresh session", async () => {
  const old = store.resolveByChannelSurface(surface);
  expect(old.parent_session_id).toBeTruthy();
  expect((await app().request(`/sessions/${old.id}`, { method: "DELETE" })).status).toBe(200);
  expect(store.getById(old.id)).toBeUndefined();
  expect(connection.db.select().from(schema.sessionSurfaceAliases).where(eq(schema.sessionSurfaceAliases.session_id, old.id)).all()).toHaveLength(0);
  expect(connection.db.select().from(schema.sessionChannelBindings).where(eq(schema.sessionChannelBindings.sessionId, old.id)).all()).toHaveLength(0);
  expect(() => store.channelBindings(old.id)).toThrow("unavailable");
  const next = store.resolveByChannelSurface(surface);
  expect(next.id).not.toBe(old.id);
  expect(next.parent_session_id).toBe(old.parent_session_id);
  expect(next.status).toBe("active");
  expect((await app().request(`/sessions/${old.id}/timeline`)).status).toBe(404);
  expect((await app().request(`/sessions/${old.id}`, { method: "DELETE" })).status).toBe(200);
});
test("pending inbox blocks deletion without changing routing", async () => {
  const session = store.resolveByChannelSurface(surface);
  connection.db.insert(schema.sessionInbox).values({ id: "inbox", session_id: session.id, entry_id: "entry", message_id: "message", status: "pending", received_at: 1, created_at: 1, updated_at: 1 }).run();
  const response = await app().request(`/sessions/${session.id}`, { method: "DELETE" });
  expect(response.status).toBe(409);
  expect(store.getById(session.id)?.status).toBe("active");
  expect(store.resolveByChannelSurface(surface).id).toBe(session.id);
});
test("session deletion and user removal require the Dashboard owner", async () => {
  const session = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const scope = `?agentId=${session.agent_id}`;
  expect((await app("luna-access-token").request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(403);
  expect((await app("luna-access-token").request(`/users/user:admin${scope}`, { method: "DELETE" })).status).toBe(403);
  expect((await app().request("/sessions/missing", { method: "DELETE" })).status).toBe(404);
  expect((await app().request(`/users/missing${scope}`, { method: "DELETE" })).status).toBe(404);
});

const feishuSender = () => ({
  channel: {type: "feishu", id: "test"},
  identity: {kind: "user" as const, displayName: "Test user", externalId: "ou_test",
    ...feishuIdentityMetadata({environment: "feishu", appId: "test:feishu:test", tenantKey: "tenant"}, {open_id: "ou_test", user_id: "same-user"})},
});

test("a removed user leaves the Agent's list and comes back unchanged when they write again", async () => {
  const channelDirectory = new ChannelDirectoryStore(connection.db);
  const observed = channelDirectory.upsertIdentity(feishuSender());
  const userId = connection.db.select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, observed.id)).get()!.userId;
  const agentId = connection.db.select().from(schema.users).where(eq(schema.users.id, userId)).get()!.agentId;
  const scope = `?agentId=${agentId}`;
  const listed = async () => ((await (await app().request("/users" + scope)).json()) as { users: { id: string }[] }).users.map(user => user.id);
  expect(await listed()).toContain(userId);
  expect((await app().request(`/users/${userId}${scope}`, { method: "DELETE" })).status).toBe(200);
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, userId)).get()?.status).toBe("removed");
  expect(await listed()).not.toContain(userId);
  channelDirectory.upsertIdentity(feishuSender());
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, userId)).get()?.status).toBe("active");
  expect(await listed()).toContain(userId);
});

test("the owner renames and blocks users of the Agent, but cannot block or remove themselves", async () => {
  const observed = new ChannelDirectoryStore(connection.db).upsertIdentity(feishuSender());
  const userId = connection.db.select().from(schema.channelUserBindings).where(eq(schema.channelUserBindings.channelIdentityId, observed.id)).get()!.userId;
  const agentId = connection.db.select().from(schema.users).where(eq(schema.users.id, userId)).get()!.agentId;
  const scope = `?agentId=${agentId}`;
  const patch = (id: string, body: unknown) => app().request(`/users/${id}${scope}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await patch(userId, { displayName: "测试同学" })).status).toBe(200);
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, userId)).get()).toMatchObject({ displayName: "测试同学", profileSource: "manual" });
  expect((await patch(userId, { status: "blocked" })).status).toBe(200);
  const { AgentStore } = await import("../../src/agents/agent-store");
  expect(() => new AgentStore(connection.db).requireAccess(userId, agentId)).toThrow("active_user_required");
  expect((await patch(userId, { status: "active" })).status).toBe(200);
  const owner = new AgentStore(connection.db).ownerUserId(agentId);
  expect((await patch(owner, { status: "blocked" })).status).toBe(409);
  expect((await app().request(`/users/${owner}${scope}`, { method: "DELETE" })).status).toBe(409);
  // A user of another Agent is not found here.
  const foreign = fixtureScope(connection.db, "someone-else");
  expect((await patch(foreign.ownerUserId, { displayName: "x" })).status).toBe(404);
});

test("account deletion is refused for the requester and for Agent owners, and revokes what the account held", async () => {
  const { deleteAccount } = await import("../../src/dashboard-api/deletion");
  const { AccessTokenService } = await import("../../src/server/auth/access-token-service");
  const { AuthorizationRuleStore } = await import("../../src/server/policy/authorization-rule-store");
  expect(() => deleteAccount(connection.db, "admin", "admin")).toThrow("不能删除当前登录账号");
  expect(() => deleteAccount(connection.db, "admin", "other")).toThrow("请先删除此账号拥有的 Agent");
  fixtureAccount(connection.db, "leaving");
  const token = new AccessTokenService({ db: connection.db, signingSecret: "test" }).issueToken({ accountId: "leaving", name: "cli", source: "cli", role: "user", ttlMs: 60000, now: Date.now() });
  new AuthorizationRuleStore(connection.db, {kind: "platform"}).addGrant({ subjectType: "user", subjectId: "leaving", target: "system.admin", effect: "allow" });
  deleteAccount(connection.db, "leaving", "admin");
  expect(connection.db.select().from(schema.accounts).where(eq(schema.accounts.id, "leaving")).get()?.status).toBe("deleted");
  expect(connection.db.select().from(schema.accessTokens).where(eq(schema.accessTokens.id, token.record.id)).get()?.revokedAt).toBeGreaterThan(0);
  expect(connection.db.select().from(schema.authorizationRules).where(eq(schema.authorizationRules.subjectId, "leaving")).all()).toHaveLength(0);
});

test("a deleted account cannot reuse a previously signed cookie", async () => {
  const { DashboardAuthService, createDashboardAuthMiddleware } = await import("../../src/server/auth");
  const { deleteAccount } = await import("../../src/dashboard-api/deletion");
  const auth = new DashboardAuthService({ provider: { id: "test", authenticateToken: async () => ({ id: "victim", name: "Victim", provider: "test" }) } });
  const login = await auth.login("test");
  const server = new Hono().use("*", createDashboardAuthMiddleware(auth, { db: connection.db })).get("/api/private", c => c.json({ ok: true }));
  const request = () => server.request("/api/private", { headers: { Cookie: `luna_dashboard_session=${login!.sessionToken}` } });
  expect((await request()).status).toBe(200);
  deleteAccount(connection.db, "victim", "admin");
  expect((await request()).status).toBe(401);
});

test("session deletion disables schedules and revokes tokens without deleting historical users", () => {
  const session = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  connection.db.insert(schema.sessionSchedules).values({ id: "schedule", actorUserId: "user:admin", sourceSessionId: session.id, targetSessionId: session.id, action: {}, timezone: "UTC", nextAt: 999, enabled: true, revision: 1, overlap: "skip", misfire: "skip", expiresAfterMs: 1000, createdAt: 1 }).run();
  connection.db.insert(schema.accessTokens).values({ id: "token", agentId: session.agent_id, tokenHash: "hash", userId: "user:admin", source: "runner", name: "test", role: "runner", sourceSessionId: session.id, issuedAt: 1, expiresAt: 999, createdAt: 1 }).run();
  deleteDashboardSession(connection.db, session.id);
  expect(connection.db.select().from(schema.sessionSchedules).get()).toBeUndefined();
  expect(connection.db.select().from(schema.accessTokens).get()?.revokedAt).toBeGreaterThan(0);
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, session.bot_user_id!)).get()?.kind).toBe("shadow");
});

test("a session reply identity cannot be replaced with a provider bot user", () => {
  const session = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const bot = new IdentityDirectory(connection.db).materializeIdentityClaims({ agentId: session.agent_id, kind: "bot", displayName: "Provider bot", claims: [] });
  expect(() => connection.db.update(schema.sessions).set({ bot_user_id: bot.id }).where(eq(schema.sessions.id, session.id)).run())
    .toThrow("session_scope_immutable");
  expect(() => store.bindBotUser(session.id, bot.id)).toThrow("session_reply_identity_mismatch");
  expect(store.requireReplyUserId(session.id)).toBe(session.bot_user_id!);
});

test("deleting owner scrubs messages and keeps safe reference placeholders; deleting references does not delete owners", async () => {
  const { MessageStore } = await import("../../src/sessions/message-store");
  const { SessionTimelineStore } = await import("../../src/sessions/session-timeline-store");
  const owner = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const reference = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const secondary = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const messages = new MessageStore(connection.db);
  const message = messages.append({ sessionId: owner.id, senderUserId: store.requireReplyUserId(owner.id), role: "assistant", content: [{ type: "text", text: "SECRET_BODY" }], rawPayload: { secret: "SECRET_RAW" } });
  const timeline = new SessionTimelineStore(connection.db);
  timeline.appendReference({ sessionId: reference.id, messageId: message.id });
  timeline.appendReference({ sessionId: secondary.id, messageId: message.id });
  deleteDashboardSession(connection.db, secondary.id);
  expect(connection.db.select().from(schema.messages).where(eq(schema.messages.id, message.id)).get()?.contentJson).toEqual([{ type: "text", text: "SECRET_BODY" }]);
  deleteDashboardSession(connection.db, owner.id);
  const row = connection.db.select().from(schema.messages).where(eq(schema.messages.id, message.id)).get()!;
  expect(row.deletedAt).toBeGreaterThan(0);
  expect(row.ownerSessionId).toBeNull();
  expect(row.senderUserId).toBe("");
  expect(row.rawPayloadJson).toBeNull();
  expect(JSON.stringify(row)).not.toContain("SECRET");
  expect(() => messages.updateRawPayload(message.id, { secret: "resurrect" })).toThrow("cannot be modified");
  expect(connection.db.select().from(schema.sessionTimelineEntries).all()).toMatchObject([{ sessionId: reference.id, messageId: message.id, entryKind: "reference" }]);
  const response = await app().request(`/sessions/${reference.id}/messages`);
  expect(response.status).toBe(200);
  const body = JSON.stringify(await response.json());
  expect(body).toContain("该消息已删除");
  expect(body).not.toContain("SECRET");
  expect((await app().request(`/sessions/${reference.id}/timeline`)).status).toBe(200);
  expect(() => timeline.appendReference({ sessionId: owner.id, messageId: message.id })).toThrow("message_reference_scope_mismatch");
});

test("session cleanup deletes managed files and runner context and keeps independent tasks", async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { config } = await import("../../src/shared");
  const { createSessionRunnerPaths } = await import("../../src/shared/runner-paths");
  const session = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const root = createSessionRunnerPaths(session.id).runnerRootPath;
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, "context.txt"), "private");
  mkdirSync(config.paths.artifacts, { recursive: true });
  const file = join(config.paths.artifacts, "test.txt"); writeFileSync(file, "private");
  connection.db.insert(schema.managedArtifacts).values(fixtureArtifact(connection.db, { id: "a", scope_type: "session", scope_id: session.id, producer: "test", kind: "file", name: "test.txt", storage_key: file, created_at: 1 })).run();
  connection.db.insert(schema.tasks).values({ id: "independent", type: "task", title: "Keep me", status: "completed", priority: "medium", primary_session_id: session.id, created_at: 1, updated_at: 1, last_activity_at: 1 , ...fixtureTaskOwnership(connection.db,session.id)}).run();
  deleteDashboardSession(connection.db, session.id);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(root)).toBe(false);
  expect(connection.db.select().from(schema.managedArtifacts).all()).toHaveLength(0);
  expect(connection.db.select().from(schema.tasks).get()).toMatchObject({ id: "independent", primary_session_id: null });
});

test("busy reference prevents erasure, and a completed delete cannot recreate inbox work", async () => {
  const { MessageStore } = await import("../../src/sessions/message-store");
  const { SessionTimelineStore } = await import("../../src/sessions/session-timeline-store");
  const owner = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin")), ref = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  const message = new MessageStore(connection.db).append({ sessionId: owner.id, senderUserId: store.requireReplyUserId(owner.id), role: "assistant", content: { text: "Keep until idle" } });
  new SessionTimelineStore(connection.db).appendReference({ sessionId: ref.id, messageId: message.id });
  connection.db.insert(schema.sessionInbox).values({ id: "busy", session_id: ref.id, message_id: message.id, entry_id: "ref", status: "processing", received_at: 1, created_at: 1, updated_at: 1 }).run();
  expect(() => deleteDashboardSession(connection.db, owner.id)).toThrow("正在处理");
  expect(store.getById(owner.id)).toBeDefined();
  connection.db.update(schema.sessionInbox).set({ status: "completed" }).run();
  deleteDashboardSession(connection.db, owner.id);
  expect(() => connection.db.insert(schema.sessionInbox).values({ id: "late", session_id: owner.id, message_id: message.id, entry_id: "late", status: "pending", received_at: 1, created_at: 1, updated_at: 1 }).run()).toThrow("Session has been deleted");
});

test("file cleanup manifests retry after service restart", async () => {
  const { sql } = await import("drizzle-orm");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { config } = await import("../../src/shared");
  mkdirSync(config.paths.artifacts, { recursive: true });
  const file = join(config.paths.artifacts, "pending.txt"); writeFileSync(file, "private");
  connection.db.run(sql`INSERT INTO session_deletions (session_id, deleted_at, pending_paths) VALUES ('interrupted', 1, ${JSON.stringify([file])})`);
  connection.close();
  connection = new DataConnection(schema);
  expect(existsSync(file)).toBe(false);
  expect(connection.db.all<{ pending_paths: string }>(sql`SELECT pending_paths FROM session_deletions WHERE session_id = 'interrupted'`)[0]?.pending_paths).toBe("[]");
});

test("an artifact referenced by another owner survives with its new owner", async () => {
  const { MessageStore } = await import("../../src/sessions/message-store");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { config } = await import("../../src/shared");
  const owner = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin")), other = store.createLocalSession("user:admin",fixtureScope(connection.db,"admin"));
  mkdirSync(config.paths.artifacts, { recursive: true });
  const file = join(config.paths.artifacts, "shared.txt"); writeFileSync(file, "shared");
  connection.db.insert(schema.managedArtifacts).values(fixtureArtifact(connection.db, { id: "shared-artifact", scope_type: "session", scope_id: owner.id, producer: "test", kind: "file", name: "shared.txt", storage_key: file, created_at: 1 })).run();
  new MessageStore(connection.db).append({ sessionId: other.id, senderUserId: store.requireReplyUserId(other.id), role: "assistant", content: { text: "artifact://shared-artifact" } });
  deleteDashboardSession(connection.db, owner.id);
  expect(existsSync(file)).toBe(true);
  expect(connection.db.select().from(schema.managedArtifacts).get()?.scope_id).toBe(other.id);
  deleteDashboardSession(connection.db, other.id);
  expect(existsSync(file)).toBe(false);
});

for (const state of ["active", "revoked"] as const) test(`session deletion waits for ${state} Runtime invocation settlement`, async () => {
  const session = store.resolveByChannelSurface(surface);
  connection.db.insert(schema.runnerInvocations).values({ agentId: session.agent_id, shadowId: session.shadow_id, id: "runtime-inv", runnerKind: "main", actorUserId: "user:admin", runnerContextId: "runtime-context", sessionId: session.id, originId: "runtime-origin", state, inputSnapshot: { version: 1, input: {} }, contextPackIds: [], createdAt: 1 }).run();
  expect((await app().request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(409);
  expect(store.getById(session.id)?.status).toBe("active");
  expect(store.resolveByChannelSurface(surface).id).toBe(session.id);
  connection.db.update(schema.runnerInvocations).set({ state: "settled", settledAt: Date.now() }).run();
  expect((await app().request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(200);
});
