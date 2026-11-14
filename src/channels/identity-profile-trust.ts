import type { ChannelIdentity } from "./types";

export function trustedChannelIdentityProfile(
  identity: Pick<ChannelIdentity, "displayName" | "avatarUrl" | "rawProfile">,
): {
  readonly displayName?: string;
  readonly avatarUrl?: string;
} {
  if (isLowConfidenceMentionSnapshot(identity.rawProfile)) {
    return {};
  }
  return {
    ...(identity.displayName !== undefined
      ? { displayName: identity.displayName }
      : {}),
    ...(identity.avatarUrl !== undefined
      ? { avatarUrl: identity.avatarUrl }
      : {}),
  };
}

function isLowConfidenceMentionSnapshot(rawProfile: unknown): boolean {
  if (!isRecord(rawProfile)) {
    return false;
  }
  if (typeof rawProfile.key !== "string" || !isRecord(rawProfile.id)) {
    return false;
  }
  const allowedKeys = new Set([
    "key",
    "id",
    "name",
    "tenant_key",
    "mentioned_type",
  ]);
  return Object.keys(rawProfile).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
