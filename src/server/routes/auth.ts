import { AccountStore } from "@/identity/account-store";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { accessTokens } from "@/data/schema";
import {
  type DashboardAuthService,
  ensureDashboardAccount,
  isSecureRequest,
  normalizeDashboardNextPath,
  withStoredProfile,
  resolveLunaAccessTokenSigningSecret,
} from "../auth";
import { AccessTokenService } from "../auth/access-token-service";
import {
  buildFeishuAuthorizeUrl,
  exchangeFeishuAuthorizationCode,
  FEISHU_OAUTH_STATE_COOKIE,
  FEISHU_OAUTH_STATE_TTL_SECONDS,
  FeishuAuthConfigStore,
  type FeishuFetch,
  resolveFeishuCallbackUrl,
} from "../auth/feishu-oauth";
import {
  isGuardResponse,
  requireAccessTokenSelf,
  requireAuthenticated,
  requireDashboardOnly,
} from "../auth/guards";
import { isPlatformAdministrator, isSuperAdministrator } from "../policy/platform-administrator";
import { getKernel } from "./kernel";

export interface AuthRouteOptions {
  readonly db?: DrizzleDB;
  readonly feishuAuthStore?: FeishuAuthConfigStore;
  readonly feishuFetch?: FeishuFetch;
}

export function createAuthRoutes(
  auth: DashboardAuthService,
  options: AuthRouteOptions = {},
): Hono {
  return new Hono()
    .get("/session", (c) => {
      const session = auth.sessionFromRequest(c);
      // The cookie stays the answer when no database serves this process (a bare server or a shut-down kernel).
      let stored;
      try {
        const db = authDb(options);
        stored = db !== undefined && session.account ? new AccountStore(db).get(session.account.id) : undefined;
      } catch {
        stored = undefined;
      }
      return c.json(stored ? withStoredProfile(session, stored) : session);
    })
    .post("/login", async (c) => {
      const body = await readLoginBody(c.req.raw);
      const login = await auth.login(body.token);
      if (login === null) {
        return c.json({ error: "invalid_token" }, 401);
      }
      let session = login.session;
      if (options.db && login.session.account) {
        const account = ensureDashboardAccount(options.db, login.session.account);
        if (account.status !== "active") return c.json({ error: "account_inactive" }, 403);
        session = withStoredProfile(session, account);
      }
      auth.setSessionCookie(c, login.sessionToken);
      return c.json(session);
    })
    .post("/logout", (c) => {
      auth.clearSessionCookie(c);
      return c.json({ authenticated: false, account: null });
    })
    .get("/me", (c) => {
      const current = requireAuthenticated(c);
      if (isGuardResponse(current)) {
        return current;
      }
      const account = current.account;
      return c.json({
        status: "ok",
        authenticated: true,
        authKind: current.authKind,
        // An account for the Dashboard and personal tokens; a runner token acts as a user of its Agent.
        ...(account
          ? { account: { id: account.id, displayName: account.name, provider: account.provider } }
          : { user: { id: current.authKind === "luna-access-token" ? current.token.actorUserId : undefined } }),
        // Lets the Dashboard show platform pages; the platform APIs enforce it themselves.
        isPlatformAdmin: (() => {
          const db = authDb(options);
          return db !== undefined && account !== undefined && isPlatformAdministrator(db, account.id);
        })(),
        isSuperAdmin: (() => {
          const db = authDb(options);
          return db !== undefined && account !== undefined && isSuperAdministrator(db, account.id);
        })(),
        ...(current.authKind === "luna-access-token"
          ? {
              token: {
                tokenId: current.token.tokenId,
                source: current.token.source,
                role: current.token.role,
                expiresAt: current.token.expiresAt,
                ...(current.token.runnerKind === undefined
                  ? {}
                  : { runnerKind: current.token.runnerKind }),
              },
            }
          : {}),
      });
    })
    .post("/cli/start", async (c) => {
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      const started = service.startCliAuthSession({
        now: Date.now(),
      });
      return c.json({
        ...started,
        verificationUri:
          `${new URL(c.req.url).origin}/auth/cli?user_code=${encodeURIComponent(started.userCode)}`,
      });
    })
    .post("/cli/poll", async (c) => {
      const body = await readJsonRecord(c.req.raw);
      if (typeof body.deviceCode !== "string" || body.deviceCode.trim().length === 0) {
        return c.json({ status: "error", code: "missing_device_code" }, 400);
      }
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      return c.json(service.pollCliAuthSession(body.deviceCode, { now: Date.now() }));
    })
    .post("/cli/confirm", async (c) => {
      const dashboard = requireDashboardOnly(c);
      if (isGuardResponse(dashboard)) {
        return dashboard;
      }
      const accountId = dashboard.account.id;
      const body = await readJsonRecord(c.req.raw);
      if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
        return c.json({ status: "error", code: "missing_user_code" }, 400);
      }
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      try {
        service.approveCliAuthSession(body.userCode, accountId, Date.now());
      } catch (error) {
        return c.json({ status: "error", code: errorCode(error) }, 400);
      }
      return c.json({ status: "approved" });
    })
    .post("/cli/deny", async (c) => {
      const dashboard = requireDashboardOnly(c);
      if (isGuardResponse(dashboard)) {
        return dashboard;
      }
      const body = await readJsonRecord(c.req.raw);
      if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
        return c.json({ status: "error", code: "missing_user_code" }, 400);
      }
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      try {
        service.denyCliAuthSession(body.userCode, Date.now());
      } catch (error) {
        return c.json({ status: "error", code: errorCode(error) }, 400);
      }
      return c.json({ status: "denied" });
    })
    .post("/cli/confirm-channel-token", async (c) => {
      const body = await readJsonRecord(c.req.raw);
      if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
        return c.json({ status: "error", code: "missing_user_code" }, 400);
      }
      if (typeof body.token !== "string" || body.token.trim().length === 0) {
        return c.json({ status: "error", code: "missing_channel_auth_token" }, 400);
      }
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      try {
        service.confirmCliAuthSessionWithChannelToken({
          userCode: body.userCode,
          token: body.token,
          now: Date.now(),
        });
      } catch (error) {
        return c.json({ status: "error", code: errorCode(error) }, 400);
      }
      return c.json({ status: "approved" });
    })
    .get("/tokens", (c) => {
      // Personal CLI/MCP tokens: every signed-in account manages its own.
      const self = requireDashboardOnly(c);
      if (isGuardResponse(self)) {
        return self;
      }
      const accountId = self.account.id;
      const db = authDb(options);
      if (db === undefined) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      const rows = db
        .select()
        .from(accessTokens)
        .where(and(eq(accessTokens.accountId, accountId), inArray(accessTokens.source, ["cli", "mcp"])))
        .orderBy(desc(accessTokens.createdAt))
        .all();
      return c.json({ tokens: rows.map(publicTokenRecord) });
    })
    .post("/tokens", async (c) => {
      // Personal CLI/MCP tokens: every signed-in account manages its own.
      const self = requireDashboardOnly(c);
      if (isGuardResponse(self)) {
        return self;
      }
      const accountId = self.account.id;
      const body = await readJsonRecord(c.req.raw);
      const source = body.source === "mcp" ? "mcp" : "cli";
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      const issued = service.issueToken({
        accountId,
        name: typeof body.name === "string" && body.name.trim().length > 0
          ? body.name.trim()
          : source === "mcp"
            ? "Luna MCP"
            : "Luna CLI",
        source,
        role: "user",
        ttlMs: typeof body.ttlMs === "number" && body.ttlMs > 0
          ? body.ttlMs
          : 30 * 24 * 60 * 60 * 1000,
        now: Date.now(),
      });
      return c.json({
        accessToken: issued.token,
        expiresAt: issued.record.expiresAt,
        token: publicTokenRecord(issued.record),
      });
    })
    .delete("/tokens/current", (c) => {
      const current = requireAccessTokenSelf(c);
      if (isGuardResponse(current)) {
        return current;
      }
      const claims = current.token;
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      // Only a personal token revokes itself here; a runner token ends with its invocation.
      if (claims.accountId === undefined) {
        return c.json({ status: "error", code: "personal_token_required" }, 403);
      }
      service.revokeToken(claims.tokenId, claims.accountId, Date.now());
      return c.json({ status: "revoked" });
    })
    .delete("/tokens/:tokenId", (c) => {
      // Personal CLI/MCP tokens: every signed-in account manages its own.
      const self = requireDashboardOnly(c);
      if (isGuardResponse(self)) {
        return self;
      }
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      service.revokeToken(c.req.param("tokenId"), self.account.id, Date.now());
      return c.json({ status: "revoked" });
    })
    .get("/feishu/start", (c) => {
      const url = new URL(c.req.url);
      const safeNext = normalizeDashboardNextPath(url.searchParams.get("next"));
      const credentials = feishuAuthStore(options).resolveActiveCredentials();
      if (credentials === null) {
        if ((c.req.header("accept") ?? "").includes("text/html")) {
          return c.redirect(loginErrorRedirect(safeNext, "feishu_not_configured"), 302);
        }
        return c.json({ error: "feishu_not_configured" }, 501);
      }
      const redirectUri = resolveFeishuCallbackUrl(c.req.url, credentials.publicBaseUrl);
      const oauthState = auth.issueOAuthState({
        next: safeNext,
        ttlSeconds: FEISHU_OAUTH_STATE_TTL_SECONDS,
      });
      const secure = isSecureRequest(c);
      setCookie(c, FEISHU_OAUTH_STATE_COOKIE, oauthState.nonce, {
        httpOnly: true,
        maxAge: FEISHU_OAUTH_STATE_TTL_SECONDS,
        path: "/api/auth/feishu",
        sameSite: secure ? "None" : "Lax",
        secure,
      });
      return c.redirect(
        buildFeishuAuthorizeUrl({
          appId: credentials.appId,
          feishuHost: credentials.feishuHost,
          redirectUri,
          state: oauthState.state,
        }),
        302,
      );
    })
    .get("/feishu/callback", async (c) => {
      const url = new URL(c.req.url);
      const code = url.searchParams.get("code")?.trim() ?? "";
      const state = url.searchParams.get("state")?.trim() ?? "";
      const oauthError = url.searchParams.get("error")?.trim() ?? "";
      const cookieNonce = getCookie(c, FEISHU_OAUTH_STATE_COOKIE);
      deleteCookie(c, FEISHU_OAUTH_STATE_COOKIE, { path: "/api/auth/feishu" });

      const verified = state ? auth.verifyOAuthState(state, cookieNonce) : null;
      const safeNext = verified?.next ?? "/";
      if (oauthError) {
        return c.redirect(loginErrorRedirect(safeNext, "feishu_access_denied"), 302);
      }
      if (verified === null || code.length === 0) {
        return c.redirect(loginErrorRedirect(safeNext, "feishu_invalid_state"), 302);
      }

      const credentials = feishuAuthStore(options).resolveActiveCredentials();
      if (credentials === null) {
        return c.redirect(loginErrorRedirect(safeNext, "feishu_not_configured"), 302);
      }

      let exchanged;
      try {
        exchanged = await exchangeFeishuAuthorizationCode(
          {
            code,
            appId: credentials.appId,
            appSecret: credentials.appSecret,
            feishuHost: credentials.feishuHost,
          },
          options.feishuFetch,
        );
      } catch {
        return c.redirect(loginErrorRedirect(safeNext, "feishu_exchange_failed"), 302);
      }

      let sessionAccount = exchanged.account;
      const db = authDb(options);
      if (db !== undefined) {
        const stored = ensureDashboardAccount(db, exchanged.account, exchanged.identityClaims);
        if (stored.status !== "active") {
          return c.redirect(loginErrorRedirect(safeNext, "account_inactive"), 302);
        }
        sessionAccount = {
          ...exchanged.account,
          name: stored.displayName,
          ...(stored.avatarUrl ? { avatarUrl: stored.avatarUrl } : {}),
        };
      }

      const issued = auth.issueSession(sessionAccount);
      auth.setSessionCookie(c, issued.sessionToken);
      return c.redirect(safeNext, 302);
    });
}

function feishuAuthStore(options: AuthRouteOptions): FeishuAuthConfigStore {
  if (options.feishuAuthStore !== undefined) {
    return options.feishuAuthStore;
  }
  const db = authDb(options);
  return new FeishuAuthConfigStore(db === undefined ? {} : { db });
}

function loginErrorRedirect(next: string, errorCode: string): string {
  const params = new URLSearchParams();
  const safeNext = normalizeDashboardNextPath(next);
  if (safeNext !== "/") {
    params.set("next", safeNext);
  }
  params.set("error", errorCode);
  return `/login?${params.toString()}`;
}

async function readLoginBody(request: Request): Promise<{ token: string }> {
  try {
    const body = await request.json();
    if (
      body &&
      typeof body === "object" &&
      "token" in body &&
      typeof body.token === "string"
    ) {
      return { token: body.token };
    }
  } catch {
    return { token: "" };
  }
  return { token: "" };
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function accessTokenService(options: AuthRouteOptions): AccessTokenService | null {
  const db = authDb(options);
  const signingSecret = resolveLunaAccessTokenSigningSecret();
  return db === undefined || signingSecret === null
    ? null
    : new AccessTokenService({ db, signingSecret });
}

function authDb(options: AuthRouteOptions): DrizzleDB | undefined {
  if (options.db !== undefined) {
    return options.db;
  }
  try {
    return getKernel().database.db;
  } catch {
    return undefined;
  }
}

function publicTokenRecord(row: typeof accessTokens.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    source: row.source,
    name: row.name,
    role: row.role,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    metadata: row.metadataJson,
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
