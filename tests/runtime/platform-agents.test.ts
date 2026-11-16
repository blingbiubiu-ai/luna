import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { AgentStore } from "../../src/agents/agent-store";
import * as schema from "../../src/data/schema";

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, {schema});
  migrate(db, {migrationsFolder: "src/data/drizzle"});
  const timestamp = new Date().toISOString();
  for (const id of ["owner-a", "owner-b", "guest"]) {
    db.insert(schema.users).values({id, kind: "human", displayName: id, status: "active", createdAt: timestamp, updatedAt: timestamp}).run();
  }
  return {sqlite, db, store: new AgentStore(db)};
}

test("Agent creation is atomic and idempotent with a distinct default Shadow identity", () => {
  const {sqlite, store} = fixture();
  try {
    const first = store.create("owner-a", {name: " A "}, "request-1");
    expect(store.create("owner-a", {name: "A"}, "request-1")).toEqual(first);
    expect(() => store.create("owner-a", {name: "different"}, "request-1")).toThrow("idempotency_conflict");
    const main = store.shadow(first.defaultShadowId);
    const other = store.createShadow("owner-a", first.id, {name: "飞书"}, "request-2");
    expect(store.createShadow("owner-a", first.id, {name: "飞书"}, "request-2")).toEqual(other);
    expect(main.agentId).toBe(first.id);
    expect(other.replyUserId).not.toBe(main.replyUserId);
    expect(main.replyUserId).not.toBe("luna:bot");
    expect(sqlite.query("SELECT kind FROM users WHERE id=?").get(other.replyUserId)).toEqual({kind: "system"});
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {sqlite.close();}
});

test("Feishu actors can use a Shadow while ownership protects management", () => {
  const {sqlite, store} = fixture();
  try {
    const a = store.create("owner-a", {name: "A"}, "a");
    const b = store.create("owner-b", {name: "B"}, "b");
    expect(() => store.requireOwner("guest", a.id)).toThrow("agent_access_denied");
    expect(store.requireScope("guest", {agentId: a.id, shadowId: a.defaultShadowId}).id).toBe(a.defaultShadowId);
    expect(() => store.createShadow("guest", a.id, {name: "X"}, "x")).toThrow("agent_access_denied");
    expect(() => store.requireScope("guest", {agentId: a.id, shadowId: b.defaultShadowId})).toThrow("scope_mismatch");
  } finally {sqlite.close();}
});

test("database rejects missing or foreign default Shadow pointers and rolls back", () => {
  const {sqlite, store} = fixture();
  try {
    const a = store.create("owner-a", {name: "A"}, "a");
    const b = store.create("owner-b", {name: "B"}, "b");
    expect(() => sqlite.transaction(() => {
      sqlite.query("UPDATE luna_agents SET default_shadow_id=? WHERE id=?").run(b.defaultShadowId, a.id);
    })()).toThrow();
    expect(store.get(a.id).defaultShadowId).toBe(a.defaultShadowId);
    expect(() => store.create("guest-missing", {name: "bad"}, "bad")).toThrow("active_user_required");
    expect(sqlite.query("SELECT count(*) AS count FROM luna_agents").get()).toEqual({count: 2});
  } finally {sqlite.close();}
});

test("Agent lists exclude unrelated records and use stable cursor pagination", () => {
  const {sqlite, store} = fixture();
  try {
    const a = store.create("owner-a", {name: "A"}, "a");
    store.create("owner-b", {name: "private"}, "b");
    const c = store.create("owner-a", {name: "C"}, "c");
    expect(store.list("guest")).toEqual([]);
    const first = store.list("owner-a", 1);
    const second = store.list("owner-a", 1, {createdAt: first[0]!.createdAt, id: first[0]!.id});
    expect(new Set([...first, ...second].map(row => row.id))).toEqual(new Set([a.id, c.id]));
    expect(() => store.list("owner-a", 101)).toThrow("invalid_limit");
  } finally {sqlite.close();}
});

test("self-service API rejects missing keys, forged ownership and unauthenticated requests", async () => {
  const {Hono} = await import("hono");
  const {createPlatformAgentRoutes} = await import("../../src/server/routes/platform-agents");
  const {sqlite, db} = fixture();
  const app = new Hono<{Variables: {
    dashboardAuthSession: import("../../src/server/auth").DashboardAuthSession;
    lunaRequestAuthKind: import("../../src/server/auth").LunaRequestAuthKind;
  }}>().use("*", async (c, next) => {
    const id = c.req.header("Test-Actor");
    if (id) {
      c.set("dashboardAuthSession", {authenticated: true, user: {id, name: id, provider: "test"}});
      c.set("lunaRequestAuthKind", "dashboard-cookie");
    }
    await next();
  }).route("/agents", createPlatformAgentRoutes(db));
  const post = (body: unknown, key?: string) => app.request("/agents", {
    method: "POST", headers: {"Test-Actor": "owner-a", "Content-Type": "application/json", ...(key ? {"Idempotency-Key": key} : {})},
    body: JSON.stringify(body),
  });
  try {
    expect((await app.request("/agents")).status).toBe(401);
    expect((await post({name: "A"})).status).toBe(400);
    expect((await post({name: "A", ownerUserId: "owner-b"}, "a")).status).toBe(400);
    const response = await post({name: "A"}, "a");
    expect(response.status).toBe(201);
    const {agent} = await response.json() as {agent: {id: string; defaultShadowId: string}};
    const renamePath = `/agents/${agent.id}/shadows/${agent.defaultShadowId}`;
    const rename = (actor: string) => app.request(renamePath, {
      method: "PATCH", headers: {"Test-Actor": actor, "Content-Type": "application/json"},
      body: JSON.stringify({name: " Renamed "}),
    });
    const replyUserId = new AgentStore(db).shadow(agent.defaultShadowId).replyUserId;
    expect((await rename("guest")).status).toBe(403);
    const renamed = await rename("owner-a");
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({shadow: {id: agent.defaultShadowId, replyUserId, name: "Renamed"}});
    expect(sqlite.query("SELECT display_name FROM users WHERE id=?").get(replyUserId)).toEqual({display_name: "Renamed"});
    const grantRequest = (target: string, subjectId = "owner-a") => app.request(`/agents/${agent.id}/authorization-rules`, {
      method: "POST", headers: {"Test-Actor": "owner-a", "Content-Type": "application/json"},
      body: JSON.stringify({subjectType: "user", subjectId, target, matchType: "exact", effect: "allow"}),
    });
    expect((await grantRequest("workspace.knowledge.read")).status).toBe(201);
    expect((await grantRequest("system.admin")).status).toBe(403);
    const accessPath = `/agents/${agent.id}/access`;
    const ownerHeaders = {"Test-Actor": "owner-a", "Content-Type": "application/json"};
    expect((await app.request(accessPath, {headers: ownerHeaders})).status).toBe(404);
    expect((await app.request(accessPath, {method:"PUT", headers: ownerHeaders})).status).toBe(404);
    expect((await grantRequest("workspace.knowledge.read", "guest")).status).toBe(201);
    const guestHeaders = {"Test-Actor": "guest"};
    expect(await (await app.request("/agents", {headers:guestHeaders})).json()).toMatchObject({agents: []});
    for (const path of ["", "/shadows", "/memories", "/authorization-rules"]) {
      expect((await app.request(`/agents/${agent.id}${path}`, {headers:guestHeaders})).status).toBe(403);
    }
    const transition = await app.request(`/agents/${agent.id}/status`, {
      method: "PUT", headers: {...ownerHeaders, "Idempotency-Key": "disable-a"},
      body: JSON.stringify({status: "disabled"}),
    });
    expect(transition.status).toBe(202);
    const {job} = await transition.json() as {job: {id: string}};
    const statusPath = `/agents/${agent.id}/lifecycle/${job.id}`;
    expect(await (await app.request(statusPath, {headers: ownerHeaders})).json()).toEqual({
      job: {status: "pending", lastError: null},
    });
    expect((await app.request(statusPath, {headers: {"Test-Actor": "owner-b"}})).status).toBe(403);
    expect((await app.request(`/agents/${agent.id}/authorization-rules`, {headers: {"Test-Actor": "owner-b"}})).status).toBe(403);
    expect((await app.request(`/agents/${agent.id}`, {headers: {"Test-Actor": "owner-b"}})).status).toBe(403);
    expect((await post({name: "B"}, "a")).status).toBe(409);
    const page = await app.request("/agents?limit=101", {headers: {"Test-Actor": "owner-a"}});
    expect(page.status).toBe(400);
  } finally {sqlite.close();}
});
