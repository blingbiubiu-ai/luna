import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { fixtureAccount, fixtureScope, fixtureUser } from "../helpers/platform-fixtures";
import { ROOT_OPERATION, ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";
import { createShadowRootAccessRoutes } from "@/server/routes/shadow-root-access";
import { createRunnerRootRoutes } from "@/server/routes/runner-root";

let home: string, connection: DataConnection<typeof schema>, store: ShadowRootAccessStore;
let alice: ReturnType<typeof fixtureScope>, ownerId: string, bobId: string, carolId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-root-access-")); setLunaHome(home);
  connection = new DataConnection(schema); store = new ShadowRootAccessStore(connection.db);
  alice = fixtureScope(connection.db, "alice"); ownerId = alice.ownerUserId;
  // "bob" is both a signed-in account that does not own Alice's Agent and, separately, a user inside it.
  fixtureAccount(connection.db, "bob");
  bobId = fixtureUser(connection.db, alice.agentId, "bob"); carolId = fixtureUser(connection.db, alice.agentId, "carol");
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });

const now = new Date().toISOString();
function group(id: string, members: string[]) {
  connection.db.insert(schema.groups).values({ id, agentId: alice.agentId, slug: id, displayName: id, createdAt: now, updatedAt: now }).run();
  for (const userId of members) connection.db.insert(schema.groupMemberships).values({ id: `${id}-${userId}`, groupId: id, userId, createdAt: now, updatedAt: now }).run();
}
test("only the Agent owner reads or changes the switch", () => {
  expect(() => store.settings("bob", alice)).toThrow();
  expect(() => store.setEnabled("bob", alice, true)).toThrow();
  expect(store.setEnabled("alice", alice, true)).toEqual({ shadowId: alice.shadowId, enabled: true });
});

/** Same path as the Users/Groups pages' grant dialogs. */
const grant = (subjectType: "user" | "group", subjectId: string, effect: "allow" | "deny" = "allow", agentId = alice.agentId) =>
  new AuthorizationRuleStore(connection.db, { kind: "agent", agentId }).addGrant({ subjectType, subjectId, target: ROOT_OPERATION, effect });

test("trust is the owner or an agent.root grant, direct or through a group, on this Agent only", () => {
  expect(store.trusted(alice, ownerId)).toBe(true);
  expect(store.trusted(alice, bobId)).toBe(false);
  grant("user", bobId);
  expect(store.trusted(alice, bobId)).toBe(true);
  group("ops", [carolId]);
  expect(store.trusted(alice, carolId)).toBe(false);
  grant("group", "ops");
  expect(store.trusted(alice, carolId)).toBe(true);
  // A deny wins over a group allow.
  grant("user", carolId, "deny");
  expect(store.trusted(alice, carolId)).toBe(false);
  // A grant on another Agent does not count here.
  const other = fixtureScope(connection.db, "dave");
  const daveId = fixtureUser(connection.db, other.agentId, "dave");
  grant("user", daveId, "allow", other.agentId);
  expect(store.trusted(alice, daveId)).toBe(false);
  expect(store.trusted(other, daveId)).toBe(true);
  // Alice's owner user is not a user of the other Agent.
  expect(store.trusted(other, ownerId)).toBe(false);
  expect(store.trusted(alice, null)).toBe(false);
});

test("routes require the owner's Dashboard session", async () => {
  const app = (actor: string) => new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", { authenticated: true, account: { id: actor, name: actor, provider: "test" } });
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); await next();
  }).route("/", createShadowRootAccessRoutes(connection.db));
  const path = `/${alice.agentId}/shadows/${alice.shadowId}/root`;
  const put = (actor: string, body: unknown) => app(actor).request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await put("bob", { enabled: true })).status).not.toBe(200);
  expect(await (await put("alice", { enabled: true })).json()).toEqual({ shadowId: alice.shadowId, enabled: true });
  expect((await put("alice", { enabled: "yes" })).status).toBe(400);
});

test("luna root status answers for the runner token's own Shadow only", async () => {
  const runner = (claims: Record<string, unknown> | undefined) => new Hono().use("*", async (c, next) => {
    (c as any).set("lunaAccessTokenClaims", claims); await next();
  }).route("/", createRunnerRootRoutes({ db: connection.db }));
  const claims = { source: "runner", role: "runner", agentId: alice.agentId, shadowId: alice.shadowId };
  const status = async (query: string, as: Record<string, unknown> | null = claims) => {
    const response = await runner(as ?? undefined).request(`/root/status${query}`);
    return { status: response.status, body: await response.json() };
  };
  expect(await status("")).toEqual({ status: 200, body: { rootAccess: false } });
  store.setEnabled("alice", alice, true);
  grant("user", bobId);
  expect((await status(`?user=${ownerId}`)).body).toEqual({ rootAccess: true, user: ownerId, trusted: true });
  expect((await status(`?user=${bobId}`)).body).toMatchObject({ trusted: true });
  expect((await status(`?user=${carolId}`)).body).toMatchObject({ trusted: false });
  expect((await status("?user=nobody")).body).toMatchObject({ trusted: false });
  // The trusted list is never returned, and only runner tokens may ask.
  expect(JSON.stringify((await status("")).body)).not.toContain(bobId);
  expect((await status("", null)).status).toBe(403);
  expect((await status("", { ...claims, source: "cli", role: "user" })).status).toBe(403);
  // Another Shadow's token sees its own switch, not this one.
  const other = fixtureScope(connection.db, "dave");
  expect((await status(`?user=${ownerId}`, { ...claims, agentId: other.agentId, shadowId: other.shadowId })).body).toEqual({ rootAccess: false, user: ownerId, trusted: false });
});

test("invocationPrivileged gates kernel-level sudo to invocations with a trusted requester", () => {
  const base = { agentId: alice.agentId, shadowId: alice.shadowId };
  expect(store.invocationPrivileged({ ...base, actorUserId: ownerId })).toEqual({ rootAccess: false, privileged: false });

  store.setEnabled("alice", alice, true);
  grant("user", bobId);

  // Untrusted DM or turn: container keeps rootAccess, but Runner subprocess stays restricted (privileged: false).
  expect(store.invocationPrivileged({ ...base, actorUserId: carolId })).toEqual({ rootAccess: true, privileged: false });
  // Owner and agent.root grantee get privileged: true.
  expect(store.invocationPrivileged({ ...base, actorUserId: ownerId })).toEqual({ rootAccess: true, privileged: true });
  expect(store.invocationPrivileged({ ...base, actorUserId: bobId })).toEqual({ rootAccess: true, privileged: true });

  // Group turn batch: if at least one user message in the batch comes from a trusted sender, privileged is true.
  const inbound = {
    id: "m1", channel: { type: "feishu", id: "ch1" }, surface: { externalId: "chat1", kind: "group" },
    sender: { externalId: "ext", kind: "user" as const }, text: "ok", mentions: [], addressing: { addressedToBot: true, reason: "mention" },
  };
  const runnerContext = {
    id: "ctx1", agent_id: alice.agentId, shadow_id: alice.shadowId, owner_type: "session", owner_id: "s1",
    runner_type: "claude", runner_session_id: null, instruction_fingerprint: null, runner_root_path: "/r", workspacePath: "/r/w", ipcPath: "/r/i",
    last_run_id: null, created_at: 1, updated_at: 1,
  };
  const batchSnapshot = (senders: string[]) => ({
    version: 1, kind: "main", input: {
      runnerContext,
      input: {
        type: "user_messages", latestMessage: inbound, context: { sessionId: "s1", candidateOpenTasks: [] },
        messages: senders.map((senderUserId, idx) => ({
          messageId: `msg_${idx}`, channelMessageKey: null, role: "user", senderUserId,
          sender: { id: senderUserId, externalId: senderUserId, kind: "user", displayName: senderUserId },
          text: "install", createdAt: idx, rawMessage: inbound,
        })),
      },
    },
  });
  expect(store.invocationPrivileged({ ...base, actorUserId: carolId, inputSnapshot: batchSnapshot([carolId]) })).toEqual({ rootAccess: true, privileged: false });
  expect(store.invocationPrivileged({ ...base, actorUserId: carolId, inputSnapshot: batchSnapshot([carolId, bobId]) })).toEqual({ rootAccess: true, privileged: true });
});
