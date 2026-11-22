import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as schema from "../../src/data/schema";
import { openExecutionDatabase } from "@luna/execution-store";
import { AgentSecretCipher } from "../../src/agent-config/secret-cipher";
import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";
import {
  defaultPlatformRuntimeSettings,
  PlatformSettingsStore,
} from "../../src/platform/platform-settings-store";
import { DashboardAuthService, createDashboardAuthMiddleware } from "../../src/server/auth";
import { FeishuAuthConfigStore } from "../../src/server/auth/feishu-oauth";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createPlatformSettingsRoutes } from "../../src/server/routes/platform-settings";
import { OrphanCleanupStore } from "../../src/runtime/orphan-cleanup";
import { FeishuMessageChannel } from "../../extensions/channels/feishu";
import { createDashboardArtifactSigner } from "../../src/dashboard-api/local-paths";
import { createArtifactsRoutes } from "../../src/server/routes/artifacts";
import { signedArtifactPreviewUrl } from "../../src/server/artifact-content-url";
import { fixtureAgent, fixtureNamedSession } from "../helpers/platform-fixtures";

function testCipher(): AgentSecretCipher {
  return AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: randomBytes(32).toString("base64"),
  });
}

test("every account reads platform settings; only a platform administrator changes platform, orphan cleanup, or feishu auth settings", async () => {
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
    const putPlatform = async (id: string, body: unknown) =>
      app.request("/api/platform-settings", {
        method: "PUT",
        headers: await as(id),
        body: JSON.stringify(body),
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
      platform: defaultPlatformRuntimeSettings(),
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

    expect((await putPlatform("member", { general: { timezone: "UTC" } })).status).toBe(403);
    expect((await putOrphan("member", { enabled: false, intervalMinutes: 60, retentionDays: 7 })).status).toBe(403);
    expect((await putFeishu("member", { enabled: true, appId: "cli_1", appSecret: "sec" })).status).toBe(403);
    expect((await app.request("/api/platform-settings/feishu-auth", { method: "DELETE", headers: await as("member") })).status).toBe(403);

    // Invalid platform patches are rejected.
    expect((await putPlatform("admin", {})).status).toBe(400);
    expect((await putPlatform("admin", { general: { publicBaseUrl: "https://luna.example.com/subpath" } })).status).toBe(400);
    expect((await putPlatform("admin", { general: { timezone: "Invalid/Zone" } })).status).toBe(400);
    expect((await putPlatform("admin", { general: { artifactSignedUrlTtlMs: 1000 } })).status).toBe(400);
    expect((await putPlatform("admin", { execution: { maxTransientRetries: 99 } })).status).toBe(400);

    // Partial section saves merge atomically without resetting other sections.
    const savedGeneral = await putPlatform("admin", {
      general: {
        publicBaseUrl: "http://10.37.108.127:8090/",
        timezone: "Asia/Singapore",
        artifactSignedUrlTtlMs: 24 * 3_600_000,
      },
    });
    expect(savedGeneral.status).toBe(200);
    const savedGeneralJson = (await savedGeneral.json()) as {
      platform: ReturnType<typeof defaultPlatformRuntimeSettings>;
      feishuAuth: { publicBaseUrl: string };
    };
    expect(savedGeneralJson.platform.general).toEqual({
      publicBaseUrl: "http://10.37.108.127:8090",
      timezone: "Asia/Singapore",
      artifactSignedUrlTtlMs: 24 * 3_600_000,
    });
    expect(savedGeneralJson.feishuAuth.publicBaseUrl).toBe("http://10.37.108.127:8090");

    const savedMarketplace = await putPlatform("admin", {
      marketplace: { gitUrl: "https://git.example.com/luna-plugins.git", branch: "release" },
      execution: { containerTimeoutMs: 45 * 60_000, taskTimeoutMs: 720 * 60_000, maxTransientRetries: 3 },
      memory: { recallLimit: 12, coreLimit: 40 },
      messaging: { maxVisibleSteps: 48, feishuDevelopers: { cli_app_1: "dev_corp" } },
    });
    expect(savedMarketplace.status).toBe(200);
    const mergedPlatform = new PlatformSettingsStore(db).get();
    expect(mergedPlatform.general).toEqual({
      publicBaseUrl: "http://10.37.108.127:8090",
      timezone: "Asia/Singapore",
      artifactSignedUrlTtlMs: 24 * 3_600_000,
    });
    expect(mergedPlatform.marketplace).toEqual({
      gitUrl: "https://git.example.com/luna-plugins.git",
      branch: "release",
    });
    expect(mergedPlatform.execution).toEqual({
      containerTimeoutMs: 45 * 60_000,
      taskTimeoutMs: 720 * 60_000,
      maxTransientRetries: 3,
    });
    expect(mergedPlatform.memory.recallLimit).toBe(12);
    expect(mergedPlatform.memory.coreLimit).toBe(40);
    expect(mergedPlatform.messaging).toEqual({
      maxVisibleSteps: 48,
      feishuDevelopers: { cli_app_1: "dev_corp" },
    });

    // Resetting general.publicBaseUrl to empty lets legacy/feishuAuth tests exercise fallback cleanly.
    expect((await putPlatform("admin", { general: { publicBaseUrl: "" } })).status).toBe(200);

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

test("Feishu outbound artifact preview links use general.publicBaseUrl from PlatformSettingsStore immediately", async () => {
  const sqlite = new Database(":memory:");
  try {
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "src/data/drizzle" });
    fixtureNamedSession(db, "session-artifact-preview", "owner");
    const artifact = new ArtifactRegistry(db).registerContent({
      scopeType: "session",
      scopeId: "session-artifact-preview",
      kind: "report",
      producer: "runner",
      name: "report.html",
      mimeType: "text/html",
      content: Buffer.from("<h1>Report</h1>"),
    });
    const channel = new FeishuMessageChannel("feishu-test", {
      chatId: "oc_test",
      appId: "cli_test",
      appSecret: "sec_test",
      db,
    });
    const signLinks = (text: string) =>
      (channel as unknown as { _signOutboundArtifactLinks(t: string): string })._signOutboundArtifactLinks(text);

    // Without publicBaseUrl, falls back to signed relative path.
    expect(signLinks(`[HTML 报告](artifact:${artifact.id})`)).toMatch(
      new RegExp(`^\\[HTML 报告\\]\\(/artifacts/${artifact.id}/preview\\?expires=\\d+&sig=[^)]+\\)$`),
    );

    // Once publicBaseUrl and artifactSignedUrlTtlMs are saved in PlatformSettingsStore, outbound links reflect both immediately without restart.
    const customTtlMs = 7 * 24 * 3_600_000;
    const before = Date.now();
    new PlatformSettingsStore(db).patch({
      general: {
        publicBaseUrl: "http://10.37.108.127:8090",
        artifactSignedUrlTtlMs: customTtlMs,
      },
    });
    const signed = signLinks(`[HTML 报告](artifact:${artifact.id})`);
    const after = Date.now();
    const match = signed.match(
      new RegExp(`^\\[HTML 报告\\]\\(http://10\\.37\\.108\\.127:8090/artifacts/${artifact.id}/preview\\?expires=(\\d+)&sig=[^)]+\\)$`),
    );
    expect(match).not.toBeNull();
    const expires = Number(match![1]);
    expect(expires).toBeGreaterThanOrEqual(before + customTtlMs);
    expect(expires).toBeLessThanOrEqual(after + customTtlMs);

    // Dashboard artifact signer and /api/artifacts/:id/preview downloadUrl also honor general.artifactSignedUrlTtlMs.
    const fixedNow = 1_795_348_600_000;
    const dashboardSigner = createDashboardArtifactSigner({
      db,
      requesterAccountId: "owner",
      now: () => fixedNow,
    });
    expect(dashboardSigner.previewUrl(artifact.id)).toContain(
      `expires=${fixedNow + customTtlMs}`,
    );

    const routes = createArtifactsRoutes({ db, now: () => fixedNow });
    const previewQuery = signedArtifactPreviewUrl({
      artifactId: artifact.id,
      now: fixedNow,
      ttlMs: customTtlMs,
    }).split("?")[1]!;
    const previewRes = await routes.request(`/${artifact.id}/preview?${previewQuery}`);
    expect(previewRes.status).toBe(200);
    const previewJson = (await previewRes.json()) as {
      artifact: { downloadUrl: string };
    };
    expect(previewJson.artifact.downloadUrl).toContain(
      `expires=${fixedNow + customTtlMs}`,
    );
  } finally {
    sqlite.close();
  }
});
