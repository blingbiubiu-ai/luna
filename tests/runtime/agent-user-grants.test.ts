import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { fixtureScope } from "../helpers/platform-fixtures";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";
import { createUsersRoutes } from "@/server/routes/users";
import { createOperationsRoutes } from "@/server/routes/operations";
import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";

let home: string, connection: DataConnection<typeof schema>;
let alice: ReturnType<typeof fixtureScope>, bob: ReturnType<typeof fixtureScope>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-agent-user-grants-")); setLunaHome(home);
  connection = new DataConnection(schema);
  alice = fixtureScope(connection.db, "alice"); bob = fixtureScope(connection.db, "bob");
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });

/** An Agent owner who is not a platform administrator. */
function app(actor: string) {
  return new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", { authenticated: true, user: { id: actor, name: actor, provider: "test" } });
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); (c as any).set("lunaAuthorizationDb", connection.db); await next();
  }).route("/users", createUsersRoutes({ db: connection.db })).route("/operations", createOperationsRoutes({ db: connection.db }));
}
const json = { "content-type": "application/json" };

test("an Agent owner grants and revokes a user's permissions on its own Agent, never on the platform", async () => {
  const scope = `?agentId=${alice.agentId}`;
  const ops = await (await app("alice").request(`/operations${scope}`)).json() as { operations: { id: string }[] };
  expect(ops.operations.map(o => o.id)).toContain("agent.root");
  expect(ops.operations.map(o => o.id)).not.toContain("system.admin");
  expect((await app("bob").request(`/operations${scope}`)).status).toBe(403);

  // Only users in the Agent's directory can be granted: bob is not, until he joins a group.
  expect((await app("alice").request(`/users/bob/authorization-rules/batch${scope}`, { method: "POST", headers: json,
    body: JSON.stringify({ items: [{ target: "agent.root", effect: "allow" }] }) })).status).toBe(404);
  const now = new Date().toISOString();
  connection.db.insert(schema.groups).values({ id: "ops", agentId: alice.agentId, slug: "ops", displayName: "Ops", createdAt: now, updatedAt: now }).run();
  connection.db.insert(schema.groupMemberships).values({ id: "ops-bob", groupId: "ops", userId: "bob", createdAt: now, updatedAt: now }).run();
  const granted = await app("alice").request(`/users/bob/authorization-rules/batch${scope}`, { method: "POST", headers: json,
    body: JSON.stringify({ items: [{ target: "agent.root", effect: "allow" }] }) });
  expect(granted.status).toBe(200);
  const { grants } = await granted.json() as { grants: { id: string }[] };
  const profile = await (await app("alice").request(`/users/bob${scope}`)).json() as { directGrants: { target: string }[]; canManageUsers: boolean; canDeleteUsers: boolean };
  expect(profile).toMatchObject({ canManageUsers: true, canDeleteUsers: false, directGrants: [expect.objectContaining({ target: "agent.root" })] });
  expect(new ShadowRootAccessStore(connection.db).trusted(alice, "bob")).toBe(true);
  expect(new AuthorizationRuleStore(connection.db, { kind: "platform" }).listGrants({ subjectType: "user", subjectId: "bob" })).toEqual([]);

  // Platform operations stay out of Agent grants; another owner cannot touch this Agent.
  expect((await app("alice").request(`/users/bob/authorization-rules/batch${scope}`, { method: "POST", headers: json,
    body: JSON.stringify({ items: [{ target: "system.admin", effect: "allow" }] }) })).status).not.toBe(200);
  expect((await app("bob").request(`/users/bob/authorization-rules/batch${scope}`, { method: "POST", headers: json,
    body: JSON.stringify({ items: [{ target: "agent.root", effect: "allow" }] }) })).status).toBe(403);
  expect((await app("bob").request(`/users/bob/authorization-rules/${grants[0]!.id}?agentId=${bob.agentId}`, { method: "DELETE" })).status).toBe(404);

  expect((await app("alice").request(`/users/bob/authorization-rules/${grants[0]!.id}${scope}`, { method: "DELETE" })).status).toBe(200);
  expect(new ShadowRootAccessStore(connection.db).trusted(alice, "bob")).toBe(false);
  // Deleting a platform account still needs a platform administrator.
  expect((await app("alice").request("/users/bob", { method: "DELETE" })).status).toBe(403);
});
