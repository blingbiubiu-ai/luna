import { existsSync } from "node:fs";

import { and, asc, eq } from "drizzle-orm";

import { ArtifactRegistry, inferMimeType } from "@/artifacts/artifact-registry";
import { artifacts } from "@/data/schema";
import { tasks } from "@/data/schema";
import type { DrizzleDB } from "@/data";
import { uuid } from "@/shared";

/**
 * Persisted row type for timeline and artifact persistence records.
 */
export type ArtifactRow = typeof artifacts.$inferSelect;
/**
 * Allowed status values for timeline and artifact persistence.
 */
export type ArtifactStatus = "active" | "archived" | "pruned";

/**
 * Input contract for and artifact persistence create artifact operations in timeline.
 */
export interface CreateArtifactInput {
  readonly taskId: string;
  readonly type: string;
  readonly name: string;
  readonly path?: string;
  readonly mimeType?: string;
  readonly status?: ArtifactStatus;
  readonly content?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Persists and reads Artifact Store records for timeline and artifact persistence.
 */
export class ArtifactStore {
  constructor(private readonly _db: DrizzleDB) {}

  create(input: CreateArtifactInput): ArtifactRow {
    const managedArtifactId = this._managedArtifactIdForInput(input);
    const metadata = {
      ...(input.metadata ?? {}),
      ...(managedArtifactId === undefined ? {} : { managedArtifactId }),
    };
    const row = {
      id: uuid(),
      task_id: input.taskId,
      timeline_event_id: null,
      type: input.type,
      name: input.name,
      mime_type: input.mimeType ?? null,
      path: input.path ?? null,
      content: input.content ?? null,
      metadata: Object.keys(metadata).length === 0 ? null : metadata,
      status: input.status ?? "active",
      retention_expires_at: null,
      created_at: Date.now(),
    } satisfies ArtifactRow;
    this._db.insert(artifacts).values(row).run();
    return row;
  }

  private _managedArtifactIdForInput(
    input: CreateArtifactInput,
  ): string | undefined {
    if (input.metadata?.managedArtifactId !== undefined) {
      return typeof input.metadata.managedArtifactId === "string"
        ? input.metadata.managedArtifactId
        : undefined;
    }
    if (input.path === undefined || !existsSync(input.path)) {
      return undefined;
    }
    const taskRow = this._db
      .select({ creatorUserId: tasks.creator_user_id })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .get();
    const artifact = new ArtifactRegistry(this._db).registerLocalFile({
      scopeType: "task",
      scopeId: input.taskId,
      ...(taskRow?.creatorUserId === null ||
      taskRow?.creatorUserId === undefined
        ? {}
        : { relatedUserId: taskRow.creatorUserId }),
      producer: "runner",
      kind: input.type,
      name: input.name,
      mimeType: input.mimeType ?? inferMimeType(input.name),
      path: input.path,
    });
    return artifact.id;
  }

  listByTask(taskId: string): ArtifactRow[] {
    return this._db
      .select()
      .from(artifacts)
      .where(eq(artifacts.task_id, taskId))
      .orderBy(asc(artifacts.created_at))
      .all();
  }

  markRawLogArtifactsPruned(input: {
    readonly taskId: string;
    readonly keepFinalReport: boolean;
  }): number {
    const rawLogArtifacts = this._activeArtifactsByTask(input.taskId).filter(
      (artifact) => _isPrunableRawLogArtifact(artifact, input.keepFinalReport),
    );

    for (const artifact of rawLogArtifacts) {
      this._db
        .update(artifacts)
        .set({ status: "pruned", path: null, content: null })
        .where(eq(artifacts.id, artifact.id))
        .run();
    }

    return rawLogArtifacts.length;
  }

  private _activeArtifactsByTask(taskId: string): ArtifactRow[] {
    return this._db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.task_id, taskId), eq(artifacts.status, "active")))
      .orderBy(asc(artifacts.created_at))
      .all();
  }
}

function _isPrunableRawLogArtifact(
  artifact: ArtifactRow,
  keepFinalReport: boolean,
): boolean {
  const name = artifact.name.toLowerCase();
  const type = artifact.type.toLowerCase();

  if (name === "diff.patch" || type === "diff_patch") {
    return false;
  }
  if (
    keepFinalReport &&
    (name === "final-report.md" || type === "final_report")
  ) {
    return false;
  }

  return (
    type.includes("stdout") ||
    type.includes("stderr") ||
    type.includes("event") ||
    type.includes("log") ||
    type.includes("jsonl") ||
    name.includes("stdout") ||
    name.includes("stderr") ||
    name.includes("event") ||
    name.endsWith(".log") ||
    name.endsWith(".jsonl")
  );
}
