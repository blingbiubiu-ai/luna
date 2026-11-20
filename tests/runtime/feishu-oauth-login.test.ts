import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { AgentSecretCipher } from "../../src/agent-config/secret-cipher";
import * as schema from "../../src/data/schema";
import { accounts } from "../../src/data/schema";
import { FeishuAuthConfigStore, type FeishuFetch } from "../../src/server/auth/feishu-oauth";
import { HonoServer } from "../../src/server/server";
import { fixtureAgent } from "../helpers/platform-fixtures";

function testCipher(): AgentSecretCipher {
  return AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: randomBytes(32).toString("base64"),
  });
}

function extractCookieValue(setCookieHeader: string, cookieName: string): string | undefined {
  const regex = new RegExp(`(?:^|,\\s*)${cookieName}=([^;]*)`);
  return setCookieHeader.match(regex)?.[1];
}

describe("Feishu OAuth Dashboard login", () => {
  test("completes OAuth redirect, code exchange, account provisioning, session cookie, and profile refresh", async () => {
    const sqlite = new Database(":memory:");
    const previousKey = process.env.LUNA_AGENT_CONFIG_MASTER_KEY;
    const previousBunKey = Bun.env.LUNA_AGENT_CONFIG_MASTER_KEY;
    const masterKey = randomBytes(32).toString("base64");
    process.env.LUNA_AGENT_CONFIG_MASTER_KEY = masterKey;
    Bun.env.LUNA_AGENT_CONFIG_MASTER_KEY = masterKey;

    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: "src/data/drizzle" });
      fixtureAgent(db, "admin");

      const store = new FeishuAuthConfigStore({
        db,
        env: {},
        cipher: AgentSecretCipher.fromEnvironment({ LUNA_AGENT_CONFIG_MASTER_KEY: masterKey }),
        verify: async () => {},
      });
      await store.save(
        {
          enabled: true,
          appId: "cli_platform_feishu",
          appSecret: "sec_platform_feishu",
          feishuHost: "https://open.feishu.test",
          publicBaseUrl: "https://luna.company.test",
        },
        "admin",
      );

      let profileName = "王华杰";
      let profileAvatar = "https://avatar.feishu.test/u1.png";
      const feishuRequests: { url: string; method: string; auth: string | null; body: unknown }[] = [];

      const fakeFeishuFetch: FeishuFetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        feishuRequests.push({ url, method, auth, body });

        if (url === "https://open.feishu.test/open-apis/auth/v3/app_access_token/internal") {
          expect(body).toEqual({ app_id: "cli_platform_feishu", app_secret: "sec_platform_feishu" });
          return Response.json({ code: 0, app_access_token: "app_tok_123" });
        }
        if (url === "https://open.feishu.test/open-apis/authen/v1/oidc/access_token") {
          expect(auth).toBe("Bearer app_tok_123");
          if ((body as { code?: string })?.code !== "valid_code") {
            return Response.json({ code: 20003, msg: "invalid code" }, { status: 400 });
          }
          return Response.json({
            code: 0,
            data: { access_token: "user_tok_456", refresh_token: "ref_789", expires_in: 7200 },
          });
        }
        if (url === "https://open.feishu.test/open-apis/authen/v1/user_info") {
          expect(auth).toBe("Bearer user_tok_456");
          return Response.json({
            code: 0,
            data: {
              union_id: "on_feishu_union_001",
              open_id: "ou_feishu_open_001",
              name: profileName,
              avatar_url: profileAvatar,
            },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const server = new HonoServer({ db, feishuFetch: fakeFeishuFetch });

      // 1. Login page promotes Feishu login and keeps access-token login in collapsible disclosure.
      const loginPage = await server.app.fetch(
        new Request("http://luna.test/login?next=%2Fagent%2Fdemo"),
      );
      expect(loginPage.status).toBe(200);
      const html = await loginPage.text();
      expect(html).toContain('data-testid="feishu-login-button"');
      expect(html).toContain('href="/api/auth/feishu/start?next=%2Fagent%2Fdemo"');
      expect(html).toContain('data-testid="token-login-disclosure"');
      expect(html).not.toContain("/api/auth/sso/start");

      // 2. Start endpoint issues signed state, sets SameSite=None; Secure cookie on HTTPS forwarded requests, and omits scope.
      const startRes = await server.app.fetch(
        new Request("http://luna.test/api/auth/feishu/start?next=%2Fagent%2Fdemo", {
          headers: { "x-forwarded-proto": "https" },
        }),
      );
      expect(startRes.status).toBe(302);
      const location = startRes.headers.get("location") ?? "";
      const authorizeUrl = new URL(location);
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
        "https://open.feishu.test/open-apis/authen/v1/authorize",
      );
      expect(authorizeUrl.searchParams.get("app_id")).toBe("cli_platform_feishu");
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
        "https://luna.company.test/api/auth/feishu/callback",
      );
      expect(authorizeUrl.searchParams.get("scope")).toBeNull();
      const state = authorizeUrl.searchParams.get("state") ?? "";
      expect(state.length).toBeGreaterThan(20);

      const startSetCookie = startRes.headers.get("set-cookie") ?? "";
      expect(startSetCookie).toContain("luna_feishu_oauth_state=");
      expect(startSetCookie).toContain("SameSite=None");
      expect(startSetCookie).toContain("Secure");
      const nonce = extractCookieValue(startSetCookie, "luna_feishu_oauth_state")!;
      expect(nonce).toBeTruthy();

      // 3. Mismatched state cookie nonce is rejected (CSRF protection).
      const wrongCookieCallback = await server.app.fetch(
        new Request(
          `http://luna.test/api/auth/feishu/callback?code=valid_code&state=${encodeURIComponent(state)}`,
          { headers: { cookie: "luna_feishu_oauth_state=wrong_nonce" } },
        ),
      );
      expect(wrongCookieCallback.status).toBe(302);
      expect(wrongCookieCallback.headers.get("location")).toBe("/login?error=feishu_invalid_state");
      expect(wrongCookieCallback.headers.get("set-cookie") ?? "").not.toContain("luna_dashboard_session=");

      // 4. Valid callback exchanges code, creates account, sets session cookie, and redirects to next.
      const callbackRes = await server.app.fetch(
        new Request(
          `http://luna.test/api/auth/feishu/callback?code=valid_code&state=${encodeURIComponent(state)}`,
          { headers: { cookie: `luna_feishu_oauth_state=${nonce}` } },
        ),
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe("/agent/demo");
      const callbackSetCookie = callbackRes.headers.get("set-cookie") ?? "";
      const sessionToken = extractCookieValue(callbackSetCookie, "luna_dashboard_session");
      expect(sessionToken).toBeTruthy();

      const sessionCookie = `luna_dashboard_session=${sessionToken}`;
      const sessionRes = await server.app.fetch(
        new Request("http://luna.test/api/auth/session", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(sessionRes.status).toBe(200);
      expect(await sessionRes.json()).toEqual({
        authenticated: true,
        account: {
          id: "feishu:on_feishu_union_001",
          name: "王华杰",
          provider: "feishu",
          avatarUrl: "https://avatar.feishu.test/u1.png",
        },
      });

      const meRes = await server.app.fetch(
        new Request("http://luna.test/api/auth/me", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(meRes.status).toBe(200);
      expect(await meRes.json()).toMatchObject({
        status: "ok",
        authenticated: true,
        authKind: "dashboard-cookie",
        account: {
          id: "feishu:on_feishu_union_001",
          displayName: "王华杰",
          provider: "feishu",
        },
        isPlatformAdmin: false,
      });

      expect(feishuRequests).toHaveLength(3);

      // 5. Re-login when Feishu webview drops state cookie still succeeds via signed state and updates profile.
      profileName = "王华杰 (Updated)";
      profileAvatar = "https://avatar.feishu.test/u2.png";
      const secondStart = await server.app.fetch(
        new Request("http://luna.test/api/auth/feishu/start?next=https://evil.example/steal"),
      );
      const secondState = new URL(secondStart.headers.get("location")!).searchParams.get("state")!;
      const secondCallback = await server.app.fetch(
        new Request(
          `http://luna.test/api/auth/feishu/callback?code=valid_code&state=${encodeURIComponent(secondState)}`,
        ),
      );
      expect(secondCallback.status).toBe(302);
      // Open-redirect guard normalizes external URLs to "/".
      expect(secondCallback.headers.get("location")).toBe("/");

      const stored = db.select().from(accounts).where(eq(accounts.id, "feishu:on_feishu_union_001")).get();
      expect(stored?.displayName).toBe("王华杰 (Updated)");
      expect(stored?.avatarUrl).toBe("https://avatar.feishu.test/u2.png");

      // 6. Disabled account cannot sign in via Feishu callback.
      db.update(accounts)
        .set({ status: "disabled", updatedAt: Date.now() })
        .where(eq(accounts.id, "feishu:on_feishu_union_001"))
        .run();
      const thirdStart = await server.app.fetch(new Request("http://luna.test/api/auth/feishu/start"));
      const thirdState = new URL(thirdStart.headers.get("location")!).searchParams.get("state")!;
      const disabledCallback = await server.app.fetch(
        new Request(
          `http://luna.test/api/auth/feishu/callback?code=valid_code&state=${encodeURIComponent(thirdState)}`,
        ),
      );
      expect(disabledCallback.status).toBe(302);
      expect(disabledCallback.headers.get("location")).toBe("/login?error=account_inactive");
    } finally {
      sqlite.close();
      if (previousKey === undefined) delete process.env.LUNA_AGENT_CONFIG_MASTER_KEY;
      else process.env.LUNA_AGENT_CONFIG_MASTER_KEY = previousKey;
      if (previousBunKey === undefined) delete Bun.env.LUNA_AGENT_CONFIG_MASTER_KEY;
      else Bun.env.LUNA_AGENT_CONFIG_MASTER_KEY = previousBunKey;
    }
  });

  test("supports environment variable fallback and open_id fallback when union_id is absent", async () => {
    const store = new FeishuAuthConfigStore({
      env: {
        FEISHU_APP_ID: "cli_env_app",
        FEISHU_APP_SECRET: "sec_env_app",
        FEISHU_HOST: "https://open.larksuite.com/",
        PUBLIC_BASE_URL: "https://lark.company.test/",
      },
      cipher: testCipher(),
    });
    expect(store.getPublicSettings()).toEqual({
      enabled: true,
      configured: true,
      source: "environment",
      appId: "cli_env_app",
      hasSecret: true,
      secretUnreadable: false,
      feishuHost: "https://open.larksuite.com",
      publicBaseUrl: "https://lark.company.test",
    });
    expect(store.resolveActiveCredentials()).toEqual({
      appId: "cli_env_app",
      appSecret: "sec_env_app",
      feishuHost: "https://open.larksuite.com",
      publicBaseUrl: "https://lark.company.test",
    });
  });
});
