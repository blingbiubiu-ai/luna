import {TaskScopeResolver} from "@/agents/task-scope";
import {AgentError,AgentStore,type AgentScope} from "@/agents/agent-store";
import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { tasks, timelineEvents } from "@/data/schema";
import { ContextPackStore } from "@/context";
import type { RequestedIdentityContext } from "@/identity/requested-identity";
import { createId } from "@/shared";

import {
  REUSABLE_TASK_STATUSES,
  type TaskType,
  type PersistentTask,
} from "./types";

/**
 * Input contract for resolve persistent task operations in the task workflow.
 */
export interface ResolvePersistentTaskInput {
  readonly scope?: AgentScope;
  readonly text: string;
  readonly title: string;
  readonly workflow: TaskType;
  readonly creatorUserId?: string | null;
  readonly creatorIdentity?: RequestedIdentityContext;
  readonly taskId?: string;
  readonly sourceTaskId?: string;
  readonly source?: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly sourceEntryId?: string | null;
    readonly sourceTurnEntryId?: string | null;
    readonly primarySessionId?: string | null;
    readonly userId?: string;
  };
}

/**
 * Represents Resolve Persistent Task Result values used by task workflow.
 */
export interface ResolvePersistentTaskResult {
  readonly persistentTask: PersistentTask;
  readonly created: boolean;
}

/**
 * Resolves Task Resolver responsibilities in task workflow.
 */
export class TaskResolver {
  private readonly _contextPackStore: ContextPackStore;

  constructor(private readonly _db: DrizzleDB) {
    this._contextPackStore = new ContextPackStore(_db);
  }

  resolvePersistentTask(
    input: ResolvePersistentTaskInput,
  ): ResolvePersistentTaskResult {
    return this._db.transaction((tx) =>
      new TaskResolver(tx as unknown as DrizzleDB)._resolvePersistentTask(input),
    );
  }

  private _resolvePersistentTask(
    input: ResolvePersistentTaskInput,
  ): ResolvePersistentTaskResult {
    const resolver=new TaskScopeResolver(this._db);
    const scope=input.source?resolver.session(input.source.sessionId):input.scope;
    if(!scope)throw new AgentError("task_scope_required",400);
    resolver.active(scope);
    if(input.scope)resolver.assertSame(scope,input.scope);
    if(input.source?.primarySessionId)resolver.assertSame(scope,resolver.session(input.source.primarySessionId));
    if(input.creatorUserId)new AgentStore(this._db).requireAccess(input.creatorUserId,scope.agentId);
    const check=(task:PersistentTask)=>resolver.assertSame(scope,{agentId:task.agent_id,shadowId:task.shadow_id});
    const existingBySourceMessage =
      input.source !== undefined
        ? this.findTaskForSourceMessage(input.source.messageId)
        : undefined;
    if (existingBySourceMessage) {
      check(existingBySourceMessage);
      this._appendSource(existingBySourceMessage.id, input.source);
      return {
        persistentTask: existingBySourceMessage,
        created: false,
      };
    }

    const existingBySource =
      input.sourceTaskId !== undefined
        ? this._findTaskById(input.sourceTaskId)
        : undefined;
    if (existingBySource) {
      check(existingBySource);
      this._appendSource(existingBySource.id, input.source);
      return {
        persistentTask: existingBySource,
        created: false,
      };
    }

    if(input.taskId) {const explicit=this._findTaskById(input.taskId);if(explicit)check(explicit);}
    const existingByRouteId =
      input.taskId !== undefined
        ? this._findReusableTaskById(input.taskId, input.workflow)
        : undefined;
    if (existingByRouteId) {
      check(existingByRouteId);
      this._appendSource(existingByRouteId.id, input.source);
      return {
        persistentTask: existingByRouteId,
        created: false,
      };
    }

    const existingById = this._findTaskMention(input.text, input.workflow,scope);
    if (existingById) {
      check(existingById);
      this._appendSource(existingById.id, input.source);
      return {
        persistentTask: existingById,
        created: false,
      };
    }

    const now = Date.now();
    const row = {
      id: createId("task"),
      agent_id:scope.agentId,shadow_id:scope.shadowId,
      type: input.workflow,
      status: "new",
      block_reason: null,
      priority: input.workflow === "approval" ? "high" : "medium",
      severity: null,
      title: input.title,
      summary: input.text,
      creator_user_id: input.creatorUserId ?? null,
      primary_session_id:
        input.source?.primarySessionId ?? input.source?.sessionId ?? null,
      source_message_id: input.source?.messageId ?? null,
      source_entry_id: input.source?.sourceEntryId ?? null,
      context_json: {
        latestUserMessage: input.text,
        knownFacts: [],
        pendingQuestions: [],
        ...(input.creatorIdentity === undefined
          ? {}
          : { requestedByIdentity: input.creatorIdentity }),
      },
      created_at: now,
      updated_at: now,
      last_activity_at: now,
    } satisfies PersistentTask;
    this._db.insert(tasks).values(row).run();
    this._appendSource(row.id, input.source);
    return { persistentTask: row, created: true };
  }

  findTaskForSourceMessage(messageRowId: string): PersistentTask | undefined {
    const taskId =
      this._contextPackStore.findTaskIdForSourceMessage(messageRowId);
    if (taskId === undefined) {
      return this._findTaskByTimelineMessage(messageRowId);
    }

    return this._findTaskById(taskId);
  }

  private _appendSource(
    taskId: string,
    source: ResolvePersistentTaskInput["source"] | undefined,
  ): void {
    if (source === undefined) {
      return;
    }

    const resolver=new TaskScopeResolver(this._db);
    resolver.assertSame(resolver.task(taskId),resolver.session(source.sessionId));
    this._contextPackStore.appendTaskSourceItem({
      taskId,
      sessionId: source.sessionId,
      messageId: source.messageId,
      sourceEntryId: source.sourceEntryId ?? null,
      sourceTurnEntryId: source.sourceTurnEntryId ?? source.sourceEntryId ?? null,
      userId: source.userId ?? null,
    });
  }

  touch(taskId: string, activityAt = Date.now()): void {
    this._db
      .update(tasks)
      .set({
        updated_at: activityAt,
        last_activity_at: activityAt,
      })
      .where(eq(tasks.id, taskId))
      .run();
  }

  private _findReusableTaskById(
    taskId: string,
    workflow: TaskType,
  ): PersistentTask | undefined {
    const candidate = this._findTaskById(taskId, workflow);
    if (!candidate || !this._canReuse(candidate)) {
      return undefined;
    }
    return candidate;
  }

  private _findTaskById(
    taskId: string,
    workflow?: TaskType,
  ): PersistentTask | undefined {
    return this._db
      .select()
      .from(tasks)
      .where(
        workflow === undefined
          ? eq(tasks.id, taskId)
          : and(eq(tasks.id, taskId), eq(tasks.type, workflow)),
      )
      .get();
  }

  private _findTaskMention(
    text: string,
    workflow: TaskType,
    scope: AgentScope,
  ): PersistentTask | undefined {
    const allTasks = this._db.select().from(tasks).where(and(eq(tasks.agent_id,scope.agentId),eq(tasks.shadow_id,scope.shadowId))).all();
    const normalizedText = text.toLowerCase();
    return allTasks.find(
      (row) =>
        row.type === workflow &&
        normalizedText.includes(row.id.toLowerCase()) &&
        this._canReuse(row),
    );
  }

  private _findTaskByTimelineMessage(
    messageRowId: string,
  ): PersistentTask | undefined {
    const timelineRow = this._db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.message_id, messageRowId))
      .all()
      .find((row) => ["route", "message.received"].includes(row.type));
    if (!timelineRow) {
      return undefined;
    }

    return this._findTaskById(timelineRow.task_id);
  }

  private _canReuse(candidate: PersistentTask): boolean {
    const reusableStatuses = new Set<string>(REUSABLE_TASK_STATUSES);
    return reusableStatuses.has(candidate.status);
  }
}
