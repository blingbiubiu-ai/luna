import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";

import * as schema from "../../src/data/schema";
import { SUPER_ADMIN_ACCOUNT_ID } from "../../src/identity/account-store";
import { DashboardAuthService, createDashboardAuthMiddleware } from "../../src/server/auth";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createAccountRoutes } from "../../src/server/routes/accounts";
import { createAuthRoutes } from "../../src/server/routes/auth";
import { fixtureAccount, fixtureAgent } from "../helpers/platform-fixtures";

test("built-in local-dashboard-user is an immutable super administrator and can manage Feishu administrators", async () => {
  const sqlite = new Database(":memory:");
  try {
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "src/data/drizzle" });

    fixtureAccount(db, SUPER_ADMIN_ACCOUNT_ID);
    fixtureAgent(db, "feishu:on_alice");
    fixtureAccount(db, "feishu:on_bob");

    const auth = new DashboardAuthService({
      sessionSecret: "test-session-secret",
      provider: {
        id: "test",
        authenticateToken: async (id) => ({
          id,
          name: id,
          provider: id === SUPER_ADMIN_ACCOUNT_ID ? "local-token" : "feishu",
        }),
      },
    });
    const app = new Hono()
      .use("*", createDashboardAuthMiddleware(auth, { db }))
      .route("/api/auth", createAuthRoutes(auth, { db }))
      .route("/api/accounts", createAccountRoutes(db));

    const cookieFor = async (id: string) => ({
      cookie: `luna_dashboard_session=${(await auth.login(id))!.sessionToken}`,
      "content-type": "application/json",
    });

    // 1. Regular Feishu account is NOT a platform admin and cannot read /api/accounts.
    const aliceMe = await (await app.request("/api/auth/me", { headers: await cookieFor("feishu:on_alice") })).json();
    expect(aliceMe).toMatchObject({ isPlatformAdmin: false, isSuperAdmin: false });
    expect((await app.request("/api/accounts", { headers: await cookieFor("feishu:on_alice") })).status).toBe(403);

    // 2. Built-in local-dashboard-user is automatically Super Admin even if a deny rule exists.
    new AuthorizationRuleStore(db, { kind: "platform" }).addGrant({
      subjectType: "user",
      subjectId: SUPER_ADMIN_ACCOUNT_ID,
      target: "system.admin",
      effect: "deny",
    });
    const superMe = await (await app.request("/api/auth/me", { headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID) })).json();
    expect(superMe).toMatchObject({ isPlatformAdmin: true, isSuperAdmin: true });

    // 3. Super admin lists accounts with super-admin first and accurate agentCount.
    const listed = await (await app.request("/api/accounts", { headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID) })).json() as {
      accounts: { id: string; isSuperAdmin: boolean; isPlatformAdmin: boolean; agentCount: number }[];
    };
    expect(listed.accounts.map((item) => ({
      id: item.id,
      isSuperAdmin: item.isSuperAdmin,
      isPlatformAdmin: item.isPlatformAdmin,
      agentCount: item.agentCount,
    }))).toEqual([
      { id: SUPER_ADMIN_ACCOUNT_ID, isSuperAdmin: true, isPlatformAdmin: true, agentCount: 0 },
      { id: "feishu:on_alice", isSuperAdmin: false, isPlatformAdmin: false, agentCount: 1 },
      { id: "feishu:on_bob", isSuperAdmin: false, isPlatformAdmin: false, agentCount: 0 },
    ]);

    // 4. Super admin cannot be revoked, disabled, or deleted.
    expect(
      (await app.request(`/api/accounts/${SUPER_ADMIN_ACCOUNT_ID}/admin`, {
        method: "PUT",
        headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID),
        body: JSON.stringify({ isPlatformAdmin: false }),
      })).status,
    ).toBe(409);
    expect(
      (await app.request(`/api/accounts/${SUPER_ADMIN_ACCOUNT_ID}/status`, {
        method: "PUT",
        headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID),
        body: JSON.stringify({ status: "disabled" }),
      })).status,
    ).toBe(409);
    expect(
      (await app.request(`/api/accounts/${SUPER_ADMIN_ACCOUNT_ID}`, {
        method: "DELETE",
        headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID),
      })).status,
    ).toBe(409);

    // 5. Super admin grants platform admin to Alice; Alice can now access /api/accounts, but cannot revoke herself.
    const grantAlice = await app.request("/api/accounts/feishu%3Aon_alice/admin", {
      method: "PUT",
      headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID),
      body: JSON.stringify({ isPlatformAdmin: true }),
    });
    expect(grantAlice.status).toBe(200);
    expect(await (await app.request("/api/auth/me", { headers: await cookieFor("feishu:on_alice") })).json()).toMatchObject({
      isPlatformAdmin: true,
      isSuperAdmin: false,
    });
    expect((await app.request("/api/accounts", { headers: await cookieFor("feishu:on_alice") })).status).toBe(200);
    expect(
      (await app.request("/api/accounts/feishu%3Aon_alice/admin", {
        method: "PUT",
        headers: await cookieFor("feishu:on_alice"),
        body: JSON.stringify({ isPlatformAdmin: false }),
      })).status,
    ).toBe(409);

    // 6. Disabling Bob revokes Bob's personal CLI token and blocks Bob's cookie session.
    const bobCliToken = new AccessTokenService({ db, signingSecret: "tok-secret" }).issueToken({
      accountId: "feishu:on_bob",
      name: "Bob CLI",
      source: "cli",
      role: "user",
      ttlMs: 60_000,
      now: Date.now(),
    });
    const bobHeaders = await cookieFor("feishu:on_bob");
    const disableBob = await app.request("/api/accounts/feishu%3Aon_bob/status", {
      method: "PUT",
      headers: await cookieFor("feishu:on_alice"),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(disableBob.status).toBe(200);
    expect((await app.request("/api/auth/me", { headers: bobHeaders })).status).toBe(401);
    expect(() =>
      new AccessTokenService({ db, signingSecret: "tok-secret" }).verifyBearer(bobCliToken.token, { now: Date.now() }),
    ).toThrow();

    // 7. Re-enabling Bob restores access; deleting Bob removes Bob from the account list while Alice (owning 1 Agent) cannot be deleted yet.
    expect(
      (await app.request("/api/accounts/feishu%3Aon_bob/status", {
        method: "PUT",
        headers: await cookieFor("feishu:on_alice"),
        body: JSON.stringify({ status: "active" }),
      })).status,
    ).toBe(200);
    expect((await app.request("/api/auth/me", { headers: await cookieFor("feishu:on_bob") })).status).toBe(200);

    expect(
      (await app.request("/api/accounts/feishu%3Aon_alice", {
        method: "DELETE",
        headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID),
      })).status,
    ).toBe(409);
    expect(
      (await app.request("/api/accounts/feishu%3Aon_bob", {
        method: "DELETE",
        headers: await cookieFor(SUPER_ADMIN_ACCOUNT_ID),
      })).status,
    ).toBe(200);
  } finally {
    sqlite.close();
  }
});
