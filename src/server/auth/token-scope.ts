import type { Context } from "hono";

import { GatewayError } from "../gateway-error";

import type { LunaRequestAuthKind } from "../auth";
import type { LunaAccessTokenClaims } from "./access-token-service";

export function assertRequestTokenAllows(
  c: Context,
  _input: { readonly operationId: string; readonly target: string },
): void {
  const claims = c.get("lunaAccessTokenClaims") as
    | LunaAccessTokenClaims
    | undefined;
  const authKind = c.get("lunaRequestAuthKind") as
    | LunaRequestAuthKind
    | undefined;
  if (claims === undefined && authKind === "dashboard-cookie") {
    return;
  }
  assertTokenAllows(claims);
}

export function assertTokenAllows(
  claims: LunaAccessTokenClaims | undefined,
): void {
  if (!claims) {
    throw new GatewayError(
      "401_missing_access_token",
      "access token is required",
      401,
    );
  }
}
