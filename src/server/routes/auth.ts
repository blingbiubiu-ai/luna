import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { accessTokens } from "@/data/schema";
import {
  type DashboardAuthService,
  ensureDashboardUser,
  resolveLunaAccessTokenSigningSecret,
} from "../auth";
import { AccessTokenService } from "../auth/access-token-service";
import {
  isGuardResponse,
  requireAccessTokenSelf,
  requireAuthenticated,
  requireDashboardOnly,
} from "../auth/guards";
import { isPlatformAdministrator } from "../policy/platform-administrator";
import { getKernel } from "./kernel";

interface AuthRouteOptions {
  readonly db?: DrizzleDB;
}

export function createAuthRoutes(
  auth: DashboardAuthService,
  options: AuthRouteOptions = {},
): Hono {
  return new Hono()
    .get("/session", (c) => c.json(auth.sessionFromRequest(c)))
    .post("/login", async (c) => {
      const body = await readLoginBody(c.req.raw);
      const login = await auth.login(body.token);
      if (login === null) {
        return c.json({ error: "invalid_token" }, 401);
      }
      if (options.db && login.session.user) {
        ensureDashboardUser(options.db, login.session.user, { bindDashboardIdentity: true });
      }
      auth.setSessionCookie(c, login.sessionToken);
      return c.json(login.session);
    })
    .post("/logout", (c) => {
      auth.clearSessionCookie(c);
      return c.json({ authenticated: false, user: null });
    })
    .get("/me", (c) => {
      const current = requireAuthenticated(c);
      if (isGuardResponse(current)) {
        return current;
      }
      return c.json({
        status: "ok",
        authenticated: true,
        authKind: current.authKind,
        user: {
          id: current.user.id,
          displayName: current.user.name,
          provider: current.user.provider,
        },
        // Lets the Dashboard show platform pages; the platform APIs enforce it themselves.
        isPlatformAdmin: (() => {
          const db = authDb(options);
          return db !== undefined && isPlatformAdministrator(db, current.user.id);
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
      const userId = dashboard.user.id;
      const body = await readJsonRecord(c.req.raw);
      if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
        return c.json({ status: "error", code: "missing_user_code" }, 400);
      }
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      try {
        service.approveCliAuthSession(body.userCode, userId, Date.now());
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
      // Personal CLI/MCP tokens: every signed-in Dashboard user manages their own.
      const self = requireDashboardOnly(c);
      if (isGuardResponse(self)) {
        return self;
      }
      const userId = self.user.id;
      const db = authDb(options);
      if (db === undefined) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      const rows = db
        .select()
        .from(accessTokens)
        .where(and(eq(accessTokens.userId, userId), inArray(accessTokens.source, ["cli", "mcp"])))
        .orderBy(desc(accessTokens.createdAt))
        .all();
      return c.json({ tokens: rows.map(publicTokenRecord) });
    })
    .post("/tokens", async (c) => {
      // Personal CLI/MCP tokens: every signed-in Dashboard user manages their own.
      const self = requireDashboardOnly(c);
      if (isGuardResponse(self)) {
        return self;
      }
      const userId = self.user.id;
      const body = await readJsonRecord(c.req.raw);
      const source = body.source === "mcp" ? "mcp" : "cli";
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      const issued = service.issueToken({
        userId,
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
      service.revokeToken(claims.tokenId, claims.actorUserId, Date.now());
      return c.json({ status: "revoked" });
    })
    .delete("/tokens/:tokenId", (c) => {
      // Personal CLI/MCP tokens: every signed-in Dashboard user manages their own.
      const self = requireDashboardOnly(c);
      if (isGuardResponse(self)) {
        return self;
      }
      const userId = self.user.id;
      const service = accessTokenService(options);
      if (service === null) {
        return c.json({ status: "error", code: "access_token_unavailable" }, 503);
      }
      service.revokeToken(c.req.param("tokenId"), userId, Date.now());
      return c.json({ status: "revoked" });
    })
    .get("/sso/start", (c) =>
      c.json({ error: "sso_not_configured" }, 501),
    )
    .get("/sso/callback", (c) =>
      c.json({ error: "sso_not_configured" }, 501),
    );
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
