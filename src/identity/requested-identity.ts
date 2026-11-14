import type { NormalizedInboundMessage } from "@/channels";
import type { DrizzleDB } from "@/data";

import { IdentityDirectory } from "./identity-directory";

export type RequestedIdentityProvider = string;

export interface RequestedIdentityContext {
  readonly provider: RequestedIdentityProvider;
  readonly externalUserId: string;
  readonly tenantKey?: string;
  readonly canonicalUserId?: string;
  readonly identityNamespace?: string;
  readonly identityKind?: string;
  readonly identityScope?: string;
}

export function requestedIdentityFromInbound(
  inbound: NormalizedInboundMessage,
): RequestedIdentityContext | undefined {
  if (inbound.sender.kind !== "user" && inbound.sender.kind !== "bot") {
    return undefined;
  }
  const explicitIdentity = normalizedRequesterIdentity(inbound.sender.requesterIdentity);
  if (explicitIdentity !== undefined) {
    return explicitIdentity;
  }
  if (requiresExplicitRequesterIdentity(inbound)) {
    return undefined;
  }

  const externalUserId = nonEmptyString(inbound.sender.externalId);
  if (externalUserId === undefined) {
    return undefined;
  }
  return {
    provider: "local",
    externalUserId,
    canonicalUserId: externalUserId,
  };
}

export function requiresExplicitRequesterIdentity(
  inbound: NormalizedInboundMessage,
): boolean {
  return (
    (inbound.sender.kind === "user" || inbound.sender.kind === "bot") &&
    inbound.sender.requiresExplicitRequesterIdentity === true
  );
}

export function canonicalUserIdForRequestedIdentity(
  db: DrizzleDB,
  identity: RequestedIdentityContext | undefined,
): string | undefined {
  if (identity === undefined) {
    return undefined;
  }
  if (identity.provider === "local") {
    return identity.canonicalUserId ?? identity.externalUserId;
  }
  return new IdentityDirectory(db).resolveUserIdForIdentity({
    namespace: identity.identityNamespace ?? identity.provider,
    kind: identity.identityKind ?? "external_id",
    value: identity.externalUserId,
    scope: identity.identityScope ??
      (identity.tenantKey === undefined ? "" : `tenant:${identity.tenantKey}`),
  });
}

export function requestedIdentityFromTaskContext(
  value: unknown,
): RequestedIdentityContext | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const requestedByIdentity = (value as Record<string, unknown>).requestedByIdentity;
  if (typeof requestedByIdentity !== "object" || requestedByIdentity === null) {
    return undefined;
  }
  const record = requestedByIdentity as Record<string, unknown>;
  const provider = nonEmptyString(record.provider);
  const externalUserId = nonEmptyString(record.externalUserId);
  if (provider === undefined || externalUserId === undefined) {
    return undefined;
  }
  return {
    provider,
    externalUserId,
    ...optionalString("tenantKey", record.tenantKey),
    ...optionalString("canonicalUserId", record.canonicalUserId),
    ...optionalString("identityNamespace", record.identityNamespace),
    ...optionalString("identityKind", record.identityKind),
    ...optionalString("identityScope", record.identityScope),
  };
}

function normalizedRequesterIdentity(
  value: NormalizedInboundMessage["sender"]["requesterIdentity"],
): RequestedIdentityContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  const provider = nonEmptyString(value.provider);
  const externalUserId = nonEmptyString(value.externalUserId);
  if (provider === undefined || externalUserId === undefined) {
    return undefined;
  }
  return {
    provider,
    externalUserId,
    ...optionalString("tenantKey", value.tenantKey),
    ...optionalString("canonicalUserId", value.canonicalUserId),
    ...optionalString("identityNamespace", value.identityNamespace),
    ...optionalString("identityKind", value.identityKind),
    ...optionalString("identityScope", value.identityScope),
  };
}

function optionalString<TKey extends string>(
  key: TKey,
  value: unknown,
): Record<TKey, string> | Record<string, never> {
  const normalized = nonEmptyString(value);
  return normalized === undefined ? {} : { [key]: normalized } as Record<TKey, string>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
