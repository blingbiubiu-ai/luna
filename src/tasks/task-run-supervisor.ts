import type { NativeProgressEntry } from "@/channels/outbound";

import type { TaskStatusCardStepEvent } from "@/messaging/notifications/task-status-card-updater";
import { InvocationService } from "@/runners/invocation-service";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { InvocationStore } from "@/runners/invocation-store";
import { taskReportForRun } from "./task-report-store";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionError } from "@luna/execution-store";
import { asc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { messages, sessionTimelineEntries, tasks } from "@/data/schema";
import { ContextPackStore } from "@/context";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import {
  RunnerContextStore,
  type ResolvedRunnerContext,
} from "@/runners/runner-context-store";
import { TimelineStore } from "@/timeline/timeline-store";
import {
  buildTaskResultForMainRunner,
  executeTaskRun,
  type ExecuteTaskRunInput,
  type ExecuteTaskRunResult,
} from "@/kernel/task-run-handler";
import { createLogger } from "@/shared";

import {
  TaskRunStore,
  type TaskRun,
} from "./task-run-store";
import type { TaskStatus } from "./types";

/**
 * Configuration options for Task Run Supervisor behavior.
 */
export interface TaskRunSupervisorOptions {
  readonly db: DrizzleDB;
  readonly runnerType: string;
  readonly resolveRunnerType?: (taskId: string, taskRunId?:string) => string;
  readonly onTaskResult?: (
    result: TaskResultForMainRunner,
  ) => Promise<void> | void;
  readonly executeRun?: (
    input: ExecuteTaskRunInput,
  ) => Promise<ExecuteTaskRunResult>;
  readonly runNotifications?: TaskRunNotificationLifecycle;
}

export interface TaskRunNotificationLifecycle {
  readonly onRunCreated?: (input: {
    readonly taskId: string;
    readonly taskRunId: string;
    readonly sourceMessageId?: string;
    readonly reason: "initial" | "restart";
  }) => Promise<void> | void;
  readonly onRunCancelled?: (input: {
    readonly taskRunId: string;
    readonly cancelledByRunId?: string;
    readonly reason: string;
  }) => Promise<void> | void;
  readonly onRunCompleted?: (input: {
    readonly taskRunId: string;
    readonly result: TaskResultForMainRunner;
  }) => Promise<void> | void;
  readonly onRunProgress?: (input: {
    readonly taskRunId: string;
    readonly events?: readonly TaskStatusCardStepEvent[];
    readonly nativeProgress?: readonly NativeProgressEntry[];
  }) => Promise<void> | void;
  readonly onRunFailed?: (input: {
    readonly taskRunId: string;
    readonly error: string;
  }) => Promise<void> | void;
}

/**
 * Input contract for starting an initial Task Run.
 */
export interface StartInitialTaskRunInput {
  readonly taskId: string;
  readonly inputSnapshot: unknown;
  readonly sourceMessageId?: string;
  /** The Main command that started this run; a replay of it returns the same run. */
  readonly operationId?: string;
}

/**
 * Input contract for cancelling an obsolete active Task Run and restarting with updated context.
 */
export interface RestartTaskRunInput {
  readonly preserveTaskContext?: boolean;
  readonly taskId: string;
  readonly updatedTaskTitle?: string;
  readonly updatedTaskSummary: string;
  readonly updateSummary: string;
  readonly inputSnapshot: unknown;
  readonly assumptions?: readonly string[];
  readonly sourceMessageId?: string;
  /** The Main command behind this run; one message may carry several commands. */
  readonly operationId?: string;
  readonly cancelReason?: string;
}

const logger = createLogger("task-run-supervisor");

/**
 * Owns explicit Task Run initial lifecycle without inserting old task rows.
 */
export class TaskRunSupervisor {
  private readonly _taskRuns: TaskRunStore;
  private readonly _contexts: RunnerContextStore;
  private readonly _contextPacks: ContextPackStore;
  private readonly _timeline: TimelineStore;
  private readonly _trackedRuns = new Set<Promise<void>>();
  private readonly _controllers = new Map<string, AbortController>();

  constructor(private readonly _options: TaskRunSupervisorOptions) {
    this._taskRuns = new TaskRunStore(_options.db);
    this._contexts = new RunnerContextStore(_options.db);
    this._contextPacks = new ContextPackStore(_options.db);
    this._timeline = new TimelineStore(_options.db);
  }

  startInitialRun(input: StartInitialTaskRunInput): TaskRun {
    const duplicateRun = this._existingRunForSource(input.taskId, "initial", input);
    if (duplicateRun !== undefined) {
      return duplicateRun;
    }

    const runnerType = this._runnerType(input.taskId);
    const runnerContext = this._contexts.resolveForTask(input.taskId, runnerType);
    return this._launchRun({...input, reason: "initial", runnerType, runnerContext});
  }

  restartTaskRun(input: RestartTaskRunInput): TaskRun {
    const duplicateRun = this._existingRunForSource(input.taskId, "restart", input);
    if (duplicateRun !== undefined) {
      return duplicateRun;
    }

    const runnerType = this._runnerType(input.taskId);
    const runnerContext = this._options.db.transaction(() => {
      this._ensureTaskUpdateContextPack(input);
      if (!input.preserveTaskContext) this._appendContextUpdatedEvent(input);
      return this._contexts.resolveForTask(input.taskId, runnerType);
    });

    const activeRun = this._taskRuns.getActiveRunForTask(input.taskId);
    const cancelReason = input.cancelReason ?? "Task Run superseded by restart.";
    const cancelledRun = activeRun === undefined ? undefined
      : this._cancelRun(activeRun, cancelReason, run => `Cancelled obsolete Task Run ${run.runIndex}.`);

    if (!input.preserveTaskContext) this._updateTaskContext({
      taskId: input.taskId,
      ...(input.updatedTaskTitle !== undefined
        ? { updatedTaskTitle: input.updatedTaskTitle }
        : {}),
      updatedTaskSummary: input.updatedTaskSummary,
      updateSummary: input.updateSummary,
      ...(input.assumptions !== undefined
        ? { assumptions: [...input.assumptions] }
        : {}),
    });

    return this._launchRun({...input, reason: "restart", runnerType, runnerContext,
      beforeCreatedNotification: run => {
        if (cancelledRun !== undefined) this._track(this._notifyRunCancelled(cancelledRun, run, cancelReason));
      }});
  }

  /** Shared tail of initial and restart runs: persist, mark the Task running, notify, execute. */
  private _launchRun(input: {
    readonly taskId: string;
    readonly reason: "initial" | "restart";
    readonly inputSnapshot: unknown;
    readonly sourceMessageId?: string;
    readonly runnerType: string;
    readonly runnerContext: ResolvedRunnerContext;
    readonly beforeCreatedNotification?: (run: TaskRun) => void;
  }): TaskRun {
    const contextPackIds = this._contextPackIdsForRun(input.taskId, input.reason);
    const run = this._taskRuns.createRun({
      taskId: input.taskId,
      reason: input.reason,
      inputSnapshot: input.inputSnapshot,
      ...(contextPackIds.length > 0 ? { contextPackIds } : {}),
      runnerType: input.runnerType,
      runnerContextId: input.runnerContext.id,
      // A command's run is identified by the command (input snapshot); one message may carry several.
      ...(input.sourceMessageId !== undefined && !_hasOperationId(input.inputSnapshot) ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    const controller = new AbortController();
    this._controllers.set(run.id, controller);

    _updateTaskStatus(this._options.db, input.taskId, "running");
    input.beforeCreatedNotification?.(run);
    this._track(this._notifyRunCreated(run));
    this._track(this._executeRun({
      run,
      runnerContext: input.runnerContext,
      inputSnapshot: run.inputSnapshot,
      signal: controller.signal,
    }));
    return run;
  }

  /** Cancel this exact run; no replacement execution and no Main result invocation. */
  cancelTaskRun(input: { taskId: string; runId: string; reason: string }): TaskRun | undefined {
    let run = this._taskRuns.listRunsForTask(input.taskId).find(run => run.id === input.runId);
    if (!run || !["running", "cancelled"].includes(run.status)) return run;
    if (run.status === "running") run = this._cancelRun(run, input.reason, () => input.reason, "cancelled");
    this._track(this._notifyRunCancelled(run, undefined, run.cancelReason ?? input.reason));
    return run;
  }

  /**
   * The single cancellation rule shared by explicit cancel and restart
   * supersession: run state, optional task status, invocation/token authority
   * and timeline commit together, and only then is the local process aborted.
   */
  private _cancelRun(run: TaskRun, reason: string, summary: (run: TaskRun) => string, taskStatus?: TaskStatus): TaskRun {
    const cancelled = this._options.db.transaction(() => {
      const cancelled = this._taskRuns.markCancelled(run.id, {cancelReason: reason});
      if (taskStatus) _updateTaskStatus(this._options.db, run.taskId, taskStatus);
      const authority = new InvocationService(this._options.db);
      for (const invocation of authority.store.pending().filter(item => item.taskRunId === run.id))
        authority.revoke(invocation.id, reason);
      this._timeline.append({taskId: run.taskId, type: "runner.cancelled", summary: summary(cancelled),
        data: {..._runMetadata(cancelled), cancelReason: reason}});
      return cancelled;
    });
    this._controllers.get(run.id)?.abort(reason);
    return cancelled;
  }

  async waitForIdle(): Promise<void> {
    while (this._trackedRuns.size > 0) {
      await Promise.all([...this._trackedRuns]);
    }
  }

  async abortAndWait(reason = "Runtime is stopping."): Promise<void> {
    for (const controller of this._controllers.values()) {
      controller.abort(reason);
    }
    await this.waitForIdle();
  }

  async recoverRunningRuns(): Promise<number> {
    const recoveryReason =
      "Runtime recovered an interrupted running Task Run.";
    let reported = 0;
    const resumeIds = new Set<string>();
    for (const invocation of new InvocationStore(this._options.db).pending()) {
      if (invocation.runnerKind !== "task" || !invocation.taskRunId || !invocation.taskId) continue;
      const run = this._taskRuns.getActiveRunForTask(invocation.taskId);
      if (run?.id !== invocation.taskRunId) continue;
      resumeIds.add(run.id);
      if (invocation.state !== "active") {
        // Revoked after its report was submitted: complete it with the report once the Job is drained.
        const report = taskReportForRun(this._options.db, run.id);
        if (report && !this._controllers.has(run.id)) {
          const controller = new AbortController();
          this._controllers.set(run.id, controller);
          this._track(this._completeAfterReport(run, report.reportArtifactId, controller.signal)
            .finally(() => this._controllers.delete(run.id)));
        }
        continue;
      }
      const runnerContext = this._contexts.getById(invocation.runnerContextId);
      if (!runnerContext) throw new Error(`Runtime Task context ${invocation.runnerContextId} is missing`);
      if (this._controllers.has(run.id)) continue;
      const controller = new AbortController();
      this._controllers.set(run.id, controller);
      this._track(this._executeRun({ run, runnerContext, inputSnapshot: run.inputSnapshot, signal: controller.signal }));
    }
    for (const task of this._options.db.select().from(tasks).all()) {
      const run = this._taskRuns.getActiveRunForTask(task.id);
      const report = run && taskReportForRun(this._options.db, run.id);
      if (run && report && !resumeIds.has(run.id)) { await this._completeRun(run, report.reportArtifactId); reported++; }
    }
    const recoveredRuns = this._taskRuns.markRunningRunsFailedForRecovery({
      error: recoveryReason,
      excludeRunIds: [...resumeIds],
    });
    for (const run of recoveredRuns) {
      const visibleFailure =
        "Task runner interrupted by runtime recovery. The Task failed instead of being rerun automatically.";
      this._timeline.append({
        taskId: run.taskId,
        type: "runner.failed",
        summary: "Task runner interrupted by runtime recovery.",
        data: {
          ..._runMetadata(run),
          recoveryReason,
          recoveredFrom: "runtime_startup",
        },
      });

      const taskRow = this._options.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, run.taskId))
        .get();
      if (!taskRow) {
        continue;
      }

      _updateTaskStatus(this._options.db, run.taskId, "failed");
      const failureResult = buildTaskResultForMainRunner(
        this._options.db,
        run.taskId,
        "failed",
        {
          failureMessage: visibleFailure,
          taskRunId: run.id,
          runIndex: run.runIndex,
        },
      );
      await this._notifyRunFailed(run, visibleFailure);
      await this._notifyTaskResult(() => failureResult);
    }
    return recoveredRuns.length + reported;
  }

  private async _executeRun(input: {
    readonly run: TaskRun;
    readonly runnerContext: ResolvedRunnerContext;
    readonly inputSnapshot: unknown;
    readonly signal: AbortSignal;
  }): Promise<void> {
    try {
      const runnerType = this._runnerType(input.run.taskId,input.run.id);
      const runnerContext = input.runnerContext.runner_type === runnerType
        ? input.runnerContext
        : this._contexts.resolveForTask(input.run.taskId, runnerType);
      const result = await this._executeTaskRun({
        db: this._options.db,
        taskRunId: input.run.id,
        taskId: input.run.taskId,
        reason: input.run.reason,
        inputSnapshot: input.inputSnapshot,
        runnerType,
        runnerContext,
        runIndex: input.run.runIndex,
        ...(input.run.sourceMessageId !== null
          ? { sourceMessageId: input.run.sourceMessageId }
          : {}),
        signal: input.signal,
        onProgress: (events, nativeProgress) => this._notifyRunProgress(input.run, events, nativeProgress),
      });

      if (input.signal.aborted || !this._isActiveRun(input.run)) {
        await this._notifyExternalCancellation(input.run, input.signal);
        return;
      }
      if (result.finalReportArtifactId === undefined) {
        throw new Error(
          "Task runner completed without a final report artifact.",
        );
      }

      await this._completeRun(input.run, result.finalReportArtifactId);
    } catch (err) {
      if (err instanceof RuntimeDetachedError) return;
      if (input.signal.aborted || !this._isActiveRun(input.run)) {
        await this._notifyExternalCancellation(input.run, input.signal);
        return;
      }
      const acceptedReport = taskReportForRun(this._options.db, input.run.id);
      if (acceptedReport) {
        logger.warn({err, task_run_id: input.run.id}, "Task execution ended after report acceptance; preserving submitted result");
        this._timeline.append({taskId: input.run.taskId, type: "runner.completion_warning", summary: "Runner exit did not follow the completion protocol; submitted report retained", data: {..._runMetadata(input.run), error: String(err)}});
        await this._completeAfterReport(input.run, acceptedReport.reportArtifactId, input.signal);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, task_id: input.run.taskId, task_run_id: input.run.id },
        "Task Run failed",
      );
      this._timeline.append({
        taskId: input.run.taskId,
        type: "runner.failed",
        summary: `Task runner failed: ${_failureHeadline(message)}`,
        data: {
          ..._runMetadata(input.run),
          error: message,
        },
      });
      let failedRun!: TaskRun;
      this._settleRun(input.run, () => {
        failedRun = this._taskRuns.markFailed(input.run.id, { error: message });
        _updateTaskStatus(this._options.db, input.run.taskId, "failed");
      });
      const failureResult = buildTaskResultForMainRunner(
        this._options.db,
        input.run.taskId,
        "failed",
        {
          failureMessage: `Task runner failed: ${_failureHeadline(message)}`,
          taskRunId: input.run.id,
          runIndex: input.run.runIndex,
        },
      );
      await this._notifyRunFailed(failedRun, message);
      await this._notifyTaskResult(() => failureResult);
    } finally {
      this._controllers.delete(input.run.id);
      if (!this._isActiveRun(input.run)) {
        const ledger = new InvocationStore(this._options.db);
        for (const invocation of ledger.pending().filter(item => item.taskRunId === input.run.id && item.state === "revoked")) {
          if (ledger.jobsFor(invocation.id).every(job => ["terminal", "settled"].includes(job.state))) ledger.finish(invocation.id);
        }
      }
    }
  }

  private async _completeRun(run: TaskRun, finalReportArtifactId: string): Promise<void> {
      let completedRun!: TaskRun;
      this._settleRun(run, () => {
        completedRun = this._taskRuns.markCompleted(run.id, {
        finalReportArtifactId: finalReportArtifactId,
        });
        _updateTaskStatus(this._options.db, run.taskId, "completed");
      });
      const completedResult = buildTaskResultForMainRunner(
        this._options.db,
        run.taskId,
        "completed",
        {
          taskRunId: completedRun.id,
          runIndex: completedRun.runIndex,
          ...(completedRun.finalReportArtifactId !== null
            ? {
                finalReportArtifactId: completedRun.finalReportArtifactId,
              }
            : {}),
        },
      );
      await this._notifyRunCompleted(completedRun, completedResult);
      await this._notifyTaskResult(() => completedResult);
  }

  /**
   * Supervisor-owned cancellations (restart, explicit cancel, shutdown) always
   * abort the signal and publish their own card update. A run cancelled while
   * the signal is still live was settled by another authority, such as the
   * JobReconciler revoking an invocation whose actor or session became
   * unavailable; close its status card instead of leaving it "running".
   */
  private async _notifyExternalCancellation(run: TaskRun, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const current = this._taskRuns.listRunsForTask(run.taskId).find(item => item.id === run.id);
    if (current?.status !== "cancelled") return;
    await this._notifyRunCancelled(current, undefined, current.cancelReason ?? "Task Run cancelled.");
  }

  /**
   * A submitted report finishes the run even when Service lost track of its Job: the Job is
   * cancelled and drained to terminal by the invocation recovery pump, then the run completes.
   * Until then the run stays running, so it is never settled while its Job may still execute.
   */
  private async _completeAfterReport(run: TaskRun, reportArtifactId: string, signal: AbortSignal): Promise<void> {
    for (let revoked = false; ; ) {
      try {
        await this._completeRun(run, reportArtifactId);
        return;
      } catch (err) {
        if (!(err instanceof ExecutionError) || err.code !== "invocation_jobs_active") throw err;
      }
      if (!revoked) {
        const authority = new InvocationService(this._options.db);
        for (const invocation of authority.store.pending().filter(item => item.taskRunId === run.id && item.state === "active"))
          authority.revoke(invocation.id, "task_report_submitted");
        logger.warn({task_run_id: run.id}, "Task report submitted while its Job is unfinished; cancelling the Job before completing");
        revoked = true;
      }
      if (signal.aborted) return;
      await delay(1000, undefined, {signal}).catch(() => {});
    }
  }

  private _settleRun(run: TaskRun, complete: () => void): void {
    new InvocationStore(this._options.db).finishOrigin({ originId: run.id, runnerKind: "task" }, complete);
  }

  private _runnerType(taskId: string, taskRunId?:string): string {
    return this._options.resolveRunnerType?.(taskId,taskRunId) ?? this._options.runnerType;
  }

  private _track(run: Promise<void>): void {
    this._trackedRuns.add(run);
    void run.finally(() => {
      this._trackedRuns.delete(run);
    });
  }

  private async _notifyRunCreated(run: TaskRun): Promise<void> {
    try {
      await this._options.runNotifications?.onRunCreated?.({
        taskId: run.taskId,
        taskRunId: run.id,
        ...(run.sourceMessageId !== null
          ? { sourceMessageId: run.sourceMessageId }
          : {}),
        reason: run.reason,
      });
    } catch (err) {
      logger.warn(
        { err, task_id: run.taskId, task_run_id: run.id },
        "failed to create Task Run status card",
      );
    }
  }

  private async _notifyRunCancelled(
    run: TaskRun,
    cancelledByRun: TaskRun | undefined,
    reason: string,
  ): Promise<void> {
    try {
      await this._options.runNotifications?.onRunCancelled?.({
        taskRunId: run.id,
        ...(cancelledByRun ? {cancelledByRunId: cancelledByRun.id} : {}),
        reason,
      });
    } catch (err) {
      logger.warn(
        { err, task_id: run.taskId, task_run_id: run.id },
        "failed to cancel Task Run status card",
      );
    }
  }

  private async _notifyRunCompleted(
    run: TaskRun,
    result: TaskResultForMainRunner,
  ): Promise<void> {
    try {
      await this._options.runNotifications?.onRunCompleted?.({
        taskRunId: run.id,
        result,
      });
    } catch (err) {
      logger.warn(
        { err, task_id: run.taskId, task_run_id: run.id },
        "failed to complete Task Run status card",
      );
    }
  }

  private async _notifyRunProgress(run: TaskRun, events?: readonly TaskStatusCardStepEvent[], nativeProgress?: readonly NativeProgressEntry[]): Promise<void> {
    try {
      await this._options.runNotifications?.onRunProgress?.({
        taskRunId: run.id,
        ...(events ? { events } : {}),
        ...(nativeProgress ? { nativeProgress } : {}),
      });
    } catch (err) {
      logger.warn(
        { err, task_id: run.taskId, task_run_id: run.id },
        "failed to update Task Run status card progress",
      );
    }
  }

  private async _notifyRunFailed(
    run: TaskRun,
    error: string,
  ): Promise<void> {
    try {
      await this._options.runNotifications?.onRunFailed?.({
        taskRunId: run.id,
        error,
      });
    } catch (err) {
      logger.warn(
        { err, task_id: run.taskId, task_run_id: run.id },
        "failed to fail Task Run status card",
      );
    }
  }

  private _isActiveRun(run: TaskRun): boolean {
    return this._taskRuns.getActiveRunForTask(run.taskId)?.id === run.id;
  }

  /** A replayed command, or else a replayed source message, returns its existing run instead of starting another. */
  private _existingRunForSource(taskId: string, reason: "initial" | "restart",
    input: { readonly sourceMessageId?: string; readonly operationId?: string }): TaskRun | undefined {
    if (input.operationId !== undefined) return this._taskRuns.getRunForOperation({taskId, operationId: input.operationId, reason});
    return input.sourceMessageId === undefined ? undefined
      : this._taskRuns.getRunForTaskSourceMessage({taskId, sourceMessageId: input.sourceMessageId, reason});
  }

  private _appendContextUpdatedEvent(input: RestartTaskRunInput): void {
    if (
      input.operationId === undefined &&
      input.sourceMessageId !== undefined &&
      this._timeline.hasMessageEvent({
        taskId: input.taskId,
        messageId: input.sourceMessageId,
        type: "context.updated",
      })
    ) {
      return;
    }

    this._timeline.append({
      taskId: input.taskId,
      // A command's event is keyed by the command; one message may carry several.
      ...(input.sourceMessageId !== undefined && input.operationId === undefined
        ? { messageId: input.sourceMessageId }
        : {}),
      type: "context.updated",
      summary: input.updateSummary,
      data: {
        updateSummary: input.updateSummary,
        ...(input.updatedTaskTitle !== undefined
          ? { updatedTaskTitle: input.updatedTaskTitle }
          : {}),
        updatedTaskSummary: input.updatedTaskSummary,
        ...(input.assumptions !== undefined
          ? { assumptions: [...input.assumptions] }
          : {}),
        ...(input.sourceMessageId !== undefined
          ? { sourceMessageId: input.sourceMessageId }
          : {}),
        ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      },
    });
  }

  private _ensureTaskUpdateContextPack(input: RestartTaskRunInput): void {
    const existing = this._contextPacks
      .listPacksForOwner("task", input.taskId)
      .find((pack) => {
        if (pack.kind !== "task_update") {
          return false;
        }
        if (input.operationId !== undefined) {
          return _isRecord(pack.metadataJson) && pack.metadataJson.operationId === input.operationId;
        }
        if (input.sourceMessageId !== undefined) {
          return pack.triggerMessageId === input.sourceMessageId;
        }
        return (
          _isRecord(pack.metadataJson) &&
          pack.metadataJson.updateSummary === input.updateSummary
        );
      });
    const source = input.sourceMessageId === undefined
      ? undefined
      : this._sourceForMessage(input.sourceMessageId);
    const pack = existing ??
      this._contextPacks.createPack({
        ownerType: "task",
        ownerId: input.taskId,
        kind: "task_update",
        selectionStrategy: "task_restart",
        triggerEntryId: source?.entryId ?? null,
        triggerMessageId: input.sourceMessageId ?? null,
        metadataJson: {
          updateSummary: input.updateSummary,
          ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
          ...(input.updatedTaskTitle !== undefined
            ? { updatedTaskTitle: input.updatedTaskTitle }
            : {}),
          updatedTaskSummary: input.updatedTaskSummary,
          ...(input.assumptions !== undefined
            ? { assumptions: [...input.assumptions] }
            : {}),
        },
      });
    this._contextPacks.addItems(pack.id, [
      ...(input.sourceMessageId === undefined
        ? []
        : [
            {
              itemKind: "message",
              itemId: input.sourceMessageId,
              sourceSessionId: source?.sessionId ?? null,
              sourceEntryId: source?.entryId ?? null,
              sourceMessageId: input.sourceMessageId,
              sourceIdentityId: source?.senderIdentityId ?? null,
              role: "source",
              reason: "task update source message",
              metadataJson: null,
            },
          ]),
      {
        itemKind: input.sourceMessageId === undefined ? "fact" : "message",
        itemId:
          input.sourceMessageId ??
          `task_update:${input.taskId}:${_stableHash(input.updateSummary)}`,
        sourceSessionId: source?.sessionId ?? null,
        sourceEntryId: source?.entryId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceIdentityId: source?.senderIdentityId ?? null,
        role: "delta_context",
        reason: "latest restart context",
        metadataJson: {
          text: input.updateSummary,
          ...(input.updatedTaskTitle !== undefined
            ? { updatedTaskTitle: input.updatedTaskTitle }
            : {}),
          updatedTaskSummary: input.updatedTaskSummary,
          ...(input.assumptions !== undefined
            ? { assumptions: [...input.assumptions] }
            : {}),
        },
      },
    ]);
  }

  private _sourceForMessage(messageId: string): {
    readonly sessionId: string;
    readonly entryId: string;
    readonly senderIdentityId: string | null;
  } | undefined {
    return this._options.db
      .select({
        sessionId: sessionTimelineEntries.sessionId,
        entryId: sessionTimelineEntries.id,
        senderIdentityId: messages.senderIdentityId,
      })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
      .where(eq(sessionTimelineEntries.messageId, messageId))
      .orderBy(asc(sessionTimelineEntries.createdAt), asc(sessionTimelineEntries.id))
      .get();
  }

  private async _executeTaskRun(
    input: ExecuteTaskRunInput,
  ): Promise<ExecuteTaskRunResult> {
    return await (this._options.executeRun ?? executeTaskRun)(input);
  }

  private _updateTaskContext(input: {
    readonly taskId: string;
    readonly updatedTaskTitle?: string;
    readonly updatedTaskSummary: string;
    readonly updateSummary: string;
    readonly assumptions?: readonly string[];
  }): void {
    const taskRow = this._options.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .get();
    if (!taskRow) {
      throw new Error(`Task "${input.taskId}" was not found.`);
    }

    const now = Date.now();
    const context = _isRecord(taskRow.context_json) ? taskRow.context_json : {};
    const knownFacts = _appendUniqueString(
      context.knownFacts,
      input.updateSummary,
    );

    // Restart updates should replace launch assumptions with the latest
    // Main Runner premises while preserving the normal context fact history.
    this._options.db
      .update(tasks)
      .set({
        ...(input.updatedTaskTitle !== undefined
          ? { title: input.updatedTaskTitle }
          : {}),
        summary: input.updatedTaskSummary,
        context_json: {
          ...context,
          currentSummary: input.updatedTaskSummary,
          latestUserMessage: input.updateSummary,
          knownFacts,
          ...(input.assumptions !== undefined
            ? { assumptions: [...input.assumptions] }
            : {}),
          pendingQuestions: Array.isArray(context.pendingQuestions)
            ? context.pendingQuestions
            : [],
        },
        updated_at: now,
        last_activity_at: now,
      })
      .where(eq(tasks.id, input.taskId))
      .run();
  }

  private _contextPackIdsForRun(
    taskId: string,
    reason: "initial" | "restart",
  ): string[] {
    const packs = this._contextPacks.listPacksForOwner("task", taskId);
    const ids = packs
      .filter((pack) => pack.kind === "task_launch")
      .map((pack) => pack.id);
    if (reason === "restart") {
      const latestUpdatePack = packs
        .filter((pack) => pack.kind === "task_update")
        .at(-1);
      if (latestUpdatePack !== undefined) {
        ids.push(latestUpdatePack.id);
      }
    }
    return [...new Set(ids)];
  }

  private async _notifyTaskResult(
    buildResult: () => TaskResultForMainRunner,
  ): Promise<void> {
    try {
      await this._options.onTaskResult?.(buildResult());
    } catch (err) {
      logger.warn(
        { err },
        "failed to deliver Task Run Supervisor result event",
      );
    }
  }
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _appendUniqueString(value: unknown, nextValue: string): string[] {
  const existing = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return existing.includes(nextValue) ? existing : [...existing, nextValue];
}

function _updateTaskStatus(
  db: DrizzleDB,
  taskId: string,
  status: TaskStatus,
): void {
  const now = Date.now();
  db.update(tasks)
    // A new run answers whatever the previous report was waiting for.
    .set({ status, ...(status === "running" ? { block_reason: null } : {}), updated_at: now, last_activity_at: now })
    .where(eq(tasks.id, taskId))
    .run();
}

function _runMetadata(run: TaskRun): Record<string, unknown> {
  return {
    taskRunId: run.id,
    runIndex: run.runIndex,
    runReason: run.reason,
    runnerType: run.runnerType,
    ...(run.sourceMessageId !== null
      ? { sourceMessageId: run.sourceMessageId }
      : {}),
  };
}

function _failureHeadline(message: string): string {
  const [firstLine] = message.split(/\n/u);
  return _shorten(firstLine ?? message, 180);
}

function _shorten(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function _stableHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function _hasOperationId(snapshot: unknown): boolean {
  return _isRecord(snapshot) && typeof snapshot.operationId === "string";
}
