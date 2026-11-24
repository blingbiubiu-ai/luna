import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { AgentStore } from "@/agents/agent-store";
import { resolveProactivitySettings } from "@/agents/agent-settings-store";
import {
  SELF_ROUTINE_ORIGINS,
  sessionBusy,
  type SelfRoutine,
  type SelfRoutineContext,
} from "@/agents/self-routines";
import type { ChannelCardAction, ChannelCardActionResult } from "@/channels/types";
import type { ReplyChannel } from "@/channels/outbound";
import type { DrizzleDB } from "@/data";
import {
  accountIdentityClaims,
  channelIdentities,
  channelUserBindings,
  correlatedRequestEvents,
  correlatedRequests,
  type CorrelatedRequestEventDirection,
  type CorrelatedRequestEventKind,
  type CorrelatedRequestMode,
  type CorrelatedRequestStatus,
  sessionCommands,
  sessions,
  shadowBotBindings,
  shadowHeartbeats,
  taskRuns,
  tasks,
  userIdentityLinks,
  users,
} from "@/data/schema";
import { GatewayError } from "@/server/gateway-error";
import { TaskInboxStore } from "@/tasks/task-inbox-store";
import { resumeWaitingTaskIfIdle } from "@/tasks/task-resume-registry";
import type { ReplyDocument } from "@luna/runner-protocol/reply";
import { resolveLunaAddress } from "./luna-address";
import {
  sessionCommandsFor,
  type CommandActor,
  type SessionCommand,
  type SessionCommandService,
} from "./session-command-service";

export type CorrelatedRequestRow = typeof correlatedRequests.$inferSelect;
export type CorrelatedRequestEventRow = typeof correlatedRequestEvents.$inferSelect;

export interface RequestUpdateEnvelope {
  readonly requestId: string;
  readonly mode: CorrelatedRequestMode;
  readonly status: CorrelatedRequestStatus;
  readonly goal: string;
  readonly contextSummary: string | null;
  readonly summary: string | null;
  readonly selectedOption: string | null;
  readonly targetAddress: string;
  readonly targetSessionId: string;
  readonly resolvedByUserId: string | null;
  readonly resolvedByRole?: "owner" | "member" | null | undefined;
  readonly via: "card" | "conversation" | "expiry" | "cancel" | "progress";
}

export interface RequestOpenedEnvelope {
  readonly requestId: string;
  readonly mode: "delegate";
  readonly goal: string;
  readonly context: string | null;
  readonly source: string;
  readonly originSessionId: string;
  readonly originTaskId: string | null;
  readonly targetAddress: string;
  readonly expiresAt: number | null;
}

export interface RequestMessageEnvelope {
  readonly requestId: string;
  readonly goal: string;
  readonly message: string;
  readonly source: string;
  readonly originSessionId: string;
  readonly originTaskId: string | null;
}

export interface RequestActor extends CommandActor {
  readonly agentId: string;
  readonly shadowId: string;
  readonly currentSessionId: string;
  readonly runnerKind?: "main" | "work" | "task" | undefined;
  readonly taskId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly invocationId?: string | undefined;
}

const OPEN_REQUEST_STATUSES: readonly CorrelatedRequestStatus[] = [
  "open",
  "in_progress",
];

const settlementSignal = new EventEmitter();
settlementSignal.setMaxListeners(0);

function notifyRequestChanged(requestId: string): void {
  settlementSignal.emit(`req:${requestId}`);
}

function deterministicRequestId(
  originScope: string,
  originId: string,
  key: string,
): string {
  const digest = createHash("sha256")
    .update(`${originScope}:${originId}:request:${key}`)
    .digest("hex")
    .slice(0, 20);
  return `req_${digest}`;
}

function appendRequestEvent(
  db: DrizzleDB,
  input: {
    readonly requestId: string;
    readonly direction: CorrelatedRequestEventDirection;
    readonly kind: CorrelatedRequestEventKind;
    readonly content: string;
    readonly metadata?: Record<string, unknown> | null | undefined;
    readonly actorUserId?: string | null | undefined;
    readonly commandId?: string | null | undefined;
    readonly createdAt: number;
  },
): CorrelatedRequestEventRow {
  const maxRow = db
    .select({ maxSeq: sql<number>`coalesce(max(${correlatedRequestEvents.seq}), 0)` })
    .from(correlatedRequestEvents)
    .where(eq(correlatedRequestEvents.requestId, input.requestId))
    .get();
  const seq = (maxRow?.maxSeq ?? 0) + 1;
  const id = `rqe_${randomUUID()}`;
  db.insert(correlatedRequestEvents)
    .values({
      id,
      requestId: input.requestId,
      seq,
      direction: input.direction,
      kind: input.kind,
      content: input.content,
      metadataJson: input.metadata ?? null,
      actorUserId: input.actorUserId ?? null,
      commandId: input.commandId ?? null,
      createdAt: input.createdAt,
    })
    .run();
  return db
    .select()
    .from(correlatedRequestEvents)
    .where(eq(correlatedRequestEvents.id, id))
    .get()!;
}

export function formatRequestUpdateInstruction(env: RequestUpdateEnvelope): string {
  return [
    `Request update [${env.requestId}] (status: ${env.status}, via: ${env.via})`,
    `Target: ${env.targetAddress} (session:${env.targetSessionId})`,
    `Goal: ${env.goal}`,
    ...(env.contextSummary ? [`Context: ${env.contextSummary}`] : []),
    ...(env.resolvedByUserId
      ? [
          `Resolved by: ${env.resolvedByUserId}${env.resolvedByRole ? ` (${env.resolvedByRole})` : ""}`,
        ]
      : []),
    ...(env.selectedOption ? [`Selected option: ${env.selectedOption}`] : []),
    ...(env.summary ? [`Summary: ${env.summary}`] : []),
  ].join("\n");
}

function formatRequestOpenedInstruction(env: RequestOpenedEnvelope): string {
  return [
    `Request opened [${env.requestId}] from ${env.source}`,
    `Goal: ${env.goal}`,
    ...(env.context ? [`Context: ${env.context}`] : []),
  ].join("\n");
}

function formatRequestMessageInstruction(env: RequestMessageEnvelope): string {
  return [
    `Follow-up message on request [${env.requestId}] from ${env.source}`,
    `Goal: ${env.goal}`,
    `Message: ${env.message}`,
  ].join("\n");
}

function resolveReturnActorUserId(
  db: DrizzleDB,
  req: CorrelatedRequestRow,
  ownerUserId: string,
): string {
  const outboundActorUserId = req.outboundCommandId
    ? db
        .select({ actorUserId: sessionCommands.actorUserId })
        .from(sessionCommands)
        .where(eq(sessionCommands.id, req.outboundCommandId))
        .get()?.actorUserId
    : undefined;
  const candidate = req.resolvedByUserId ?? outboundActorUserId;
  if (candidate) {
    const active = db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, candidate),
          eq(users.agentId, req.agentId),
          eq(users.status, "active"),
        ),
      )
      .get();
    if (active) return active.id;
  }
  return ownerUserId;
}

function buildUpdateEnvelope(
  db: DrizzleDB,
  req: CorrelatedRequestRow,
  viaOverride?: RequestUpdateEnvelope["via"],
): RequestUpdateEnvelope {
  const ownerUserId = new AgentStore(db).ownerUserId(req.agentId);
  const resolvedByRole = req.resolvedByUserId
    ? req.resolvedByUserId === ownerUserId
      ? "owner"
      : "member"
    : null;
  const res = req.resultJson ?? {};
  const summary =
    typeof res.summary === "string"
      ? res.summary
      : typeof res.answer === "string"
        ? res.answer
        : typeof res.reason === "string"
          ? res.reason
          : null;
  const selectedOption =
    typeof res.selectedOption === "string" ? res.selectedOption : null;
  const storedVia = res.via;
  const via: RequestUpdateEnvelope["via"] =
    viaOverride ??
    (storedVia === "card" ||
    storedVia === "conversation" ||
    storedVia === "expiry" ||
    storedVia === "cancel" ||
    storedVia === "progress"
      ? storedVia
      : req.status === "expired"
        ? "expiry"
        : req.status === "cancelled"
          ? "cancel"
          : "conversation");
  return {
    requestId: req.id,
    mode: req.mode,
    status: req.status,
    goal: req.instruction,
    contextSummary: req.contextSummary,
    summary,
    selectedOption,
    targetAddress: req.targetAddress,
    targetSessionId: req.targetSessionId,
    resolvedByUserId: req.resolvedByUserId,
    resolvedByRole,
    via,
  };
}

function deliverRequestUpdateToOrigin(
  db: DrizzleDB,
  commands: Pick<SessionCommandService, "accept">,
  req: CorrelatedRequestRow,
  now = Date.now(),
): { returnCommandId: string | null; taskResumed: boolean } {
  const envelope = buildUpdateEnvelope(db, req);
  if (req.originTaskId) {
    const taskRow = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, req.originTaskId))
      .get();
    if (!taskRow || taskRow.status === "cancelled") {
      return { returnCommandId: null, taskResumed: false };
    }
    const eventKey = `tie_req_${req.id}_${req.status}`;
    new TaskInboxStore(db).append({
      id: eventKey,
      taskId: req.originTaskId,
      kind: "request_update",
      source: `session:${req.targetSessionId}`,
      correlationId: req.id,
      content: formatRequestUpdateInstruction(envelope),
      payload: envelope as unknown as Record<string, unknown>,
      now,
    });
    return { returnCommandId: null, taskResumed: true };
  }

  const originSession = db
    .select()
    .from(sessions)
    .where(eq(sessions.id, req.originSessionId))
    .get();
  if (!originSession || originSession.status !== "active") {
    return { returnCommandId: null, taskResumed: false };
  }

  const ownerUserId = new AgentStore(db).ownerUserId(req.agentId);
  const validActor = resolveReturnActorUserId(db, req, ownerUserId);

  try {
    const cmd = commands.accept(
      {
        userId: validActor,
        sourceSessionId: req.originSessionId,
        originId: `request-update:${req.id}:${req.status}`,
        correlationId: req.id,
        hops: Math.max(1, req.hops),
      },
      req.originSessionId,
      "session.invoke",
      "result",
      {
        content: formatRequestUpdateInstruction(envelope),
        purpose: "notification",
        eventKind: "request_update",
        requestUpdate: envelope,
      } as never,
      { expiresAt: now + 24 * 3_600_000 },
    );
    return { returnCommandId: cmd.id, taskResumed: false };
  } catch (error) {
    console.warn("failed to queue correlated request update return", {
      requestId: req.id,
      error: String(error),
    });
    return { returnCommandId: null, taskResumed: false };
  }
}

function triggerTaskAutoResumeIfNeeded(
  db: DrizzleDB,
  req: CorrelatedRequestRow,
): void {
  if (!req.originTaskId) return;
  const activeRun = db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.task_id, req.originTaskId),
        eq(taskRuns.status, "running"),
      ),
    )
    .get();
  if (activeRun) {
    // Active container is still running (either waiting on `requests wait` or will pick up via PostToolUse/Stop hook).
    return;
  }
  const taskRow = db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, req.originTaskId))
    .get();
  if (!taskRow || taskRow.status === "cancelled") return;
  resumeWaitingTaskIfIdle(db, {
    taskId: req.originTaskId,
    operationId: `req-return:${req.id}:${req.status}`,
    summary: `Received ${req.status} response for request ${req.id}`,
  });
}

const HEARTBEAT_NEGATIVE_VERDICT_RE =
  /^(婉拒|拒绝|驳回|取消|忽略|暂不|不发|不要|不处理|跳过|decline|reject|no|cancel|skip|ignore)/i;

export function isHeartbeatSession(db: DrizzleDB, sessionId: string): boolean {
  return Boolean(
    db
      .select({ shadowId: shadowHeartbeats.shadowId })
      .from(shadowHeartbeats)
      .where(eq(shadowHeartbeats.sessionId, sessionId))
      .get(),
  );
}

/**
 * Checks whether the current Heartbeat turn (`turnId = actor.originId`) is the
 * return invocation (`correlated_requests.return_command_id`) of an owner-approved request.
 */
export function hasHeartbeatOwnerApproval(
  db: DrizzleDB,
  actor: {
    readonly shadowId: string;
    readonly currentSessionId: string;
    readonly originId: string;
  },
  ownerUserId: string,
): boolean {
  if (!actor.originId) return false;
  const req = db
    .select()
    .from(correlatedRequests)
    .where(
      and(
        eq(correlatedRequests.returnCommandId, actor.originId),
        eq(correlatedRequests.status, "done"),
        eq(correlatedRequests.shadowId, actor.shadowId),
        eq(correlatedRequests.originSessionId, actor.currentSessionId),
        eq(correlatedRequests.resolvedByUserId, ownerUserId),
      ),
    )
    .get();
  if (!req) return false;
  const res = req.resultJson ?? {};
  const verdict = String(res.selectedOption ?? res.summary ?? res.answer ?? "").trim();
  return Boolean(verdict && !HEARTBEAT_NEGATIVE_VERDICT_RE.test(verdict));
}

export function assertHeartbeatOutboundApproved(
  db: DrizzleDB,
  actor: {
    readonly agentId: string;
    readonly shadowId: string;
    readonly currentSessionId: string;
    readonly originId: string;
  },
  options?: { readonly allowOwnerAskTargetUserId?: string | undefined },
): void {
  if (!isHeartbeatSession(db, actor.currentSessionId)) return;
  const proactivity = resolveProactivitySettings(db, actor.agentId);
  if (!proactivity.heartbeatApprovalRequired) return;
  const ownerUserId = new AgentStore(db).ownerUserId(actor.agentId);
  if (
    options?.allowOwnerAskTargetUserId &&
    options.allowOwnerAskTargetUserId === ownerUserId
  ) {
    return;
  }
  if (hasHeartbeatOwnerApproval(db, actor, ownerUserId)) return;
  throw new GatewayError(
    "heartbeat_approval_required",
    "Heartbeat proactive follow-up requires owner approval first: send an approval card via `luna ask --to owner --options '[\"同意跟进\",\"暂不发送\"]' --text ...` and wait for `request_update` before dispatching via `luna say --via-main`.",
    403,
  );
}

export class CorrelatedRequestService {
  constructor(
    private readonly db: DrizzleDB,
    private readonly channelFor: (id: string) => ReplyChannel | undefined,
  ) {}

  private get commands(): SessionCommandService {
    return sessionCommandsFor(this.db, this.channelFor);
  }

  createRequest(input: {
    readonly actor: RequestActor;
    readonly key: string;
    readonly toAddress: string;
    readonly goal: string;
    readonly contextSummary?: string | undefined;
    readonly options?: readonly string[] | undefined;
    readonly expiresInMs?: number | undefined;
    readonly now?: number | undefined;
  }): CorrelatedRequestRow {
    const now = input.now ?? Date.now();
    const goal = input.goal.trim();
    if (!goal) {
      throw new GatewayError("invalid_goal", "Request goal cannot be empty", 400);
    }
    const trimmedTo = input.toAddress.trim();
    const isTaskActor = Boolean(input.actor.taskId || input.actor.runnerKind === "task");
    if (isTaskActor && trimmedTo !== "main") {
      throw new GatewayError(
        "address_forbidden",
        "Task Runner may only send requests to 'main'",
        403,
      );
    }
    const cleanOptions = input.options?.map(o => o.trim()).filter(Boolean);
    if (isTaskActor && cleanOptions && cleanOptions.length > 0) {
      throw new GatewayError(
        "invalid_request_mode",
        "Task Runner requests to 'main' use delegate mode (omit --options; Main decides whether to send a user card)",
        400,
      );
    }

    const ownerUserId = new AgentStore(this.db).ownerUserId(input.actor.agentId);
    const allowLocalFallback =
      trimmedTo === "owner" || trimmedTo === `user:${ownerUserId}`;
    const resolved = resolveLunaAddress(
      this.db,
      {
        agentId: input.actor.agentId,
        shadowId: input.actor.shadowId,
        currentSessionId: input.actor.currentSessionId,
        taskId: input.actor.taskId,
      },
      trimmedTo,
      { create: true, allowLocalFallback },
    );
    if (resolved.kind === "self") {
      throw new GatewayError(
        "invalid_request_target",
        "Cannot send a correlated request to the Heartbeat self session",
        400,
      );
    }

    const mode: CorrelatedRequestMode =
      cleanOptions && cleanOptions.length > 0 ? "card" : "delegate";

    if (
      mode === "delegate" &&
      !isTaskActor &&
      resolved.sessionId === input.actor.currentSessionId
    ) {
      throw new GatewayError(
        "self_request",
        "Cannot delegate a request to the current session itself",
        409,
      );
    }

    if (!isTaskActor) {
      assertHeartbeatOutboundApproved(this.db, input.actor, {
        allowOwnerAskTargetUserId: resolved.targetUserId,
      });
    }

    const originScope = input.actor.taskId
      ? `task:${input.actor.taskId}`
      : input.actor.sourceSessionId;
    const requestId = deterministicRequestId(
      originScope,
      input.actor.originId,
      input.key,
    );
    const existing = this.db
      .select()
      .from(correlatedRequests)
      .where(eq(correlatedRequests.id, requestId))
      .get();
    if (existing) {
      if (
        existing.instruction !== goal ||
        existing.targetSessionId !== resolved.sessionId ||
        existing.mode !== mode
      ) {
        throw new GatewayError(
          "idempotency_conflict",
          "Key already used with different request parameters",
          409,
        );
      }
      return existing;
    }

    const defaultExpiresMs = resolveProactivitySettings(
      this.db,
      input.actor.agentId,
    ).askDefaultExpiresMs;
    const expiresAt = now + (input.expiresInMs ?? defaultExpiresMs);
    const contextSummary = input.contextSummary?.trim() || null;

    return this.db.transaction(tx => {
      let cmd: SessionCommand;
      if (mode === "card") {
        const reply: ReplyDocument = {
          type: "luna.reply",
          version: 1,
          presentation: "card",
          template: "markdown",
          title: "待确认",
          content: [
            { type: "text", text: goal },
            { type: "actions", requestId, options: cleanOptions! },
          ],
        };
        cmd = this.commands.accept(
          {
            ...input.actor,
            correlationId: requestId,
          },
          resolved.sessionId,
          "message.send",
          `request-card:${input.key}`,
          {
            content: goal,
            reply,
            purpose: "notification",
            authoredBy:
              resolved.sessionId !== input.actor.sourceSessionId
                ? "cross_session"
                : "service",
          },
          { availableAt: now },
        );
      } else {
        const openedEnvelope: RequestOpenedEnvelope = {
          requestId,
          mode: "delegate",
          goal,
          context: contextSummary,
          source: input.actor.taskId
            ? `task:${input.actor.taskId}`
            : `session:${input.actor.sourceSessionId}`,
          originSessionId: input.actor.sourceSessionId,
          originTaskId: input.actor.taskId ?? null,
          targetAddress: resolved.address,
          expiresAt,
        };
        cmd = this.commands.accept(
          {
            ...input.actor,
            correlationId: requestId,
          },
          resolved.sessionId,
          "session.invoke",
          `request-open:${input.key}`,
          {
            content: formatRequestOpenedInstruction(openedEnvelope),
            purpose: "notification",
            eventKind: "request_opened",
            requestOpened: openedEnvelope,
          } as never,
          { availableAt: now, expiresAt },
        );
      }

      const row: typeof correlatedRequests.$inferInsert = {
        id: requestId,
        kind: "request",
        mode,
        agentId: input.actor.agentId,
        shadowId: input.actor.shadowId,
        originSessionId: input.actor.sourceSessionId,
        originTurnId: input.actor.originId,
        originTaskId: input.actor.taskId ?? null,
        originTaskRunId: input.actor.taskRunId ?? null,
        targetAddress: resolved.address,
        targetSessionId: resolved.sessionId,
        targetUserId: resolved.targetUserId ?? null,
        outboundCommandId: cmd.id,
        outboundMessageId: cmd.messageId,
        instruction: goal,
        contextSummary,
        optionsJson: cleanOptions?.length ? cleanOptions : null,
        hops: cmd.hops,
        status: "open",
        resultJson: null,
        resolvedByUserId: null,
        returnCommandId: null,
        expiresAt,
        createdByInvocationId: input.actor.invocationId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(correlatedRequests).values(row).run();
      appendRequestEvent(tx as unknown as DrizzleDB, {
        requestId,
        direction: "origin_to_target",
        kind: "opened",
        content: goal,
        metadata: {
          mode,
          ...(contextSummary ? { context: contextSummary } : {}),
          ...(cleanOptions?.length ? { options: cleanOptions } : {}),
        },
        actorUserId: input.actor.userId,
        commandId: cmd.id,
        createdAt: now,
      });
      return tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, requestId))
        .get()!;
    });
  }

  updateRequest(input: {
    readonly requestId: string;
    readonly action: "progress" | "done" | "declined";
    readonly summary: string;
    readonly selectedOption?: string | undefined;
    readonly resolvedByUserId: string;
    readonly source: "runner" | "card" | "dashboard";
    readonly expectedShadowId?: string | undefined;
    readonly expectedTargetSessionId?: string | undefined;
    readonly now?: number | undefined;
  }): { readonly request: CorrelatedRequestRow; readonly alreadyResolved: boolean } {
    const now = input.now ?? Date.now();
    const summary = input.summary.trim();
    if (!summary) {
      throw new GatewayError("invalid_summary", "Summary cannot be empty", 400);
    }

    let triggerResumeFor: CorrelatedRequestRow | undefined;
    const outcome = this.db.transaction(tx => {
      const dbTx = tx as unknown as DrizzleDB;
      const existing = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, input.requestId))
        .get();
      if (!existing) {
        throw new GatewayError("request_not_found", "Request not found", 404);
      }
      if (
        input.expectedShadowId &&
        existing.shadowId !== input.expectedShadowId
      ) {
        throw new GatewayError(
          "request_forbidden",
          "Request belongs to another Shadow",
          403,
        );
      }
      if (
        input.expectedTargetSessionId &&
        existing.targetSessionId !== input.expectedTargetSessionId
      ) {
        throw new GatewayError(
          "request_session_mismatch",
          "Request does not target the current session",
          403,
        );
      }
      if (
        existing.mode === "card" &&
        existing.targetUserId &&
        input.resolvedByUserId !== existing.targetUserId
      ) {
        throw new GatewayError(
          "request_forbidden",
          "Card request targets another user",
          403,
        );
      }

      if (input.action === "progress") {
        if (!OPEN_REQUEST_STATUSES.includes(existing.status)) {
          throw new GatewayError(
            "request_not_open",
            `Request is already ${existing.status}`,
            409,
          );
        }
        tx.update(correlatedRequests)
          .set({
            status: "in_progress",
            resultJson: {
              ...(existing.resultJson ?? {}),
              latestProgress: summary,
              via: "progress",
            },
            updatedAt: now,
          })
          .where(eq(correlatedRequests.id, existing.id))
          .run();
        appendRequestEvent(dbTx, {
          requestId: existing.id,
          direction: "target_to_origin",
          kind: "progress",
          content: summary,
          actorUserId: input.resolvedByUserId,
          createdAt: now,
        });
        const updated = tx
          .select()
          .from(correlatedRequests)
          .where(eq(correlatedRequests.id, existing.id))
          .get()!;
        return { request: updated, alreadyResolved: false };
      }

      const targetStatus: "done" | "declined" = input.action;
      const existingSummary =
        typeof (existing.resultJson as { summary?: unknown } | null)?.summary === "string"
          ? (existing.resultJson as { summary: string }).summary
          : undefined;
      if (
        existing.status === targetStatus &&
        (input.source === "card" || existingSummary === summary)
      ) {
        return { request: existing, alreadyResolved: true };
      }
      if (!OPEN_REQUEST_STATUSES.includes(existing.status)) {
        throw new GatewayError(
          "request_not_open",
          `Request is already ${existing.status}; use luna say --via-main for post-settlement updates`,
          409,
        );
      }
      if (
        existing.optionsJson?.length &&
        input.selectedOption &&
        !existing.optionsJson.includes(input.selectedOption)
      ) {
        throw new GatewayError(
          "invalid_option",
          "Selected option is not among allowed options",
          400,
        );
      }

      const via: "card" | "conversation" =
        input.source === "card" ? "card" : "conversation";
      const resultPayload: Record<string, unknown> = {
        summary,
        answer: summary,
        ...(input.selectedOption ? { selectedOption: input.selectedOption } : {}),
        via,
        source: input.source,
      };
      tx.update(correlatedRequests)
        .set({
          status: targetStatus,
          resultJson: resultPayload,
          resolvedByUserId: input.resolvedByUserId,
          updatedAt: now,
        })
        .where(eq(correlatedRequests.id, existing.id))
        .run();

      const updated = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get()!;
      const { returnCommandId, taskResumed } = deliverRequestUpdateToOrigin(
        dbTx,
        this.commands,
        updated,
        now,
      );
      if (returnCommandId) {
        tx.update(correlatedRequests)
          .set({ returnCommandId })
          .where(eq(correlatedRequests.id, existing.id))
          .run();
      }
      appendRequestEvent(dbTx, {
        requestId: existing.id,
        direction: "target_to_origin",
        kind: input.source === "card" ? "card_click" : targetStatus,
        content: summary,
        metadata: {
          via,
          ...(input.selectedOption ? { selectedOption: input.selectedOption } : {}),
        },
        actorUserId: input.resolvedByUserId,
        commandId: returnCommandId,
        createdAt: now,
      });
      const finalRow = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get()!;
      if (taskResumed) {
        triggerResumeFor = finalRow;
      }
      return { request: finalRow, alreadyResolved: false };
    });

    notifyRequestChanged(outcome.request.id);
    if (triggerResumeFor) {
      triggerTaskAutoResumeIfNeeded(this.db, triggerResumeFor);
    }
    return outcome;
  }

  sendMessage(input: {
    readonly actor: RequestActor;
    readonly key: string;
    readonly requestId: string;
    readonly message: string;
    readonly now?: number | undefined;
  }): { readonly request: CorrelatedRequestRow; readonly command: SessionCommand } {
    const now = input.now ?? Date.now();
    const message = input.message.trim();
    if (!message) {
      throw new GatewayError("invalid_message", "Message cannot be empty", 400);
    }

    return this.db.transaction(tx => {
      const dbTx = tx as unknown as DrizzleDB;
      const existing = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, input.requestId))
        .get();
      if (!existing || existing.shadowId !== input.actor.shadowId) {
        throw new GatewayError("request_not_found", "Request not found", 404);
      }
      const isOrigin = input.actor.taskId
        ? existing.originTaskId === input.actor.taskId
        : existing.originSessionId === input.actor.currentSessionId &&
          existing.originTaskId === null;
      if (!isOrigin) {
        throw new GatewayError(
          "request_forbidden",
          "Only the origin of a request can append follow-up messages",
          403,
        );
      }
      if (!OPEN_REQUEST_STATUSES.includes(existing.status)) {
        throw new GatewayError(
          "request_not_open",
          `Request is already ${existing.status}`,
          409,
        );
      }

      const msgEnvelope: RequestMessageEnvelope = {
        requestId: existing.id,
        goal: existing.instruction,
        message,
        source: existing.originTaskId
          ? `task:${existing.originTaskId}`
          : `session:${existing.originSessionId}`,
        originSessionId: existing.originSessionId,
        originTaskId: existing.originTaskId,
      };
      const cmd = this.commands.accept(
        {
          ...input.actor,
          correlationId: existing.id,
        },
        existing.targetSessionId,
        "session.invoke",
        `request-msg:${existing.id}:${input.key}`,
        {
          content: formatRequestMessageInstruction(msgEnvelope),
          purpose: "notification",
          eventKind: "request_message",
          requestMessage: msgEnvelope,
        } as never,
        { availableAt: now, expiresAt: existing.expiresAt ?? now + 2 * 3_600_000 },
      );

      tx.update(correlatedRequests)
        .set({ updatedAt: now })
        .where(eq(correlatedRequests.id, existing.id))
        .run();
      appendRequestEvent(dbTx, {
        requestId: existing.id,
        direction: "origin_to_target",
        kind: "message",
        content: message,
        actorUserId: input.actor.userId,
        commandId: cmd.id,
        createdAt: now,
      });

      const updated = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get()!;
      return { request: updated, command: cmd };
    });
  }

  cancelRequest(input: {
    readonly requestId: string;
    readonly shadowId: string;
    readonly actorUserId?: string | undefined;
    readonly expectedOriginSessionId?: string | undefined;
    readonly expectedOriginTaskId?: string | null | undefined;
    readonly now?: number | undefined;
  }): CorrelatedRequestRow {
    const now = input.now ?? Date.now();
    const updated = this.db.transaction(tx => {
      const dbTx = tx as unknown as DrizzleDB;
      const existing = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, input.requestId))
        .get();
      if (!existing || existing.shadowId !== input.shadowId) {
        throw new GatewayError("request_not_found", "Request not found", 404);
      }
      if (input.expectedOriginTaskId !== undefined) {
        if (existing.originTaskId !== input.expectedOriginTaskId) {
          throw new GatewayError("request_forbidden", "Request belongs to another origin", 403);
        }
      } else if (
        input.expectedOriginSessionId &&
        existing.originSessionId !== input.expectedOriginSessionId
      ) {
        throw new GatewayError("request_forbidden", "Request belongs to another session", 403);
      }
      if (!OPEN_REQUEST_STATUSES.includes(existing.status)) return existing;
      if (
        existing.outboundCommandId &&
        this.commands.get(existing.outboundCommandId)?.status === "pending"
      ) {
        this.commands.cancel(existing.outboundCommandId);
      }
      tx.update(correlatedRequests)
        .set({
          status: "cancelled",
          resultJson: { reason: "Cancelled by origin", via: "cancel" },
          updatedAt: now,
        })
        .where(eq(correlatedRequests.id, existing.id))
        .run();
      appendRequestEvent(dbTx, {
        requestId: existing.id,
        direction: "origin_to_target",
        kind: "cancelled",
        content: "Cancelled by origin",
        actorUserId: input.actorUserId ?? null,
        createdAt: now,
      });
      return tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get()!;
    });
    notifyRequestChanged(updated.id);
    return updated;
  }

  getRequest(
    shadowId: string,
    requestId: string,
  ): {
    readonly request: CorrelatedRequestRow;
    readonly events: readonly CorrelatedRequestEventRow[];
  } {
    const request = this.db
      .select()
      .from(correlatedRequests)
      .where(eq(correlatedRequests.id, requestId))
      .get();
    if (!request || request.shadowId !== shadowId) {
      throw new GatewayError("request_not_found", "Request not found", 404);
    }
    const events = this.db
      .select()
      .from(correlatedRequestEvents)
      .where(eq(correlatedRequestEvents.requestId, requestId))
      .orderBy(asc(correlatedRequestEvents.seq))
      .all();
    return { request, events };
  }

  async waitForRequest(input: {
    readonly shadowId: string;
    readonly requestId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly consumerTask?:
      | {
          readonly taskId: string;
          readonly runnerContextId: string;
          readonly runId: string;
        }
      | undefined;
  }): Promise<{
    readonly request: CorrelatedRequestRow;
    readonly events: readonly CorrelatedRequestEventRow[];
    readonly settled: boolean;
  }> {
    const clampedMs = Math.min(Math.max(input.timeoutMs, 0), 5 * 60_000);
    const deadline = Date.now() + clampedMs;
    while (true) {
      const current = this.getRequest(input.shadowId, input.requestId);
      if (!OPEN_REQUEST_STATUSES.includes(current.request.status)) {
        if (
          input.consumerTask &&
          current.request.originTaskId === input.consumerTask.taskId
        ) {
          new TaskInboxStore(this.db).markDeliveredForCorrelation({
            taskId: input.consumerTask.taskId,
            correlationId: current.request.id,
            runnerContextId: input.consumerTask.runnerContextId,
            runId: input.consumerTask.runId,
          });
        }
        return { ...current, settled: true };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || input.signal?.aborted) {
        return { ...current, settled: false };
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, Math.min(remaining, 500));
        const onChange = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timer);
          settlementSignal.off(`req:${input.requestId}`, onChange);
          input.signal?.removeEventListener("abort", onAbort);
        };
        settlementSignal.once(`req:${input.requestId}`, onChange);
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  async handleCardAction(
    action: ChannelCardAction,
  ): Promise<ChannelCardActionResult | undefined> {
    const requestId =
      typeof action.actionValue.requestId === "string"
        ? action.actionValue.requestId.trim()
        : "";
    const option =
      typeof action.actionValue.option === "string"
        ? action.actionValue.option.trim()
        : "";
    if (!requestId || !option) return undefined;

    const req = this.db
      .select()
      .from(correlatedRequests)
      .where(eq(correlatedRequests.id, requestId))
      .get();
    if (!req || req.mode !== "card") {
      return {
        toast: { type: "warning", content: "未找到对应的确认请求。" },
      };
    }

    const binding = this.db
      .select()
      .from(shadowBotBindings)
      .where(
        and(
          eq(shadowBotBindings.shadowId, req.shadowId),
          eq(shadowBotBindings.status, "active"),
        ),
      )
      .get();
    if (binding && binding.channelConfigId !== action.channel.id) {
      return {
        toast: { type: "error", content: "通道绑定不匹配，无法处理该操作。" },
      };
    }

    const { userId, displayName } = this.resolveCardOperator(
      req.agentId,
      action,
    );
    if (req.targetUserId && userId !== req.targetUserId) {
      return {
        toast: { type: "warning", content: "该确认仅限指定负责人操作。" },
      };
    }

    const resolvedUserId =
      userId ??
      req.targetUserId ??
      new AgentStore(this.db).ownerUserId(req.agentId);

    if (req.status === "done") {
      return {
        toast: { type: "info", content: "该请求已被处理，无需重复操作。" },
      };
    }
    if (!OPEN_REQUEST_STATUSES.includes(req.status)) {
      return {
        toast: { type: "warning", content: `该请求已处于 ${req.status} 状态。` },
      };
    }

    const { request: settledReq, alreadyResolved } = this.updateRequest({
      requestId: req.id,
      action: "done",
      summary: option,
      selectedOption: option,
      resolvedByUserId: resolvedUserId,
      source: "card",
    });
    const finalOption = String(
      settledReq.resultJson?.selectedOption ??
        settledReq.resultJson?.summary ??
        option,
    );
    const isNegative = HEARTBEAT_NEGATIVE_VERDICT_RE.test(finalOption.trim());
    const actorLabel = displayName ?? resolvedUserId;
    const settledCard = {
      bodyMarkdown: req.instruction,
      options: req.optionsJson?.length ? req.optionsJson : [finalOption],
      selectedOption: finalOption,
      actorLabel,
      isNegative,
    };
    if (alreadyResolved) {
      return {
        toast: { type: "info", content: "该请求已被处理，无需重复操作。" },
        updatedTitle: isNegative ? "已跳过" : "已确认",
        updatedMarkdown: `${req.instruction}\n\n---\n${isNegative ? "⏭️" : "✅"} 已选择：**${finalOption}**`,
        settledCard,
      };
    }

    return {
      toast: {
        type: "success",
        content: isNegative ? `已跳过：${option}` : `已确认：${option}`,
      },
      updatedTitle: isNegative ? "已跳过" : "已确认",
      updatedMarkdown: `${req.instruction}\n\n---\n${isNegative ? "⏭️" : "✅"} 已由 **${actorLabel}** 选择：**${option}**`,
      settledCard,
    };
  }

  private resolveCardOperator(
    agentId: string,
    action: ChannelCardAction,
  ): { userId: string | null; displayName: string | null } {
    const candidateIds = [
      ...new Set(
        [
          action.operatorIdentity.providerIds?.open_id,
          action.operatorIdentity.providerIds?.union_id,
          action.operatorIdentity.providerIds?.user_id,
          action.operatorIdentity.externalId,
        ]
          .map(v => (typeof v === "string" ? v.trim() : ""))
          .filter(Boolean),
      ),
    ];
    for (const candidateId of candidateIds) {
      const bound = this.db
        .select({
          userId: users.id,
          displayName: users.displayName,
        })
        .from(channelIdentities)
        .innerJoin(
          channelUserBindings,
          eq(channelUserBindings.channelIdentityId, channelIdentities.id),
        )
        .innerJoin(users, eq(users.id, channelUserBindings.userId))
        .where(
          and(
            eq(channelIdentities.channelId, action.channel.id),
            eq(users.agentId, agentId),
            eq(users.status, "active"),
            sql`(${channelIdentities.externalId} = ${candidateId}
              OR json_extract(${channelIdentities.providerIdsJson}, '$.open_id') = ${candidateId}
              OR json_extract(${channelIdentities.providerIdsJson}, '$.union_id') = ${candidateId}
              OR json_extract(${channelIdentities.providerIdsJson}, '$.user_id') = ${candidateId})`,
          ),
        )
        .get();
      if (bound) {
        return { userId: bound.userId, displayName: bound.displayName };
      }
      const linked = this.db
        .select({ userId: users.id, displayName: users.displayName })
        .from(userIdentityLinks)
        .innerJoin(users, eq(users.id, userIdentityLinks.userId))
        .where(
          and(
            eq(users.agentId, agentId),
            eq(users.status, "active"),
            eq(userIdentityLinks.identityValue, candidateId),
          ),
        )
        .get();
      if (linked) {
        return { userId: linked.userId, displayName: linked.displayName };
      }
      const accountLinked = this.db
        .select({ userId: users.id, displayName: users.displayName })
        .from(accountIdentityClaims)
        .innerJoin(users, eq(users.accountId, accountIdentityClaims.accountId))
        .where(
          and(
            eq(users.agentId, agentId),
            eq(users.status, "active"),
            eq(accountIdentityClaims.identityValue, candidateId),
          ),
        )
        .get();
      if (accountLinked) {
        return {
          userId: accountLinked.userId,
          displayName: accountLinked.displayName,
        };
      }
    }
    return {
      userId: null,
      displayName: action.operatorIdentity.displayName ?? null,
    };
  }

  listRequests(
    shadowId: string,
    options: {
      readonly status?: CorrelatedRequestRow["status"] | undefined;
      readonly mode?: CorrelatedRequestMode | undefined;
      readonly originSessionId?: string | undefined;
      readonly originTaskId?: string | undefined;
      readonly targetSessionId?: string | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): CorrelatedRequestRow[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(correlatedRequests)
      .where(
        and(
          eq(correlatedRequests.shadowId, shadowId),
          options.status ? eq(correlatedRequests.status, options.status) : undefined,
          options.mode ? eq(correlatedRequests.mode, options.mode) : undefined,
          options.originSessionId
            ? eq(correlatedRequests.originSessionId, options.originSessionId)
            : undefined,
          options.originTaskId
            ? eq(correlatedRequests.originTaskId, options.originTaskId)
            : undefined,
          options.targetSessionId
            ? eq(correlatedRequests.targetSessionId, options.targetSessionId)
            : undefined,
        ),
      )
      .orderBy(desc(correlatedRequests.createdAt))
      .limit(limit)
      .all();
  }

  /** Open (`open` or `in_progress`) requests targeting `sessionId` for `<events>` injection. */
  openRequestsForTurn(
    sessionId: string,
    senderUserIds?: readonly string[],
    now = Date.now(),
  ): CorrelatedRequestRow[] {
    const rows = this.db
      .select()
      .from(correlatedRequests)
      .where(
        and(
          eq(correlatedRequests.targetSessionId, sessionId),
          inArray(correlatedRequests.status, [...OPEN_REQUEST_STATUSES]),
        ),
      )
      .orderBy(desc(correlatedRequests.createdAt))
      .all()
      .filter(r => r.expiresAt === null || r.expiresAt > now);

    if (!senderUserIds?.length) return rows;
    const senders = new Set(senderUserIds);
    return rows.filter(
      r =>
        r.mode === "delegate" ||
        r.targetUserId === null ||
        senders.has(r.targetUserId),
    );
  }

  /** Open requests originated by a specific `(taskId, taskRunId?)`. */
  openRequestsFromTask(
    taskId: string,
    taskRunId?: string,
  ): CorrelatedRequestRow[] {
    return this.db
      .select()
      .from(correlatedRequests)
      .where(
        and(
          eq(correlatedRequests.originTaskId, taskId),
          taskRunId ? eq(correlatedRequests.originTaskRunId, taskRunId) : undefined,
          inArray(correlatedRequests.status, [...OPEN_REQUEST_STATUSES]),
        ),
      )
      .orderBy(asc(correlatedRequests.createdAt))
      .all();
  }
}

/**
 * Self-routine that expires overdue `open` / `in_progress` requests and delivers
 * an `expired` `request_update` back to the origin session or Task.
 */
export function createCorrelatedRequestExpiryRoutine(): SelfRoutine<CorrelatedRequestRow> {
  return {
    kind: "request_expiry",
    originPrefix: SELF_ROUTINE_ORIGINS.request_expiry,
    commandKey: "request-expired",
    enabled: () => true,
    findDue({ db, now }: SelfRoutineContext): readonly CorrelatedRequestRow[] {
      const overdue = db
        .select()
        .from(correlatedRequests)
        .where(
          and(
            or(
              eq(correlatedRequests.status, "open"),
              eq(correlatedRequests.status, "in_progress"),
            ),
            lte(correlatedRequests.expiresAt, now),
          ),
        )
        .all();
      const candidates: CorrelatedRequestRow[] = [];
      for (const req of overdue) {
        if (req.originTaskId) {
          // Settle Task-originated request expiry directly via TaskInboxStore + auto-resume.
          const settled = db.transaction(tx => {
            const dbTx = tx as unknown as DrizzleDB;
            const fresh = tx
              .select()
              .from(correlatedRequests)
              .where(eq(correlatedRequests.id, req.id))
              .get();
            if (!fresh || !OPEN_REQUEST_STATUSES.includes(fresh.status)) return undefined;
            tx.update(correlatedRequests)
              .set({
                status: "expired",
                resultJson: { reason: "Expired without response", expiredAt: now, via: "expiry" },
                updatedAt: now,
              })
              .where(eq(correlatedRequests.id, req.id))
              .run();
            appendRequestEvent(dbTx, {
              requestId: req.id,
              direction: "system",
              kind: "expired",
              content: "Expired without response",
              createdAt: now,
            });
            const updated = tx
              .select()
              .from(correlatedRequests)
              .where(eq(correlatedRequests.id, req.id))
              .get()!;
            deliverRequestUpdateToOrigin(dbTx, sessionCommandsFor(dbTx, () => undefined), updated, now);
            return updated;
          });
          if (settled) {
            notifyRequestChanged(settled.id);
            triggerTaskAutoResumeIfNeeded(db, settled);
          }
          continue;
        }

        const origin = db
          .select()
          .from(sessions)
          .where(eq(sessions.id, req.originSessionId))
          .get();
        if (!origin || origin.status !== "active") {
          db.update(correlatedRequests)
            .set({
              status: "expired",
              resultJson: { reason: "Expired without response", via: "expiry" },
              updatedAt: now,
            })
            .where(
              and(
                eq(correlatedRequests.id, req.id),
                inArray(correlatedRequests.status, [...OPEN_REQUEST_STATUSES]),
              ),
            )
            .run();
          appendRequestEvent(db, {
            requestId: req.id,
            direction: "system",
            kind: "expired",
            content: "Expired without response",
            createdAt: now,
          });
          notifyRequestChanged(req.id);
          continue;
        }
        if (sessionBusy(db, origin.id)) continue;
        candidates.push(req);
      }
      return candidates;
    },
    resolveSessionId: (_ctx, req) => req.originSessionId,
    actorUserId: ({ db }, req) =>
      resolveReturnActorUserId(
        db,
        req,
        new AgentStore(db).ownerUserId(req.agentId),
      ),
    originId: (_ctx, req) => `${SELF_ROUTINE_ORIGINS.request_expiry}${req.id}`,
    instruction({ db }, req) {
      const previewRow: CorrelatedRequestRow = {
        ...req,
        status: "expired",
        resultJson: { summary: "Expired without response", via: "expiry" },
      };
      return formatRequestUpdateInstruction(buildUpdateEnvelope(db, previewRow, "expiry"));
    },
    onQueued({ db, now }, req, command) {
      const previewRow: CorrelatedRequestRow = {
        ...req,
        status: "expired",
        resultJson: { summary: "Expired without response", expiredAt: now, via: "expiry" },
      };
      const envelope = buildUpdateEnvelope(db, previewRow, "expiry");
      db.update(sessionCommands)
        .set({
          correlationId: req.id,
          payload: {
            ...command.payload,
            eventKind: "request_update",
            requestUpdate: envelope,
          },
        })
        .where(eq(sessionCommands.id, command.id))
        .run();
      db.update(correlatedRequests)
        .set({
          status: "expired",
          resultJson: { summary: "Expired without response", expiredAt: now, via: "expiry" },
          returnCommandId: command.id,
          updatedAt: now,
        })
        .where(eq(correlatedRequests.id, req.id))
        .run();
      appendRequestEvent(db, {
        requestId: req.id,
        direction: "system",
        kind: "expired",
        content: "Expired without response",
        commandId: command.id,
        createdAt: now,
      });
      notifyRequestChanged(req.id);
    },
  };
}
