import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as schema from "../../src/data/schema";
import { openExecutionDatabase } from "@luna/execution-store";
import { DashboardAuthService, createDashboardAuthMiddleware } from "../../src/server/auth";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createPlatformSettingsRoutes } from "../../src/server/routes/platform-settings";
import { OrphanCleanupStore } from "../../src/runtime/orphan-cleanup";
import { fixtureAgent } from "../helpers/platform-fixtures";

test("every account reads the orphan cleanup setting; only a platform administrator changes it", async () => {
  const sqlite = new Database(":memory:"), runtimeDb = openExecutionDatabase(":memory:");
  try {
    const db = drizzle(sqlite, {schema});
    migrate(db, {migrationsFolder: "src/data/drizzle"});
    fixtureAgent(db, "admin"); fixtureAgent(db, "member");
    new AuthorizationRuleStore(db, {kind: "platform"}).addGrant({ subjectType: "user", subjectId: "admin", target: "system.admin", effect: "allow" });
    const auth = new DashboardAuthService({sessionSecret: "test-session-secret", provider: { id: "test", authenticateToken: async id => ({id, name: id, provider: "test"}) }});
    const settings = new OrphanCleanupStore(runtimeDb);
    const app = new Hono().use("*", createDashboardAuthMiddleware(auth, {db})).route("/api/platform-settings", createPlatformSettingsRoutes(db, () => settings));
    const as = async (id: string) => ({ cookie: "luna_dashboard_session=" + (await auth.login(id))!.sessionToken, "content-type": "application/json" });
    const put = async (id: string, body: unknown) => app.request("/api/platform-settings/orphan-cleanup", { method: "PUT", headers: await as(id), body: JSON.stringify(body) });

    expect((await app.request("/api/platform-settings")).status).toBe(401);
    expect(await (await app.request("/api/platform-settings", { headers: await as("member") })).json())
      .toEqual({ orphanCleanup: { enabled: true, intervalMinutes: 60, retentionDays: 7 }, canEdit: false });
    expect((await put("member", { enabled: false, intervalMinutes: 60, retentionDays: 7 })).status).toBe(403);
    expect((await put("admin", { enabled: true, intervalMinutes: 2, retentionDays: 7 })).status).toBe(400);
    const saved = await put("admin", { enabled: false, intervalMinutes: 120, retentionDays: 3 });
    expect(saved.status).toBe(200);
    expect(await (await app.request("/api/platform-settings", { headers: await as("admin") })).json())
      .toEqual({ orphanCleanup: { enabled: false, intervalMinutes: 120, retentionDays: 3 }, canEdit: true });
    expect(settings.get()).toEqual({ enabled: false, intervalMinutes: 120, retentionDays: 3 });
  } finally { sqlite.close(); runtimeDb.close(); }
});
