import {fixtureArtifact} from "../helpers/platform-fixtures";
import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import {fixtureScope} from "../helpers/platform-fixtures";
import { fixtureAgent, fixturePlatformAdmin, fixtureSessionOwnership } from "../helpers/platform-fixtures";
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
import { deleteDashboardSession, deleteDashboardUser } from "../../src/dashboard-api/deletion";

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
    c.set("dashboardAuthSession", { authenticated: true, user: { id: "admin", name: "Admin", provider: "test" } });
    c.set("lunaRequestAuthKind", kind);
    if (kind !== "dashboard-cookie") c.set("lunaAccessTokenClaims", { source: "runner" });
    await next();
  }).route("/sessions", createSessionsRoutes({ db: connection.db })).route("/users", createUsersRoutes({ db: connection.db }));
}
const surface = { channelType: "feishu", channelId: "test", groupId: "chat", threadId: "thread", rootMessageId: "root", createThreadLaunchContext: false };
test("session deletion releases all routing keys, removes the session and starts a fresh session", async () => {
  const old = store.resolveByChannelSurface(surface);
  expect((await app().request(`/sessions/${old.id}`, { method: "DELETE" })).status).toBe(200);
  expect(store.getById(old.id)).toBeUndefined();
  expect(connection.db.select().from(schema.sessionSurfaceAliases).all()).toHaveLength(0);
  expect(connection.db.select().from(schema.sessionChannelBindings).all()).toHaveLength(0);
  expect(() => store.channelBindings(old.id)).toThrow("unavailable");
  const next = store.resolveByChannelSurface(surface);
  expect(next.id).not.toBe(old.id);
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
test("session deletion requires a Dashboard owner and platform user deletion requires an administrator", async () => {
  const session = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  expect((await app("luna-access-token").request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(403);
  expect((await app("luna-access-token").request(`/users/admin`, { method: "DELETE" })).status).toBe(403);
  expect((await app().request("/sessions/missing", { method: "DELETE" })).status).toBe(404);
  expect((await app().request("/users/missing", { method: "DELETE" })).status).toBe(404);
});
test("deleted users lose bindings and grants; subsequent identity resolution creates a new user", async () => {
  const directory = new IdentityDirectory(connection.db);
  const channelDirectory = new ChannelDirectoryStore(connection.db);
  const sender = {
    channel: {type: "feishu", id: "test"},
    identity: {kind: "user" as const, displayName: "Test user", externalId: "ou_test",
      ...feishuIdentityMetadata({environment: "feishu", appId: "test:feishu:test", tenantKey: "tenant"}, {open_id: "ou_test", user_id: "same-user"})},
  };
  fixtureSessionOwnership(connection.db, "feishu", "second", "admin");
  const secondSender = {
    channel: {type: "feishu", id: "second"},
    identity: {...sender.identity, externalId: "ou_second",
      ...feishuIdentityMetadata({environment: "feishu", appId: "test:feishu:second", tenantKey: "tenant"}, {open_id: "ou_second", user_id: "same-user"})},
  };
  const observed = channelDirectory.upsertIdentity(sender);
  const other = channelDirectory.upsertIdentity(secondSender);
  const bound = (identityId: string) => connection.db.select().from(schema.channelUserBindings)
    .where(eq(schema.channelUserBindings.channelIdentityId, identityId)).get();
  const old = {id: bound(observed.id)!.userId};
  expect(bound(other.id)?.userId).toBe(old.id);
  connection.db.insert(schema.authorizationRules).values({ scopeType: "agent", agentId: fixtureAgent(connection.db).id, id: "grant", subjectType: "user", subjectId: old.id, target: "test", matchType: "exact", effect: "allow", createdAt: "1", updatedAt: "1" }).run();
  const scope = `?agentId=${fixtureAgent(connection.db, "admin").id}`;
  expect((await app().request(`/users/${old.id}`, { method: "DELETE" })).status).toBe(200);
  const detail = await app().request(`/users/${old.id}${scope}`);
  expect(detail.status).toBe(404);
  expect(((await (await app().request("/users" + scope)).json()) as { users: { id: string }[] }).users.some((user: { id: string }) => user.id === old.id)).toBe(false);
  expect((await app().request(`/users/${old.id}/group-memberships`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: "any", role: "member" }) })).status).toBe(404);
  expect((await app().request(`/users/${old.id}/authorization-rules/batch${scope}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ target: "agent.root", effect: "allow" }] }) })).status).toBe(404);
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, old.id)).get()?.status).toBe("deleted");
  expect(connection.db.select().from(schema.authorizationRules).where(eq(schema.authorizationRules.subjectId, old.id)).all()).toHaveLength(0);
  expect(bound(observed.id)).toBeUndefined();
  expect(bound(other.id)).toBeUndefined();
  expect(connection.db.select().from(schema.identityObservations).all()).toHaveLength(0);
  expect(channelDirectory.upsertIdentity(sender).id).toBe(observed.id);
  expect(channelDirectory.upsertIdentity(secondSender).id).toBe(other.id);
  const next = bound(observed.id)!.userId;
  expect(bound(other.id)?.userId).toBe(next);
  expect(next).not.toBe(old.id);
  expect(directory.resolveUserIdForIdentity({namespace: "feishu", kind: "open_id", value: "ou_test", scope: "app:test:feishu:test"})).toBe(next);
});
test("system identities and the current user are protected", () => {
  const session = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  expect(() => deleteDashboardUser(connection.db, session.bot_user_id!, "admin")).toThrow("系统身份");
  expect(() => deleteDashboardUser(connection.db, "admin", "admin")).toThrow("不能删除当前登录用户");
});
test("deletion disables schedules and revokes tokens without deleting historical users", () => {
  const session = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  connection.db.insert(schema.sessionSchedules).values({ id: "schedule", actorUserId: "admin", sourceSessionId: session.id, targetSessionId: session.id, action: {}, timezone: "UTC", nextAt: 999, enabled: true, revision: 1, overlap: "skip", misfire: "skip", expiresAfterMs: 1000, createdAt: 1 }).run();
  connection.db.insert(schema.accessTokens).values({ id: "token", tokenHash: "hash", userId: "admin", source: "runner", name: "test", role: "runner", sourceSessionId: session.id, issuedAt: 1, expiresAt: 999, createdAt: 1 }).run();
  deleteDashboardSession(connection.db, session.id);
  expect(connection.db.select().from(schema.sessionSchedules).get()).toBeUndefined();
  expect(connection.db.select().from(schema.accessTokens).get()?.revokedAt).toBeGreaterThan(0);
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, session.bot_user_id!)).get()?.kind).toBe("system");
});

test("deleted dashboard users cannot reuse a previously signed cookie", async () => {
  const { DashboardAuthService, createDashboardAuthMiddleware } = await import("../../src/server/auth");
  const auth = new DashboardAuthService({ provider: { id: "test", authenticateToken: async () => ({ id: "victim", name: "Victim", provider: "test" }) } });
  const login = await auth.login("test");
  const server = new Hono().use("*", createDashboardAuthMiddleware(auth, { db: connection.db })).get("/api/private", c => c.json({ ok: true }));
  const request = () => server.request("/api/private", { headers: { Cookie: `luna_dashboard_session=${login!.sessionToken}` } });
  expect((await request()).status).toBe(200);
  deleteDashboardUser(connection.db, "victim", "admin");
  expect((await request()).status).toBe(401);
});


test("historical message authors retain deleted status and resolve to read-only details", async () => {
  const user = new IdentityDirectory(connection.db).materializeIdentityClaims({ kind: "human", displayName: "Historical author", claims: [] });
  const session = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  connection.db.insert(schema.messages).values({ id: "historical-message", agentId:session.agent_id,shadowId:session.shadow_id,bindingId:session.binding_id, channelType: "dashboard", channelId: "luna-dashboard", externalMessageId: "historical", senderUserId: user.id, role: "user", contentKind: "text", presentationKind: "plain", contentJson: { type: "text", text: "Historical message" }, occurredAt: 1, createdAt: 1 }).run();
  connection.db.insert(schema.sessionTimelineEntries).values({ id: "historical-entry", sessionId: session.id, messageId: "historical-message", entryKind: "message", createdAt: 1 }).run();
  deleteDashboardUser(connection.db, user.id, "admin");
  const response = await app().request(`/sessions/${session.id}/messages`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([{ senderUser: { id: user.id, status: "deleted", displayName: "Historical author" } }]);
  const detail = await app().request(`/users/${user.id}?agentId=${session.agent_id}`);
  expect(await detail.json()).toMatchObject({ id: user.id, status: "deleted", messageCount: 1, sessionCount: 1 });
});


test("shared membership and permission writes also reject deleted users", async () => {
  const { GroupStore } = await import("../../src/server/groups/group-store");
  const { AuthorizationRuleStore } = await import("../../src/server/policy/authorization-rule-store");
  const user = new IdentityDirectory(connection.db).materializeIdentityClaims({ kind: "human", displayName: "Read-only user", claims: [] });
  deleteDashboardUser(connection.db, user.id, "admin");
  connection.db.insert(schema.groups).values({ agentId: fixtureAgent(connection.db).id, id: "group", slug: "group", displayName: "Group", createdAt: "1", updatedAt: "1" }).run();
  expect(() => new GroupStore(connection.db).addMember({ groupId: "group", userId: user.id })).toThrow("active_user_required");
  expect(() => new AuthorizationRuleStore(connection.db, {kind: "platform"}).addGrant({ subjectType: "user", subjectId: user.id, target: "system.admin", effect: "allow" })).toThrow("已删除用户");
  expect(connection.db.select().from(schema.groupMemberships).all()).toHaveLength(0);
  expect(connection.db.select().from(schema.authorizationRules).all()).toHaveLength(0);
});

test("deletion protects system kind rather than bot kind or profile source", () => {
  const directory = new IdentityDirectory(connection.db);
  const system = directory.materializeIdentityClaims({ kind: "system", displayName: "System", claims: [] });
  expect(() => deleteDashboardUser(connection.db, system.id, "admin")).toThrow("系统身份");
  const bot = directory.materializeIdentityClaims({ kind: "bot", displayName: "Old bot", claims: [] });
  connection.db.update(schema.users).set({ profileSource: "system" }).where(eq(schema.users.id, bot.id)).run();
  deleteDashboardUser(connection.db, bot.id, "admin");
  expect(connection.db.select().from(schema.users).where(eq(schema.users.id, bot.id)).get()?.status).toBe("deleted");
});

test("a session reply identity cannot be replaced with a provider bot user", () => {
  const bot = new IdentityDirectory(connection.db).materializeIdentityClaims({ kind: "bot", displayName: "Provider bot", claims: [] });
  const session = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  expect(() => connection.db.update(schema.sessions).set({ bot_user_id: bot.id }).where(eq(schema.sessions.id, session.id)).run())
    .toThrow("session_scope_immutable");
  expect(() => store.bindBotUser(session.id, bot.id)).toThrow("session_reply_identity_mismatch");
  deleteDashboardUser(connection.db, bot.id, "admin");
  expect(store.requireReplyUserId(session.id)).toBe(session.bot_user_id!);
});

test("deleting owner scrubs messages and keeps safe reference placeholders; deleting references does not delete owners", async () => {
  const { MessageStore } = await import("../../src/sessions/message-store");
  const { SessionTimelineStore } = await import("../../src/sessions/session-timeline-store");
  const owner = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  const reference = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
  const secondary = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
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
  const session = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
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
  const owner = store.createLocalSession("admin",fixtureScope(connection.db,"admin")), ref = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
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
  const owner = store.createLocalSession("admin",fixtureScope(connection.db,"admin")), other = store.createLocalSession("admin",fixtureScope(connection.db,"admin"));
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
  connection.db.insert(schema.runnerInvocations).values({ agentId: session.agent_id, shadowId: session.shadow_id, id: "runtime-inv", runnerKind: "work", actorUserId: "admin", runnerContextId: "runtime-context", sessionId: session.id, originId: "runtime-origin", state, inputSnapshot: { version: 1, input: {} }, contextPackIds: [], createdAt: 1 }).run();
  expect((await app().request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(409);
  expect(store.getById(session.id)?.status).toBe("active");
  expect(store.resolveByChannelSurface(surface).id).toBe(session.id);
  connection.db.update(schema.runnerInvocations).set({ state: "settled", settledAt: Date.now() }).run();
  expect((await app().request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(200);
});
