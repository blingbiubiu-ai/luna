import type { NativeProgressEntry } from "@/channels/outbound";

import { createHash } from "node:crypto";
import { SessionDispatcher } from "@/sessions/session-dispatcher";
import { GatewayError } from "@/server/gateway-error";
import type { OperationResult } from "@/runners/operation-contract";
import { SessionStore } from "@/sessions/session-store";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { RECENT_PROGRESS_STEPS } from "@/messaging/notifications/buffered-progress";
import type { TaskStatusCardStepEvent } from "@/messaging/notifications/task-status-card-updater";

import type { NormalizedInboundMessage } from "@/channels";
import type { DrizzleDB } from "@/data";
import {
  messages,
  runnerOperations,
  taskRunNotifications,
  taskRuns,
  taskSubscriptions,
  timelineEvents,
  tasks,
} from "@/data/schema";
import { NotificationAttemptStore } from "@/messaging/notifications/notification-attempt-store";
import { persistTaskStatusCardMessage } from "@/messaging/notifications/status-card-message-store";
import {
  buildTaskStatusCardSteps,
  TaskStatusCardUpdater,
} from "@/messaging/notifications/task-status-card-updater";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import { nativeProgressEntries } from "@/messaging/notifications/feishu-task-updater";
import type { ReplyChannel } from "@/channels/outbound";

import {
  TaskRunNotificationStore,
  type TaskRunNotification,
} from "./task-run-notification-store";
import { WAITING_FOR_INPUT, type TaskSubscription } from "./types";

export interface TaskRunNotificationServiceOptions {
  readonly db: DrizzleDB;
  readonly channelForNotification: (
    notification: TaskRunNotification,
  ) => ReplyChannel | undefined;
}

export interface OnTaskRunCreatedInput {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly sourceMessageId?: string;
  readonly reason: "initial" | "restart" | string;
}

export interface OnTaskRunCancelledInput {
  readonly taskRunId: string;
  readonly cancelledByRunId?: string;
  readonly reason: string;
}

export interface OnTaskRunCompletedInput {
  readonly taskRunId: string;
  readonly result?: TaskRunNotificationResult;
}

export interface OnTaskRunProgressInput {
  readonly taskRunId: string;
  readonly events?: readonly TaskStatusCardStepEvent[];
  readonly nativeProgress?: readonly NativeProgressEntry[];
}

export interface OnTaskRunFailedInput {
  readonly taskRunId: string;
  readonly error: string;
}

export type TaskRunNotificationResult =
  Partial<TaskResultForMainRunner> &
  Pick<TaskResultForMainRunner, "taskId" | "title" | "summary" | "status">;

/**
 * Owns Task Run status-card notification side effects.
 */
const cardLanes = new WeakMap<DrizzleDB, SessionDispatcher>();

export class TaskRunNotificationService {
  private readonly _notifications: TaskRunNotificationStore;
  private readonly _attempts: NotificationAttemptStore;
  private readonly _recentProgress = new Map<string, readonly TaskStatusCardStepEvent[]>();

  constructor(private readonly _options: TaskRunNotificationServiceOptions) {
    this._notifications = new TaskRunNotificationStore(_options.db);
    this._attempts = new NotificationAttemptStore(_options.db);
  }

  async onRunCreated(input: OnTaskRunCreatedInput): Promise<void> {
    return this._serialize(input.taskRunId, () => this._onRunCreated(input));
  }

  private async _onRunCreated(input: OnTaskRunCreatedInput): Promise<void> {
    const task = this._requireTask(input.taskId);
    const run = this._requireRun(input.taskRunId);
    const subscriptions = this._subscriptionsForTask(input.taskId);
    for (const subscription of subscriptions) {
      const notification = this._notifications.resolveForRunSubscription({
        taskId: input.taskId,
        taskRunId: run.id,
        runIndex: run.run_index,
        subscriptionId: subscription.id,
        statusCardStyle: subscription.status_card_style ?? "card",
        sessionId: subscription.session_id,
        channelType: subscription.channel_type,
        channelId: subscription.channel_id,
        groupId: subscription.group_id,
        threadKey: subscription.thread_key,
        rootMessageKey: subscription.root_message_key,
        surfaceKey: subscription.surface_key,
      });
      if (notification.statusMessageId !== null) {
        continue;
      }
      const channel = this._options.channelForNotification(notification);
      if (channel === undefined) {
        continue;
      }
      const inbound = this._syntheticInbound(
        notification,
        input.sourceMessageId,
      );
      const attempt = this._attempts.resolve({
        idempotencyKey: JSON.stringify([
          "task-run-notification",
          run.id,
          subscription.id,
          "create_status_card",
        ]),
        taskId: task.id,
        subscriptionId: subscription.id,
        messageId: input.sourceMessageId ?? run.id,
        action: "create_status_card",
      });
      if (attempt.status === "sent" && attempt.outbound_id !== null) {
        this._notifications.setStatusMessageId(
          notification.id,
          attempt.outbound_id,
        );
        continue;
      }

      new SessionStore(this._options.db).requireReplyUserId(notification.sessionId);
      const outbound = await new TaskStatusCardUpdater(
        channel,
        inbound,
      ).createStatusCard(
        subscription,
        {
          persistentTask: { ...task, status: "running" },
          subscription,
          latestEvent: {
            type: "runner.step",
            summary: `第 ${run.run_index} 轮执行已开始。`,
            data: { taskRunId: run.id, runIndex: run.run_index },
          } as never,
        },
        attempt.idempotency_key,
      );
      this._attempts.markSent(attempt.id, outbound.id);
      const saved = this._notifications.setStatusMessageId(
        notification.id,
        outbound.id,
      );
      persistTaskStatusCardMessage({
        db: this._options.db,
        sessionId: subscription.session_id,
        taskId: task.id,
        taskRunId: run.id,
        runIndex: run.run_index,
        notificationId: saved.id,
        inbound,
        subscription,
        taskTitle: task.title,
        taskSummary: task.summary,
        taskStatus: "running",
        outbound,
      });
    }
  }

  async onRunCancelled(input: OnTaskRunCancelledInput): Promise<void> {
    await this._updateTerminalCards({
      taskRunId: input.taskRunId,
      status: "cancelled",
      content: input.cancelledByRunId ? `收到新的补充信息，已中断本轮执行。${input.reason}` : `任务已取消。${input.reason}`,
    });
  }

  async onRunProgress(input: OnTaskRunProgressInput): Promise<void> {
    return this._serialize(input.taskRunId, () => this._onRunProgress(input));
  }

  private async _onRunProgress(input: OnTaskRunProgressInput): Promise<void> {
    const run = this._requireRun(input.taskRunId);
    const task = this._requireTask(run.task_id);
    const delta = input.events?.map(event => ({ ...event, id: event.id ?? createHash("sha256").update(event.summary).digest("hex") }));
    const timelineEventsForRun = delta
      ? [...(this._recentProgress.get(run.id) ?? []), ...delta].slice(-RECENT_PROGRESS_STEPS)
      : this._timelineEventsForRun(run);
    this._recentProgress.set(run.id, timelineEventsForRun);
    const latestProgressEvent = _latestProgressEvent(timelineEventsForRun);
    if (latestProgressEvent === undefined) {
      return;
    }
    const statusCardSteps = buildTaskStatusCardSteps({
      timelineEvents: timelineEventsForRun,
    });
    if (statusCardSteps === undefined) {
      return;
    }

    for (const notification of this._notifications.listForRun(input.taskRunId)) {
      if (
        notification.state !== "active" ||
        notification.statusMessageId === null
      ) {
        continue;
      }
      const channel = this._options.channelForNotification(notification);
      if (channel === undefined) {
        continue;
      }
      const subscription = this._requireSubscription(notification.subscriptionId);
      const inbound = this._syntheticInbound(
        notification,
        run.source_message_id ?? undefined,
      );
      const attempt = this._attempts.resolve({
        idempotencyKey: JSON.stringify([
          "task-run-notification",
          run.id,
          notification.subscriptionId,
          "update_status_card_progress",
          notification.statusMessageId,
          latestProgressEvent.id!,
        ]),
        taskId: run.task_id,
        subscriptionId: notification.subscriptionId,
        messageId: latestProgressEvent.id!,
        action: "update_status_card_progress",
      });
      if (attempt.status === "sent") {
        continue;
      }

      new SessionStore(this._options.db).requireReplyUserId(notification.sessionId);
      const outbound = await channel.send(inbound, {
        replyMode: "update_status_card",
        targetMessageId: notification.statusMessageId,
        sessionId: notification.sessionId,
        idempotencyKey: attempt.idempotency_key,
        statusCardStyle: notification.statusCardStyle,
        nativeProgress: input.nativeProgress ?? nativeProgressEntries(delta ?? timelineEventsForRun),
        statusCardState: "active",
        statusCard: {
          taskId: run.task_id,
          title: task.title,
          ...(task.summary !== null ? { summary: task.summary } : {}),
          status: "running",
        },
        statusCardSteps,
        content: "",
      });
      this._attempts.markSent(attempt.id, outbound.id);
      persistTaskStatusCardMessage({
        db: this._options.db,
        sessionId: notification.sessionId,
        taskId: run.task_id,
        taskRunId: run.id,
        runIndex: run.run_index,
        notificationId: notification.id,
        inbound,
        subscription,
        taskTitle: task.title,
        taskSummary: task.summary,
        taskStatus: "running",
        outbound,
      });
    }
  }

  async onRunCompleted(input: OnTaskRunCompletedInput): Promise<void> {
    const waiting = this._requireTask(this._requireRun(input.taskRunId).task_id).block_reason === WAITING_FOR_INPUT;
    await this._updateTerminalCards({
      taskRunId: input.taskRunId,
      status: "completed",
      content: waiting ? "等待答复。" : "处理完成。",
      ...(input.result !== undefined ? { result: input.result } : {}),
    });
  }

  async onRunFailed(input: OnTaskRunFailedInput): Promise<void> {
    await this._updateTerminalCards({
      taskRunId: input.taskRunId,
      status: "failed",
      content: input.error,
    });
  }

  private async _updateTerminalCards(input: {
    readonly taskRunId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly content: string;
    readonly result?: TaskRunNotificationResult;
  }): Promise<void> {
    try { await this._serialize(input.taskRunId, () => this._updateTerminalCardsUnlocked(input)); }
    finally { this._recentProgress.delete(input.taskRunId); }
  }

  private async _updateTerminalCardsUnlocked(input: {
    readonly taskRunId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly content: string;
    readonly result?: TaskRunNotificationResult;
  }): Promise<void> {
    const run = this._requireRun(input.taskRunId);
    const task = this._requireTask(run.task_id);
    for (const notification of this._notifications.listForRun(input.taskRunId)) {
      if (notification.state === "terminal") {
        continue;
      }
      if (notification.statusMessageId === null) {
        this._notifications.markTerminal(notification.id);
        continue;
      }
      const channel = this._options.channelForNotification(notification);
      if (channel === undefined) {
        continue;
      }
      const subscription = this._requireSubscription(notification.subscriptionId);
      const inbound = this._syntheticInbound(
        notification,
        run.source_message_id ?? undefined,
      );
      const attempt = this._attempts.resolve({
        idempotencyKey: JSON.stringify([
          "task-run-notification",
          run.id,
          notification.subscriptionId,
          "update_status_card",
          notification.statusMessageId,
          input.status,
        ]),
        taskId: run.task_id,
        subscriptionId: notification.subscriptionId,
        messageId: run.source_message_id ?? run.id,
        action: "update_status_card",
      });
      if (attempt.status === "sent") {
        this._notifications.markTerminal(notification.id);
        continue;
      }

      const title = input.result?.title ?? task.title;
      const summary = input.result?.summary ?? task.summary;
      const statusCardSteps = buildTaskStatusCardSteps({
        timelineEvents: this._timelineEventsForRun(run),
      });
      new SessionStore(this._options.db).requireReplyUserId(notification.sessionId);
      const outbound = await channel.send(inbound, {
        replyMode: "update_status_card",
        targetMessageId: notification.statusMessageId,
        sessionId: notification.sessionId,
        idempotencyKey: attempt.idempotency_key,
        statusCardStyle: notification.statusCardStyle,
        nativeProgress: nativeProgressEntries(this._timelineEventsForRun(run)),
        statusCardState: "terminal",
        statusCard: {
          taskId: run.task_id,
          title,
          ...(summary !== null ? { summary } : {}),
          status: input.status,
        },
        ...(statusCardSteps !== undefined ? { statusCardSteps } : {}),
        content: input.content,
      });
      this._attempts.markSent(attempt.id, outbound.id);
      const terminal = this._notifications.markTerminal(notification.id);
      persistTaskStatusCardMessage({
        db: this._options.db,
        sessionId: notification.sessionId,
        taskId: run.task_id,
        taskRunId: run.id,
        runIndex: run.run_index,
        notificationId: terminal.id,
        inbound,
        subscription,
        taskTitle: title,
        taskSummary: summary,
        taskStatus: input.status,
        outbound,
      });
    }
  }

  private _serialize<T>(runId: string, callback: () => Promise<T>): Promise<T> {
    let lane = cardLanes.get(this._options.db);
    if (!lane) { lane = new SessionDispatcher(); cardLanes.set(this._options.db, lane); }
    return lane.dispatch({kind: "message_delivery", sessionId: runId}, callback);
  }

  async applyStatusCardCommand(operationId: string, result: OperationResult, resend: boolean, style?: "card" | "native"): Promise<OperationResult> {
    return this._serialize(result.runId!, async () => {
      const db = this._options.db;
      let saved = db.select().from(runnerOperations).where(eq(runnerOperations.id, operationId)).get()?.result ?? result;
      // Receipt persistence and pointer replacement commit together.
      if (saved.statusMessageId) return saved;
      let notification = this._notifications.requireById(saved.notificationId!);
      const channel = this._options.channelForNotification(notification);
      if (!channel) throw new GatewayError("channel_unavailable", "Task status-card channel unavailable", 409);
      const subscription = this._requireSubscription(notification.subscriptionId);
      new SessionStore(db).requireReplyUserId(notification.sessionId);
      const run = this._requireRun(notification.taskRunId);
      const inbound = this._syntheticInbound(notification, run.source_message_id ?? undefined);
      const selectedStyle = style ?? notification.statusCardStyle;
      if (selectedStyle !== notification.statusCardStyle && notification.statusMessageId && !resend)
        throw new GatewayError("style_change_requires_resend", "Changing progress style requires --resend", 409);
      const updater = new TaskStatusCardUpdater(channel, inbound);
      const snapshot = () => {
        const current = this._requireRun(run.id);
        return updater.statusCardOperation({...subscription, status_card_style: selectedStyle}, {
          persistentTask: {...this._requireTask(run.task_id), status: current.status},
          subscription, timelineEvents: this._timelineEventsForRun(current),
        }, `task-status-card:${operationId}`);
      };
      if (!saved.cardDelivery) {
        const initial = snapshot();
        const operation = !resend && notification.statusMessageId
          ? {...initial, replyMode: "update_status_card" as const, targetMessageId: notification.statusMessageId}
          : initial;
        saved = {...saved, cardDelivery: {notificationId: notification.id,
          previousMessageId: notification.statusMessageId, operation}};
        db.update(runnerOperations).set({result: saved, updatedAt: Date.now()})
          .where(eq(runnerOperations.id, operationId)).run();
      }
      const delivery = saved.cardDelivery!;
      if (notification.statusMessageId !== delivery.previousMessageId)
        throw new GatewayError("card_command_superseded", "A newer command replaced this status card", 409);
      if (resend && notification.statusMessageId && notification.statusCardStyle === "native" && notification.state === "active") {
        await channel.send(inbound, {...delivery.operation, replyMode: "update_status_card", statusCardStyle: "native",
          statusCardState: "terminal", statusCard: {...delivery.operation.statusCard!, status: "cancelled"},
          targetMessageId: notification.statusMessageId, idempotencyKey: `task-status-card:${operationId}:close`,
          content: "进度已转移到新的消息。"});
      }
      // Frozen payload + stable request key permit safe replay after ambiguous delivery.
      let outbound = await channel.send(inbound, delivery.operation);
      const messageId = delivery.operation.replyMode === "update_status_card"
        ? delivery.operation.targetMessageId! : outbound.id;
      const fresh = snapshot();
      const displayed = (value: typeof fresh) => JSON.stringify({
        content: value.content, statusCard: value.statusCard,
        statusCardStyle: value.statusCardStyle, nativeProgress: value.nativeProgress,
        statusCardState: value.statusCardState, statusCardSteps: value.statusCardSteps,
      });
      if (displayed(fresh) !== displayed(delivery.operation)) {
        const revision = createHash("sha256").update(displayed(fresh)).digest("hex").slice(0, 16);
        outbound = await channel.send(inbound, {...fresh, replyMode: "update_status_card",
          targetMessageId: messageId, idempotencyKey: `task-status-card:${operationId}:refresh:${revision}`});
      }
      const completed = {...saved, statusMessageId: messageId};
      db.transaction(() => {
        db.update(taskRunNotifications).set({status_message_id: messageId, status_card_style: selectedStyle,
          state: outbound.statusCardState === "terminal" ? "terminal" : "active", updated_at: Date.now()})
          .where(eq(taskRunNotifications.id, notification.id)).run();
        db.update(taskSubscriptions).set({notification_level: "major_updates", status_card_style: selectedStyle, updated_at: Date.now()})
          .where(eq(taskSubscriptions.id, subscription.id)).run();
        persistTaskStatusCardMessage({db, sessionId: notification.sessionId, taskId: run.task_id,
          taskRunId: run.id, runIndex: run.run_index, notificationId: notification.id, inbound, subscription,
          taskTitle: outbound.statusCard!.title ?? this._requireTask(run.task_id).title, taskSummary: outbound.statusCard!.summary ?? null,
          taskStatus: outbound.statusCard!.status ?? this._requireRun(run.id).status, outbound});
        db.update(runnerOperations).set({result: completed, updatedAt: Date.now()})
          .where(eq(runnerOperations.id, operationId)).run();
      });
      return completed;
    });
  }

  private _requireTask(taskId: string) {
    const row = this._options.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!row) {
      throw new Error(`Task "${taskId}" was not found.`);
    }
    return row;
  }

  private _requireRun(taskRunId: string) {
    const row = this._options.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.id, taskRunId))
      .get();
    if (!row) {
      throw new Error(`Task Run "${taskRunId}" was not found.`);
    }
    return row;
  }

  private _subscriptionsForTask(taskId: string): TaskSubscription[] {
    return this._options.db
      .select()
      .from(taskSubscriptions)
      .where(eq(taskSubscriptions.task_id, taskId))
      .all().filter(subscription => subscription.notification_level !== "none") as TaskSubscription[];
  }

  private _requireSubscription(subscriptionId: string): TaskSubscription {
    const row = this._options.db
      .select()
      .from(taskSubscriptions)
      .where(eq(taskSubscriptions.id, subscriptionId))
      .get();
    if (!row) {
      throw new Error(`Task subscription "${subscriptionId}" was not found.`);
    }
    return row as TaskSubscription;
  }

  private _syntheticInbound(
    notification: TaskRunNotification,
    sourceMessageId: string | undefined,
  ): NormalizedInboundMessage {
    const sourceMessage = sourceMessageId === undefined
      ? undefined
      : this._options.db
        .select()
        .from(messages)
        .where(eq(messages.id, sourceMessageId))
        .get();
    const replyAnchorId = notification.rootMessageKey ??
      sourceMessage?.externalMessageId ??
      notification.statusMessageId ??
      notification.taskRunId;
    return {
      id: replyAnchorId,
      channel: {
        type: notification.channelType,
        id: notification.channelId,
      },
      surface: {
        externalId: notification.groupId ?? notification.channelId,
        kind: notification.groupId !== null ? "group" : "unknown",
      },
      ...(notification.threadKey !== null
        ? {
            thread: {
              externalId: notification.threadKey,
              ...(notification.rootMessageKey !== null
                ? { rootMessageExternalId: notification.rootMessageKey }
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
        origin: "task_run_notification",
        taskRunId: notification.taskRunId,
        notificationId: notification.id,
      },
    };
  }

  private _timelineEventsForRun(
    run: typeof taskRuns.$inferSelect,
  ): (typeof timelineEvents.$inferSelect)[] {
    return this._options.db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.task_id, run.task_id), inArray(timelineEvents.type,["runner.step","runner.cancelled","runner.failed"]), sql`json_extract(
        CASE WHEN json_valid(${timelineEvents.data}) THEN
          CASE WHEN json_type(${timelineEvents.data}) = 'text' AND json_valid(json_extract(${timelineEvents.data}, '$'))
            THEN json_extract(${timelineEvents.data}, '$') ELSE ${timelineEvents.data} END
          ELSE '{}' END, '$.taskRunId') = ${run.id}`))
      .orderBy(desc(timelineEvents.created_at), desc(timelineEvents.id))
      .limit(RECENT_PROGRESS_STEPS)
      .all()
      .map((row) => ({ ...row, data: _normalizedTimelineData(row.data) }))
      .reverse();
  }
}

function _normalizedTimelineData(data: unknown): unknown {
  if (typeof data !== "string") {
    return data;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function _latestProgressEvent(
  events: readonly TaskStatusCardStepEvent[],
): TaskStatusCardStepEvent | undefined {
  return events
    .filter((event) => event.type === "runner.step")
    .at(-1);
}
