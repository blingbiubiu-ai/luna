import {fixtureArtifact} from "../helpers/platform-fixtures";
import {fixtureScope} from "../helpers/platform-fixtures";
import { createSessionsRoutes } from "../../src/server/routes/sessions";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { config, setLunaHome } from "../../src/shared";
import { createTaskRunnerPaths } from "../../src/shared/runner-paths";
import { SessionStore } from "../../src/sessions/session-store";
import { MessageStore } from "../../src/sessions/message-store";
import { createTasksRoutes } from "../../src/server/routes/tasks";
import { createSessionCommandAdminRoutes } from "../../src/server/routes/session-commands";
import { deleteDashboardTask, deleteDashboardSchedule } from "../../src/dashboard-api/task-deletion";
let home: string, db: DataConnection<typeof schema>;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "luna-task-delete-")); setLunaHome(home); db = new DataConnection(schema); });
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
function app(kind = "dashboard-cookie", userId = "admin") {
  return new Hono<{ Variables: Record<string, unknown> }>().use("*", async (c, next) => {
    c.set("dashboardAuthSession", { authenticated: true, account: { id: userId, name: "Fixture user", provider: "test" } });
    c.set("lunaRequestAuthKind", kind);
    if (kind !== "dashboard-cookie") c.set("lunaAccessTokenClaims", { source: "runner" });
    await next();
  }).route("/sessions", createSessionsRoutes({ db: db.db })).route("/tasks", createTasksRoutes({ db: db.db })).route("/session-commands", createSessionCommandAdminRoutes({ db: db.db }));
}
function task(status = "completed") {
  const { agentId, shadowId } = fixtureScope(db.db, "admin");
  db.db.insert(schema.tasks).values({ id: "task", type: "task", title: "Delete me", status, priority: "medium", created_at: 1, updated_at: 1, last_activity_at: 1, agent_id: agentId, shadow_id: shadowId, creator_user_id: "user:admin"}).run();
}
function schedule(commandStatus?: string) {
  const session = new SessionStore(db.db).createLocalSession("user:admin",fixtureScope(db.db,"admin"));
  db.db.insert(schema.sessionSchedules).values({ id: "schedule", title: "Reminder", actorUserId: "user:admin", sourceSessionId: session.id, targetSessionId: session.id, action: { kind: "message.send", content: "hello" }, timezone: "UTC", nextAt: Date.now() + 60000, intervalMs: 60000, enabled: true, revision: 1, overlap: "skip", misfire: "skip", expiresAfterMs: 1000, createdAt: 1 }).run();
  if (commandStatus) {
    const message = new MessageStore(db.db).append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: "assistant", content: { text: "hello" }, rawPayload: { deliveryStatus: commandStatus } });
    db.db.insert(schema.sessionCommands).values({ id: "command", kind: "message.send", sessionId: session.id, sourceSessionId: session.id, actorUserId: "user:admin", originId: "occurrence", dedupeKey: "key", payload: { content: "hello" }, status: commandStatus, messageId: message.id, correlationId: "corr", availableAt: 1, createdAt: 1, updatedAt: 1 }).run();
    db.db.insert(schema.scheduleOccurrences).values({ id: "occurrence", scheduleId: "schedule", scheduledAt: 1, revision: 1, commandId: "command", status: commandStatus, snapshot: { content: "hello" }, createdAt: 1 }).run();
  }
  return session;
}

test("task deletion removes task and owned files, preserves session messages, revokes tokens and is idempotent", async () => {
  task(); const session = new SessionStore(db.db).createLocalSession("user:admin",fixtureScope(db.db,"admin"));
  new MessageStore(db.db).append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: "assistant", content: { text: "Historical task reply" } });
  const root = createTaskRunnerPaths("task").runnerRootPath;
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, "context"), "private");
  mkdirSync(config.paths.artifacts, { recursive: true }); const file = join(config.paths.artifacts, "test"); writeFileSync(file, "private");
  db.db.insert(schema.managedArtifacts).values(fixtureArtifact(db.db, { id: "artifact", scope_type: "task", scope_id: "task", producer: "test", kind: "file", name: "test", storage_key: file, created_at: 1 })).run();
  db.db.insert(schema.accessTokens).values({ id: "token", tokenHash: "hash", userId: "user:admin", agentId: fixtureScope(db.db, "admin").agentId, source: "runner", sourceTaskId: "task", name: "task", role: "runner", issuedAt: 1, expiresAt: 999, createdAt: 1 }).run();
  expect((await app().request('/tasks/task', { method: 'DELETE' })).status).toBe(200);
  const pending = join(config.paths.artifacts, "retry-cleanup");
  writeFileSync(pending, "fixture");
  db.db.run(sql`UPDATE task_deletions SET pending_paths=${JSON.stringify([pending])} WHERE task_id='task'`);
  fixtureScope(db.db, "other");
  expect((await app("dashboard-cookie", "other").request('/tasks/task', { method: 'DELETE' })).status).toBe(403);
  expect(existsSync(pending)).toBe(true);

  expect((await app().request('/tasks/task', { method: 'DELETE' })).status).toBe(200);
  expect(existsSync(pending)).toBe(false);
  expect((await app().request('/tasks/task')).status).toBe(404);
  expect(db.db.select().from(schema.tasks).all()).toHaveLength(0);
  expect(db.db.select().from(schema.messages).all()).toHaveLength(1);
  expect(db.db.select().from(schema.accessTokens).get()?.revokedAt).toBeGreaterThan(0);
  expect(existsSync(root)).toBe(false); expect(existsSync(file)).toBe(false);
  expect(() => db.db.insert(schema.taskParticipants).values({ id: "late", task_id: "task", user_id: "user:admin", role: "owner", created_at: 1 }).run()).toThrow('Task has been deleted');
});

test("running tasks reject deletion without mutation", async () => {
  task("running");
  expect((await app().request('/tasks/task', { method: 'DELETE' })).status).toBe(409);
  expect(db.db.select().from(schema.tasks).get()?.status).toBe('running');
});

test("running schedule executions reject deletion without mutation", async () => {
  const source = schedule("running");
  expect((await app().request(`/session-commands/schedules/schedule?agentId=${source.agent_id}`, { method: 'DELETE' })).status).toBe(409);
  expect(db.db.select().from(schema.sessionSchedules).get()?.enabled).toBe(true);
});

test("schedule deletion removes schedule and occurrences, cancels pending commands, preserves messages", async () => {
  const source = schedule("pending");
  expect((await app().request(`/session-commands/schedules/schedule?agentId=${source.agent_id}`, { method: 'DELETE' })).status).toBe(200);
  expect((await app().request(`/session-commands/schedules/schedule?agentId=${source.agent_id}`, { method: 'DELETE' })).status).toBe(404);
  expect(db.db.select().from(schema.sessionSchedules).all()).toHaveLength(0);
  expect(db.db.select().from(schema.scheduleOccurrences).all()).toHaveLength(0);
  expect(db.db.select().from(schema.sessionCommands).all()).toHaveLength(0);
  expect(db.db.select().from(schema.messages).get()?.rawPayloadJson).toMatchObject({ deliveryStatus: 'cancelled' });
  expect(() => db.db.insert(schema.scheduleOccurrences).values({ id: 'late', scheduleId: 'schedule', scheduledAt: 2, revision: 1, status: 'pending', snapshot: {}, createdAt: 2 }).run()).toThrow('Schedule has been deleted');
});

test("deletion requires a Dashboard session and unknown IDs return 404", async () => {
  task(); const source = schedule();
  for (const path of ['/tasks/task', `/session-commands/schedules/schedule?agentId=${source.agent_id}`]) expect((await app('luna-access-token').request(path, { method: 'DELETE' })).status).toBe(403);
  for (const path of ['/tasks/missing', `/session-commands/schedules/missing?agentId=${source.agent_id}`]) expect((await app().request(path, { method: 'DELETE' })).status).toBe(404);
});

test("a new idle task can be deleted and shared task artifacts survive", () => {
  task('new'); const session = new SessionStore(db.db).createLocalSession('user:admin',fixtureScope(db.db,'admin'));
  mkdirSync(config.paths.artifacts, { recursive: true }); const file = join(config.paths.artifacts, 'shared'); writeFileSync(file, 'shared');
  db.db.insert(schema.managedArtifacts).values(fixtureArtifact(db.db, { id: 'shared', scope_type: 'task', scope_id: 'task', producer: 'test', kind: 'file', name: 'shared', storage_key: file, created_at: 1 })).run();
  new MessageStore(db.db).append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: 'assistant', content: { text: 'artifact:shared' } });
  deleteDashboardTask(db.db, 'task');
  expect(existsSync(file)).toBe(true);
  expect(db.db.select().from(schema.managedArtifacts).get()?.scope_id).toBe(session.id);
});

test("deleted tasks retain session, source-message, card and markdown references without retaining task content", async () => {
  task();
  const session = new SessionStore(db.db).createLocalSession('user:admin',fixtureScope(db.db,'admin'));
  const store = new MessageStore(db.db);
  const source = store.append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: 'assistant', content: { text: 'Original request' } });
  db.db.update(schema.tasks).set({ primary_session_id: session.id, source_message_id: source.id }).where(eq(schema.tasks.id, 'task')).run();
  store.append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: 'assistant', presentationKind: 'task_result_card', content: { text: 'Historical result' }, rawPayload: { sourceTaskId: 'task' } });
  store.append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: 'assistant', content: { text: '[View task](/agent/tasks/task)' } });
  deleteDashboardTask(db.db, 'task');
  const sessions = await (await app().request(`/sessions?agentId=${session.agent_id}`)).json() as Array<{id:string;linkedTasks:unknown[]}>;
  expect(sessions.find(row => row.id === session.id)?.linkedTasks).toEqual([{ id: 'task', title: '该任务已删除', status: 'deleted', priority: null }]);
  const messages = await (await app().request(`/sessions/${session.id}/messages`)).json() as Array<{linkedTasks:unknown[];presentation?:{task?:unknown}}>;
  expect(messages).toHaveLength(3);
  for (const message of messages) expect(message.linkedTasks).toMatchObject([{ id: 'task', status: 'deleted', title: '该任务已删除' }]);
  expect(messages[1]?.presentation?.task).toMatchObject({ id: 'task', status: 'deleted' });
  expect(JSON.stringify(db.db.all(sql`SELECT * FROM deleted_task_references`))).not.toContain('Delete me');
  // Later references to an already deleted task receive the same placeholder.
  store.append({ sessionId: session.id, senderUserId: session.bot_user_id!, role: 'assistant', content: { text: '[Later reference](/agent/tasks/task)' } });
  const later = await (await app().request(`/sessions/${session.id}/messages`)).json() as Array<{linkedTasks:unknown[]}>;
  expect(later.at(-1)?.linkedTasks).toMatchObject([{ id: 'task', status: 'deleted' }]);
});

for (const state of ["active", "revoked"] as const) test(`task deletion waits for ${state} Runtime invocation settlement`, async () => {
  task("cancelled");
  const invocationTask = db.db.select().from(schema.tasks).where(eq(schema.tasks.id, "task")).get()!;
  db.db.insert(schema.runnerInvocations).values({ agentId: invocationTask.agent_id, shadowId: invocationTask.shadow_id, id: "runtime-inv", runnerKind: "task", actorUserId: "user:admin", runnerContextId: "runtime-context", taskId: "task", taskRunId: "runtime-run", originId: "runtime-origin", state, inputSnapshot: { version: 1, input: {} }, contextPackIds: [], createdAt: 1 }).run();
  expect((await app().request('/tasks/task', { method: 'DELETE' })).status).toBe(409);
  expect(db.db.select().from(schema.tasks).get()?.status).toBe("cancelled");
  expect(db.db.all(sql`SELECT 1 FROM task_deletions`)).toHaveLength(0);
  db.db.update(schema.runnerInvocations).set({ state: "settled", settledAt: Date.now() }).run();
  expect((await app().request('/tasks/task', { method: 'DELETE' })).status).toBe(200);
});
