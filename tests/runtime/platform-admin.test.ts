import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as schema from "../../src/data/schema";
import { DashboardAuthService, createDashboardAuthMiddleware } from "../../src/server/auth";
import { requireAdmin, isGuardResponse } from "../../src/server/auth/guards";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createUsersRoutes } from "../../src/server/routes/users";
import { fixtureAgent } from "../helpers/platform-fixtures";

test("Agent owners can read their user directory without platform administration", async () => {
  const sqlite = new Database(":memory:");
  try {
    const db = drizzle(sqlite, {schema});
    migrate(db, {migrationsFolder: "src/data/drizzle"});
    const agent = fixtureAgent(db, "owner");
    const other = fixtureAgent(db, "other");
    const auth = new DashboardAuthService({sessionSecret: "test-session-secret", provider: {
      id: "test", authenticateToken: async id => ({id, name: id, provider: "test"}),
    }});
    const app = new Hono().use("*", createDashboardAuthMiddleware(auth, {db})).route("/users", createUsersRoutes({db}));
    const login = await auth.login("owner");
    const headers = {cookie: "luna_dashboard_session=" + login!.sessionToken};
    const scope = "?agentId=" + agent.id;
    const listed = await app.request("/users" + scope, {headers});
    expect(listed.status).toBe(200);
    const list = await listed.json() as {users: {id: string}[]};
    expect(list.users.map(user => user.id).sort()).toEqual(["owner", db.select().from(schema.agentShadows).where(eq(schema.agentShadows.id, agent.defaultShadowId)).get()!.replyUserId].sort());
    const profile = await app.request("/users/owner" + scope, {headers});
    expect(profile.status).toBe(200);
    // The Agent owner manages its users; deleting a platform account needs an administrator.
    expect(await profile.json()).toMatchObject({canManageUsers: true, canDeleteUsers: false, directGrants: []});
    expect((await app.request("/users/other" + scope, {headers})).status).toBe(404);
    expect((await app.request("/users?agentId=" + other.id, {headers})).status).toBe(403);
    for (const path of ["/users", "/users/owner", "/users?agentId="]) {
      const unscoped = await app.request(path, {headers});
      expect(unscoped.status).toBe(400);
      expect(await unscoped.json()).toEqual({code: "agent_scope_required"});
    }
    expect((await app.request("/users/owner" + scope, {headers, method: "DELETE"})).status).toBe(403);

    new AuthorizationRuleStore(db, {kind: "platform"}).addGrant({
      subjectType: "user", subjectId: "owner", target: "system.admin", effect: "allow",
    });
    const adminList = await app.request("/users" + scope, {headers});
    expect(await adminList.json()).toEqual(list);
    const adminProfile = await app.request("/users/owner" + scope, {headers});
    expect(await adminProfile.json()).toMatchObject({canManageUsers: true, canDeleteUsers: true, directGrants: []});
    expect((await app.request("/users/other" + scope, {headers})).status).toBe(404);
    expect((await app.request("/users/other?agentId=" + other.id, {headers})).status).toBe(403);
    expect((await app.request("/users/owner", {headers})).status).toBe(400);
  } finally {sqlite.close();}
});

test("real authentication middleware requires an active explicit system.admin grant", async () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, {schema});
  migrate(db, {migrationsFolder: "src/data/drizzle"});
  const auth = new DashboardAuthService({sessionSecret: "test-session-secret", provider: {
    id: "test", authenticateToken: async id => ({id, name: id, provider: "test"}),
  }});
  const app = new Hono().use("*", createDashboardAuthMiddleware(auth, {db}))
    .get("/api/platform-admin-check", c => {
      const result = requireAdmin(c);
      return isGuardResponse(result) ? result : c.json({userId: result.user.id});
    });
  const session = await auth.login("owner");
  const request = () => app.request("/api/platform-admin-check", {headers: {cookie: "luna_dashboard_session=" + session!.sessionToken}});
  try {
    expect((await request()).status).toBe(403);
    const grants = new AuthorizationRuleStore(db, {kind: "platform"});
    const expired = grants.addGrant({subjectType: "user", subjectId: "owner", target: "system.admin", effect: "allow", expiresAt: Date.now() - 1000});
    expect((await request()).status).toBe(403);
    grants.deleteGrant(expired.id);
    const allow = grants.addGrant({subjectType: "user", subjectId: "owner", target: "system.admin", effect: "allow"});
    expect((await request()).status).toBe(200);
    const deny = grants.addGrant({subjectType: "user", subjectId: "owner", target: "system.admin", effect: "deny"});
    expect((await request()).status).toBe(403);
    grants.deleteGrant(deny.id);
    db.update(schema.users).set({status: "disabled"}).where(eq(schema.users.id, "owner")).run();
    expect((await request()).status).toBe(403);
    db.update(schema.users).set({status: "active", kind: "system"}).where(eq(schema.users.id, "owner")).run();
    expect((await request()).status).toBe(403);
    grants.deleteGrant(allow.id);
    expect((await app.request("/api/platform-admin-check")).status).toBe(401);
  } finally {sqlite.close();}
});

test("a dashboard context without the trusted policy database fails closed", async () => {
  const app = new Hono<{Variables: {dashboardAuthSession: unknown; lunaRequestAuthKind: string}}>()
    .use("*", async (c, next) => {
      c.set("dashboardAuthSession", {authenticated: true, user: {id: "owner", name: "owner", provider: "test"}});
      c.set("lunaRequestAuthKind", "dashboard-cookie");
      await next();
    }).get("/", c => {
      const result = requireAdmin(c);
      return isGuardResponse(result) ? result : c.json({unexpected: true});
    });
  expect((await app.request("/")).status).toBe(403);
});
