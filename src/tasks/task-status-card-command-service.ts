import {and, desc, eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {messages, tasks, taskRuns, taskSubscriptions} from "@/data/schema";
import {GatewayError} from "@/server/gateway-error";
import {SessionStore} from "@/sessions/session-store";
import type {OperationContext, OperationResult} from "@/runners/operation-contract";
import {TaskRunNotificationStore} from "./task-run-notification-store";

/** Pin a command to the current run and its existing delivery subscription. */
export class TaskStatusCardCommandService {
  constructor(private readonly db: DrizzleDB) {}

  prepare(taskId: string, context: OperationContext): OperationResult {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) throw new GatewayError("task_not_found", "Task not found", 404);
    const source = task.source_message_id
      ? this.db.select().from(messages).where(eq(messages.id, task.source_message_id)).get() : undefined;
    const subscribed = this.db.select().from(taskSubscriptions).where(and(
      eq(taskSubscriptions.task_id, taskId), eq(taskSubscriptions.session_id, context.sessionId))).get();
    if (task.primary_session_id !== context.sessionId && source?.ownerSessionId !== context.sessionId && !subscribed)
      throw new GatewayError("task_scope_mismatch", "Task does not belong to this conversation", 403);
    const subscription = this.db.select().from(taskSubscriptions).where(and(
      eq(taskSubscriptions.task_id, taskId), eq(taskSubscriptions.session_id, task.primary_session_id ?? context.sessionId))).get();
    if (!subscription) throw new GatewayError("subscription_missing", "Task has no bound delivery session", 409);
    const session = new SessionStore(this.db).getById(subscription.session_id);
    if (!session || session.status !== "active") throw new GatewayError("session_unavailable", "Task delivery session unavailable", 409);
    const run = this.db.select().from(taskRuns).where(eq(taskRuns.task_id, taskId)).orderBy(desc(taskRuns.run_index)).get();
    if (!run) throw new GatewayError("task_not_started", "Task has no execution run yet", 409);
    const notification = new TaskRunNotificationStore(this.db).resolveForRunSubscription({
      statusCardStyle: subscription.status_card_style,
      taskId, taskRunId: run.id, runIndex: run.run_index, subscriptionId: subscription.id,
      sessionId: subscription.session_id, channelType: subscription.channel_type, channelId: subscription.channel_id,
      groupId: subscription.group_id, threadKey: subscription.thread_key, rootMessageKey: subscription.root_message_key,
      surfaceKey: subscription.surface_key,
    });
    return {taskId, runId: run.id, taskSessionId: subscription.session_id, notificationId: notification.id};
  }
}
