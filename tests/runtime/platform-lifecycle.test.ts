import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq, sql} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {AgentLifecycleStore} from "@/agents/agent-lifecycle-store";
import {SessionStore} from "@/sessions/session-store";
import {AccessTokenService} from "@/server/auth/access-token-service";
import {fixtureScope, fixtureRunnerContext, fixtureOwnerUserId} from "../helpers/platform-fixtures";

let home: string, connection: DataConnection<typeof schema>, scope: ReturnType<typeof fixtureScope>;
let first: string, other: string, shadowId: string;
const owner = "owner", ownerUser = fixtureOwnerUserId(owner);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-lifecycle-")); setLunaHome(home);
  connection = new DataConnection(schema); scope = fixtureScope(connection.db, owner);
  const agents = new AgentStore(connection.db);
  shadowId = agents.createShadow(owner, scope.agentId, {name: "Other"}, "other").id;
  first = new SessionStore(connection.db).createLocalSession(ownerUser, scope).id;
  other = new SessionStore(connection.db).createLocalSession(ownerUser, {...scope, shadowId}).id;
});
afterEach(() => {connection.close(); rmSync(home, {recursive: true, force: true});});
function seedQueue(sessionId: string) {
  const db = connection.db;

  db.insert(schema.sessionSchedules).values({id: sessionId, actorUserId: ownerUser, sourceSessionId: sessionId, targetSessionId: sessionId,
    action: {}, timezone: "UTC", nextAt: 1, enabled: true, revision: 1, overlap: "skip", misfire: "skip", expiresAfterMs: 1000, createdAt: 1}).run();
  db.insert(schema.sessionCommands).values({id: sessionId, kind: "message.send", sessionId, sourceSessionId: sessionId, actorUserId: ownerUser,
    originId: "test", dedupeKey: sessionId, payload: {}, status: "pending", correlationId: sessionId, availableAt: 1, createdAt: 1, updatedAt: 1}).run();
  db.insert(schema.runnerContexts).values(fixtureRunnerContext(db, {id: sessionId, owner_type: "session", owner_id: sessionId, runner_type: "test", runner_root_path: "/unused", created_at: 1, updated_at: 1})).run();
  return new AccessTokenService({db, signingSecret: "test"}).issueToken({userId: ownerUser, name: "test", source: "runner", role: "runner", runnerKind: "work", sourceSessionId: sessionId, sourceRunnerJobId: sessionId, now: Date.now(), ttlMs: 60000});
}
test("Shadow disable atomically revokes authority and cancels queued work without touching siblings", () => {
  const firstToken = seedQueue(first), otherToken = seedQueue(other);
  const lifecycle = new AgentLifecycleStore(connection.db);
  const job = lifecycle.request(owner, scope, "disabled", "disable-shadow");
  expect(job.status).toBe("pending");
  expect(lifecycle.request(owner, scope, "disabled", "disable-shadow").id).toBe(job.id);
  expect(() => lifecycle.request(owner, scope, "active", "disable-shadow")).toThrow("idempotency_conflict");
  expect(() => lifecycle.request(owner, scope, "active", "resume")).toThrow("lifecycle_pending");
  const tokens = new AccessTokenService({db: connection.db, signingSecret: "test"});
  expect(() => tokens.verifyBearer(firstToken.token, {now: Date.now()})).toThrow("revoked_access_token");
  expect(tokens.verifyBearer(otherToken.token, {now: Date.now()}).claims.shadowId).toBe(shadowId);
  expect(connection.db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, first)).get()?.status).toBe("cancelled");
  expect(connection.db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, other)).get()?.status).toBe("pending");
  expect(connection.db.select().from(schema.sessionSchedules).where(eq(schema.sessionSchedules.id, first)).get()).toMatchObject({enabled: false, paused: true, revision: 2});
  expect(() => new AgentStore(connection.db).requireScope(ownerUser, scope)).toThrow("shadow_disabled");
  expect(new AgentLifecycleStore(connection.db).pending().map(row => row.id)).toEqual([job.id]);
});
test("Agent disable closes every Shadow while owner can still inspect configuration", () => {
  seedQueue(first); seedQueue(other);
  new AgentLifecycleStore(connection.db).request(owner, {agentId: scope.agentId}, "disabled", "disable-agent");
  const agents = new AgentStore(connection.db);
  expect(agents.listShadows(owner, scope.agentId)).toHaveLength(2);
  expect(() => agents.requireScope(ownerUser, {...scope, shadowId})).toThrow("agent_disabled");
  expect(connection.db.select().from(schema.sessionSchedules).all().every(row => !row.enabled)).toBe(true);
  expect(() => new AgentLifecycleStore(connection.db).request(owner, {...scope, shadowId}, "active", "resume-child")).toThrow("agent_disabled");
});

test("lifecycle retries an unconfirmed Worker drain and completes after only its own work settles", async () => {
  seedQueue(first); seedQueue(other);
  const db = connection.db;
  db.update(schema.sessionCommands).set({status: "running"}).where(eq(schema.sessionCommands.id, first)).run();
  const lifecycle = new AgentLifecycleStore(db);
  const job = lifecycle.request(owner, scope, "disabled", "drain-shadow");
  const drained: string[] = [];
  let connected = false;
  const reconcile = () => new AgentLifecycleStore(db).reconcile(job, async () => {}, async target => {
    drained.push(target.shadowId);
    if (!connected) throw Error("worker_disconnected");
  });
  await reconcile();
  expect(drained).toEqual([]);
  db.update(schema.sessionCommands).set({status: "sent"}).where(eq(schema.sessionCommands.id, first)).run();
  await reconcile();
  expect(lifecycle.pending()[0]).toMatchObject({id: job.id, lastError: "worker_disconnected"});
  connected = true;
  await reconcile();
  expect(drained).toEqual([scope.shadowId, scope.shadowId]);
  expect(lifecycle.pending()).toEqual([]);
  expect(lifecycle.request(owner, scope, "disabled", "drain-shadow")).toMatchObject({id: job.id, status: "completed", lastError: null});
  expect(lifecycle.request(owner, scope, "active", "resume-shadow").status).toBe("completed");
  expect(db.select().from(schema.sessionCommands).where(eq(schema.sessionCommands.id, other)).get()?.status).toBe("pending");
});
test("only owner can change lifecycle and default Shadow cannot be deleted independently", () => {
  fixtureScope(connection.db, "member");
  const lifecycle = new AgentLifecycleStore(connection.db);
  expect(() => lifecycle.request("member", scope, "disabled", "forged")).toThrow("agent_access_denied");
  expect(() => lifecycle.request(owner, scope, "deleted", "default-delete")).toThrow("default_shadow_delete_forbidden");
  const foreign = fixtureScope(connection.db, "foreign");
  expect(() => lifecycle.request(owner, {...scope, shadowId: foreign.shadowId}, "disabled", "foreign-shadow")).toThrow("scope_mismatch");
  expect(lifecycle.pending()).toHaveLength(0);
});
test("Agent soft deletion preserves its history and an idempotent audit receipt", () => {
  const lifecycle = new AgentLifecycleStore(connection.db);
  const job = lifecycle.request(owner, {agentId: scope.agentId}, "deleted", "delete");
  expect(lifecycle.request(owner, {agentId: scope.agentId}, "deleted", "delete").id).toBe(job.id);
  expect(new AgentStore(connection.db).get(scope.agentId).status).toBe("deleted");
  expect(new SessionStore(connection.db).getById(first)).toBeDefined();
  expect(connection.db.select().from(schema.agentShadows).all().every(row => row.status === "deleted")).toBe(true);
  expect(() => lifecycle.request(owner, {agentId: scope.agentId}, "active", "restore-deleted")).toThrow("agent_deleted");
  expect(connection.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
});

test("lifecycle acceptance is transactional if durable audit persistence fails", () => {
  const issued = seedQueue(first);
  connection.db.run(sql`CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON agent_lifecycle_jobs BEGIN SELECT RAISE(ABORT,'audit_unavailable'); END`);
  expect(() => new AgentLifecycleStore(connection.db).request(owner, scope, "disabled", "rollback")).toThrow();
  expect(new AgentStore(connection.db).shadow(scope.shadowId).status).toBe("active");
  expect(connection.db.select().from(schema.sessionSchedules).get()).toMatchObject({enabled: true, revision: 1});
  expect(connection.db.select().from(schema.sessionCommands).get()?.status).toBe("pending");
  expect(new AccessTokenService({db: connection.db, signingSecret: "test"}).verifyBearer(issued.token, {now: Date.now()}).claims.shadowId).toBe(scope.shadowId);
});

test("deleting a Shadow purges its Worker data after draining; disabling keeps it", async () => {
  const lifecycle = new AgentLifecycleStore(connection.db);
  const calls: string[] = [];
  const drain = async (target: {shadowId: string}) => {calls.push(`drain:${target.shadowId}`);};
  const purge = async (target: {shadowId: string}) => {calls.push(`purge:${target.shadowId}`);};
  const target = {agentId: scope.agentId, shadowId};
  const disabled = lifecycle.request(owner, target, "disabled", "disable-other");
  await lifecycle.reconcile(disabled, async () => {}, drain, purge);
  expect(calls).toEqual([`drain:${shadowId}`]);
  lifecycle.request(owner, target, "active", "resume-other");
  calls.length = 0;
  const deleted = lifecycle.request(owner, target, "deleted", "delete-other");
  let reachable = false;
  await lifecycle.reconcile(deleted, async () => {}, drain, async target => {
    calls.push(`purge:${target.shadowId}`);
    if (!reachable) throw Error("worker_disconnected");
  });
  // A Worker that cannot be reached keeps the job pending; the purge is retried.
  expect(lifecycle.pending()[0]).toMatchObject({id: deleted.id, lastError: "worker_disconnected"});
  expect(lifecycle.purgeable([target])).toEqual([]);
  reachable = true;
  calls.length = 0;
  await lifecycle.reconcile(deleted, async () => {}, drain, purge);
  expect(calls).toEqual([`drain:${shadowId}`, `purge:${shadowId}`]);
  expect(lifecycle.pending()).toEqual([]);
});

test("purgeable lists only placed Shadows that are deleted with no lifecycle job pending", () => {
  const lifecycle = new AgentLifecycleStore(connection.db);
  const deleted = {agentId: scope.agentId, shadowId}, live = {agentId: scope.agentId, shadowId: scope.shadowId};
  connection.db.update(schema.agentShadows).set({status: "deleted"}).where(eq(schema.agentShadows.id, shadowId)).run();
  expect(lifecycle.purgeable([deleted, live, {agentId: scope.agentId, shadowId: "unknown"}])).toEqual([deleted]);
  lifecycle.request(owner, {agentId: scope.agentId}, "disabled", "disable-agent");
  expect(lifecycle.purgeable([deleted])).toEqual([]);
});

test("live keeps only Shadows this Service knows, of the right Agent, with neither deleted", () => {
  const lifecycle = new AgentLifecycleStore(connection.db);
  const live = {agentId: scope.agentId, shadowId: scope.shadowId}, deleted = {agentId: scope.agentId, shadowId};
  connection.db.update(schema.agentShadows).set({status: "deleted"}).where(eq(schema.agentShadows.id, shadowId)).run();
  expect(lifecycle.live([live, deleted, {agentId: scope.agentId, shadowId: "unknown"}, {agentId: "unknown", shadowId: scope.shadowId}])).toEqual([live]);
  connection.db.update(schema.lunaAgents).set({status: "deleted"}).where(eq(schema.lunaAgents.id, scope.agentId)).run();
  expect(lifecycle.live([live])).toEqual([]);
});
