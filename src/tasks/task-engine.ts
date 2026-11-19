import {TaskScopeResolver} from "@/agents/task-scope";
import { and, eq } from "drizzle-orm";

import type { MessageRow } from "@/sessions/message-store";
import type { SessionRow } from "@/sessions/session-store";
import type { NormalizedInboundMessage } from "@/channels";
import { normalizedRootMessageExternalId } from "@/channels";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import type { DrizzleDB } from "@/data";
import { tasks, taskParticipants } from "@/data/schema";
import { ContextPackStore } from "@/context";
import {
  canonicalUserIdForRequestedIdentity,
  requiresExplicitRequesterIdentity,
  requestedIdentityFromInbound,
} from "@/identity/requested-identity";
import { TimelineStore } from "@/timeline/timeline-store";
import type { RouteDecision, ReplyChannel } from "@/channels/outbound";
import { uuid } from "@/shared";

import { TaskResolver } from "./task-resolver";
import { taskWithLatestRunStatus } from "./task-status-projection";
import { TaskSubscriptionStore } from "./task-subscription-store";
import type {
  PersistentTaskResolved,
  TaskType,
} from "./types";

/**
 * Configuration options for task engine behavior in the task workflow.
 */
export interface TaskEngineOptions {
  readonly db: DrizzleDB;
  readonly channel: ReplyChannel;
}

/**
 * Input contract for create or update task operations in the task workflow.
 */
export interface CreateOrUpdateTaskInput {
  readonly sessionId: string;
  readonly primarySessionId?: string;
  readonly sourceEntryId?: string;
  readonly sourceTurnEntryId?: string;
  readonly messageRowId: string;
  readonly route: Extract<RouteDecision, { kind: "persistent_task" }>;
  readonly inbound: NormalizedInboundMessage;
  readonly sourceTaskId?: string;
  readonly onTaskResolved?: (result: PersistentTaskResolved) => void;
}

/**
 * Input contract for attach existing task operations in the task workflow.
 */
export interface AttachExistingTaskInput extends CreateOrUpdateTaskInput {
  readonly taskId: string;
}

/**
 * Coordinates Task Engine responsibilities in task workflow.
 */
export class TaskEngine {
  private readonly _taskResolver: TaskResolver;
  private readonly _subscriptionStore: TaskSubscriptionStore;
  private readonly _timelineStore: TimelineStore;
  private readonly _contextPackStore: ContextPackStore;

  constructor(private readonly _options: TaskEngineOptions) {
    this._taskResolver = new TaskResolver(_options.db);
    this._subscriptionStore = new TaskSubscriptionStore(_options.db);
    this._timelineStore = new TimelineStore(_options.db);
    this._contextPackStore = new ContextPackStore(_options.db);
  }

  async createOrUpdateTask(input: CreateOrUpdateTaskInput): Promise<string> {
    const result = await this.createOrUpdateTaskResult(input);
    return result.persistentTask.id;
  }

  async createOrUpdateTaskResult(
    input: CreateOrUpdateTaskInput,
  ): Promise<PersistentTaskResolved> {
    return await this._handlePersistentTask(input);
  }

  async attachExistingTaskResult(
    input: AttachExistingTaskInput,
  ): Promise<PersistentTaskResolved> {
    const persistentTask = this._options.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.type, persistentTaskType(input.route.workflow)),
        ),
      )
      .get();
    if (!persistentTask) {
      throw new Error(`Task "${input.taskId}" was not found.`);
    }

    const scope=new TaskScopeResolver(this._options.db);
    scope.assertSame(scope.task(persistentTask.id),scope.session(this._workSessionId(input)));
    return await this._handleResolvedPersistentTask(input, {
      persistentTask,
      created: false,
    });
  }

  private async _handlePersistentTask(
    input: CreateOrUpdateTaskInput,
  ): Promise<PersistentTaskResolved> {
    const workSessionId = this._workSessionId(input);
    const canonicalCreatorUserId = this._canonicalRequesterUserId(input.inbound, workSessionId);
    const persistedCreatorIdentity = this._persistedRequesterIdentity(input.inbound);
    const result = this._taskResolver.resolvePersistentTask({
      text: input.inbound.text,
      title: this._titleForMessage(input.inbound.text),
      workflow: persistentTaskType(input.route.workflow),
      ...(canonicalCreatorUserId === undefined
        ? {}
        : { creatorUserId: canonicalCreatorUserId }),
      ...(persistedCreatorIdentity === undefined
        ? {}
        : { creatorIdentity: persistedCreatorIdentity }),
      ...(input.route.taskId !== undefined ? { taskId: input.route.taskId } : {}),
      ...(input.sourceTaskId !== undefined
        ? { sourceTaskId: input.sourceTaskId }
        : {}),
      source: {
        sessionId: workSessionId,
        messageId: input.messageRowId,
        sourceEntryId: input.sourceEntryId ?? null,
        sourceTurnEntryId: input.sourceTurnEntryId ?? input.sourceEntryId ?? null,
        primarySessionId: workSessionId,
        ...(canonicalCreatorUserId === undefined
          ? {}
          : { userId: canonicalCreatorUserId }),
      },
    });
    return await this._handleResolvedPersistentTask(input, result);
  }

  private async _handleResolvedPersistentTask(
    input: CreateOrUpdateTaskInput,
    result: PersistentTaskResolved,
  ): Promise<PersistentTaskResolved> {
    const { created } = result;
    const persistentTask = taskWithLatestRunStatus(
      this._options.db,
      result.persistentTask,
    );
    const workSessionId = this._workSessionId(input);
    const threadExternalId = input.inbound.thread?.externalId;
    const rootMessageExternalId = normalizedRootMessageExternalId(input.inbound);
    const subscription = this._subscriptionStore.resolve({
      taskId: persistentTask.id,
      sessionId: workSessionId,
      channelType: input.inbound.channel.type,
      channelId: input.inbound.channel.id,
      groupId: input.inbound.surface.externalId,
      ...(threadExternalId !== undefined ? { threadId: threadExternalId } : {}),
      ...(rootMessageExternalId !== undefined
        ? { rootMessageId: rootMessageExternalId }
        : {}),
      visibility: created ? "full" : "summary",
    });
    const visibility = subscription.visibility;
    const resolvedResult = { ...result, persistentTask, subscription };

    input.onTaskResolved?.(resolvedResult);

    this._timelineStore.append({
      taskId: persistentTask.id,
      sessionId: workSessionId,
      messageId: input.messageRowId,
      type: "route",
      summary: `Routed inbound message to ${persistentTask.type} workflow.`,
      data: input.route,
    });

    if (created) {
      this._timelineStore.append({
        taskId: persistentTask.id,
        sessionId: workSessionId,
        messageId: input.messageRowId,
        type: "task.created",
        summary: `Created ${persistentTask.type} workflow ${persistentTask.title}.`,
      });
    }

    this._timelineStore.append({
      taskId: persistentTask.id,
      sessionId: workSessionId,
      messageId: input.messageRowId,
      type: "message.received",
      summary: `Received ${persistentTask.type} message.`,
      data: { channel_message_key: input.inbound.id },
      visibility,
    });

    this._appendSourceAndParticipant(
      persistentTask.id,
      workSessionId,
      input.messageRowId,
      input.sourceEntryId,
      input.sourceTurnEntryId,
      this._canonicalRequesterUserId(input.inbound, workSessionId),
    );

    this._taskResolver.touch(persistentTask.id);
    return resolvedResult;
  }

  private _workSessionId(input: CreateOrUpdateTaskInput): string {
    return input.primarySessionId ?? input.sessionId;
  }

  /** The requester as a user of the session's Agent. */
  private _canonicalRequesterUserId(
    inbound: NormalizedInboundMessage,
    sessionId: string,
  ): string | undefined {
    const requestedByIdentity = requestedIdentityFromInbound(inbound);
    this._assertProviderScopedRequesterIsExplicit(inbound, requestedByIdentity);
    this._materializeRequesterIdentity(inbound, requestedByIdentity);
    return canonicalUserIdForRequestedIdentity(
      this._options.db,
      new TaskScopeResolver(this._options.db).session(sessionId).agentId,
      requestedByIdentity,
    );
  }

  private _persistedRequesterIdentity(
    inbound: NormalizedInboundMessage,
  ): ReturnType<typeof requestedIdentityFromInbound> {
    const requestedByIdentity = requestedIdentityFromInbound(inbound);
    this._assertProviderScopedRequesterIsExplicit(inbound, requestedByIdentity);
    return requestedByIdentity?.provider === "local"
      ? undefined
      : requestedByIdentity;
  }

  private _materializeRequesterIdentity(
    inbound: NormalizedInboundMessage,
    requestedByIdentity: ReturnType<typeof requestedIdentityFromInbound>,
  ): void {
    if (requestedByIdentity === undefined) {
      return;
    }
    if (inbound.sender.kind !== "user" && inbound.sender.kind !== "bot") {
      return;
    }
    new ChannelDirectoryStore(this._options.db).upsertIdentity({
      channel: inbound.channel,
      identity: inbound.sender,
    });
  }

  private _assertProviderScopedRequesterIsExplicit(
    inbound: NormalizedInboundMessage,
    requestedByIdentity: ReturnType<typeof requestedIdentityFromInbound>,
  ): void {
    if (
      requiresExplicitRequesterIdentity(inbound) &&
      requestedByIdentity === undefined
    ) {
      throw new Error(
        "Task requester requires an explicit normalized requester identity.",
      );
    }
  }

  private _titleForMessage(text: string): string {
    const [beforeComma] = text.split(/[，,]/u);
    return (beforeComma?.trim() || text.trim()).slice(0, 80);
  }

  private _appendSourceAndParticipant(
    taskId: string,
    sessionId: SessionRow["id"],
    messageId: MessageRow["id"],
    sourceEntryId?: string,
    sourceTurnEntryId?: string,
    senderUserId?: string,
  ): void {
    const now = Date.now();
    this._contextPackStore.appendTaskSourceItem({
      taskId,
      sessionId,
      messageId,
      sourceEntryId: sourceEntryId ?? null,
      sourceTurnEntryId: sourceTurnEntryId ?? sourceEntryId ?? null,
      userId: senderUserId ?? null,
      createdAt: now,
    });

    if (senderUserId === undefined) {
      return;
    }
    this._options.db
      .insert(taskParticipants)
      .values({
        id: uuid(),
        task_id: taskId,
        user_id: senderUserId,
        role: "requester",
        created_at: now,
      })
      .onConflictDoNothing({
        target: [
          taskParticipants.task_id,
          taskParticipants.user_id,
          taskParticipants.role,
        ],
      })
      .run();
  }
}

function persistentTaskType(workflow: TaskType): TaskType {
  return workflow;
}
