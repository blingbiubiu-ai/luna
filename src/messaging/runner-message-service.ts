import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { extractReplyEnvelope, parseReply, replyMarkdown, type ReplyDocument } from "@luna/runner-protocol/reply";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import { channelSurfaces, sessions, taskRuns, tasks, taskSubscriptions } from "@/data/schema";
import { InvocationService } from "@/runners/invocation-service";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import { TaskInboxStore, type TaskInboxEventRow } from "@/tasks/task-inbox-store";
import { resumeWaitingTaskIfIdle } from "@/tasks/task-resume-registry";
import { TimelineStore } from "@/timeline/timeline-store";
import type { RequestActor } from "./correlated-request-service";
import { sessionCommandsFor } from "./session-command-service";

export class RunnerMessageService {
  constructor(
    private readonly db: DrizzleDB,
    private readonly channelFor: (id: string) => ReplyChannel | undefined,
  ) {}

  /** Resolves an active Main or Work Runner actor. */
  actor(claims: LunaAccessTokenClaims | undefined): RequestActor {
    if (
      claims?.source !== "runner" ||
      claims.role !== "runner" ||
      !["main", "work"].includes(claims.runnerKind ?? "")
    ) {
      throw new GatewayError(
        "runner_required",
        "A Main or Work Runner token is required",
        403,
      );
    }
    const { invocation, snapshot } = new InvocationService(
      this.db,
    ).requireActive(claims, claims.runnerKind as "main" | "work");
    if (snapshot.kind === "task") {
      throw new GatewayError("runner_required", "Main or Work required", 403);
    }
    const source =
      snapshot.kind === "main" &&
      snapshot.input.input.type === "session_trigger"
        ? snapshot.input.input
        : undefined;
    return {
      userId: invocation.actorUserId,
      agentId: invocation.agentId,
      shadowId: invocation.shadowId,
      runnerKind: claims.runnerKind as "main" | "work",
      invocationId: invocation.id,
      sourceSessionId: invocation.sessionId!,
      currentSessionId: invocation.sessionId!,
      originId: invocation.originId,
      ...(snapshot.kind === "main" &&
      snapshot.input.input.type === "user_messages"
        ? { triggerMessageId: snapshot.input.input.messages.at(-1)?.messageId }
        : {}),
      contextBefore: invocation.createdAt,
      ...(source ? { correlationId: source.correlationId, hops: source.hops } : {}),
    };
  }

  /** Resolves an active Main, Work, or Task Runner actor. */
  anyActor(claims: LunaAccessTokenClaims | undefined): RequestActor {
    if (
      claims?.source !== "runner" ||
      claims.role !== "runner" ||
      !["main", "work", "task"].includes(claims.runnerKind ?? "")
    ) {
      throw new GatewayError(
        "runner_required",
        "A Runner token is required",
        403,
      );
    }
    if (claims.runnerKind !== "task") {
      return this.actor(claims);
    }
    const { invocation } = new InvocationService(this.db).requireActive(
      claims,
      "task",
    );
    if (!invocation.taskId) {
      throw new GatewayError("task_not_found", "Task scope missing", 404);
    }
    const taskRow = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, invocation.taskId))
      .get();
    if (!taskRow) {
      throw new GatewayError("task_not_found", "Task no longer exists", 404);
    }
    const primarySessionId =
      taskRow.primary_session_id ??
      this.db
        .select({ sessionId: taskSubscriptions.session_id })
        .from(taskSubscriptions)
        .where(eq(taskSubscriptions.task_id, taskRow.id))
        .get()?.sessionId;
    if (!primarySessionId) {
      throw new GatewayError(
        "session_unavailable",
        "Task has no subscribed Main session",
        409,
      );
    }
    return {
      userId: invocation.actorUserId,
      agentId: invocation.agentId,
      shadowId: invocation.shadowId,
      runnerKind: "task",
      taskId: invocation.taskId,
      taskRunId: invocation.taskRunId ?? undefined,
      invocationId: invocation.id,
      sourceSessionId: primarySessionId,
      currentSessionId: primarySessionId,
      originId: invocation.originId,
      contextBefore: invocation.createdAt,
    };
  }

  get(claims: LunaAccessTokenClaims | undefined, id: string) {
    const actor = this.anyActor(claims);
    const row = sessionCommandsFor(this.db, this.channelFor).get(id);
    if (
      !row ||
      row.actorUserId !== actor.userId ||
      row.sourceSessionId !== actor.sourceSessionId ||
      (row.sessionId !== actor.currentSessionId &&
        row.originId !== actor.originId)
    ) {
      throw new GatewayError("command_not_found", "Command not found", 404);
    }
    return row;
  }

  async send(
    claims: LunaAccessTokenClaims | undefined,
    key: string,
    content: string,
    purpose: "progress" | "answer" | "notification",
    targetSessionId?: string,
    reply?: ReplyDocument,
    mentionBotUserId?: string,
  ) {
    if (key === "service-final-answer") {
      throw new GatewayError("reserved_request_id", "Reserved request ID", 400);
    }
    const actor = this.actor(claims);
    if (!reply && !mentionBotUserId && extractReplyEnvelope(content)) {
      reply = parseReply(content);
      content = replyMarkdown(reply);
    } else if (reply) {
      reply = parseReply(JSON.stringify(reply));
      content = replyMarkdown(reply);
    }
    const destination = targetSessionId ?? actor.currentSessionId;
    const authoredBy =
      destination === actor.currentSessionId ? "runner" : "cross_session";
    return sessionCommandsFor(this.db, this.channelFor).accept(
      actor,
      destination,
      "message.send",
      key,
      {
        content,
        purpose,
        authoredBy,
        ...(reply ? { reply } : {}),
        ...(mentionBotUserId ? { mentionBotUserId } : {}),
      },
    );
  }

  /**
   * Resolves lightweight structured origin context (`sourceSession` and optional
   * `relatedTask`) for cross-session `say --via-main` delegations so the target
   * Main understands whether the originating session holds a primary Task.
   */
  private resolvePeerOriginContext(
    actor: RequestActor,
    relatedTaskId?: string,
  ): {
    sourceSession?: { id: string; kind: string; title?: string } | undefined;
    relatedTask?:
      | { id: string; title: string; status: string; primarySessionId: string }
      | undefined;
  } {
    const sourceRow = this.db
      .select({
        id: sessions.id,
        kind: sessions.kind,
        title: sessions.title,
        channelType: sessions.channel_type,
        channelId: sessions.channel_id,
        groupId: sessions.group_id,
      })
      .from(sessions)
      .where(eq(sessions.id, actor.currentSessionId))
      .get();

    let sourceTitle = sourceRow?.title?.trim() || undefined;
    if (!sourceTitle && sourceRow?.groupId) {
      const surface = this.db
        .select({ displayName: channelSurfaces.displayName })
        .from(channelSurfaces)
        .where(
          and(
            eq(channelSurfaces.channelType, sourceRow.channelType),
            eq(channelSurfaces.channelId, sourceRow.channelId),
            eq(channelSurfaces.externalId, sourceRow.groupId),
          ),
        )
        .get();
      sourceTitle = surface?.displayName?.trim() || undefined;
    }

    const sourceSession = sourceRow
      ? {
          id: sourceRow.id,
          kind: sourceRow.kind,
          ...(sourceTitle ? { title: sourceTitle } : {}),
        }
      : undefined;

    if (relatedTaskId) {
      const taskRow = this.db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          agentId: tasks.agent_id,
          shadowId: tasks.shadow_id,
          primarySessionId: tasks.primary_session_id,
        })
        .from(tasks)
        .where(eq(tasks.id, relatedTaskId))
        .get();
      if (!taskRow) {
        throw new GatewayError("task_not_found", "Task not found", 404);
      }
      if (
        taskRow.agentId !== actor.agentId ||
        taskRow.shadowId !== actor.shadowId ||
        taskRow.primarySessionId !== actor.currentSessionId
      ) {
        throw new GatewayError(
          "runner_resource_access_denied",
          "relatedTaskId must belong to the current session",
          403,
        );
      }
      return {
        sourceSession,
        relatedTask: {
          id: taskRow.id,
          title: taskRow.title,
          status: taskRow.status,
          primarySessionId: taskRow.primarySessionId,
        },
      };
    }

    // Auto-attach only when the non-heartbeat source session has a single unambiguous active Task.
    if (sourceRow && sourceRow.kind !== "heartbeat") {
      const activeTasks = this.db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          primarySessionId: tasks.primary_session_id,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.agent_id, actor.agentId),
            eq(tasks.shadow_id, actor.shadowId),
            eq(tasks.primary_session_id, actor.currentSessionId),
            inArray(tasks.status, ["queued", "running", "waiting"]),
          ),
        )
        .limit(2)
        .all();
      if (activeTasks.length === 1) {
        const sole = activeTasks[0]!;
        return {
          sourceSession,
          relatedTask: {
            id: sole.id,
            title: sole.title,
            status: sole.status,
            primarySessionId: sole.primarySessionId!,
          },
        };
      }
    }

    return { sourceSession };
  }

  /**
   * One-way message delivery to a target session's Main Runner (`say --via-main` or
   * Task Runner `say --to main` milestone update) without creating a `Request` ticket.
   */
  invokePeer(
    actor: RequestActor,
    key: string,
    targetSessionId: string,
    content: string,
    contextRefs: string[] = [],
    relatedTaskId?: string,
  ) {
    if (!actor.taskId && targetSessionId === actor.currentSessionId) {
      throw new GatewayError(
        "self_invoke",
        "Cannot send --via-main to the current session itself",
        409,
      );
    }
    const source = actor.taskId
      ? `task:${actor.taskId}`
      : `session:${actor.currentSessionId}`;
    const originContext = actor.taskId
      ? {}
      : this.resolvePeerOriginContext(actor, relatedTaskId);
    if (actor.taskId) {
      new TimelineStore(this.db).append({
        taskId: actor.taskId,
        sessionId: targetSessionId,
        type: "runner.milestone",
        summary: content.slice(0, 240),
        data: {
          taskRunId: actor.taskRunId ?? null,
          content,
        },
      });
    }
    return sessionCommandsFor(this.db, this.channelFor).accept(
      actor,
      targetSessionId,
      "session.invoke",
      key,
      {
        content,
        contextRefs,
        purpose: "notification",
        eventKind: "peer_message",
        peerMessage: {
          source,
          content,
          ...(actor.taskId ? { taskId: actor.taskId, taskRunId: actor.taskRunId ?? null } : {}),
          ...(originContext.sourceSession ? { sourceSession: originContext.sourceSession } : {}),
          ...(originContext.relatedTask ? { relatedTask: originContext.relatedTask } : {}),
        },
      } as never,
    );
  }

  /**
   * Soft non-disruptive message from Main/Work Runner to a Task (`say --to task:<id>`).
   * Appends to `task_inbox_events` without aborting any active container run.
   */
  sendToTask(
    actor: RequestActor,
    key: string,
    taskId: string,
    content: string,
  ): TaskInboxEventRow {
    const taskRow = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!taskRow) {
      throw new GatewayError("task_not_found", "Task not found", 404);
    }
    if (
      taskRow.agent_id !== actor.agentId ||
      taskRow.shadow_id !== actor.shadowId
    ) {
      throw new GatewayError(
        "task_scope_mismatch",
        "Task belongs to another Agent or Shadow",
        403,
      );
    }
    if (taskRow.status === "cancelled") {
      throw new GatewayError(
        "task_cancelled",
        "Cannot send messages to a cancelled Task",
        409,
      );
    }
    const digest = createHash("sha256")
      .update(`${actor.currentSessionId}:${actor.originId}:task-say:${taskId}:${key}`)
      .digest("hex")
      .slice(0, 20);
    const id = `tie_${digest}`;
    const event = new TaskInboxStore(this.db).append({
      id,
      taskId,
      kind: "peer_message",
      source: `session:${actor.currentSessionId}`,
      content,
      payload: {
        sourceSessionId: actor.currentSessionId,
        actorUserId: actor.userId,
      },
    });
    new TimelineStore(this.db).append({
      taskId,
      sessionId: actor.currentSessionId,
      type: "message.note",
      summary: content.slice(0, 240),
      data: {
        inboxEventId: event.id,
        sourceSessionId: actor.currentSessionId,
      },
    });
    if (taskRow.status === "waiting") {
      const activeRun = this.db
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .where(and(eq(taskRuns.task_id, taskId), eq(taskRuns.status, "running")))
        .get();
      if (!activeRun) {
        resumeWaitingTaskIfIdle(this.db, {
          taskId,
          operationId: `task-say:${event.id}`,
          summary: `Supplemental note from session ${actor.currentSessionId}: ${content.slice(0, 200)}`,
        });
      }
    }
    return event;
  }
}
