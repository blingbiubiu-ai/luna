import type { Context, MiddlewareHandler } from "hono";
import type { DrizzleDB } from "@/data";
import {isPlatformAdministrator} from "../policy/platform-administrator";

import {
  dashboardAuthSessionFromContext,
  lunaAccessTokenClaimsFromContext,
  type DashboardAuthUser,
  type LunaRequestAuthKind,
} from "../auth";
import type { LunaAccessTokenClaims } from "./access-token-service";

export interface AuthenticatedDashboardContext {
  readonly authKind: "dashboard-cookie";
  readonly user: DashboardAuthUser;
}

export interface AuthenticatedAccessTokenContext {
  readonly authKind: "luna-access-token";
  readonly user: DashboardAuthUser;
  readonly token: LunaAccessTokenClaims;
}

export type AuthenticatedContext =
  | AuthenticatedDashboardContext
  | AuthenticatedAccessTokenContext;

export function requireAuthenticated(c: Context): AuthenticatedContext | Response {
  const session = dashboardAuthSessionFromContext(c);
  const user = session?.authenticated === true && session.user !== null
    ? session.user
    : undefined;
  if (user === undefined) {
    return unauthorized(c);
  }
  const authKind = c.get("lunaRequestAuthKind") as LunaRequestAuthKind | undefined;
  const token = lunaAccessTokenClaimsFromContext(c);
  if (authKind === "luna-access-token" && token !== undefined) {
    return { authKind, user, token };
  }
  if (authKind === "dashboard-cookie") {
    return { authKind, user };
  }
  return unauthorized(c);
}

export function requireDashboardOnly(
  c: Context,
): AuthenticatedDashboardContext | Response {
  const auth = requireAuthenticated(c);
  if (isGuardResponse(auth)) {
    return auth;
  }
  if (auth.authKind === "dashboard-cookie") {
    return auth;
  }
  return c.json({
    status: "error",
    code: "dashboard_session_required",
    message: "Dashboard session authentication is required",
  }, 403);
}

export function requireAdmin(c: Context): AuthenticatedDashboardContext | Response {
  const auth = requireDashboardOnly(c);
  if (isGuardResponse(auth)) return auth;
  // Only the authentication middleware supplies this database, never request data.
  const db = c.get("lunaAuthorizationDb") as DrizzleDB | undefined;
  if(db && isPlatformAdministrator(db,auth.user.id))return auth;
  return c.json({status: "error", code: "platform_admin_required", message: "Platform administrator permission is required"}, 403);
}

export function requireAccessTokenSelf(
  c: Context,
): AuthenticatedAccessTokenContext | Response {
  const auth = requireAuthenticated(c);
  if (isGuardResponse(auth)) {
    return auth;
  }
  if (auth.authKind === "luna-access-token") {
    return auth;
  }
  return c.json({
    status: "error",
    code: "access_token_required",
    message: "Access token authentication is required",
  }, 403);
}

export function isGuardResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export function requireAdminMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const admin = requireAdmin(c);
    if (isGuardResponse(admin)) {
      return admin;
    }
    await next();
  };
}

function unauthorized(c: Context): Response {
  return c.json({
    status: "error",
    code: "unauthorized",
    message: "authentication required",
  }, 401);
}
