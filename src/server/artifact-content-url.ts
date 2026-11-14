import { createHmac, timingSafeEqual } from "node:crypto";

import { DEFAULT_LUNA_DASHBOARD_TOKEN } from "@luna/host-runtime/defaults";

export const DEFAULT_ARTIFACT_CONTENT_SIGNED_URL_TTL_MS = 2 * 60 * 60 * 1000;

const ARTIFACT_CONTENT_PURPOSE = "artifact-content";

export interface SignedArtifactContentUrlInput {
  readonly artifactId: string;
  readonly now: number;
  readonly ttlMs?: number;
}

export function artifactContentPath(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content`;
}

export function artifactPreviewPath(artifactId: string): string {
  return `/artifacts/${encodeURIComponent(artifactId)}/preview`;
}

export function signedArtifactContentUrl(
  input: SignedArtifactContentUrlInput,
): string {
  return signedArtifactUrl(input, "content");
}

export function signedArtifactPreviewUrl(
  input: SignedArtifactContentUrlInput,
): string {
  return signedArtifactUrl(input, "preview");
}

function signedArtifactUrl(
  input: SignedArtifactContentUrlInput,
  variant: "content" | "preview",
): string {
  const ttlMs = input.ttlMs ?? DEFAULT_ARTIFACT_CONTENT_SIGNED_URL_TTL_MS;
  const expires = input.now + ttlMs;
  const sig = signArtifactContent(input.artifactId, expires);
  const path = variant === "preview" ? artifactPreviewPath(input.artifactId) : artifactContentPath(input.artifactId);
  return `${path}?expires=${expires}&sig=${encodeURIComponent(sig)}`;
}

export function hasArtifactContentSignature(url: URL): boolean {
  return url.searchParams.has("expires") && url.searchParams.has("sig");
}

export function verifyArtifactContentSignature(input: {
  readonly artifactId: string;
  readonly expires: string | null;
  readonly sig: string | null;
  readonly now: number;
}): boolean {
  if (input.expires === null || input.sig === null) {
    return false;
  }
  const expires = Number(input.expires);
  if (!Number.isSafeInteger(expires) || input.now > expires) {
    return false;
  }
  const expected = signArtifactContent(input.artifactId, expires);
  return secureEqual(input.sig, expected);
}

function signArtifactContent(artifactId: string, expires: number): string {
  const secret = resolveArtifactContentSigningSecret();
  if (secret === null) {
    return "";
  }
  return createHmac("sha256", secret)
    .update(`${ARTIFACT_CONTENT_PURPOSE}.${artifactId}.${expires}`)
    .digest("base64url");
}

function resolveArtifactContentSigningSecret(): string | null {
  return Bun.env.LUNA_ACCESS_TOKEN_SECRET?.trim() ||
    Bun.env.LUNA_DASHBOARD_TOKEN?.trim() ||
    DEFAULT_LUNA_DASHBOARD_TOKEN;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
