import { validateFeishuClaimScope } from "./feishu-identity-scopes";

/** Rejects identity evidence lacking required namespace/kind/value or namespace-specific scope format. */
export function validateIdentityClaim(claim: {
  readonly namespace: string;
  readonly kind: string;
  readonly value: string;
  readonly scope: string;
}): void {
  if (!claim.namespace.trim() || !claim.kind.trim() || !claim.value.trim()) {
    throw new Error("identity_claim_invalid");
  }
  validateFeishuClaimScope(claim);
}
