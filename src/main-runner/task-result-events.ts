import { taskResultArtifactRefs } from "./task-result-artifacts";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { InvocationStore } from "@/runners/invocation-store";
import { enqueueTaskResult } from "@/tasks/task-result-outbox";
import { taskReportForRun } from "@/tasks/task-report-store";
import { runnerAnswers } from "@/messaging/runner-answer";
import { taskResultMessageOrigin } from "@/runners/main-invocation-registry";
import { sessionDispatcherFor } from "@/sessions/session-dispatcher";
import { runnerOperations, sessionTriggers } from "@/data/schema";
import { createHash } from "node:crypto";

import { and, asc, desc, eq, ne } from "drizzle-orm";

import { artifactizeLocalFileReferencesInValue } from "@/artifacts/local-file-artifactizer";
import type { TaskSubscription } from "@/tasks/types";
import type { TaskRunNotificationService } from "@/tasks/task-run-notification-service";
import type { NormalizedInboundMessage } from "@/channels";
import { lookupChannelSurfaceKind } from "@/channels/directory-store";
import type { DrizzleDB } from "@/data";
import {
  taskRuns,
  taskSubscriptions,
  tasks,
  notificationAttempts,
  timelineEvents,
} from "@/data/schema";
import {
  NotificationAttemptStore,
  type NotificationAttempt,
} from "@/messaging/notifications/notification-attempt-store";
import { RunnerContextStore } from "@/runners/runner-context-store";
import type { ReplyChannel } from "@/channels/outbound";
import { createLogger, uuid } from "@/shared";

import { MainRunnerContextBuilder } from "./context-builder";
import { MainRunnerFreshLaunchReplayRequiredError, type MainRunner } from "./main-runner";
import type {
  TaskResultForMainRunner,
  MainRunnerInput,
  MainRunnerCompletion,
} from "./types";

/**
 * Configuration options for Main Runner task result event publisher behavior in session.
 */
export interface TaskResultEventPublisherOptions {
  readonly db: DrizzleDB;
  readonly runnerType: string;
  readonly resolveRunnerType?: (sessionId: string) => string;
  readonly mainRunner: Pick<MainRunner, "run">;
  readonly channelForSubscription: (
    subscription: TaskSubscription,
  ) => ReplyChannel | undefined;
  readonly taskRunNotifications?: Pick<
    TaskRunNotificationService,
    "onRunCompleted" | "onRunFailed"
  >;
}

const logger = createLogger("task-result-events");

/**
 * Coordinates Task Result Event Publisher responsibilities in session Main Runner.
 */
export class TaskResultEventPublisher {
  private readonly _db: DrizzleDB;
  private readonly _runnerType: (sessionId: string) => string;
  private readonly _mainRunner: Pick<MainRunner, "run">;
  private readonly _channelForSubscription: (
    subscription: TaskSubscription,
  ) => ReplyChannel | undefined;
  private readonly _taskRunNotifications:
    | Pick<TaskRunNotificationService, "onRunCompleted" | "onRunFailed">
    | undefined;
  private readonly _contextBuilder: MainRunnerContextBuilder;
  private readonly _runnerContexts: RunnerContextStore;
  private readonly _attempts: NotificationAttemptStore;

  constructor(options: TaskResultEventPublisherOptions) {
    this._db = options.db;
    this._runnerType = options.resolveRunnerType ?? (() => options.runnerType);
    this._mainRunner = options.mainRunner;
    this._channelForSubscription = options.channelForSubscription;
    this._taskRunNotifications = options.taskRunNotifications;
    this._contextBuilder = new MainRunnerContextBuilder(options.db);
    this._runnerContexts = new RunnerContextStore(options.db);
    this._attempts = new NotificationAttemptStore(options.db);
  }

  async publish(result: TaskResultForMainRunner): Promise<void> {
    if (!this._isValidTaskRunResult(result)) {
      logger.warn(
        { task_id: result.taskId, task_run_id: result.taskRunId },
        "skipping stale Task result delivery",
      );
      return;
    }
    const subscriptions = this._activeStatusCardSubscriptions(result.taskId);
    for (const subscription of subscriptions) this._enqueueTrigger({ result, subscription });
    await this._syncRunTerminalNotification(result);
    if (!this._isLatestTaskRunResult(result)) {
      logger.warn(
        { task_id: result.taskId, task_run_id: result.taskRunId },
        "skipping superseded Task result reply",
      );
      return;
    }
    const deliveries = await Promise.allSettled(subscriptions.map((subscription) =>
      this._publishForSubscription({ result, subscription }),
    ));
    const failures = deliveries.flatMap((delivery) =>
      delivery.status === "rejected" ? [delivery.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Task result publication failed");
  }

  async recoverPending(): Promise<number> {
    let recoveredCount = 0;
    let detached = false;
    const triggers = this._db.select().from(sessionTriggers).all()
      .filter((row) => row.kind === "task_result" && !["completed", "cancelled"].includes(row.status));
    // Reserve each session lane before awaiting any long-running recovered Job.
    await Promise.all(triggers.map(async (trigger) => {
      if (!("result" in trigger.payload)) return;
      const subscription = this._subscriptionById(trigger.payload.subscriptionId);
      if (!subscription) return;
      try {
        await this._publishForSubscription({ result: trigger.payload.result, subscription });
        recoveredCount += 1;
      } catch (err) {
        if (err instanceof RuntimeDetachedError) { detached = true; return; }
        logger.warn({ err, trigger_id: trigger.id }, "Task result trigger recovery failed");
      }
    }));
    if (detached) return recoveredCount;
    const attempts = this._pendingTaskResultAttempts();
    for (const attempt of attempts) {
      const eventRow = this._taskResultEventForAttempt(attempt);
      if (eventRow === undefined) {
        logger.warn(
          {
            attempt_id: attempt.id,
            task_id: attempt.task_id,
            subscription_id: attempt.subscription_id,
          },
          "skipping Task result retry because event payload is unavailable",
        );
        continue;
      }
      const subscription = this._subscriptionById(attempt.subscription_id);
      if (
        subscription === undefined ||
        subscription.task_id !== eventRow.result.taskId ||
        !this._isValidTaskRunResult(eventRow.result) ||
        !this._isLatestTaskRunResult(eventRow.result)
      ) {
        continue;
      }
      try {
        await sessionDispatcherFor(this._db).dispatch(
          { kind: "task_result", sessionId: subscription.session_id },
          () => this._executeForSubscription({ result: eventRow.result, subscription }),
        );
        const latestAttempt = this._attempts.requireById(attempt.id);
        if (latestAttempt.status === "sent") {
          recoveredCount += 1;
        }
      } catch (err) {
        if (err instanceof RuntimeDetachedError) return recoveredCount;
        logger.warn(
          { err, attempt_id: attempt.id, task_id: attempt.task_id },
          "Task result retry failed",
        );
      }
    }
    return recoveredCount;
  }

  private _enqueueTrigger(input: {
    readonly result: TaskResultForMainRunner;
    readonly subscription: TaskSubscription;
  }): string {
    return enqueueTaskResult(this._db, input.result, input.subscription);
  }

  private async _publishForSubscription(input: {
    readonly result: TaskResultForMainRunner;
    readonly subscription: TaskSubscription;
  }): Promise<void> {
    await sessionDispatcherFor(this._db).dispatch({ kind: "task_result", sessionId: input.subscription.session_id }, async () => {
      const dedupeKey = this._enqueueTrigger(input);
      const trigger = this._db.select().from(sessionTriggers).where(eq(sessionTriggers.dedupeKey, dedupeKey)).get()!;
      if (["completed", "cancelled"].includes(trigger.status)) return;
      const mark = (status: string, error: string | null = null) => {
        const write = () => { this._db.update(sessionTriggers).set({ status, error, updatedAt: Date.now() })
          .where(and(eq(sessionTriggers.id, trigger.id), ne(sessionTriggers.status, "cancelled"))).run(); };
        if (status !== "running") new InvocationStore(this._db).finishOrigin({
          originId: taskResultMessageOrigin(input.result.taskRunId, input.subscription.session_id), sessionId: input.subscription.session_id, runnerKind: "main",
        }, write);
        else write();
      };
      if (!this._isValidTaskRunResult(input.result) || !this._isLatestTaskRunResult(input.result)) {
        mark("completed");
        return;
      }
      mark("running");
      try {
        const delivered = await this._executeForSubscription(input);
        mark(delivered ? "completed" : "failed", delivered ? null : "Channel unavailable");
      } catch (error) {
        if (error instanceof RuntimeDetachedError) throw error;
        mark("failed", String(error));
        throw error;
      }
    });
  }

  private async _executeForSubscription(input: {
    readonly result: TaskResultForMainRunner;
    readonly subscription: TaskSubscription;
  }): Promise<boolean> {
    const dedupeKey = this._enqueueTrigger(input);
    if (this._db.select().from(sessionTriggers).where(eq(sessionTriggers.dedupeKey, dedupeKey)).get()?.status === "cancelled") return false;
    const result = this._artifactizeTaskResult(input.result);
    const normalizedInbound = this._syntheticNormalizedInbound(input.subscription);
    const messageId = this._syntheticChannelMessageId(
      result,
      input.subscription,
    );
    const claim = this._claimDelivery({
      result,
      subscription: input.subscription,
      inbound: normalizedInbound,
      messageId,
    });
    const attempt = claim.attempt;
    const recovering = new InvocationStore(this._db).findActive({ runnerKind: "main", sessionId: input.subscription.session_id, originId: taskResultMessageOrigin(result.taskRunId, input.subscription.session_id) });
    if (!recovering && (attempt.status === "skipped" || (attempt.status === "sent" && attempt.outbound_id !== null))) {
      return true;
    }
    if (!recovering && this._completeCommandReply(input.result, input.subscription, attempt)) return true;

    const channel = this._channelForSubscription(input.subscription);
    if (channel === undefined) {
      this._attempts.markFailed(attempt.id);
      logger.warn(
        {
          task_id: result.taskId,
          subscription_id: input.subscription.id,
          channel_id: input.subscription.channel_id,
        },
        "skipping Task result delivery because channel is unavailable",
      );
      return false;
    }

    await this._runMain({
      result,
      subscription: input.subscription,
      attemptId: attempt.id,
    }).catch(
      (err) => {
        if (err instanceof RuntimeDetachedError) throw err;
        if (runnerAnswers(this._db, input.subscription.session_id,
          taskResultMessageOrigin(result.taskRunId, input.subscription.session_id)).length) {
          return { status: "completed", followupReleased: false } as MainRunnerCompletion;
        }
        logger.warn(
          {
            err,
            task_id: result.taskId,
            subscription_id: input.subscription.id,
          },
          "Main Runner failed to handle Task result; retaining failed delivery for recovery",
        );
        this._attempts.markFailed(attempt.id);
        throw err;
      },
    );

    if (this._completeCommandReply(input.result, input.subscription, attempt)) return true;
    if (this._mayEndSilently(input.result, input.subscription)) {
      this._attempts.markSkipped(attempt.id);
      return true;
    }
    this._attempts.markFailed(attempt.id);
    throw new Error("Main Runner completed without submitting the task result through a message command");
  }

  /**
   * A result needs a reply unless nobody is waiting on it: Main started the run
   * as a quiet background check, or in this turn Main already sent the Task on
   * (update, restart or cancel), so the work continues there.
   */
  private _mayEndSilently(result: TaskResultForMainRunner, subscription: TaskSubscription): boolean {
    const run = this._db.select({ input: taskRuns.input_snapshot }).from(taskRuns).where(eq(taskRuns.id, result.taskRunId)).get();
    if ((run?.input as { quiet?: unknown } | null | undefined)?.quiet === true) return true;
    const origin = taskResultMessageOrigin(result.taskRunId, subscription.session_id);
    return this._db.select().from(runnerOperations)
      .where(and(eq(runnerOperations.sessionId, subscription.session_id), eq(runnerOperations.originId, origin))).all()
      .some(row => row.status === "applied"
        && (row.request.kind === "task.update" || row.request.kind === "task.restart" || row.request.kind === "task.cancel")
        && row.request.payload.taskId === result.taskId);
  }

  private _completeCommandReply(
    result: TaskResultForMainRunner,
    subscription: TaskSubscription,
    attempt: NotificationAttempt,
  ): boolean {
    const answers = runnerAnswers(this._db, subscription.session_id,
      taskResultMessageOrigin(result.taskRunId, subscription.session_id));
    const sent = answers.find(command => command.status === "sent");
    if (sent) this._attempts.markSent(attempt.id, sent.providerMessageId ?? sent.messageId ?? sent.id);
    // Pending and ambiguous sends remain owned by the durable command queue.
    return answers.length > 0;
  }

  private _artifactizeTaskResult(
    result: TaskResultForMainRunner,
  ): TaskResultForMainRunner {
    return artifactizeLocalFileReferencesInValue<TaskResultForMainRunner>({
      db: this._db,
      value: result,
      scopeType: "task",
      scopeId: result.taskId,
      relatedUserId: this._relatedUserIdForTask(result.taskId),
      producer: "runner",
    });
  }

  private async _syncRunTerminalNotification(
    result: TaskResultForMainRunner,
  ): Promise<void> {
    if (this._taskRunNotifications === undefined) {
      return;
    }
    try {
      if (result.status === "completed") {
        await this._taskRunNotifications.onRunCompleted({
          taskRunId: result.taskRunId,
          result,
        });
      } else if (result.status === "failed") {
        await this._taskRunNotifications.onRunFailed({
          taskRunId: result.taskRunId,
          error: result.summary,
        });
      }
    } catch (err) {
      logger.warn(
        { err, task_id: result.taskId, task_run_id: result.taskRunId },
        "Task Run status card terminal update failed",
      );
    }
  }

  private _isValidTaskRunResult(result: TaskResultForMainRunner): boolean {
    if (result.taskRunId === undefined) {
      return false;
    }

    const run = this._db
      .select()
      .from(taskRuns)
      .where(
        and(eq(taskRuns.id, result.taskRunId), eq(taskRuns.task_id, result.taskId)),
      )
      .get();
    if (run === undefined) {
      return false;
    }
    if (run.status !== result.status) {
      const report = taskReportForRun(this._db, run.id);
      if (run.status !== "running" || result.status !== "completed" || !report ||
          !result.artifactIds.includes(report.reportArtifactId)) return false;
    }
    if (result.runIndex !== undefined && run.run_index !== result.runIndex) {
      return false;
    }

    return true;
  }

  private _isLatestTaskRunResult(result: TaskResultForMainRunner): boolean {
    if (result.taskRunId === undefined) {
      return false;
    }
    const latest = this._db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.task_id, result.taskId))
      .orderBy(desc(taskRuns.run_index), desc(taskRuns.started_at))
      .limit(1)
      .get();
    return latest?.id === result.taskRunId;
  }

  private async _runMain(input: {
    readonly result: TaskResultForMainRunner;
    readonly subscription: TaskSubscription;
    readonly attemptId: string;
  }): Promise<MainRunnerCompletion> {
    const runOnce = async () => {
      const runnerContext = this._runnerContexts.resolveForSession(
        input.subscription.session_id,
        this._runnerType(input.subscription.session_id),
      );
      const context = this._contextBuilder.buildForSession(
        input.subscription.session_id,
        {
          includeLaunchSeed: runnerContext.runner_session_id === null,
          createdForInvocationId: input.attemptId,
        },
      );
      const taskOrigin = this._db
        .select({
          creatorUserId: tasks.creator_user_id,
          sourceMessageId: tasks.source_message_id,
        })
        .from(tasks)
        .where(eq(tasks.id, input.result.taskId))
        .get();
      const surfaceKind = input.subscription.thread_key !== null
        ? "thread"
        : input.subscription.group_id !== null
          ? lookupChannelSurfaceKind(this._db, {
              type: input.subscription.channel_type,
              id: input.subscription.channel_id,
            }, input.subscription.group_id) ?? "group"
          : input.subscription.channel_type === "dashboard"
            ? "p2p"
            : undefined;
      const mainRunnerInput: MainRunnerInput = {
        type: "task_result",
        sessionId: input.subscription.session_id,
        taskId: input.result.taskId,
        ...(surfaceKind === "p2p" || surfaceKind === "group" || surfaceKind === "thread"
          ? { surface: surfaceKind }
          : {}),
        ...(taskOrigin?.creatorUserId ? { requesterUserId: taskOrigin.creatorUserId } : {}),
        ...(taskOrigin?.sourceMessageId ? { sourceMessageId: taskOrigin.sourceMessageId } : {}),
        result: {
          ...input.result,
          artifactRefs: taskResultArtifactRefs(this._db, input.result.taskId, input.result.artifactIds),
        },
        context,
      };
      return await this._mainRunner.run({
        input: mainRunnerInput,
        runnerContext,
      });
    };
    try {
      return await runOnce();
    } catch (error) {
      if (error instanceof MainRunnerFreshLaunchReplayRequiredError) {
        return await runOnce();
      }
      throw error;
    }
  }

  private _activeStatusCardSubscriptions(taskId: string): TaskSubscription[] {
    return this._db
      .select()
      .from(taskSubscriptions)
      .where(eq(taskSubscriptions.task_id, taskId))
      .orderBy(asc(taskSubscriptions.id))
      .all();
  }

  private _relatedUserIdForTask(taskId: string): string | undefined {
    const task = this._db
      .select({ creatorUserId: tasks.creator_user_id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    return task?.creatorUserId ?? undefined;
  }

  private _syntheticNormalizedInbound(
    subscription: TaskSubscription,
  ): NormalizedInboundMessage {
    const replyAnchorId = subscription.root_message_key ?? subscription.thread_key!;
    return {
      id: replyAnchorId,
      channel: {
        type: subscription.channel_type,
        id: subscription.channel_id,
      },
      surface: {
        externalId: subscription.group_id ?? subscription.channel_id,
        kind:
          lookupChannelSurfaceKind(
            this._db,
            { type: subscription.channel_type, id: subscription.channel_id },
            subscription.group_id,
          ) ?? (subscription.group_id !== null ? "group" : "unknown"),
      },
      ...(subscription.thread_key !== null
        ? {
            thread: {
              externalId: subscription.thread_key,
              ...(subscription.root_message_key !== null
                ? { rootMessageExternalId: subscription.root_message_key }
                : {}),
            },
          }
        : {}),
      sender: {
        externalId: "luna-system",
        kind: "system",
        displayName: "Luna",
      },
      text: "",
      mentions: [],
      addressing: { addressedToBot: true, reason: "p2p" },
      rawPayload: {
        origin: "task_result_event",
        subscriptionId: subscription.id,
      },
    };
  }

  private _syntheticChannelMessageId(
    result: TaskResultForMainRunner,
    subscription: TaskSubscription,
  ): string {
    return [
      "task-result",
      result.taskId,
      subscription.id,
      result.status,
      _resultOccurrenceKey(result),
    ].join(":");
  }

  private _notificationIdempotencyKey(
    result: TaskResultForMainRunner,
    subscription: TaskSubscription,
  ): string {
    return JSON.stringify([
      "task-result-notification",
      result.taskId,
      subscription.id,
      result.status,
      _resultOccurrenceKey(result),
    ]);
  }

  private _claimDelivery(input: {
    readonly result: TaskResultForMainRunner;
    readonly subscription: TaskSubscription;
    readonly inbound: NormalizedInboundMessage;
    readonly messageId: string;
  }): {
    readonly attempt: NotificationAttempt;
    readonly eventMessageId: string;
  } {
    return this._db.transaction((tx) => {
      const db = tx as unknown as DrizzleDB;
      const attemptStore = new NotificationAttemptStore(db);
      const attempt = attemptStore.resolve({
        idempotencyKey: this._notificationIdempotencyKey(
          input.result,
          input.subscription,
        ),
        taskId: input.result.taskId,
        subscriptionId: input.subscription.id,
        messageId: input.messageId,
        action: "publish_task_result",
      });
      if (attempt.status === "sent" && attempt.outbound_id !== null) {
        return { attempt, eventMessageId: input.messageId };
      }

      db.insert(timelineEvents)
        .values({
          id: uuid(),
          task_id: input.result.taskId,
          session_id: input.subscription.session_id,
          message_id: input.messageId,
          actor_user_id: input.inbound.sender.externalId,
          source_message_id: null,
          type: "task.result_event",
          summary: input.result.userVisibleReport,
          data: {
            origin: "task_result_event",
            sourceTaskId: input.result.taskId,
            ...(input.result.taskRunId !== undefined
              ? { taskRunId: input.result.taskRunId }
              : {}),
            ...(input.result.runIndex !== undefined
              ? { runIndex: input.result.runIndex }
              : {}),
            status: input.result.status,
            subscriptionId: input.subscription.id,
            occurrenceKey: _resultOccurrenceKey(input.result),
            result: input.result,
          },
          visibility: "internal",
          created_at: Date.now(),
        })
        .onConflictDoNothing({
          target: [
            timelineEvents.task_id,
            timelineEvents.message_id,
            timelineEvents.type,
          ],
        })
        .run();

      return { attempt, eventMessageId: input.messageId };
    });
  }

  private _pendingTaskResultAttempts(): NotificationAttempt[] {
    return this._db
      .select()
      .from(notificationAttempts)
      .where(eq(notificationAttempts.action, "publish_task_result"))
      .orderBy(
        asc(notificationAttempts.created_at),
        asc(notificationAttempts.id),
      )
      .all()
      .filter((attempt) => attempt.status !== "sent" && attempt.status !== "skipped");
  }

  private _taskResultEventForAttempt(
    attempt: NotificationAttempt,
  ): { readonly result: TaskResultForMainRunner } | undefined {
    const row = this._db
      .select()
      .from(timelineEvents)
      .where(
        and(
          eq(timelineEvents.task_id, attempt.task_id),
          eq(timelineEvents.message_id, attempt.message_id),
          eq(timelineEvents.type, "task.result_event"),
        ),
      )
      .all()
      .find((event) => {
        return (
          _isRecord(event.data) &&
          event.data.origin === "task_result_event" &&
          _isTaskResult(event.data.result)
        );
      });
    if (row === undefined || !_isRecord(row.data)) {
      return undefined;
    }
    return { result: row.data.result as TaskResultForMainRunner };
  }

  private _subscriptionById(
    subscriptionId: string,
  ): TaskSubscription | undefined {
    return this._db
      .select()
      .from(taskSubscriptions)
      .where(eq(taskSubscriptions.id, subscriptionId))
      .get();
  }

}

function _resultOccurrenceKey(result: TaskResultForMainRunner): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: result.title,
        taskRunId: result.taskRunId ?? null,
        runIndex: result.runIndex ?? null,
        summary: result.summary,
        conclusion: result.conclusion ?? null,
        evidenceSummary: result.evidenceSummary,
        userVisibleReport: result.userVisibleReport,
        artifactIds: [...result.artifactIds].sort(),
        nextActions: result.nextActions,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function _isTaskResult(value: unknown): value is TaskResultForMainRunner {
  return (
    _isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.taskRunId === "string" &&
    (value.runIndex === undefined || typeof value.runIndex === "number") &&
    (value.status === "completed" ||
      value.status === "failed" ||
      value.status === "cancelled") &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.evidenceSummary) &&
    typeof value.userVisibleReport === "string" &&
    Array.isArray(value.artifactIds) &&
    Array.isArray(value.nextActions)
  );
}
