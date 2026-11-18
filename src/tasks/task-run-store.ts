import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { taskRuns } from "@/data/schema";
import { createId } from "@/shared";

export type TaskRunStatus = "running" | "completed" | "cancelled" | "failed";
export type TaskRunReason = "initial" | "restart";

export interface TaskRun {
  readonly id: string;
  readonly taskId: string;
  readonly runIndex: number;
  readonly status: TaskRunStatus;
  readonly reason: TaskRunReason;
  readonly inputSnapshot: unknown;
  readonly materializedPrompt: string | null;
  readonly runnerType: string;
  readonly runnerContextId: string | null;
  readonly sourceMessageId: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly cancelReason: string | null;
  readonly error: string | null;
  readonly finalReportArtifactId: string | null;
}

export interface CreateTaskRunInput {
  readonly id?: string;
  readonly taskId: string;
  readonly reason: TaskRunReason;
  readonly inputSnapshot: unknown;
  readonly contextPackIds?: readonly string[];
  readonly runnerType: string;
  readonly runnerContextId?: string;
  readonly sourceMessageId?: string;
  readonly startedAt?: number;
}

export interface CompleteTaskRunInput {
  readonly finishedAt?: number;
  readonly finalReportArtifactId: string;
}

export interface CancelTaskRunInput {
  readonly finishedAt?: number;
  readonly cancelReason?: string;
}

export interface FailTaskRunInput {
  readonly finishedAt?: number;
  readonly error?: string;
}

export class TaskRunActiveRunError extends Error {
  constructor(readonly taskId: string) {
    super(`Task "${taskId}" already has an active Task Run.`);
    this.name = "TaskRunActiveRunError";
  }
}

export class TaskRunTerminalTransitionError extends Error {
  constructor(
    readonly id: string,
    readonly currentStatus: TaskRunStatus,
    readonly targetStatus: Exclude<TaskRunStatus, "running">,
  ) {
    super(
      `Task Run "${id}" cannot transition from ${currentStatus} to ${targetStatus}.`,
    );
    this.name = "TaskRunTerminalTransitionError";
  }
}

/**
 * Persists and reads Task Run lifecycle records for explicit Task execution.
 */
export class TaskRunStore {
  constructor(private readonly _db: DrizzleDB) {}

  createRun(input: CreateTaskRunInput): TaskRun {
    return this._db.transaction((tx) => {
      const active = tx
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.task_id, input.taskId),
            eq(taskRuns.status, "running"),
          ),
        )
        .get();
      if (active) {
        throw new TaskRunActiveRunError(input.taskId);
      }

      const latest = tx
        .select({ runIndex: taskRuns.run_index })
        .from(taskRuns)
        .where(eq(taskRuns.task_id, input.taskId))
        .orderBy(desc(taskRuns.run_index))
        .limit(1)
        .get();
      const now = input.startedAt ?? Date.now();
      const row: typeof taskRuns.$inferInsert = {
        id: input.id ?? createId("task_run"),
        task_id: input.taskId,
        run_index: (latest?.runIndex ?? 0) + 1,
        status: "running",
        reason: input.reason,
        input_snapshot: _inputSnapshotWithContextPackIds(
          input.inputSnapshot,
          input.contextPackIds,
        ),
        materialized_prompt: null,
        runner_type: input.runnerType,
        runner_context_id: input.runnerContextId ?? null,
        source_message_id: input.sourceMessageId ?? null,
        started_at: now,
        finished_at: null,
        cancel_reason: null,
        error: null,
        final_report_artifact_id: null,
      };

      tx.insert(taskRuns).values(row).run();
      return _toTaskRun(row as typeof taskRuns.$inferSelect);
    });
  }

  listRunsForTask(taskId: string): TaskRun[] {
    return this._db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.task_id, taskId))
      .orderBy(taskRuns.run_index)
      .all()
      .map(_toTaskRun);
  }

  getActiveRunForTask(taskId: string): TaskRun | undefined {
    const row = this._db
      .select()
      .from(taskRuns)
      .where(and(eq(taskRuns.task_id, taskId), eq(taskRuns.status, "running")))
      .get();
    return row ? _toTaskRun(row) : undefined;
  }

  getRunForOperation(input: { readonly taskId: string; readonly operationId: string; readonly reason: TaskRunReason }): TaskRun | undefined {
    const row = this._db.select().from(taskRuns)
      .where(and(eq(taskRuns.task_id, input.taskId), eq(taskRuns.reason, input.reason),
        sql`json_extract(${taskRuns.input_snapshot}, '$.operationId') = ${input.operationId}`))
      .orderBy(desc(taskRuns.run_index)).limit(1).get();
    return row ? _toTaskRun(row) : undefined;
  }

  getRunForTaskSourceMessage(input: {
    readonly taskId: string;
    readonly sourceMessageId: string;
    readonly reason?: TaskRunReason;
  }): TaskRun | undefined {
    const predicates = [
      eq(taskRuns.task_id, input.taskId),
      eq(taskRuns.source_message_id, input.sourceMessageId),
    ];
    if (input.reason !== undefined) {
      predicates.push(eq(taskRuns.reason, input.reason));
    }

    const row = this._db
      .select()
      .from(taskRuns)
      .where(and(...predicates))
      .orderBy(desc(taskRuns.run_index))
      .limit(1)
      .get();
    return row ? _toTaskRun(row) : undefined;
  }

  markCompleted(id: string, input: CompleteTaskRunInput): TaskRun {
    if (
      typeof input.finalReportArtifactId !== "string" ||
      input.finalReportArtifactId.trim() === ""
    ) {
      throw new Error(
        `Task Run "${id}" requires a final report artifact before it can complete.`,
      );
    }
    return this._markTerminal(id, "completed", {
      status: "completed",
      finished_at: input.finishedAt ?? Date.now(),
      cancel_reason: null,
      error: null,
      final_report_artifact_id: input.finalReportArtifactId,
    });
  }

  markCancelled(id: string, input: CancelTaskRunInput = {}): TaskRun {
    return this._markTerminal(id, "cancelled", {
      status: "cancelled",
      finished_at: input.finishedAt ?? Date.now(),
      cancel_reason: input.cancelReason ?? null,
      error: null,
      final_report_artifact_id: null,
    });
  }

  markFailed(id: string, input: FailTaskRunInput = {}): TaskRun {
    return this._markTerminal(id, "failed", {
      status: "failed",
      finished_at: input.finishedAt ?? Date.now(),
      cancel_reason: null,
      error: input.error ?? null,
      final_report_artifact_id: null,
    });
  }

  markRunningRunsFailedForRecovery(input: FailTaskRunInput & { readonly excludeRunIds?: readonly string[] } = {}): TaskRun[] {
    return this._db.transaction((tx) => {
      const running = tx
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .where(eq(taskRuns.status, "running"))
        .all().filter(run => !input.excludeRunIds?.includes(run.id));
      if (running.length === 0) {
        return [];
      }

      const ids = running.map((run) => run.id);
      tx.update(taskRuns)
        .set({
          status: "failed",
          finished_at: input.finishedAt ?? Date.now(),
          cancel_reason: null,
          error:
            input.error ?? "Runtime recovered an interrupted running Task Run.",
          final_report_artifact_id: null,
        })
        .where(and(inArray(taskRuns.id, ids), eq(taskRuns.status, "running")))
        .run();
      return tx
        .select()
        .from(taskRuns)
        .where(and(inArray(taskRuns.id, ids), eq(taskRuns.status, "failed")))
        .all()
        .map(_toTaskRun);
    });
  }

  private _markTerminal(
    id: string,
    targetStatus: Exclude<TaskRunStatus, "running">,
    values: Partial<typeof taskRuns.$inferInsert>,
  ): TaskRun {
    return this._db.transaction((tx) => {
      const current = tx
        .select({ status: taskRuns.status })
        .from(taskRuns)
        .where(eq(taskRuns.id, id))
        .get();
      if (!current) {
        throw new Error(`Task Run "${id}" was not found.`);
      }
      const currentStatus = current.status as TaskRunStatus;
      if (currentStatus !== "running") {
        throw new TaskRunTerminalTransitionError(
          id,
          currentStatus,
          targetStatus,
        );
      }

      tx.update(taskRuns)
        .set(values)
        .where(and(eq(taskRuns.id, id), eq(taskRuns.status, "running")))
        .run();
      const updated = tx
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.id, id))
        .get();
      if (!updated) {
        throw new Error(`Task Run "${id}" was not found.`);
      }
      return _toTaskRun(updated);
    });
  }
}

function _toTaskRun(row: typeof taskRuns.$inferSelect): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    runIndex: row.run_index,
    status: row.status as TaskRunStatus,
    reason: row.reason as TaskRunReason,
    inputSnapshot: row.input_snapshot,
    materializedPrompt: row.materialized_prompt,
    runnerType: row.runner_type,
    runnerContextId: row.runner_context_id,
    sourceMessageId: row.source_message_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelReason: row.cancel_reason,
    error: row.error,
    finalReportArtifactId: row.final_report_artifact_id,
  };
}

function _inputSnapshotWithContextPackIds(
  inputSnapshot: unknown,
  contextPackIds: readonly string[] | undefined,
): unknown {
  if (contextPackIds === undefined) {
    return inputSnapshot;
  }
  if (_isRecord(inputSnapshot)) {
    return {
      ...inputSnapshot,
      contextPackIds: [...contextPackIds],
    };
  }
  return {
    rawInputSnapshot: inputSnapshot,
    contextPackIds: [...contextPackIds],
  };
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
