import { InvocationService } from "./invocation-service";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { runnerOperations, sessions, users } from "@/data/schema";
import { runnerActorUserId, type LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import { SessionDispatcher } from "@/sessions/session-dispatcher";
import { ThreadCommandService } from "@/sessions/thread-command-service";
import { SessionStateStore } from "@/main-runner/session-state-store";
import { TaskStatusCardCommandService } from "@/tasks/task-status-card-command-service";
import { TaskRunNotificationService } from "@/tasks/task-run-notification-service";
import { TaskCommandService, type TaskCommandSupervisor } from "@/tasks/task-command-service";
import { mainMessageOrigin } from "./main-invocation-registry";
import { operationSchemas, type OperationContext, type OperationKind, type OperationRequest } from "./operation-contract";

export class OperationExecutionError extends Error {
  constructor(readonly receipt: object, readonly httpStatus: number, cause: unknown) {
    super(String(cause), {cause});
  }
}

type Operation = typeof runnerOperations.$inferSelect;
const lanes = new WeakMap<DrizzleDB, SessionDispatcher>();

/** Authenticated transport and durable operation lifecycle, separate from task domain logic. */
export class RunnerOperationService {
  constructor(private readonly db: DrizzleDB, private readonly supervisor: TaskCommandSupervisor, private readonly cards?: TaskRunNotificationService) {}

  private active(claims: LunaAccessTokenClaims | undefined) {
    if (claims?.runnerKind !== "main") throw new GatewayError("main_required", "Only Main may change task or session state", 403);
    const { snapshot } = new InvocationService(this.db).requireActive(claims!, "main");
    if (snapshot.kind !== "main") throw new GatewayError("main_required", "Only Main may change task or session state", 403);
    return snapshot.input;
  }

  async execute(claims: LunaAccessTokenClaims | undefined, kind: OperationKind, requestId: string, value: unknown) {
    const active = this.active(claims);
    const input = active.input;
    if (input.type === "task_result") throw new GatewayError("unsupported_source", "Task result invocations only report through messages", 409);
    if (kind === "session.create_thread" && input.type === "user_messages" && value && typeof value === "object" &&
        !Array.isArray(value) && !("anchorMessageId" in value)) {
      const anchorMessageId = input.messages.at(-1)?.messageId;
      if (anchorMessageId) value = { ...value, anchorMessageId };
    }
    const payload = operationSchemas[kind].parse(value);
    const request = {kind, payload} as OperationRequest;
    const sessionId = input.context.sessionId;
    let lane = lanes.get(this.db);
    if (!lane) {lane = new SessionDispatcher(); lanes.set(this.db, lane);}
    return lane.dispatch({kind: "user_messages", sessionId}, async () => {
      this.active(claims);
      const originId = mainMessageOrigin(active);
      const existing = this.db.select().from(runnerOperations).where(and(eq(runnerOperations.sessionId, sessionId), eq(runnerOperations.originId, originId), eq(runnerOperations.requestId, requestId))).get();
      if (existing) {
        if (!isDeepStrictEqual(existing.request, request)) throw new GatewayError("idempotency_conflict", "Request ID already used with different operation or payload", 409);
        return this.apply(existing);
      }
      const session = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
      if (!session || session.status !== "active") throw new GatewayError("session_unavailable", "Session unavailable", 409);
      const availableIds = input.type === "user_messages" ? input.messages.map(row => row.messageId) : [];
      const selectedIds = "sourceMessageIds" in payload && payload.sourceMessageIds ? payload.sourceMessageIds : availableIds;
      if (selectedIds.some(id => !availableIds.includes(id))) throw new GatewayError("invalid_source", "Source messages must belong to the current invocation", 403);
      const context: OperationContext = {sessionId, originId, actorUserId: runnerActorUserId(claims!), sourceMessageIds: [...new Set(selectedIds)],
        inbound: input.type === "user_messages" ? (input.messages.find(row => row.messageId === selectedIds.at(-1))?.rawMessage ?? input.latestMessage) : {
          id: session.root_message_key ?? `trigger:${input.triggerId}`,
          channel: {type: session.channel_type, id: session.channel_id}, surface: {externalId: session.group_id ?? session.channel_id, kind: "unknown"},
          sender: {kind: "user", externalId: runnerActorUserId(claims!), requesterIdentity: {provider: "local", externalUserId: runnerActorUserId(claims!), canonicalUserId: runnerActorUserId(claims!)}},
          text: input.instruction, mentions: [], addressing: {addressedToBot: true, reason: "p2p"},
          ...(session.thread_key ? {thread: {externalId: session.thread_key, ...(session.root_message_key ? {rootMessageExternalId: session.root_message_key} : {})}} : {})}};
      const now = Date.now();
      const row: Operation = {id: randomUUID(), sessionId, originId, requestId, request, context, status: "accepted", result: null, error: null, createdAt: now, updatedAt: now};
      this.db.insert(runnerOperations).values(row).run();
      return this.apply(row);
    });
  }

  get(claims: LunaAccessTokenClaims | undefined, id: string) {
    const active = this.active(claims);
    const row = this.db.select().from(runnerOperations).where(eq(runnerOperations.id, id)).get();
    if (!row || row.sessionId !== active.input.context.sessionId || row.context.actorUserId !== runnerActorUserId(claims!))
      throw new GatewayError("operation_not_found", "Operation not found", 404);
    return this.receipt(row);
  }

  /** Accepted operations survive Main exit. Prepared operations safely redispatch after a crash. */
  async recoverPending() {
    let recovered = 0;
    for (const row of this.db.select().from(runnerOperations).where(inArray(runnerOperations.status, ["accepted", "prepared"])).all()) {
      try {await this.apply(row); recovered++;} catch { /* Receipt retains the failure for inspection/retry. */ }
    }
    return recovered;
  }

  private async apply(row: Operation) {
    if (row.status === "applied") return this.receipt(row);
    try {
      const actor = this.db.select().from(users).where(eq(users.id, row.context.actorUserId)).get();
      const session = this.db.select().from(sessions).where(eq(sessions.id, row.sessionId)).get();
      if (!actor || actor.status !== "active" || !session || session.status !== "active") throw new GatewayError("operation_scope_inactive", "Actor or session inactive", 409);
      if (row.status !== "prepared") {
        row = this.db.transaction(tx => {
          const db = tx as unknown as DrizzleDB;
          let result = {};
          if (row.request.kind === "task.status_card") {
            result = new TaskStatusCardCommandService(db).prepare(row.request.payload.taskId, row.context);
          } else if (row.request.kind === "session.create_thread") {
            result = new ThreadCommandService(db).prepare(row.id, row.request, row.context);
          } else if (row.request.kind === "session.clarify") {
            const {question, ...state} = row.request.payload;
            new SessionStateStore(db).saveClarification(row.sessionId, {...state, lastReply: question});
          } else if (row.request.kind === "session.release") {
            // The completion adapter reads this durable operation to close the activation window.
          } else result = new TaskCommandService(db, this.supervisor).prepare(row.id, row.request, row.context);
          return tx.update(runnerOperations).set({result, status: "prepared", error: null, updatedAt: Date.now()}).where(eq(runnerOperations.id, row.id)).returning().get()!;
        });
      }
      const result = row.request.kind === "task.status_card"
        ? await (this.cards ?? new TaskRunNotificationService({db: this.db, channelForNotification: () => undefined})).applyStatusCardCommand(row.id, row.result!, row.request.payload.resend, row.request.payload.style)
        : row.request.kind === "session.create_thread" || row.request.kind === "session.clarify" || row.request.kind === "session.release" ? row.result! :
        new TaskCommandService(this.db, this.supervisor).dispatch(row.request, row.context, row.result!);
      row = this.db.update(runnerOperations).set({result, status: "applied", error: null, updatedAt: Date.now()}).where(eq(runnerOperations.id, row.id)).returning().get()!;
      return this.receipt(row);
    } catch (error) {
      const failed = this.db.update(runnerOperations).set({status: row.status === "prepared" ? "prepared" : "failed", error: String(error), updatedAt: Date.now()}).where(eq(runnerOperations.id, row.id)).returning().get()!;
      throw new OperationExecutionError(this.receipt(failed), error instanceof GatewayError ? error.status : 500, error);
    }
  }

  private receipt(row: Operation) {
    return {commandId: row.id, sessionId: row.sessionId, operation: row.request.kind, status: row.status,
      ...(row.result?.targetSessionId ? {targetSessionId: row.result.targetSessionId} : {}),
      ...(row.result?.statusMessageId ? {statusMessageId: row.result.statusMessageId} : {}),
      ...(row.result?.taskSessionId ? {taskSessionId: row.result.taskSessionId} : {}),
      ...(row.result?.cancelled !== undefined ? {cancelled: row.result.cancelled} : {}),
      taskIds: row.result?.taskId ? [row.result.taskId] : [], ...(row.result?.runId ? {runId: row.result.runId} : {}), error: row.error};
  }
}
