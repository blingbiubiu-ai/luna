import {TaskScopeResolver} from "@/agents/task-scope";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { managedArtifacts } from "@/data/schema";
import { config, uuid } from "@/shared";
import { inferMimeType } from "@luna/service-client/mime";

export { inferMimeType } from "@luna/service-client/mime";

export type ManagedArtifactRow = typeof managedArtifacts.$inferSelect;

export interface RegisterArtifactInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly relatedUserId?: string;
  readonly producer: string;
  readonly kind: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly path: string;
  readonly retentionPolicy?: string;
  readonly retentionExpiresAt?: number;
  readonly attribution?: ArtifactAttributionInput;
}

export interface RegisterArtifactContentInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly relatedUserId?: string;
  readonly producer: string;
  readonly kind: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly content: Uint8Array;
  readonly retentionPolicy?: string;
  readonly retentionExpiresAt?: number;
  readonly attribution?: ArtifactAttributionInput;
}

export interface ArtifactAttributionInput {
  readonly pluginId?: string;
  readonly operationId?: string;
  readonly invocationId?: string;
  readonly source?: string;
  readonly subjectId?: string;
  readonly messageId?: string;
}

export interface ArtifactDescriptor {
  readonly id: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly producer: string;
  readonly kind: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly retention: string;
  readonly downloadUrl: string;
}

export class ArtifactRegistry {
  constructor(private readonly _db: DrizzleDB) {}

  registerLocalFile(input: RegisterArtifactInput): ManagedArtifactRow {
    new TaskScopeResolver(this._db).owner(input.scopeType, input.scopeId);
    const source = localFileDescriptor(input.path);
    return this._registerStoredArtifact({
      ...input,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      writeStorage: (storageKey) => {
        if (input.path !== storageKey || !existsSync(storageKey)) {
          copyFileSync(input.path, storageKey);
        }
      },
    });
  }

  registerContent(input: RegisterArtifactContentInput): ManagedArtifactRow {
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    return this._registerStoredArtifact({
      ...input,
      sizeBytes: input.content.byteLength,
      sha256,
      writeStorage: (storageKey) => writeFileSync(storageKey, input.content),
    });
  }

  private _registerStoredArtifact(input: {
    readonly scopeType: string;
    readonly scopeId: string;
    readonly relatedUserId?: string;
    readonly producer: string;
    readonly kind: string;
    readonly name: string;
    readonly mimeType?: string;
    readonly retentionPolicy?: string;
    readonly retentionExpiresAt?: number;
    readonly attribution?: ArtifactAttributionInput;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly writeStorage: (storageKey: string) => void;
  }): ManagedArtifactRow {
    const scope = new TaskScopeResolver(this._db).owner(input.scopeType, input.scopeId);
    const storageKey = managedArtifactStorageKey({
      ...scope,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      sha256: input.sha256,
      name: input.name,
    });
    const existing = this._db
      .select()
      .from(managedArtifacts)
      .where(
        and(
          eq(managedArtifacts.storage_backend, "local"),
          eq(managedArtifacts.storage_key, storageKey),
          eq(managedArtifacts.scope_type, input.scopeType),
          eq(managedArtifacts.scope_id, input.scopeId),
          eq(managedArtifacts.status, "active"),
        ),
      )
      .get();
    if (existing !== undefined) {
      return existing;
    }
    mkdirSync(dirname(storageKey), { recursive: true });
    input.writeStorage(storageKey);
    const row = {
      id: uuid(),
      agent_id: scope.agentId,
      shadow_id: scope.shadowId,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      related_user_id: input.relatedUserId ?? null,
      producer: input.producer,
      kind: input.kind,
      name: input.name,
      mime_type: input.mimeType ?? inferMimeType(input.name),
      size_bytes: input.sizeBytes,
      sha256: input.sha256,
      storage_backend: "local",
      storage_key: storageKey,
      plugin_id: input.attribution?.pluginId ?? null,
      operation_id: input.attribution?.operationId ?? null,
      invocation_id: input.attribution?.invocationId ?? null,
      invocation_source: input.attribution?.source ?? null,
      invocation_subject_id: input.attribution?.subjectId ?? null,
      message_id: input.attribution?.messageId ?? null,
      status: "active",
      retention_policy: input.retentionPolicy ?? "task",
      retention_expires_at: input.retentionExpiresAt ?? null,
      created_at: Date.now(),
      deleted_at: null,
    } satisfies ManagedArtifactRow;
    this._db.insert(managedArtifacts).values(row).run();
    return row;
  }

  get(id: string): ManagedArtifactRow | undefined {
    return this._db
      .select()
      .from(managedArtifacts)
      .where(eq(managedArtifacts.id, id))
      .get();
  }

  getActive(id: string): ManagedArtifactRow | undefined {
    return this._db
      .select()
      .from(managedArtifacts)
      .where(and(eq(managedArtifacts.id, id), eq(managedArtifacts.status, "active")))
      .get();
  }

  describe(
    row: ManagedArtifactRow,
    options: { readonly downloadUrl?: string } = {},
  ): ArtifactDescriptor {
    return {
      id: row.id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      producer: row.producer,
      kind: row.kind,
      name: row.name,
      mimeType: row.mime_type ?? inferMimeType(row.name),
      sizeBytes: row.size_bytes,
      createdAt: new Date(row.created_at).toISOString(),
      retention: row.retention_policy,
      downloadUrl: options.downloadUrl ?? `/api/artifacts/${row.id}/content`,
    };
  }
}

export function artifactFile(row: ManagedArtifactRow): Bun.BunFile {
  if (row.storage_backend !== "local") {
    throw new Error(`Unsupported artifact backend: ${row.storage_backend}`);
  }
  return Bun.file(row.storage_key);
}

function localFileDescriptor(path: string): {
  readonly sizeBytes: number;
  readonly sha256: string;
} {
  if (!existsSync(path)) {
    throw new Error(`Artifact source file not found: ${path}`);
  }
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new Error(`Artifact source is not a file: ${path}`);
  }
  return {
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function managedArtifactStorageKey(input: {
  readonly agentId: string;
  readonly shadowId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly sha256: string;
  readonly name: string;
}): string {
  return join(
    config.paths.artifacts,
    "agents", safePathSegment(input.agentId),
    "shadows", safePathSegment(input.shadowId),
    input.scopeType,
    createHash("sha256").update(input.scopeId).digest("hex"),
    `${input.sha256}-${safeFileName(input.name)}`,
  );
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

function safeFileName(value: string): string {
  const name = value.split(/[\\/]/).pop() ?? "artifact";
  return safePathSegment(name);
}
