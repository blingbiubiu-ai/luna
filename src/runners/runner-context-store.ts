import {TaskScopeResolver} from "@/agents/task-scope";
import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { runnerContexts, runnerContextOrigins } from "@/data/schema";
import { config, uuid } from "@/shared";
import {
  createSessionRunnerPaths,
  createTaskRunnerPaths,
  deriveRunnerPaths,
  type RunnerPaths,
} from "@/shared/runner-paths";
import { isPathContainedByRunnerRootBase } from "@/shared/runner-root-base";
import { ensureRunnerRootLayout } from "./runner-root-layout";
import { ExecutionError } from "@luna/execution-store";
import type { ExecutionRuntime } from "@/runtime/execution-runtime";

export {
  createSessionRunnerPaths,
  createTaskRunnerPaths,
} from "@/shared/runner-paths";

/**
 * Persisted row type for runner execution records.
 */
export type RunnerContextRow = typeof runnerContexts.$inferSelect;
export type ResolvedRunnerContext = Omit<
  RunnerContextRow,
  "provider_fingerprint" | "model_fingerprint"
> &
  Partial<Pick<RunnerContextRow, "provider_fingerprint" | "model_fingerprint">> &
  Omit<RunnerPaths, "runnerRootPath">;

export class RunnerRootError extends Error {
  readonly code = "runner_root_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "RunnerRootError";
  }
}

// A Service database is bound when its Runtime transport is created.
const runtimes = new WeakMap<DrizzleDB, Pick<ExecutionRuntime, "runtimeId" | "preparedContext">>();

export function bindRunnerContextsToRuntime(db: DrizzleDB, runtime: string | Pick<ExecutionRuntime, "runtimeId" | "preparedContext">): void {
  runtimes.set(db, typeof runtime === "string" ? {runtimeId: runtime} : runtime);
}

export function runnerContextRuntime(db: DrizzleDB) { return runtimes.get(db); }

export function assertStoredRunnerRoots(db: DrizzleDB): void {
  const rows = db.select({ id: runnerContexts.id, runner_root_path: runnerContexts.runner_root_path })
    .from(runnerContexts)
    .innerJoin(runnerContextOrigins, eq(runnerContextOrigins.contextId, runnerContexts.id))
    .all();
  for (const row of rows) {
    assertRunnerRootContained(row.runner_root_path, row.id);
  }
}

export interface SyncInstructionFingerprintResult {
  readonly runnerContext: ResolvedRunnerContext;
  readonly runnerSessionInvalidated: boolean;
}

export interface SyncAgentCompatibilityResult {
  readonly runnerContext: ResolvedRunnerContext;
  readonly providerChanged: boolean;
  readonly modelChanged: boolean;
  readonly runnerSessionInvalidated: boolean;
}

/**
 * Persists and reads Runner Context Store records for runner execution.
 */
export class RunnerContextStore {
  constructor(private readonly _db: DrizzleDB) {}

  resolveForSession(
    sessionId: string,
    runnerType: string,
  ): ResolvedRunnerContext {
    return this._resolve({
      ownerType: "session",
      ownerId: sessionId,
      runnerType,
      paths: createSessionRunnerPaths(sessionId),
    });
  }

  resolveForTask(
    taskId: string,
    runnerType: string,
  ): ResolvedRunnerContext {
    return this._resolve({
      ownerType: "task",
      ownerId: taskId,
      runnerType,
      paths: createTaskRunnerPaths(taskId),
    });
  }

  getById(runnerContextId: string): ResolvedRunnerContext | undefined {
    const row = this._db
      .select()
      .from(runnerContexts)
      .where(eq(runnerContexts.id, runnerContextId))
      .get();
    return row === undefined ? undefined : withDerivedPaths(row);
  }


  clearRunnerSessionIdByScopeKey(
    scopeKey: string,
  ): void {
    // scopeKey format: "session:<runnerContextId>" or "task:<taskId>:<runnerType>".
    const parts = scopeKey.split(":");
    if (parts.length < 2) return;
    const kind = parts[0];
    const id = parts[1];
    const runnerType = parts.slice(2).join(":");
    if (id === undefined) return;
    if (kind === "task") {
      if (parts.length < 3 || runnerType.length === 0) return;
      this._db
        .update(runnerContexts)
        .set({
          runner_session_id: null,
          updated_at: Date.now(),
        })
        .where(
          and(
            eq(runnerContexts.owner_type, "task"),
            eq(runnerContexts.owner_id, id),
            eq(runnerContexts.runner_type, runnerType),
          ),
        )
        .run();
      return;
    }
    if (kind !== "session" || parts.length !== 2) return;
    const runnerContextId = id;
    this._db
      .update(runnerContexts)
      .set({
        runner_session_id: null,
        updated_at: Date.now(),
      })
      .where(eq(runnerContexts.id, runnerContextId))
      .run();
  }

  clearRunnerSessionId(
    runnerContextId: string,
  ): void {
    this._db
      .update(runnerContexts)
      .set({
        runner_session_id: null,
        updated_at: Date.now(),
      })
      .where(eq(runnerContexts.id, runnerContextId))
      .run();
  }

  persistRunnerSessionId(
    runnerContextId: string,
    runnerSessionId: string,
  ): void {
    this._db
      .update(runnerContexts)
      .set({
        runner_session_id: runnerSessionId,
        updated_at: Date.now(),
      })
      .where(eq(runnerContexts.id, runnerContextId))
      .run();
  }

  /**
   * Records the context's session fingerprint and starts a fresh provider session when it changed.
   * The fingerprint covers the Shadow scope (with placement generation) and the Worker
   * (`context-preparation.ts`).
   */
  syncInstructionFingerprint(
    runnerContextId: string,
    instructionFingerprint: string,
  ): SyncInstructionFingerprintResult {
    const existing = this._db
      .select()
      .from(runnerContexts)
      .where(eq(runnerContexts.id, runnerContextId))
      .get();
    if (existing === undefined) {
      throw new Error(`Runner context "${runnerContextId}" was not found.`);
    }
    if (existing.instruction_fingerprint === instructionFingerprint) {
      return {
        runnerContext: withDerivedPaths(existing),
        runnerSessionInvalidated: false,
      };
    }

    this._db
      .update(runnerContexts)
      .set({
        instruction_fingerprint: instructionFingerprint,
        runner_session_id: null,
        updated_at: Date.now(),
      })
      .where(eq(runnerContexts.id, runnerContextId))
      .run();

    const updated = this._db
      .select()
      .from(runnerContexts)
      .where(eq(runnerContexts.id, runnerContextId))
      .get();
    if (updated === undefined) {
      throw new Error(`Runner context "${runnerContextId}" was not found after fingerprint sync.`);
    }
    return {
      runnerContext: withDerivedPaths(updated),
      runnerSessionInvalidated: existing.runner_session_id !== null,
    };
  }

  syncAgentCompatibility(
    runnerContextId: string,
    input: {
      readonly providerFingerprint: string;
      readonly modelFingerprint: string;
      readonly resumeOnModelChange: boolean;
    },
  ): SyncAgentCompatibilityResult {
    const existing = this._db.select().from(runnerContexts)
      .where(eq(runnerContexts.id, runnerContextId)).get();
    if (existing === undefined) {
      throw new Error(`Runner context "${runnerContextId}" was not found.`);
    }
    const providerChanged = existing.provider_fingerprint !== input.providerFingerprint;
    const modelChanged = existing.model_fingerprint !== input.modelFingerprint;
    const invalidate = providerChanged || (modelChanged && !input.resumeOnModelChange);
    if (providerChanged || modelChanged) {
      this._db.update(runnerContexts).set({
        provider_fingerprint: input.providerFingerprint,
        model_fingerprint: input.modelFingerprint,
        ...(invalidate ? { runner_session_id: null } : {}),
        updated_at: Date.now(),
      }).where(eq(runnerContexts.id, runnerContextId)).run();
    }
    const updated = this._db.select().from(runnerContexts)
      .where(eq(runnerContexts.id, runnerContextId)).get()!;
    return {
      runnerContext: withDerivedPaths(updated),
      providerChanged,
      modelChanged,
      runnerSessionInvalidated: invalidate && existing.runner_session_id !== null,
    };
  }

  private _resolve(input: {
    readonly ownerType: string;
    readonly ownerId: string;
    readonly runnerType: string;
    readonly paths: RunnerPaths;
  }): ResolvedRunnerContext {
    const scope = new TaskScopeResolver(this._db).owner(input.ownerType, input.ownerId);
    const row = this._find(input);

    if (row) {
      assertRunnerRootContained(row.runner_root_path, row.id);
      const resolved = withDerivedPaths(this._ensureRuntimeOrigin(row));
      if (!runtimes.has(this._db)) ensureRunnerRootLayout({
        runnerRootPath: row.runner_root_path,
        workspacePath: resolved.workspacePath,
      });
      return resolved;
    }

    const { runnerRootPath, workspacePath } = input.paths;
    assertRunnerRootContained(runnerRootPath);
    this._assertRootOwner(input, runnerRootPath);
    if (!runtimes.has(this._db)) ensureRunnerRootLayout({
      runnerRootPath,
      workspacePath,
    });

    const now = Date.now();
    const runnerContext = {
      id: uuid(),
      agent_id: scope.agentId,
      shadow_id: scope.shadowId,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      runner_type: input.runnerType,
      runner_session_id: null,
      instruction_fingerprint: null,
      provider_fingerprint: null,
      model_fingerprint: null,
      runner_root_path: runnerRootPath,
      last_run_id: null,
      created_at: now,
      updated_at: now,
    } satisfies RunnerContextRow;

    const runtimeId = runtimes.get(this._db)?.runtimeId;
    try {
      this._db.transaction(tx => {
        tx.insert(runnerContexts).values(runnerContext).run();
        if (runtimeId) {
          const siblings = tx.select({ context: runnerContexts, origin: runnerContextOrigins }).from(runnerContexts)
            .leftJoin(runnerContextOrigins, eq(runnerContexts.id, runnerContextOrigins.contextId))
            .where(eq(runnerContexts.runner_root_path, runnerRootPath)).all();
          // Existing local files do not require resuming the old provider session.
          const peers = siblings.filter(row => row.context.id !== runnerContext.id);
          if (peers.some(row => row.origin && row.origin.runtimeId !== runtimeId)) {
            throw new ExecutionError(409, "context_runtime_mismatch");
          }
          tx.insert(runnerContextOrigins).values({ contextId: runnerContext.id, runtimeId }).run();
        }
      });
    } catch (err) {
      const existing = this._find(input);
      if (existing) {
        return withDerivedPaths(this._ensureRuntimeOrigin(existing));
      }
      throw err;
    }
    return withDerivedPaths(runnerContext);
  }

  /** Like a provider/model reset, keep the owner and files but start a fresh CLI session. */
  private _ensureRuntimeOrigin(row: RunnerContextRow): RunnerContextRow {
    const runtimeId = runtimes.get(this._db)?.runtimeId;
    if (!runtimeId) return row;
    return this._db.transaction(tx => {
      const origin = tx.select().from(runnerContextOrigins)
        .where(eq(runnerContextOrigins.contextId, row.id)).get();
      if (origin) {
        if (origin.runtimeId !== runtimeId) throw new ExecutionError(409, "context_runtime_mismatch", { contextId: row.id });
        return tx.select().from(runnerContexts).where(eq(runnerContexts.id, row.id)).get()!;
      }
      const peers = tx.select({ runtimeId: runnerContextOrigins.runtimeId }).from(runnerContexts)
        .innerJoin(runnerContextOrigins, eq(runnerContexts.id, runnerContextOrigins.contextId))
        .where(eq(runnerContexts.runner_root_path, row.runner_root_path)).all();
      if (peers.some(peer => peer.runtimeId !== runtimeId)) throw new ExecutionError(409, "context_runtime_mismatch", { contextId: row.id });
      tx.update(runnerContexts).set({ runner_session_id: null, last_run_id: null, updated_at: Date.now() })
        .where(eq(runnerContexts.id, row.id)).run();
      tx.insert(runnerContextOrigins).values({ contextId: row.id, runtimeId }).run();
      return tx.select().from(runnerContexts).where(eq(runnerContexts.id, row.id)).get()!;
    });
  }

  private _find(input: {
    readonly ownerType: string;
    readonly ownerId: string;
    readonly runnerType: string;
  }): RunnerContextRow | undefined {
    return this._db
      .select()
      .from(runnerContexts)
      .where(
        and(
          eq(runnerContexts.owner_type, input.ownerType),
          eq(runnerContexts.owner_id, input.ownerId),
          eq(runnerContexts.runner_type, input.runnerType),
        ),
      )
      .get();
  }

  private _assertRootOwner(
    input: { readonly ownerType: string; readonly ownerId: string },
    runnerRootPath: string,
  ): void {
    const rows = this._db
      .select()
      .from(runnerContexts)
      .where(eq(runnerContexts.runner_root_path, runnerRootPath))
      .all();
    const conflicting = rows.find(
      (row) =>
        row.owner_type !== input.ownerType || row.owner_id !== input.ownerId,
    );
    if (conflicting !== undefined) {
      throw new RunnerRootError(
        `Runner root "${runnerRootPath}" belongs to a different owner ` +
          `(${conflicting.owner_type}:${conflicting.owner_id}).`,
      );
    }
  }
}

function withDerivedPaths(row: RunnerContextRow): ResolvedRunnerContext {
  assertRunnerRootContained(row.runner_root_path, row.id);
  const { workspacePath, ipcPath } = deriveRunnerPaths(row.runner_root_path);
  return { ...row, workspacePath, ipcPath };
}

function assertRunnerRootContained(path: string, contextId?: string): void {
  if (!isPathContainedByRunnerRootBase(path)) {
    throw new RunnerRootError(
      `Runner root "${path}"${contextId ? ` for context "${contextId}"` : ""} ` +
        "is outside the configured runner root base.",
    );
  }
}
