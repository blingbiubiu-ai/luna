import { parseArtifactRef } from "@luna/service-client/artifact-ref";
import { ArtifactRegistry } from "@/artifacts/artifact-registry";
import type { DrizzleDB } from "@/data";
import {
  artifactContentPath,
  artifactPreviewPath,
  signedArtifactContentUrl,
  signedArtifactPreviewUrl,
} from "@/server/artifact-content-url";
import { createArtifactAccessPolicy } from "@/server/artifact-access-policy";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";

/**
 * Dashboard DTOs must not reinterpret durable local paths. New resources are
 * exposed through artifact refs; old local paths remain plain text.
 */
export function sanitizeDashboardLocalFileReferencesInValue<T>(
  value: T,
  _options: unknown = {},
): T {
  return value;
}

export interface DashboardArtifactUrlSigner {
  readonly previewUrl: (artifactId: string) => string | undefined;
  readonly contentUrl: (artifactId: string) => string | undefined;
}

export type DashboardArtifactSigner = DashboardArtifactUrlSigner;

export interface DashboardArtifactSigningOptions {
  readonly artifactSigner: DashboardArtifactSigner;
}

export function signDashboardArtifactReferencesInValue<T>(
  value: T,
  options: DashboardArtifactSigningOptions,
): T {
  return rewriteDashboardArtifactRefsInValue(value, options.artifactSigner);
}

export function linkDashboardArtifactReferencesInMarkdown(
  text: string,
  options: DashboardArtifactSigningOptions,
): string {
  const replacements: string[] = [];
  const placeholder = (value: string) => {
    const index = replacements.push(value) - 1;
    return `__LUNA_DASHBOARD_ARTIFACT_LINK_${index}__`;
  };

  const linked = text
    .replace(
      /!\[([^\]]*)\]\(artifact:([A-Za-z0-9._:-]+)\)/g,
      (match, alt: string, artifactId: string) => {
        const href = options.artifactSigner.contentUrl(artifactId);
        return href === undefined ? match : placeholder(`![${alt}](${href})`);
      },
    )
    .replace(
      /\[([^\]]+)\]\(artifact:([A-Za-z0-9._:-]+)\)/g,
      (match, label: string, artifactId: string) => {
        const href = options.artifactSigner.previewUrl(artifactId);
        return href === undefined ? match : placeholder(`[${label}](${href})`);
      },
    )
    .replace(/`artifact:([A-Za-z0-9._:-]+)`/g, (match, artifactId: string) => {
      const href = options.artifactSigner.previewUrl(artifactId);
      return href === undefined
        ? match
        : placeholder(`[artifact:${artifactId}](${href})`);
    })
    .replace(
      /(^|[^\w:/])artifact:([A-Za-z0-9._:-]+)/g,
      (match, prefix: string, artifactId: string) => {
        const href = options.artifactSigner.previewUrl(artifactId);
        return href === undefined
          ? match
          : `${prefix}${placeholder(`[artifact:${artifactId}](${href})`)}`;
      },
    );

  return linked.replace(
    /__LUNA_DASHBOARD_ARTIFACT_LINK_(\d+)__/g,
    (match, index: string) => replacements[Number(index)] ?? match,
  );
}

export function createDashboardArtifactSigner(input: {
  readonly db: DrizzleDB;
  readonly requesterUserId?: string | undefined;
  readonly accessTokenClaims?: LunaAccessTokenClaims | undefined;
  readonly now?: () => number;
}): DashboardArtifactUrlSigner {
  const registry = new ArtifactRegistry(input.db);
  const policy = createArtifactAccessPolicy({
    db:input.db,
    readHistory: true,
    requesterUserId: input.requesterUserId,
    accessTokenClaims: input.accessTokenClaims,
  });
  const url = (artifactId: string, variant: "preview" | "content") => {
    const artifact = registry.getActive(artifactId);
    if (artifact === undefined) return undefined;
    if (policy.canCreateSignedUrl(artifact)) {
      const sign = variant === "preview" ? signedArtifactPreviewUrl : signedArtifactContentUrl;
      return sign({artifactId, now: input.now?.() ?? Date.now()});
    }
    // Historical Dashboard links retain cookie authentication at the destination.
    if (input.accessTokenClaims === undefined && policy.canReadMetadata(artifact)) {
      return variant === "preview" ? artifactPreviewPath(artifactId) : artifactContentPath(artifactId);
    }
    return undefined;
  };
  return {
    previewUrl: artifactId => url(artifactId, "preview"),
    contentUrl: artifactId => url(artifactId, "content"),
  };
}

function rewriteDashboardArtifactRefsInValue<T>(
  value: T,
  artifactSigner: DashboardArtifactSigner,
  key?: string,
): T {
  if (typeof value === "string") {
    const artifactId = parseArtifactRef(value);
    if (artifactId !== undefined) {
      const signedUrl = artifactUrlForValueKey(artifactId, key, artifactSigner);
      return (signedUrl ?? value) as T;
    }
    return linkDashboardArtifactReferencesInMarkdown(value, { artifactSigner }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteDashboardArtifactRefsInValue(item, artifactSigner)
    ) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        rewriteDashboardArtifactRefsInValue(item, artifactSigner, childKey),
      ]),
    ) as T;
  }
  return value;
}

function artifactUrlForValueKey(
  artifactId: string,
  key: string | undefined,
  artifactSigner: DashboardArtifactSigner,
): string | undefined {
  const normalized = key?.toLowerCase() ?? "";
  if (
    normalized === "url" ||
    normalized === "src" ||
    normalized === "imageurl" ||
    normalized === "image_url"
  ) {
    return artifactSigner.contentUrl(artifactId);
  }
  return artifactSigner.previewUrl(artifactId);
}
