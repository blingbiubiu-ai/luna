import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { DrizzleDB } from "@/data";
import { InvocationService } from "@/runners/invocation-service";
import { AccountStore } from "@/identity/account-store";

import { DEFAULT_LUNA_DASHBOARD_TOKEN } from "@luna/host-runtime/defaults";
import {
  AccessTokenService,
  type LunaAccessTokenClaims,
} from "./auth/access-token-service";
import { getKernel } from "./routes/kernel";

const SESSION_COOKIE = "luna_dashboard_session";
/** A Dashboard sign-in lasts 30 days from its last renewal; one in use is renewed (see `renewSession`). */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
/** The local-token sign-in has no person behind it, so its name is a placeholder a linked chat identity may replace. */
export const LOCAL_ACCOUNT_NAME = "Local dashboard user";
const LOCAL_ACCOUNT = {
  id: "local-dashboard-user",
  name: LOCAL_ACCOUNT_NAME,
  provider: "local-token",
} as const;

/** A signed-in Dashboard account. */
export interface DashboardAccount {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly avatarUrl?: string | null;
}

export interface DashboardAuthSession {
  readonly authenticated: boolean;
  readonly account: DashboardAccount | null;
}

export type LunaRequestAuthKind = "dashboard-cookie" | "luna-access-token";

export interface DashboardAuthProvider {
  readonly id: string;
  authenticateToken(token: string): Promise<DashboardAccount | null>;
}

export interface DashboardAuthMiddlewareOptions {
  readonly db?: DrizzleDB;
}

interface ServiceBearerAuthResult {
  /** The account of a personal token; absent for a runner token, which acts as `claims.actorUserId`. */
  readonly account?: DashboardAccount;
  readonly claims: LunaAccessTokenClaims;
}

export function createLocalTokenAuthProvider(
  token: string,
): DashboardAuthProvider {
  return {
    id: "local-token",
    async authenticateToken(candidate: string) {
      return secureEqual(candidate, token) ? LOCAL_ACCOUNT : null;
    },
  };
}

export class DashboardAuthService {
  private readonly _provider: DashboardAuthProvider;
  private readonly _sessionSecret: string;
  private readonly _usesLocalDefaultToken: boolean;

  constructor(input?: {
    readonly provider?: DashboardAuthProvider;
    readonly sessionSecret?: string;
  }) {
    const token = resolveDashboardToken();
    this._provider = input?.provider ?? createLocalTokenAuthProvider(token.value);
    this._sessionSecret = input?.sessionSecret ?? sessionSecret();
    this._usesLocalDefaultToken = token.value === DEFAULT_LUNA_DASHBOARD_TOKEN;
  }

  get providerId(): string {
    return this._provider.id;
  }

  get usesLocalDefaultToken(): boolean {
    return this._usesLocalDefaultToken;
  }

  async login(token: string): Promise<{
    readonly sessionToken: string;
    readonly session: DashboardAuthSession;
  } | null> {
    const account = await this._provider.authenticateToken(token);
    if (account === null) {
      return null;
    }
    const sessionToken = this._signSession({
      sub: account.id,
      name: account.name,
      provider: account.provider,
      ...(account.avatarUrl === undefined ? {} : { avatarUrl: account.avatarUrl }),
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });
    return {
      sessionToken,
      session: {
        authenticated: true,
        account,
      },
    };
  }

  sessionFromRequest(c: Context): DashboardAuthSession {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      return { authenticated: false, account: null };
    }
    const claims = this._verifySession(token);
    if (claims === null) {
      return { authenticated: false, account: null };
    }
    return {
      authenticated: true,
      account: {
        id: claims.sub,
        name: claims.name,
        provider: claims.provider,
        ...(claims.avatarUrl === undefined ? {} : { avatarUrl: claims.avatarUrl }),
      },
    };
  }

  /** Reissues a valid session past half its lifetime, so a Dashboard in use stays signed in and an idle one expires. */
  renewSession(c: Context): void {
    const token = getCookie(c, SESSION_COOKIE);
    const claims = token ? this._verifySession(token) : null;
    const now = Math.floor(Date.now() / 1000);
    if (claims === null || claims.exp - now > SESSION_TTL_SECONDS / 2) return;
    this.setSessionCookie(c, this._signSession({...claims, exp: now + SESSION_TTL_SECONDS}));
  }

  setSessionCookie(c: Context, sessionToken: string): void {
    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: isSecureRequest(c),
    });
  }

  clearSessionCookie(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
    });
  }

  private _signSession(claims: SessionClaims): string {
    const payload = base64UrlEncode(JSON.stringify(claims));
    const signature = this._signature(payload);
    return `${payload}.${signature}`;
  }

  private _verifySession(token: string): SessionClaims | null {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      return null;
    }
    if (!secureEqual(signature, this._signature(payload))) {
      return null;
    }
    try {
      const claims = JSON.parse(base64UrlDecode(payload)) as Partial<SessionClaims>;
      if (
        typeof claims.sub !== "string" ||
        typeof claims.name !== "string" ||
        typeof claims.provider !== "string" ||
        (
          claims.avatarUrl !== undefined &&
          claims.avatarUrl !== null &&
          typeof claims.avatarUrl !== "string"
        ) ||
        typeof claims.exp !== "number"
      ) {
        return null;
      }
      if (claims.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      return {
        sub: claims.sub,
        name: claims.name,
        provider: claims.provider,
        ...(claims.avatarUrl === undefined ? {} : { avatarUrl: claims.avatarUrl }),
        exp: claims.exp,
      };
    } catch {
      return null;
    }
  }

  private _signature(payload: string): string {
    return createHmac("sha256", this._sessionSecret)
      .update(payload)
      .digest("base64url");
  }
}

export function createDashboardAuthMiddleware(
  auth: DashboardAuthService,
  options: DashboardAuthMiddlewareOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (options.db !== undefined) c.set("lunaAuthorizationDb", options.db);
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const allowSignedArtifactContent = isSignedArtifactContentRequest(
      c.req.method,
      url,
    );
    if (isPublicPath(pathname)) {
      await next();
      return;
    }
    let session = auth.sessionFromRequest(c);
    if (session.authenticated) {
      if (options.db !== undefined && session.account !== null) {
        const account = ensureDashboardAccount(options.db, session.account);
        if (account.status !== "active") {
          deleteCookie(c, SESSION_COOKIE);
          return c.json({ status: "error", message: "账号已停用或删除，请联系管理员。" }, 401);
        }
        session = withStoredProfile(session, account);
      }
      auth.renewSession(c);
      c.set("lunaRequestAuthKind", "dashboard-cookie" satisfies LunaRequestAuthKind);
      c.set("dashboardAuthSession", session);
      await next();
      return;
    }
    const bearerAuth = isServiceAuthPath(pathname)
      ? authenticateServiceBearer(c, options.db)
      : null;
    if (bearerAuth !== null) {
      c.set("lunaRequestAuthKind", "luna-access-token" satisfies LunaRequestAuthKind);
      c.set("lunaAccessTokenClaims", bearerAuth.claims);
      c.set("dashboardAuthSession", {
        authenticated: true,
        account: bearerAuth.account ?? null,
      } satisfies DashboardAuthSession);
      await next();
      return;
    }
    if (allowSignedArtifactContent) {
      await next();
      return;
    }
    if (isServiceAuthPath(pathname)) {
      return c.json(
        {
          status: "error",
          code: "unauthorized",
          message: "authentication required",
        },
        401,
      );
    }
    return c.redirect(
      `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      302,
    );
  };
}

export function dashboardAuthSessionFromContext(
  c: Context,
): DashboardAuthSession | null {
  return (c.get("dashboardAuthSession") as DashboardAuthSession | undefined) ??
    null;
}

/** The signed-in account of a Dashboard cookie or a personal token; undefined for a runner token. */
export function requesterAccountIdFromContext(
  c: Context,
): string | undefined {
  const session = dashboardAuthSessionFromContext(c);
  return session?.authenticated === true && session.account !== null
    ? session.account.id
    : undefined;
}

export function lunaAccessTokenClaimsFromContext(
  c: Context,
): LunaAccessTokenClaims | undefined {
  return c.get("lunaAccessTokenClaims") as LunaAccessTokenClaims | undefined;
}

/** Records a signed-in account and keeps its profile current. */
export function ensureDashboardAccount(db: DrizzleDB, account: DashboardAccount) {
  return new AccountStore(db).ensure({...account, placeholderName: account.provider === "local-token"});
}

/** The session shows the account's stored name and avatar, which may differ from the sign-in's placeholder. */
export function withStoredProfile(session: DashboardAuthSession, stored: {displayName: string; avatarUrl: string | null}): DashboardAuthSession {
  if (!session.account) return session;
  return {...session, account: {...session.account, name: stored.displayName, ...(stored.avatarUrl ? {avatarUrl: stored.avatarUrl} : {})}};
}

export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/health" ||
    pathname === "/api/auth/session" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/cli/start" ||
    pathname === "/api/auth/cli/poll" ||
    pathname === "/api/auth/cli/confirm-channel-token" ||
    pathname === "/auth/cli" ||
    pathname === "/api/auth/sso/start" ||
    pathname === "/api/auth/sso/callback" ||
    (!isApiPath(pathname) && isStaticAssetPath(pathname))
  );
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isServiceAuthPath(pathname: string): boolean {
  return isApiPath(pathname) || pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function isSignedArtifactContentRequest(method: string, url: URL): boolean {
  return method.toUpperCase() === "GET" &&
    (
      /^\/api\/artifacts\/[^/]+\/content$/.test(url.pathname) ||
      /^\/api\/artifacts\/[^/]+\/preview$/.test(url.pathname) ||
      /^\/artifacts\/[^/]+\/preview$/.test(url.pathname)
    ) &&
    url.searchParams.has("expires") &&
    url.searchParams.has("sig");
}

function authenticateServiceBearer(
  c: Context,
  db: DrizzleDB | undefined,
): ServiceBearerAuthResult | null {
  const header = c.req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match === null) {
    return null;
  }
  const candidate = match[1]?.trim() ?? "";
  if (candidate === "") {
    return null;
  }
  const signingSecret = resolveLunaAccessTokenSigningSecret();
  const authDb = db ?? serviceAuthDb();
  if (signingSecret === null || authDb === undefined) {
    return null;
  }
  try {
    const verified = new AccessTokenService({
      db: authDb,
      signingSecret,
    }).verifyBearer(candidate, {
      now: Date.now(),
    });
    if (verified.claims.source === "runner") {
      if (!verified.claims.runnerKind) return null;
      new InvocationService(authDb).requireActive(verified.claims, verified.claims.runnerKind);
    }
    return {
      ...(verified.subject.kind === "account"
        ? { account: { id: verified.subject.id, name: verified.subject.displayName, provider: "luna-access-token" } }
        : {}),
      claims: verified.claims,
    };
  } catch {
    return null;
  }
}

function serviceAuthDb(): DrizzleDB | undefined {
  try {
    return getKernel().database.db;
  } catch {
    return undefined;
  }
}

export function resolveLunaAccessTokenSigningSecret(): string | null {
  return Bun.env.LUNA_ACCESS_TOKEN_SECRET?.trim() ||
    Bun.env.LUNA_DASHBOARD_TOKEN?.trim() ||
    null;
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.[a-zA-Z0-9]+$/.test(pathname);
}

function resolveDashboardToken(): {
  readonly value: string;
  readonly source: "configured" | "local-dev-default";
} {
  const configured = Bun.env.LUNA_DASHBOARD_TOKEN?.trim();
  if (configured) {
    return { value: configured, source: "configured" };
  }
  return {
    value: DEFAULT_LUNA_DASHBOARD_TOKEN,
    source: "local-dev-default",
  };
}

function sessionSecret(): string {
  const configured = Bun.env.LUNA_DASHBOARD_SESSION_SECRET?.trim();
  if (configured) {
    return configured;
  }
  const generated = Bun.env.LUNA_DASHBOARD_DEV_SESSION_SECRET?.trim() ||
    randomBytes(32).toString("base64url");
  Bun.env.LUNA_DASHBOARD_DEV_SESSION_SECRET = generated;
  process.env.LUNA_DASHBOARD_DEV_SESSION_SECRET = generated;
  return generated;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function isSecureRequest(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

interface SessionClaims {
  readonly sub: string;
  readonly name: string;
  readonly provider: string;
  readonly avatarUrl?: string | null;
  readonly exp: number;
}
