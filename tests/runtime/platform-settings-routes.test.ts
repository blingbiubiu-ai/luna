import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as schema from "../../src/data/schema";
import { openExecutionDatabase } from "@luna/execution-store";
import { AgentSecretCipher } from "../../src/agent-config/secret-cipher";
import { DashboardAuthService, createDashboardAuthMiddleware } from "../../src/server/auth";
import { FeishuAuthConfigStore } from "../../src/server/auth/feishu-oauth";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createPlatformSettingsRoutes } from "../../src/server/routes/platform-settings";
import { OrphanCleanupStore } from "../../src/runtime/orphan-cleanup";
import { fixtureAgent } from "../helpers/platform-fixtures";

function testCipher(): AgentSecretCipher {
  return AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: randomBytes(32).toString("base64"),
  });
}

test("every account reads platform settings; only a platform administrator changes orphan cleanup or feishu auth", async () => {
  const sqlite = new Database(":memory:"), runtimeDb = openExecutionDatabase(":memory:");
  try {
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "src/data/drizzle" });
    fixtureAgent(db, "admin");
    fixtureAgent(db, "member");
    new AuthorizationRuleStore(db, { kind: "platform" }).addGrant({
      subjectType: "user",
      subjectId: "admin",
      target: "system.admin",
      effect: "allow",
    });
    const verifiedCalls: { appId: string; appSecret: string; feishuHost: string }[] = [];
    const feishuStore = new FeishuAuthConfigStore({
      db,
      env: {},
      cipher: testCipher(),
      verify: async (creds) => {
        if (creds.appSecret === "bad-secret") throw new Error("invalid app_secret");
        verifiedCalls.push(creds);
      },
    });
    const auth = new DashboardAuthService({
      sessionSecret: "test-session-secret",
      provider: { id: "test", authenticateToken: async (id) => ({ id, name: id, provider: "test" }) },
    });
    const settings = new OrphanCleanupStore(runtimeDb);
    const app = new Hono()
      .use("*", createDashboardAuthMiddleware(auth, { db }))
      .route("/api/platform-settings", createPlatformSettingsRoutes(db, () => settings, feishuStore));
    const as = async (id: string) => ({
      cookie: "luna_dashboard_session=" + (await auth.login(id))!.sessionToken,
      "content-type": "application/json",
    });
    const putOrphan = async (id: string, body: unknown) =>
      app.request("/api/platform-settings/orphan-cleanup", {
        method: "PUT",
        headers: await as(id),
        body: JSON.stringify(body),
      });
    const putFeishu = async (id: string, body: unknown) =>
      app.request("/api/platform-settings/feishu-auth", {
        method: "PUT",
        headers: await as(id),
        body: JSON.stringify(body),
      });

    expect((await app.request("/api/platform-settings")).status).toBe(401);
    expect(await (await app.request("/api/platform-settings", { headers: await as("member") })).json()).toEqual({
      orphanCleanup: { enabled: true, intervalMinutes: 60, retentionDays: 7 },
      feishuAuth: {
        enabled: false,
        configured: false,
        source: "none",
        appId: "",
        hasSecret: false,
        secretUnreadable: false,
        feishuHost: "https://open.feishu.cn",
        publicBaseUrl: "",
      },
      canEdit: false,
    });

    expect((await putOrphan("member", { enabled: false, intervalMinutes: 60, retentionDays: 7 })).status).toBe(403);
    expect((await putFeishu("member", { enabled: true, appId: "cli_1", appSecret: "sec" })).status).toBe(403);
    expect((await app.request("/api/platform-settings/feishu-auth", { method: "DELETE", headers: await as("member") })).status).toBe(403);

    expect((await putOrphan("admin", { enabled: true, intervalMinutes: 2, retentionDays: 7 })).status).toBe(400);
    const savedOrphan = await putOrphan("admin", { enabled: false, intervalMinutes: 120, retentionDays: 3 });
    expect(savedOrphan.status).toBe(200);
    expect(settings.get()).toEqual({ enabled: false, intervalMinutes: 120, retentionDays: 3 });

    // Missing secret on initial save is rejected.
    expect((await putFeishu("admin", { enabled: true, appId: "cli_app_1" })).status).toBe(400);
    // Invalid URL is rejected.
    expect(
      (await putFeishu("admin", {
        enabled: true,
        appId: "cli_app_1",
        appSecret: "sec_1",
        publicBaseUrl: "https://luna.example.com/subpath",
      })).status,
    ).toBe(400);
    // Failed Feishu credential verification is rejected.
    expect((await putFeishu("admin", { enabled: true, appId: "cli_app_1", appSecret: "bad-secret" })).status).toBe(400);

    // Valid save encrypts secret, verifies credentials, and never exposes plaintext secret.
    const savedFeishu = await putFeishu("admin", {
      enabled: true,
      appId: "cli_app_1",
      appSecret: "sec_good",
      feishuHost: "https://open.feishu.cn/",
      publicBaseUrl: "https://luna.example.com/",
    });
    expect(savedFeishu.status).toBe(200);
    const savedBody = await savedFeishu.json();
    expect(savedBody).toEqual({
      feishuAuth: {
        enabled: true,
        configured: true,
        source: "database",
        appId: "cli_app_1",
        hasSecret: true,
        secretUnreadable: false,
        feishuHost: "https://open.feishu.cn",
        publicBaseUrl: "https://luna.example.com",
      },
    });
    expect(JSON.stringify(savedBody)).not.toContain("sec_good");
    expect(verifiedCalls).toEqual([
      { appId: "cli_app_1", appSecret: "sec_good", feishuHost: "https://open.feishu.cn" },
    ]);

    // Subsequent update without appSecret reuses the stored encrypted secret when appId is unchanged.
    const updatedWithoutSecret = await putFeishu("admin", {
      enabled: false,
      appId: "cli_app_1",
      feishuHost: "https://open.feishu.cn",
      publicBaseUrl: "https://luna2.example.com",
    });
    expect(updatedWithoutSecret.status).toBe(200);
    expect(await updatedWithoutSecret.json()).toEqual({
      feishuAuth: {
        enabled: false,
        configured: true,
        source: "database",
        appId: "cli_app_1",
        hasSecret: true,
        secretUnreadable: false,
        feishuHost: "https://open.feishu.cn",
        publicBaseUrl: "https://luna2.example.com",
      },
    });
    expect(feishuStore.resolveActiveCredentials()).toBeNull();

    // Clearing database config reverts to environment fallback (none here).
    const cleared = await app.request("/api/platform-settings/feishu-auth", {
      method: "DELETE",
      headers: await as("admin"),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      feishuAuth: {
        enabled: false,
        configured: false,
        source: "none",
        appId: "",
        hasSecret: false,
        secretUnreadable: false,
        feishuHost: "https://open.feishu.cn",
        publicBaseUrl: "",
      },
    });
  } finally {
    sqlite.close();
    runtimeDb.close();
  }
});
