import {BotBindingStore} from "@/agents/bot-binding-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import {SessionStore} from "@/sessions/session-store";
import { and, eq, isNull } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { taskSubscriptions } from "@/data/schema";
import { uuid } from "@/shared";

import type { TaskSubscription, TaskVisibility, TaskNotificationLevel } from "./types";

/**
 * Input contract for resolve task subscription operations in the task workflow.
 */
export interface ResolveTaskSubscriptionInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly visibility: TaskVisibility;
  readonly statusCardStyle?: "card" | "native";
  readonly notificationLevel?: TaskNotificationLevel;
}

/**
 * Input contract for find task subscription for surface operations in the task workflow.
 */
export interface FindTaskSubscriptionForSurfaceInput {
  readonly channelType: string;
  readonly channelId: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
}

/**
 * Persists and reads Task Subscription Store records for task workflow.
 */
export class TaskSubscriptionStore {
  constructor(private readonly _db: DrizzleDB) {}

  resolve(input: ResolveTaskSubscriptionInput): TaskSubscription {
    const scope=new TaskScopeResolver(this._db);
    scope.assertSame(scope.task(input.taskId),scope.session(input.sessionId));
    const sessions=new SessionStore(this._db),session=sessions.getById(input.sessionId)!;
    if(session.channel_type!==input.channelType||session.channel_id!==input.channelId)throw new Error("subscription_channel_mismatch");
    if(input.channelType!=="dashboard")sessions.requireChannelScope(session,input.channelId);
    const normalizedInput = normalizedTaskSubscriptionInput(input);
    const surfaceKey = createTaskSubscriptionSurfaceKey(normalizedInput);
    const existing = this._db
      .select()
      .from(taskSubscriptions)
      .where(
        and(
          eq(taskSubscriptions.task_id, normalizedInput.taskId),
          eq(taskSubscriptions.surface_key, surfaceKey),
        ),
      )
      .get();
    if (existing) {
      return this._upgradeExisting(existing, normalizedInput, surfaceKey);
    }
    const singleSurfaceSubscription =
      this._findSingleExistingSubscriptionForRootlessTask(normalizedInput);
    if (singleSurfaceSubscription) {
      return this._upgradeExisting(
        singleSurfaceSubscription,
        normalizedInput,
        surfaceKey,
      );
    }

    const now = Date.now();
    const row = {
      id: uuid(),
      task_id: normalizedInput.taskId,
      session_id: normalizedInput.sessionId,
      channel_type: normalizedInput.channelType,
      channel_id: normalizedInput.channelId,
      group_id: normalizedInput.groupId ?? null,
      thread_key: normalizedInput.threadId ?? null,
      root_message_key: normalizedInput.rootMessageId ?? null,
      surface_key: surfaceKey,
      visibility: normalizedInput.visibility,
      status_card_style: normalizedInput.statusCardStyle ?? "card",
      notification_level: normalizedInput.notificationLevel ?? "major_updates",
      created_at: now,
      updated_at: now,
    } satisfies TaskSubscription;
    this._db.insert(taskSubscriptions).values(row).run();
    return row;
  }

  listForTask(taskId: string): TaskSubscription[] {
    return this._db
      .select()
      .from(taskSubscriptions)
      .where(eq(taskSubscriptions.task_id, taskId))
      .all();
  }

  findForSurface(
    input: FindTaskSubscriptionForSurfaceInput,
  ): TaskSubscription | undefined {
    const binding=input.channelType==="dashboard"?undefined:new BotBindingStore(this._db).requireActive(input.channelId);
    return this._db
      .select()
      .from(taskSubscriptions)
      .where(
        and(
          eq(taskSubscriptions.channel_type, input.channelType),
          eq(taskSubscriptions.channel_id, input.channelId),
          input.groupId === undefined
            ? isNull(taskSubscriptions.group_id)
            : eq(taskSubscriptions.group_id, input.groupId),
        ),
      )
      .all()
      .find((subscription) => {
        const session=new SessionStore(this._db).getById(subscription.session_id);
        if(!session||session.status!=="active"||(binding&&session.binding_id!==binding.id))return false;
        if (
          input.threadId !== undefined &&
          subscription.thread_key === input.threadId
        ) {
          return true;
        }
        if (input.rootMessageId === undefined) {
          return false;
        }
        return (
          subscription.root_message_key === input.rootMessageId
        );
      });
  }

  requireById(subscriptionId: string): TaskSubscription {
    const row = this._db
      .select()
      .from(taskSubscriptions)
      .where(eq(taskSubscriptions.id, subscriptionId))
      .get();
    if (!row) {
      throw new Error(`Task subscription "${subscriptionId}" was not found.`);
    }
    return row;
  }

  private _upgradeExisting(
    existing: TaskSubscription,
    input: ResolveTaskSubscriptionInput,
    surfaceKey: string,
  ): TaskSubscription {
    const visibility =
      existing.visibility === "full" || input.visibility !== "full"
        ? existing.visibility
        : "full";
    const nextSessionId =
      existing.session_id === input.sessionId
        ? undefined
        : input.sessionId;
    const nextRootMessageId =
      existing.root_message_key !== null || input.rootMessageId === undefined
        ? undefined
        : input.rootMessageId;
    const nextThreadId =
      existing.thread_key === (input.threadId ?? null) ||
      input.threadId === undefined
        ? undefined
        : input.threadId;
    const nextSurfaceKey =
      existing.surface_key === surfaceKey ? undefined : surfaceKey;

    if (
      visibility === existing.visibility &&
      nextSessionId === undefined &&
      nextRootMessageId === undefined &&
      nextThreadId === undefined &&
      nextSurfaceKey === undefined
    ) {
      return existing;
    }

    const updatedAt = Date.now();
    this._db
      .update(taskSubscriptions)
      .set({
        ...(nextSessionId !== undefined
          ? { session_id: nextSessionId }
          : {}),
        ...(nextRootMessageId !== undefined
          ? { root_message_key: nextRootMessageId }
          : {}),
        ...(nextThreadId !== undefined ? { thread_key: nextThreadId } : {}),
        ...(nextSurfaceKey !== undefined ? { surface_key: nextSurfaceKey } : {}),
        visibility,
        updated_at: updatedAt,
      })
      .where(eq(taskSubscriptions.id, existing.id))
      .run();

    return {
      ...existing,
      ...(nextSessionId !== undefined
        ? { session_id: nextSessionId }
        : {}),
      ...(nextRootMessageId !== undefined
        ? { root_message_key: nextRootMessageId }
        : {}),
      ...(nextThreadId !== undefined ? { thread_key: nextThreadId } : {}),
      ...(nextSurfaceKey !== undefined ? { surface_key: nextSurfaceKey } : {}),
      visibility,
      updated_at: updatedAt,
    };
  }

  private _findSingleExistingSubscriptionForRootlessTask(
    input: ResolveTaskSubscriptionInput,
  ): TaskSubscription | undefined {
    if (input.threadId !== undefined || input.rootMessageId !== undefined) {
      return undefined;
    }

    const candidates = this._db
      .select()
      .from(taskSubscriptions)
      .where(
        and(
          eq(taskSubscriptions.task_id, input.taskId),
          eq(taskSubscriptions.channel_type, input.channelType),
          eq(taskSubscriptions.channel_id, input.channelId),
          input.groupId === undefined
            ? isNull(taskSubscriptions.group_id)
            : eq(taskSubscriptions.group_id, input.groupId),
        ),
      )
      .all();

    return candidates.length === 1 ? candidates[0] : undefined;
  }

}

function normalizedTaskSubscriptionInput(
  input: ResolveTaskSubscriptionInput,
): ResolveTaskSubscriptionInput {
  if (input.rootMessageId === undefined || input.threadId === undefined) {
    return input;
  }
  return {
    ...input,
    threadId: input.rootMessageId,
  };
}

/**
 * Executes create Task Subscription Surface Key logic for task workflow.
 */
export function createTaskSubscriptionSurfaceKey(input: {
  readonly channelType: string;
  readonly channelId: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
}): string {
  const discriminator =
    input.threadId !== undefined && input.threadId !== null
      ? ["thread", input.threadId]
      : input.rootMessageId !== undefined && input.rootMessageId !== null
        ? ["root", input.rootMessageId]
        : ["channel", "rootless"];

  return JSON.stringify([
    "v1",
    input.channelType,
    input.channelId,
    input.groupId ?? null,
    ...discriminator,
  ]);
}
