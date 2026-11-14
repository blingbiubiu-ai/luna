import type { ChannelIdentity, ChannelIdentityClaim, ChannelRequesterIdentity } from "@/channels/types";

/** Application/developer scope comes from the authenticated adapter, never a sender app_id. */
export interface FeishuIdentityScope {
  readonly environment: "feishu" | "lark";
  readonly appId: string;
  readonly tenantKey?: string;
  readonly developerId?: string;
}

/** Provider IDs without their required scope are not canonical identity evidence. */
export function feishuIdentityMetadata(
  scope: FeishuIdentityScope,
  ids: Readonly<{open_id?: string; user_id?: string; union_id?: string}>,
): {identityClaims: ChannelIdentityClaim[]; requesterIdentity?: ChannelRequesterIdentity; requiresExplicitRequesterIdentity: true} {
  if (!scope.appId.trim()) throw new Error("identity_application_scope_required");
  const claims: ChannelIdentityClaim[] = [];
  const add = (kind: string, value: string | undefined, identityScope: string | undefined) => {
    if (value?.trim() && identityScope) claims.push({namespace: scope.environment, kind, value, scope: identityScope, confidence: "verified"});
  };
  add("open_id", ids.open_id, `app:${scope.appId}`);
  add("user_id", ids.user_id, scope.tenantKey?.trim() ? `tenant:${scope.tenantKey}` : undefined);
  add("union_id", ids.union_id, scope.developerId?.trim() ? `developer:${scope.developerId}` : undefined);
  const preferred = claims.find(claim => claim.kind === "open_id") ?? claims.find(claim => claim.kind === "user_id");
  return {identityClaims: claims, requiresExplicitRequesterIdentity: true,
    ...(preferred ? {requesterIdentity: {provider: scope.environment, externalUserId: preferred.value,
      ...(scope.tenantKey ? {tenantKey: scope.tenantKey} : {}), identityNamespace: preferred.namespace,
      identityKind: preferred.kind, identityScope: preferred.scope!}} : {})};
}


/** Rebuild evidence after profile enrichment so newly observed tenant IDs are not lost. */
export function scopeFeishuIdentity(identity: ChannelIdentity, scope: FeishuIdentityScope): ChannelIdentity {
  const {identityClaims: _claims, requesterIdentity: _requester, ...profile} = identity;
  const tenantKey = identity.providerIds?.tenant_key;
  if (scope.tenantKey && tenantKey && scope.tenantKey !== tenantKey) throw new Error("identity_tenant_scope_mismatch");
  return {...profile, ...feishuIdentityMetadata({...scope, ...(tenantKey ? {tenantKey} : {})}, identity.providerIds ?? {})};
}
