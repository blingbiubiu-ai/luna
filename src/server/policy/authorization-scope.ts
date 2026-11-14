import { and, eq, isNull } from "drizzle-orm";
import { authorizationRules } from "@/data/schema";

export type AuthorizationScope = Readonly<{kind: "platform"} | {kind: "agent"; agentId: string}>;

/** Missing scope is an error, never a request for all grants. */
export function authorizationScopeFields(scope: AuthorizationScope | undefined) {
  if (!scope || (scope.kind === "agent" && !scope.agentId.trim())) throw new Error("authorization_scope_required");
  return {scopeType: scope.kind, agentId: scope.kind === "agent" ? scope.agentId : null};
}

export function authorizationScopeFilter(scope: AuthorizationScope | undefined) {
  const fields = authorizationScopeFields(scope);
  return and(eq(authorizationRules.scopeType, fields.scopeType),
    fields.agentId === null ? isNull(authorizationRules.agentId) : eq(authorizationRules.agentId, fields.agentId))!;
}
