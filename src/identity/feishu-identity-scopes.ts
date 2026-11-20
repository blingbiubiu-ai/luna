import type { ChannelIdentity, ChannelIdentityClaim, ChannelRequesterIdentity } from "@/channels/types";

/** Application/developer scope comes from the authenticated adapter, never a sender app_id. */
export interface FeishuIdentityScope {
  readonly environment: "feishu" | "lark";
  readonly appId: string;
  readonly tenantKey?: string;
  readonly developerId?: string;
}

const FEISHU_CLAIM_SCOPE_PREFIX: Readonly<Record<string, string>> = {
  open_id: "app:",
  user_id: "tenant:",
  tenant_union_id: "tenant:",
  union_id: "developer:",
  external_id: "channel:",
};

/** Infers `"feishu"` vs `"lark"` namespace from a Feishu/Lark API host URL. */
export function feishuEnvironmentFromHost(host: string): "feishu" | "lark" {
  try {
    return new URL(host).hostname.toLowerCase().includes("lark") ? "lark" : "feishu";
  } catch {
    return host.toLowerCase().includes("lark") ? "lark" : "feishu";
  }
}

export function validateFeishuClaimScope(claim: {
  readonly namespace: string;
  readonly kind: string;
  readonly scope: string;
}): void {
  if (claim.namespace !== "feishu" && claim.namespace !== "lark") return;
  const prefix = FEISHU_CLAIM_SCOPE_PREFIX[claim.kind];
  if (!prefix || !claim.scope.startsWith(prefix) || claim.scope.length === prefix.length) {
    throw new Error("identity_scope_required");
  }
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
  const tenantScope = scope.tenantKey?.trim() ? `tenant:${scope.tenantKey.trim()}` : undefined;
  add("open_id", ids.open_id, `app:${scope.appId}`);
  add("user_id", ids.user_id, tenantScope);
  add("tenant_union_id", ids.union_id, tenantScope);
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
