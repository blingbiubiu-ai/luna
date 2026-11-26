import {TaskScopeResolver} from "@/agents/task-scope";
import {AgentStore} from "@/agents/agent-store";
import { TaskRunStore } from "./task-run-store";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { tasks, taskParticipants, taskSubscriptions, sessionTimelineEntries, messages } from "@/data/schema";
import { ContextPackStore } from "@/context";
import { canonicalUserIdForRequestedIdentity, requestedIdentityFromInbound } from "@/identity/requested-identity";
import { SessionStateStore } from "@/main-runner/session-state-store";
import { isHeartbeatSession } from "@/messaging/correlated-request-service";
import { resolveLunaAddress } from "@/messaging/luna-address";
import { TimelineStore } from "@/timeline/timeline-store";
import { GatewayError } from "@/server/gateway-error";
import type { OperationContext, OperationRequest, OperationResult } from "@/runners/operation-contract";
import { SessionStore } from "@/sessions/session-store";
import { SessionTimelineStore } from "@/sessions/session-timeline-store";
import { TaskSubscriptionStore } from "./task-subscription-store";
import { AgentSettingsStore } from "@/agents/agent-settings-store";
import type { TaskRunSupervisor } from "./task-run-supervisor";

type TaskRequest = Extract<
  OperationRequest,
  {
    kind:
      | "task.create"
      | "task.update"
      | "task.restart"
      | "task.cancel"
      | "task.transfer"
      | "task.watch"
      | "task.unwatch";
  }
>;
export type TaskCommandSupervisor = Pick<TaskRunSupervisor, "startInitialRun" | "restartTaskRun" | "cancelTaskRun"> & {
  readonly cancelWaitingTask?: TaskRunSupervisor["cancelWaitingTask"];
};

function resolveTargetSessionForAddress(
  db: DrizzleDB,
  scope: { readonly agentId: string; readonly shadowId: string },
  currentSessionId: string,
  rawTo: string,
) {
  const trimmed = rawTo.trim();
  if (trimmed === "self" || trimmed === "main") {
    throw new GatewayError(
      "invalid_target_session",
      "Task target must be a user conversation, not 'self' or 'main'",
      400,
    );
  }
  const normalized =
    trimmed === "current" || trimmed === "owner" || trimmed.includes(":")
      ? trimmed
      : `session:${trimmed}`;
  const resolved = resolveLunaAddress(
    db,
    { agentId: scope.agentId, shadowId: scope.shadowId, currentSessionId },
    normalized,
  );
  if (isHeartbeatSession(db, resolved.sessionId)) {
    throw new GatewayError(
      "invalid_target_session",
      "Heartbeat self session cannot own or watch a Task",
      400,
    );
  }
  const store = new SessionStore(db);
  const target = store.getById(resolved.sessionId);
  if (!target || target.status !== "active") {
    throw new GatewayError("session_unavailable", "Task target session unavailable", 409);
  }
  const scopes = new TaskScopeResolver(db);
  scopes.assertSame(scope, scopes.session(target.id));
  store.requireReplyUserId(target.id);
  return target;
}

/** Task mutations are transactional; run dispatch uses the supervisor's durable source deduplication. */
export class TaskCommandService {
  constructor(private readonly db: DrizzleDB, private readonly supervisor: TaskCommandSupervisor) {}

  prepare(id: string, request: TaskRequest, context: OperationContext): OperationResult {
    const db = this.db;
    const {sessionId, actorUserId, inbound, sourceMessageIds} = context;
    const scopes=new TaskScopeResolver(db),scope=scopes.session(sessionId);
    const agentStore = new AgentStore(db);
    agentStore.requireAccess(actorUserId,scope.agentId);
    const payload = request.payload;
    const assumptions = "assumptions" in payload ? payload.assumptions : undefined;
    const now = Date.now();
    const taskId = request.kind === "task.create" ? `task_${id}` : request.payload.taskId;
    const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if(existing)scopes.assertSame(scope,scopes.task(existing.id));
    if (request.kind !== "task.create") {
      if (!existing) throw new GatewayError("task_not_found", "Task not found", 404);
      const subscribed = db.select().from(taskSubscriptions).where(and(eq(taskSubscriptions.task_id, taskId), eq(taskSubscriptions.session_id, sessionId))).get();
      const source = existing.source_message_id ? db.select().from(messages).where(eq(messages.id, existing.source_message_id)).get() : undefined;
      const isLinkedSession = existing.primary_session_id === sessionId || Boolean(subscribed) || source?.ownerSessionId === sessionId;
      const ownerId = agentStore.ownerUserId(scope.agentId);
      const isOwnerOrCreator = actorUserId === ownerId || (existing.creator_user_id !== null && actorUserId === existing.creator_user_id);
      if (request.kind === "task.transfer" || request.kind === "task.watch" || request.kind === "task.unwatch") {
        if (!isLinkedSession && !isOwnerOrCreator) {
          throw new GatewayError("task_scope_mismatch", "Task does not belong to this conversation", 403);
        }
        const target = resolveTargetSessionForAddress(db, scope, sessionId, request.payload.to);
        if (!isLinkedSession && target.id !== sessionId && actorUserId !== ownerId) {
          throw new GatewayError(
            "task_scope_mismatch",
            "Only the Agent owner or a linked session may attach another session to this Task",
            403,
          );
        }
        if (request.kind === "task.unwatch") {
          if (existing.primary_session_id === target.id) {
            throw new GatewayError(
              "cannot_unwatch_primary_session",
              "Cannot unwatch the Task's primary session; transfer primary ownership first",
              409,
            );
          }
          const removed = db
            .delete(taskSubscriptions)
            .where(and(eq(taskSubscriptions.task_id, taskId), eq(taskSubscriptions.session_id, target.id)))
            .returning({ id: taskSubscriptions.id })
            .all();
          new TimelineStore(db).append({
            taskId,
            sessionId,
            type: "task.watcher_removed",
            summary: `Removed watcher session ${target.id}`,
            data: { operationId: id, watcherSessionId: target.id },
          });
          return {
            taskId,
            ...(existing.primary_session_id ? { taskSessionId: existing.primary_session_id } : {}),
            targetSessionId: target.id,
            unwatched: removed.length > 0,
          };
        }
        if (request.kind === "task.watch") {
          const watchSub = new TaskSubscriptionStore(db).resolve({
            taskId,
            sessionId: target.id,
            channelType: target.channel_type,
            channelId: target.channel_id,
            ...(target.group_id ? { groupId: target.group_id } : {}),
            ...(target.thread_key ? { threadId: target.thread_key } : {}),
            ...(target.root_message_key ? { rootMessageId: target.root_message_key } : {}),
            visibility: "full",
            notificationLevel: request.payload.notify,
          });
          db.update(taskSubscriptions)
            .set({ notification_level: request.payload.notify, updated_at: now })
            .where(eq(taskSubscriptions.id, watchSub.id))
            .run();
          new TimelineStore(db).append({
            taskId,
            sessionId,
            type: "task.watcher_updated",
            summary: `Updated watcher session ${target.id} (${request.payload.notify})`,
            data: { operationId: id, watcherSessionId: target.id, notify: request.payload.notify },
          });
          const activeRun = new TaskRunStore(db).getActiveRunForTask(taskId);
          return {
            taskId,
            taskSessionId: existing.primary_session_id ?? target.id,
            targetSessionId: target.id,
            notify: request.payload.notify,
            ...(activeRun ? { runId: activeRun.id } : {}),
            ...(request.payload.notify === "major_updates" && activeRun ? { spawnStatusCard: true } : {}),
          };
        }
        // `task.transfer`
        const previousPrimaryId = existing.primary_session_id;
        if (target.id !== sessionId) {
          for (const messageId of sourceMessageIds) {
            new SessionTimelineStore(db).appendReference({ sessionId: target.id, messageId });
            new ContextPackStore(db).appendTaskSourceItem({ taskId, sessionId, messageId });
          }
        }
        const prevSub = previousPrimaryId
          ? db
              .select()
              .from(taskSubscriptions)
              .where(and(eq(taskSubscriptions.task_id, taskId), eq(taskSubscriptions.session_id, previousPrimaryId)))
              .get()
          : undefined;
        const existingTargetSub = db
          .select()
          .from(taskSubscriptions)
          .where(and(eq(taskSubscriptions.task_id, taskId), eq(taskSubscriptions.session_id, target.id)))
          .get();
        const card = new AgentSettingsStore(db).get(scope.agentId).main.taskProgressCard;
        const targetStyle =
          request.payload.statusCardStyle ??
          existingTargetSub?.status_card_style ??
          prevSub?.status_card_style ??
          card.style;
        const inheritedSendCard = prevSub
          ? prevSub.notification_level === "major_updates" || prevSub.notification_level === "all"
          : card.send;
        const shouldSendCard = request.payload.sendStatusCard ?? inheritedSendCard;
        const targetNotify = shouldSendCard ? ("major_updates" as const) : ("none" as const);
        const targetSub = new TaskSubscriptionStore(db).resolve({
          taskId,
          sessionId: target.id,
          channelType: target.channel_type,
          channelId: target.channel_id,
          ...(target.group_id ? { groupId: target.group_id } : {}),
          ...(target.thread_key ? { threadId: target.thread_key } : {}),
          ...(target.root_message_key ? { rootMessageId: target.root_message_key } : {}),
          visibility: "full",
          statusCardStyle: targetStyle,
          notificationLevel: targetNotify,
        });
        db.update(taskSubscriptions)
          .set({
            notification_level: targetNotify,
            status_card_style: targetStyle,
            visibility: "full",
            updated_at: now,
          })
          .where(eq(taskSubscriptions.id, targetSub.id))
          .run();

        if (previousPrimaryId && previousPrimaryId !== target.id) {
          const prevSession = new SessionStore(db).getById(previousPrimaryId);
          if (prevSession && prevSession.status === "active") {
            const originSub = new TaskSubscriptionStore(db).resolve({
              taskId,
              sessionId: prevSession.id,
              channelType: prevSession.channel_type,
              channelId: prevSession.channel_id,
              ...(prevSession.group_id ? { groupId: prevSession.group_id } : {}),
              ...(prevSession.thread_key ? { threadId: prevSession.thread_key } : {}),
              ...(prevSession.root_message_key ? { rootMessageId: prevSession.root_message_key } : {}),
              visibility: "full",
              notificationLevel: request.payload.originNotify,
            });
            db.update(taskSubscriptions)
              .set({ notification_level: request.payload.originNotify, updated_at: now })
              .where(eq(taskSubscriptions.id, originSub.id))
              .run();
          }
        }

        db.update(tasks)
          .set({ primary_session_id: target.id, updated_at: now, last_activity_at: now })
          .where(eq(tasks.id, taskId))
          .run();
        new TimelineStore(db).append({
          taskId,
          sessionId,
          type: "task.transferred",
          summary: `Transferred primary session to ${target.id}`,
          data: {
            operationId: id,
            ...(previousPrimaryId ? { fromSessionId: previousPrimaryId } : {}),
            toSessionId: target.id,
            originNotify: request.payload.originNotify,
            sourceMessageIds,
          },
        });
        const activeRun = new TaskRunStore(db).getActiveRunForTask(taskId);
        return {
          taskId,
          ...(previousPrimaryId ? { previousSessionId: previousPrimaryId } : {}),
          taskSessionId: target.id,
          targetSessionId: target.id,
          originNotify: request.payload.originNotify,
          ...(activeRun ? { runId: activeRun.id } : {}),
          ...(shouldSendCard && activeRun ? { spawnStatusCard: true } : {}),
        };
      }
      if (!isLinkedSession)
        throw new GatewayError("task_scope_mismatch", "Task does not belong to this conversation", 403);
    }
    const store = new SessionStore(db);
    const targetSessionId = request.kind === "task.create"
      ? request.payload.sessionId ?? sessionId
      : existing!.primary_session_id ?? sessionId;
    const target = store.getById(targetSessionId);
    if (!target || target.status !== "active") throw new GatewayError("session_unavailable", "Task target session unavailable", 409);
    scopes.assertSame(scope,scopes.session(target.id));
    store.requireReplyUserId(target.id);
    if (request.kind === "task.cancel") {
      // Freeze the selected run before dispatch. Retrying this command must never
      // cancel a later run started explicitly by another request.
      const run = new TaskRunStore(db).getActiveRunForTask(taskId);
      return {taskId, taskSessionId: target.id, ...(run ? {runId: run.id} : {}), cancelled: false};
    }
    if (target.id !== sessionId) for (const messageId of sourceMessageIds)
      new SessionTimelineStore(db).appendReference({sessionId: target.id, messageId});
    const identity = requestedIdentityFromInbound(inbound) ?? {provider: "local", externalUserId: actorUserId, canonicalUserId: actorUserId};
    const creatorUserId = canonicalUserIdForRequestedIdentity(db, scope.agentId, identity) ?? actorUserId;
    const sourceMessageId = sourceMessageIds.at(-1);
    const entry = sourceMessageId ? db.select().from(sessionTimelineEntries).where(and(eq(sessionTimelineEntries.sessionId, sessionId), eq(sessionTimelineEntries.messageId, sourceMessageId))).get() : undefined;
    if (request.kind === "task.create") {
      db.insert(tasks).values({id: taskId, agent_id:scope.agentId,shadow_id:scope.shadowId, type: request.payload.taskType, title: request.payload.title,
        summary: request.payload.summary, status: "new", creator_user_id: creatorUserId, primary_session_id: target.id,
        source_message_id: sourceMessageId ?? null, source_entry_id: entry?.id ?? null,
        context_json: {latestUserMessage: inbound.text, knownFacts: request.payload.facts, pendingQuestions: [],
          requestedByIdentity: identity, ...(assumptions ? {assumptions: assumptions} : {})},
        created_at: now, updated_at: now, last_activity_at: now}).run();
      new SessionStateStore(db).clearClarification(sessionId);
    }
    // The command itself is recorded in runner_operations; the Task's sources are the people's
    // own messages. Its title, summary and facts live on the Task row.
    const packs = new ContextPackStore(db);
    for (const messageId of sourceMessageIds) packs.appendTaskSourceItem({taskId, sessionId, messageId});
    if (request.kind === "task.create") {
      for (const pack of packs.listPacksForOwner("session", target.id).filter(pack => pack.kind === "thread_launch" || pack.kind === "group_launch")) {
        for (const item of packs.listItemsForPack(pack.id)) {
          if (item.sourceMessageId && item.sourceSessionId)
            packs.appendTaskSourceItem({taskId, sessionId: item.sourceSessionId, messageId: item.sourceMessageId});
        }
      }
    }
    db.insert(taskParticipants).values({id: randomUUID(), task_id: taskId, user_id: creatorUserId, role: "requester", created_at: now}).onConflictDoNothing().run();
    const subscription = new TaskSubscriptionStore(db).resolve({taskId, sessionId: target.id,
      channelType: target.channel_type, channelId: target.channel_id,
      ...(target.group_id ? {groupId: target.group_id} : {}),
      ...(target.thread_key ? {threadId: target.thread_key} : {}),
      ...(target.root_message_key ? {rootMessageId: target.root_message_key} : {}),
      // What the Runner leaves unchosen follows the Agent's settings.
      ...(request.kind === "task.create" ? (() => {
        const card = new AgentSettingsStore(db).get(scope.agentId).main.taskProgressCard;
        return {statusCardStyle: request.payload.statusCardStyle ?? card.style,
          notificationLevel: (request.payload.sendStatusCard ?? card.send) ? "major_updates" as const : "none" as const};
      })() : {}),
      visibility: "full"});
    // An existing subscription keeps its card preference unless this command chooses one.
    if (request.kind !== "task.create" && request.payload.sendStatusCard !== undefined)
      db.update(taskSubscriptions).set({notification_level: request.payload.sendStatusCard ? "major_updates" : "none", updated_at: now})
        .where(eq(taskSubscriptions.id, subscription.id)).run();
    // A message may carry several commands, so the event is keyed by the command; its sources are in data.
    new TimelineStore(db).append({taskId, sessionId,
      type: request.kind === "task.create" ? "task.created" : "message.received",
      summary: request.kind === "task.create" ? request.payload.title : request.kind === "task.update" ? request.payload.updateSummary : "Restart with existing task context",
      data: {operationId: id, sourceMessageIds, ...(assumptions ? {assumptions: assumptions} : {})}});
    return {taskId, ...(sourceMessageId ? {sourceMessageId} : {}), taskSessionId: target.id};
  }

  dispatch(operationId: string, request: TaskRequest, context: OperationContext, result: OperationResult): OperationResult {
    const taskId = result.taskId!;
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) throw new GatewayError("task_not_found", "Task no longer exists", 404);
    const scopes=new TaskScopeResolver(this.db),scope=scopes.task(taskId);
    scopes.assertSame(scope,scopes.session(context.sessionId));
    scopes.assertSame(scope,scopes.session(result.taskSessionId??context.sessionId));
    new AgentStore(this.db).requireAccess(context.actorUserId,scope.agentId);
    new SessionStore(this.db).requireReplyUserId(result.taskSessionId??context.sessionId);
    if (request.kind === "task.transfer" || request.kind === "task.watch" || request.kind === "task.unwatch") {
      return result;
    }
    if (request.kind === "task.cancel") {
      if (result.runId) {
        const run = this.supervisor.cancelTaskRun({taskId, runId: result.runId, reason: request.payload.reason});
        return {...result, cancelled: run?.status === "cancelled"};
      }
      const cancelledWaiting = this.supervisor.cancelWaitingTask?.({taskId, reason: request.payload.reason}) ?? false;
      return {...result, cancelled: cancelledWaiting};
    }
    const inputSnapshot = {operation: request.kind, operationId, sessionId: result.taskSessionId ?? context.sessionId, messageRowId: result.sourceMessageId,
      messageRowIds: context.sourceMessageIds, inbound: context.inbound,
      ...(request.kind !== "task.create" && request.payload.quiet ? {quiet: true} : {}),
      requestedByIdentity: requestedIdentityFromInbound(context.inbound) ?? {provider: "local", externalUserId: context.actorUserId, canonicalUserId: context.actorUserId}};
    const source = result.sourceMessageId ? {sourceMessageId: result.sourceMessageId} : {};
    const run = request.kind === "task.create"
      ? this.supervisor.startInitialRun({taskId, inputSnapshot, operationId, ...source})
      : this.supervisor.restartTaskRun({taskId, inputSnapshot, operationId, ...source,
          ...(request.kind === "task.update" ? {
            updatedTaskSummary: request.payload.updatedTaskSummary ?? task.summary ?? "",
            updateSummary: request.payload.updateSummary,
            ...(request.payload.updatedTaskTitle ? {updatedTaskTitle: request.payload.updatedTaskTitle} : {}),
            ...(request.payload.assumptions ? {assumptions: request.payload.assumptions} : {}),
          } : {updatedTaskSummary: task.summary ?? "", updateSummary: "Restart with existing task context", preserveTaskContext: true})});
    return {...result, runId: run.id};
  }
}
