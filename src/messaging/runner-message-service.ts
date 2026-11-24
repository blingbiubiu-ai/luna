import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { parseReply, replyMarkdown, type ReplyDocument } from "@luna/runner-protocol/reply";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import { tasks, taskSubscriptions } from "@/data/schema";
import { InvocationService } from "@/runners/invocation-service";
import type { LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import { TaskInboxStore, type TaskInboxEventRow } from "@/tasks/task-inbox-store";
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
    if (reply) {
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
   * One-way message delivery to a target session's Main Runner (`say --via-main` or
   * Task Runner `say --to main` milestone update) without creating a `Request` ticket.
   */
  invokePeer(
    actor: RequestActor,
    key: string,
    targetSessionId: string,
    content: string,
    contextRefs: string[] = [],
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
    return event;
  }
}
