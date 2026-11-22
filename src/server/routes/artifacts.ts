import {AgentError} from "@/agents/agent-store";
import {ResourceRouteAccess} from "../policy/resource-route-access";
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { managedArtifacts } from "@/data/schema";
import {
  ArtifactRegistry,
  artifactFile,
  type RegisterArtifactContentInput,
  type RegisterArtifactInput,
} from "@/artifacts/artifact-registry";
import {
  artifactContentPath,
  artifactPreviewPath,
  signedArtifactContentUrl,
  signedArtifactPreviewUrl,
  verifyArtifactContentSignature,
} from "../artifact-content-url";

import {
  requesterAccountIdFromContext,
  lunaAccessTokenClaimsFromContext,
} from "../auth";
import { createArtifactAccessPolicy, runnerArtifactScope } from "../artifact-access-policy";
import { RunnerArtifactGrantStore } from "../auth/runner-artifact-grant-store";
import { runnerActorUserId } from "../auth/access-token-service";
import { resolveArtifactSignedUrlTtlMs } from "@/platform/platform-settings-store";
import { getKernel } from "./kernel";

export interface ArtifactsRouteOptions {
  readonly db?: DrizzleDB;
  readonly now?: () => number;
  readonly signedUrlTtlMs?: number;
}

type ArtifactRecord = NonNullable<ReturnType<ArtifactRegistry["getActive"]>>;
type ArtifactRenderMode =
  | "markdown"
  | "html"
  | "json"
  | "text"
  | "image"
  | "pdf"
  | "binary";

export function createArtifactsRoutes(options: ArtifactsRouteOptions = {}) {
  const getDb = () => options.db ?? getKernel().database.db;
  const now = () => options.now?.() ?? Date.now();
  const signedUrlTtlMs = () =>
    options.signedUrlTtlMs ?? resolveArtifactSignedUrlTtlMs(getDb());
  const artifactDownloadUrl = (artifactId: string) =>
    signedArtifactContentUrl({
      artifactId,
      now: now(),
      ttlMs: signedUrlTtlMs(),
    });
  const artifactPreviewUrl = (artifactId: string) =>
    signedArtifactPreviewUrl({
      artifactId,
      now: now(),
      ttlMs: signedUrlTtlMs(),
    });

  return new Hono()
    .onError((error,c)=>{if(error instanceof AgentError)return c.json({code:error.code},error.status);throw error;})
    .post("/", async (c) => {
      const claims = lunaAccessTokenClaimsFromContext(c);
      if (claims?.source !== "mcp" && claims?.source !== "runner") {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      const parsed = parseCreateArtifactInput(await c.req.json().catch(() => null));
      const input = parsed === null
        ? null
        : createArtifactInputForClaims(parsed, claims);
      if (input === null) {
        return c.json(
          {
            status: "error",
            code: "invalid_request",
            message: "invalid artifact registration request",
          },
          400,
        );
      }
      const db = getDb();
      const registry = new ArtifactRegistry(db);
      if (input === "forbidden") {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      if(input.input.scopeType!=="session"&&input.input.scopeType!=="task")return c.json({code:"artifact_scope_required"},400);
      new ResourceRouteAccess(db).require(c,input.input.scopeType,input.input.scopeId);
      const artifact = input.source === "content"
        ? registry.registerContent(input.input)
        : registry.registerLocalFile(input.input);
      if (claims.source === "runner" && claims.role === "runner") {
        new RunnerArtifactGrantStore(db).grant(claims.tokenId, [artifact.id]);
      }
      return c.json(
        {
          status: "ok",
          artifact: registry.describe(artifact, claims.source === "runner" ? {} : {
            downloadUrl: artifactDownloadUrl(artifact.id),
          }),
        },
        201,
      );
    })
    .get("/:id", (c) => {
      const registry = new ArtifactRegistry(getDb());
      const artifact = registry.getActive(c.req.param("id"));
      if (artifact === undefined) {
        return c.notFound();
      }
      const policy = artifactAccessPolicyForContext(c, getDb());
      if (!policy.canReadMetadata(artifact)) {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      return c.json({
        status: "ok",
        artifact: registry.describe(artifact, policy.canCreateSignedUrl(artifact) ? {
          downloadUrl: artifactDownloadUrl(artifact.id),
        } : {}),
      });
    })
    .post("/:id/signed-url", (c) => {
      const registry = new ArtifactRegistry(getDb());
      const artifact = registry.getActive(c.req.param("id"));
      if (artifact === undefined) {
        return c.notFound();
      }
      const policy = artifactAccessPolicyForContext(c, getDb());
      if (!policy.canCreateSignedUrl(artifact)) {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      return c.json({
        status: "ok",
        artifact: {
          id: artifact.id,
          downloadUrl: artifactDownloadUrl(artifact.id),
        },
      });
    })
    .get("/:id/content", async (c) => {
      const registry = new ArtifactRegistry(getDb());
      const artifactId = c.req.param("id");
      const artifact = registry.getActive(artifactId);
      const signedAccess = verifyArtifactContentSignature({
        artifactId,
        expires: c.req.query("expires") ?? null,
        sig: c.req.query("sig") ?? null,
        now: now(),
      });
      if (artifact === undefined) {
        return c.notFound();
      }
      const policy = artifactAccessPolicyForContext(c, getDb());
      if (!policy.canReadContent(artifact, { hasValidSignature: signedAccess })) {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      const file = artifactFile(artifact);
      if (!(await file.exists())) {
        return c.notFound();
      }
      const contentType = (artifact.mime_type ?? file.type) ||
        "application/octet-stream";
      return new Response(file, {
        headers: artifactContentHeaders({
          mimeType: contentType,
          filename: artifact.name,
        }),
      });
    })
    .get("/:id/preview", async (c) => {
      const registry = new ArtifactRegistry(getDb());
      const artifactId = c.req.param("id");
      const artifact = registry.getActive(artifactId);
      const signedAccess = verifyArtifactContentSignature({
        artifactId,
        expires: c.req.query("expires") ?? null,
        sig: c.req.query("sig") ?? null,
        now: now(),
      });
      if (artifact === undefined) {
        return c.notFound();
      }
      const policy = artifactAccessPolicyForContext(c, getDb());
      if (!policy.canReadContent(artifact, { hasValidSignature: signedAccess })) {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      const file = artifactFile(artifact);
      if (!(await file.exists())) {
        return c.notFound();
      }
      const contentType = (artifact.mime_type ?? file.type) ||
        "application/octet-stream";
      const renderMode = artifactRenderMode(contentType);
      const runner = lunaAccessTokenClaimsFromContext(c)?.source === "runner";
      const downloadUrl = (row: ArtifactRecord) => signedAccess || policy.canCreateSignedUrl(row)
        ? artifactDownloadUrl(row.id) : artifactContentPath(row.id);
      const text = shouldIncludePreviewContent(renderMode) ? await file.text() : undefined;
      const content = text !== undefined && !runner
        ? rewritePreviewArtifactRefs({
          text,
          mimeType: contentType,
          artifact,
          registry,
          resolveUrl: (referenced, purpose) => {
            const signed = signedAccess || policy.canCreateSignedUrl(referenced);
            if (!signed && !policy.canReadMetadata(referenced)) return undefined;
            if (purpose === "content") return signed ? artifactDownloadUrl(referenced.id) : artifactContentPath(referenced.id);
            return signed ? artifactPreviewUrl(referenced.id) : artifactPreviewPath(referenced.id);
          },
        })
        : text;
      return c.json({
        status: "ok",
        artifact: {
          id: artifact.id,
          name: artifact.name,
          kind: artifact.kind,
          mimeType: contentType,
          renderMode,
          downloadUrl: downloadUrl(artifact),
          ...(content === undefined ? {} : { content }),
        },
      });
    })
    .delete("/:id", (c) => {
      const db = getDb();
      const registry = new ArtifactRegistry(db);
      const artifact = registry.getActive(c.req.param("id"));
      if (artifact === undefined) {
        return c.notFound();
      }
      const policy = artifactAccessPolicyForContext(c, db);
      if (!policy.canDelete(artifact)) {
        return c.json(
          {
            status: "error",
            code: "forbidden",
            message: "artifact access denied",
          },
          403,
        );
      }
      db.update(managedArtifacts)
        .set({ status: "deleted", deleted_at: Date.now() })
        .where(eq(managedArtifacts.id, artifact.id))
        .run();
      return c.json({
        status: "ok",
        artifact: registry.describe(artifact, {
          downloadUrl: artifactDownloadUrl(artifact.id),
        }),
      });
    });
}

export const artifactsRoutes = createArtifactsRoutes();

function artifactRenderMode(mimeType: string): ArtifactRenderMode {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "text/markdown") return "markdown";
  if (normalized === "text/html" || normalized === "application/xhtml+xml") {
    return "html";
  }
  if (normalized === "application/json") return "json";
  if (normalized.startsWith("text/")) return "text";
  if (normalized.startsWith("image/")) return "image";
  if (normalized === "application/pdf") return "pdf";
  return "binary";
}

function shouldIncludePreviewContent(renderMode: ArtifactRenderMode): boolean {
  return renderMode === "markdown" ||
    renderMode === "html" ||
    renderMode === "json" ||
    renderMode === "text";
}

function artifactContentHeaders(input: {
  readonly mimeType: string;
  readonly filename: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": artifactContentType(input.mimeType),
    "content-disposition": artifactContentDisposition(input),
    "x-content-type-options": "nosniff",
  };
  if (isHtmlArtifactMime(input.mimeType)) {
    headers["content-security-policy"] =
      "sandbox; default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline'";
  }
  return headers;
}

function rewritePreviewArtifactRefs(input: {
  readonly text: string;
  readonly mimeType: string;
  readonly artifact: ArtifactRecord;
  readonly registry: ArtifactRegistry;
  readonly resolveUrl: (artifact: ArtifactRecord, purpose: "content" | "preview") => string | undefined;
}): string {
  const resolveUrl = (
    artifactId: string,
    purpose: "content" | "preview",
  ) => {
    const referenced = input.registry.getActive(artifactId);
    if (referenced === undefined) {
      return undefined;
    }
    if (!canReferencePreviewArtifact(input.artifact, referenced)) {
      return undefined;
    }
    return input.resolveUrl(referenced, purpose);
  };
  if (isMarkdownArtifactMime(input.mimeType)) {
    return rewriteMarkdownArtifactRefs(input.text, resolveUrl);
  }
  if (isHtmlLikeArtifactMime(input.mimeType)) {
    return rewriteHtmlArtifactRefs(input.text, resolveUrl);
  }
  return rewriteBareArtifactRefs(input.text, resolveUrl);
}

function canReferencePreviewArtifact(
  source: ArtifactRecord,
  referenced: ArtifactRecord,
): boolean {
  if (source.agent_id !== referenced.agent_id || source.shadow_id !== referenced.shadow_id) return false;
  if (source.id === referenced.id) {
    return true;
  }
  if (
    source.scope_type === referenced.scope_type &&
    source.scope_id === referenced.scope_id
  ) {
    return true;
  }
  return source.related_user_id !== null &&
    source.related_user_id === referenced.related_user_id;
}

function rewriteMarkdownArtifactRefs(
  text: string,
  resolveUrl: (
    artifactId: string,
    purpose: "content" | "preview",
  ) => string | undefined,
): string {
  const replacements: string[] = [];
  const placeholder = (value: string) => {
    const index = replacements.push(value) - 1;
    return `__LUNA_ARTIFACT_PREVIEW_REF_${index}__`;
  };
  const linked = text
    .replace(
      /!\[([^\]]*)\]\(artifact:([A-Za-z0-9._:-]+)\)/g,
      (match, alt: string, artifactId: string) => {
        const href = resolveUrl(artifactId, "content");
        return href === undefined ? match : placeholder(`![${alt}](${href})`);
      },
    )
    .replace(
      /\[([^\]]+)\]\(artifact:([A-Za-z0-9._:-]+)\)/g,
      (match, label: string, artifactId: string) => {
        const href = resolveUrl(artifactId, "preview");
        return href === undefined ? match : placeholder(`[${label}](${href})`);
      },
    )
    .replace(/`artifact:([A-Za-z0-9._:-]+)`/g, (match, artifactId: string) => {
      const href = resolveUrl(artifactId, "preview");
      return href === undefined
        ? match
        : placeholder(`[artifact:${artifactId}](${href})`);
    })
    .replace(
      /(^|[^\w:/])artifact:([A-Za-z0-9._:-]+)/g,
      (match, prefix: string, artifactId: string) => {
        const href = resolveUrl(artifactId, "preview");
        return href === undefined
          ? match
          : `${prefix}${placeholder(`[artifact:${artifactId}](${href})`)}`;
      },
    );
  return linked.replace(
    /__LUNA_ARTIFACT_PREVIEW_REF_(\d+)__/g,
    (match, index: string) => replacements[Number(index)] ?? match,
  );
}

function rewriteHtmlArtifactRefs(
  text: string,
  resolveUrl: (
    artifactId: string,
    purpose: "content" | "preview",
  ) => string | undefined,
): string {
  return text.replace(
    /\b(src|href)=(["'])artifact:([A-Za-z0-9._:-]+)\2/gi,
    (match, attribute: string, quote: string, artifactId: string) => {
      const href = resolveUrl(
        artifactId,
        attribute.toLowerCase() === "src" ? "content" : "preview",
      );
      return href === undefined ? match : `${attribute}=${quote}${href}${quote}`;
    },
  );
}

function rewriteBareArtifactRefs(
  text: string,
  resolveUrl: (
    artifactId: string,
    purpose: "content" | "preview",
  ) => string | undefined,
): string {
  return text.replace(/artifact:([A-Za-z0-9._:-]+)/g, (match, artifactId: string) =>
    resolveUrl(artifactId, "preview") ?? match
  );
}

function artifactContentType(mimeType: string): string {
  if (mimeTypeHasCharset(mimeType) || !isUtf8TextArtifactMime(mimeType)) {
    return mimeType;
  }
  return `${mimeType}; charset=utf-8`;
}

function mimeTypeHasCharset(mimeType: string): boolean {
  return mimeType
    .split(";")
    .slice(1)
    .some((part) => part.trim().toLowerCase().startsWith("charset="));
}

function isUtf8TextArtifactMime(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/xhtml+xml" ||
    normalized === "application/javascript";
}

function artifactContentDisposition(input: {
  readonly mimeType: string;
  readonly filename: string;
}): string {
  const disposition = isBrowserPreviewableArtifactMime(input.mimeType)
    ? "inline"
    : "attachment";
  return `${disposition}; filename="${input.filename.replace(/"/g, "")}"`;
}

function isBrowserPreviewableArtifactMime(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") ||
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/pdf" ||
    normalized === "application/xml" ||
    normalized === "application/xhtml+xml" ||
    normalized === "application/javascript";
}

function isHtmlArtifactMime(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized === "text/html" || normalized === "application/xhtml+xml";
}

function isHtmlLikeArtifactMime(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized === "text/html" || normalized === "application/xhtml+xml";
}

function isMarkdownArtifactMime(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized === "text/markdown";
}

type ParsedCreateArtifactInput =
  | { readonly source: "path"; readonly input: RegisterArtifactInput }
  | { readonly source: "content"; readonly input: RegisterArtifactContentInput };

function parseCreateArtifactInput(
  value: unknown,
): ParsedCreateArtifactInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const contentBase64 = stringField(record.contentBase64);
  const required = {
    scopeType: stringField(record.scopeType),
    scopeId: stringField(record.scopeId),
    producer: stringField(record.producer),
    kind: stringField(record.kind),
    name: stringField(record.name),
    path: stringField(record.path),
  };
  if (
    required.scopeType === undefined ||
    required.scopeId === undefined ||
    required.producer === undefined ||
    required.kind === undefined ||
    required.name === undefined
  ) {
    return null;
  }
  const common = {
    scopeType: required.scopeType,
    scopeId: required.scopeId,
    producer: required.producer,
    kind: required.kind,
    name: required.name,
    ...optionalString("relatedUserId", record.relatedUserId),
    ...optionalString("mimeType", record.mimeType),
    ...optionalString("retentionPolicy", record.retentionPolicy),
    ...optionalNumber("retentionExpiresAt", record.retentionExpiresAt),
  };
  if (contentBase64 !== undefined) {
    return {
      source: "content",
      input: {
        ...common,
        content: Buffer.from(contentBase64, "base64"),
      },
    };
  }
  if (required.path === undefined) {
    return null;
  }
  return {
    source: "path",
    input: {
      ...common,
      path: required.path,
    },
  };
}

function createArtifactInputForClaims(
  parsed: ParsedCreateArtifactInput,
  claims: NonNullable<ReturnType<typeof lunaAccessTokenClaimsFromContext>>,
): ParsedCreateArtifactInput | "forbidden" {
  if (claims.source === "mcp") {
    return parsed;
  }
  if (claims.source !== "runner" || parsed.source !== "content") {
    return "forbidden";
  }
  const scope = runnerArtifactScope(claims);
  if (
    scope === undefined ||
    parsed.input.scopeType !== scope.scopeType ||
    parsed.input.scopeId !== scope.scopeId ||
    parsed.input.producer !== "runner"
  ) {
    return "forbidden";
  }
  return {
    source: "content",
    input: {
      ...parsed.input,
      relatedUserId: runnerActorUserId(claims),
      producer: "runner",
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalString<TKey extends string>(
  key: TKey,
  value: unknown,
): Record<TKey, string> | Record<string, never> {
  const parsed = stringField(value);
  return parsed === undefined ? {} : { [key]: parsed } as Record<TKey, string>;
}

function optionalNumber<TKey extends string>(
  key: TKey,
  value: unknown,
): Record<TKey, number> | Record<string, never> {
  return typeof value === "number" && Number.isFinite(value)
    ? { [key]: value } as Record<TKey, number>
    : {};
}

function artifactAccessPolicyForContext(c: Context, db: DrizzleDB) {
  const claims = lunaAccessTokenClaimsFromContext(c);
  return createArtifactAccessPolicy({
    db,
    readHistory: true,
    requesterAccountId: requesterAccountIdFromContext(c),
    accessTokenClaims: claims,
    runArtifactAllowlist: claims === undefined
      ? []
      : new RunnerArtifactGrantStore(db).list(claims.tokenId),
  });
}
