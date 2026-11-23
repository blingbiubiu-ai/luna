import { createHash } from "node:crypto";
import { and, desc, eq, lte, sql } from "drizzle-orm";
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
  correlatedRequests,
  sessionCommands,
  sessions,
  shadowBotBindings,
  shadowHeartbeats,
  userIdentityLinks,
  users,
} from "@/data/schema";
import { GatewayError } from "@/server/gateway-error";
import type { ReplyDocument } from "@luna/runner-protocol/reply";
import { resolveLunaAddress } from "./luna-address";
import {
  sessionCommandsFor,
  type CommandActor,
  type SessionCommand,
  type SessionCommandService,
} from "./session-command-service";

export type CorrelatedRequestRow = typeof correlatedRequests.$inferSelect;

export interface RequestResultEnvelope {
  readonly requestId: string;
  readonly kind: "ask" | "handoff";
  readonly status: CorrelatedRequestRow["status"];
  readonly instruction: string;
  readonly contextSummary: string | null;
  readonly targetAddress: string;
  readonly targetSessionId: string;
  readonly resolvedByUserId: string | null;
  readonly resolvedByRole?: "owner" | "member" | null | undefined;
  readonly result: Record<string, unknown> | null;
}

function deterministicRequestId(
  sourceSessionId: string,
  originId: string,
  kind: "ask" | "handoff",
  key: string,
): string {
  const digest = createHash("sha256")
    .update(`${sourceSessionId}:${originId}:${kind}:${key}`)
    .digest("hex")
    .slice(0, 20);
  return `req_${digest}`;
}

export function formatRequestResultInstruction(env: RequestResultEnvelope): string {
  return [
    `Correlated ${env.kind} result [${env.requestId}] (status: ${env.status})`,
    `Target: ${env.targetAddress} (session:${env.targetSessionId})`,
    `Original ${env.kind === "ask" ? "question" : "instruction"}: ${env.instruction}`,
    ...(env.contextSummary ? [`Context: ${env.contextSummary}`] : []),
    ...(env.resolvedByUserId
      ? [
          `Resolved by: ${env.resolvedByUserId}${env.resolvedByRole ? ` (${env.resolvedByRole})` : ""}`,
        ]
      : []),
    ...(env.result ? [`Result: ${JSON.stringify(env.result)}`] : []),
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

function queueReturnToOrigin(
  db: DrizzleDB,
  commands: Pick<SessionCommandService, "accept">,
  req: CorrelatedRequestRow,
  originPrefix: string,
  now = Date.now(),
): string | null {
  const originSession = db
    .select()
    .from(sessions)
    .where(eq(sessions.id, req.originSessionId))
    .get();
  if (!originSession || originSession.status !== "active") return null;

  const ownerUserId = new AgentStore(db).ownerUserId(req.agentId);
  const validActor = resolveReturnActorUserId(db, req, ownerUserId);
  const resolvedByRole = req.resolvedByUserId
    ? req.resolvedByUserId === ownerUserId
      ? "owner"
      : "member"
    : null;

  const envelope: RequestResultEnvelope = {
    requestId: req.id,
    kind: req.kind,
    status: req.status,
    instruction: req.instruction,
    contextSummary: req.contextSummary,
    targetAddress: req.targetAddress,
    targetSessionId: req.targetSessionId,
    resolvedByUserId: req.resolvedByUserId,
    resolvedByRole,
    result: req.resultJson,
  };

  try {
    const cmd = commands.accept(
      {
        userId: validActor,
        sourceSessionId: req.originSessionId,
        originId: `${originPrefix}${req.id}`,
        correlationId: req.id,
        hops: Math.max(1, req.hops),
      },
      req.originSessionId,
      "session.invoke",
      "result",
      {
        content: formatRequestResultInstruction(envelope),
        purpose: "notification",
        requestResult: envelope,
      } as never,
      { expiresAt: now + 24 * 3_600_000 },
    );
    return cmd.id;
  } catch (error) {
    console.warn("failed to queue correlated request result return", {
      requestId: req.id,
      error: String(error),
    });
    return null;
  }
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
 * return invocation (`correlated_requests.return_command_id`) of an owner-approved ask.
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
        eq(correlatedRequests.kind, "ask"),
        eq(correlatedRequests.status, "answered"),
        eq(correlatedRequests.shadowId, actor.shadowId),
        eq(correlatedRequests.originSessionId, actor.currentSessionId),
        eq(correlatedRequests.resolvedByUserId, ownerUserId),
      ),
    )
    .get();
  if (!req) return false;
  const res = req.resultJson ?? {};
  const verdict = String(res.selectedOption ?? res.answer ?? "").trim();
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
    "Heartbeat proactive follow-up requires owner approval first: send an approval card via `luna asks create --to owner --options '[\"同意跟进\",\"暂不发送\"]' ...` and wait for `request_result` before dispatching to another session.",
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

  createAsk(input: {
    readonly actor: CommandActor & {
      readonly agentId: string;
      readonly shadowId: string;
      readonly currentSessionId: string;
      readonly invocationId?: string;
    };
    readonly key: string;
    readonly toAddress: string;
    readonly question: string;
    readonly contextSummary?: string | undefined;
    readonly options?: readonly string[] | undefined;
    readonly expiresInMs?: number | undefined;
    readonly now?: number | undefined;
  }): CorrelatedRequestRow {
    const now = input.now ?? Date.now();
    const question = input.question.trim();
    if (!question) {
      throw new GatewayError("invalid_question", "Question cannot be empty", 400);
    }
    const ownerUserId = new AgentStore(this.db).ownerUserId(input.actor.agentId);
    const trimmedTo = input.toAddress.trim();
    const allowLocalFallback =
      trimmedTo === "owner" || trimmedTo === `user:${ownerUserId}`;
    const resolved = resolveLunaAddress(
      this.db,
      {
        agentId: input.actor.agentId,
        shadowId: input.actor.shadowId,
        currentSessionId: input.actor.currentSessionId,
      },
      input.toAddress,
      { create: true, allowLocalFallback },
    );
    if (resolved.kind === "self") {
      throw new GatewayError(
        "invalid_ask_target",
        "Cannot ask the Heartbeat self session",
        400,
      );
    }
    assertHeartbeatOutboundApproved(this.db, input.actor, {
      allowOwnerAskTargetUserId: resolved.targetUserId,
    });

    const requestId = deterministicRequestId(
      input.actor.sourceSessionId,
      input.actor.originId,
      "ask",
      input.key,
    );
    const existing = this.db
      .select()
      .from(correlatedRequests)
      .where(eq(correlatedRequests.id, requestId))
      .get();
    if (existing) {
      if (
        existing.instruction !== question ||
        existing.targetSessionId !== resolved.sessionId
      ) {
        throw new GatewayError(
          "idempotency_conflict",
          "Key already used with different ask parameters",
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
    const cleanOptions = input.options?.map(o => o.trim()).filter(Boolean);

    const reply: ReplyDocument | undefined =
      cleanOptions && cleanOptions.length > 0
        ? {
            type: "luna.reply",
            version: 1,
            presentation: "card",
            template: "markdown",
            title: "待确认",
            content: [
              { type: "text", text: question },
              { type: "actions", requestId, options: cleanOptions },
            ],
          }
        : undefined;

    return this.db.transaction(tx => {
      const cmd = this.commands.accept(
        input.actor,
        resolved.sessionId,
        "message.send",
        `ask:${input.key}`,
        {
          content: question,
          ...(reply ? { reply } : {}),
          purpose: "notification",
        },
        { availableAt: now },
      );

      const row: typeof correlatedRequests.$inferInsert = {
        id: requestId,
        kind: "ask",
        agentId: input.actor.agentId,
        shadowId: input.actor.shadowId,
        originSessionId: input.actor.sourceSessionId,
        originTurnId: input.actor.originId,
        targetAddress: resolved.address,
        targetSessionId: resolved.sessionId,
        targetUserId: resolved.targetUserId ?? null,
        outboundCommandId: cmd.id,
        outboundMessageId: cmd.messageId,
        instruction: question,
        contextSummary: input.contextSummary?.trim() || null,
        optionsJson: cleanOptions?.length ? cleanOptions : null,
        hops: input.actor.hops ?? 3,
        status: "pending",
        resultJson: null,
        resolvedByUserId: null,
        returnCommandId: null,
        expiresAt,
        createdByInvocationId: input.actor.invocationId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(correlatedRequests).values(row).run();
      return tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, requestId))
        .get()!;
    });
  }

  answerAsk(input: {
    readonly requestId: string;
    readonly answer: string;
    readonly selectedOption?: string | undefined;
    readonly resolvedByUserId: string;
    readonly source: "runner" | "card" | "dashboard";
    readonly expectedShadowId?: string | undefined;
    readonly expectedTargetSessionId?: string | undefined;
    readonly now?: number | undefined;
  }): { readonly request: CorrelatedRequestRow; readonly alreadyResolved: boolean } {
    const now = input.now ?? Date.now();
    const answer = input.answer.trim();
    if (!answer) {
      throw new GatewayError("invalid_answer", "Answer cannot be empty", 400);
    }

    return this.db.transaction(tx => {
      const existing = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, input.requestId))
        .get();
      if (!existing || existing.kind !== "ask") {
        throw new GatewayError("ask_not_found", "Ask request not found", 404);
      }
      if (
        input.expectedShadowId &&
        existing.shadowId !== input.expectedShadowId
      ) {
        throw new GatewayError(
          "ask_forbidden",
          "Ask belongs to another Shadow",
          403,
        );
      }
      if (
        input.expectedTargetSessionId &&
        existing.targetSessionId !== input.expectedTargetSessionId
      ) {
        throw new GatewayError(
          "ask_session_mismatch",
          "Ask does not target the current session",
          403,
        );
      }
      if (
        existing.targetUserId &&
        input.resolvedByUserId !== existing.targetUserId
      ) {
        throw new GatewayError(
          "ask_forbidden",
          "Ask targets another user",
          403,
        );
      }
      if (existing.status === "answered") {
        return { request: existing, alreadyResolved: true };
      }
      if (existing.status !== "pending") {
        throw new GatewayError(
          "ask_not_pending",
          `Ask is already ${existing.status}`,
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

      const resultPayload = {
        answer,
        ...(input.selectedOption ? { selectedOption: input.selectedOption } : {}),
        source: input.source,
      };
      tx.update(correlatedRequests)
        .set({
          status: "answered",
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
      const returnCmdId = queueReturnToOrigin(
        this.db,
        this.commands,
        updated,
        "request-result:",
        now,
      );
      if (returnCmdId) {
        tx.update(correlatedRequests)
          .set({ returnCommandId: returnCmdId })
          .where(eq(correlatedRequests.id, existing.id))
          .run();
      }
      return {
        request: tx
          .select()
          .from(correlatedRequests)
          .where(eq(correlatedRequests.id, existing.id))
          .get()!,
        alreadyResolved: false,
      };
    });
  }

  cancelAsk(input: {
    readonly requestId: string;
    readonly shadowId: string;
    readonly now?: number | undefined;
  }): CorrelatedRequestRow {
    const now = input.now ?? Date.now();
    return this.db.transaction(tx => {
      const existing = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, input.requestId))
        .get();
      if (!existing || existing.shadowId !== input.shadowId) {
        throw new GatewayError("request_not_found", "Request not found", 404);
      }
      if (existing.status !== "pending") return existing;
      if (
        existing.outboundCommandId &&
        this.commands.get(existing.outboundCommandId)?.status === "pending"
      ) {
        this.commands.cancel(existing.outboundCommandId);
      }
      tx.update(correlatedRequests)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(correlatedRequests.id, existing.id))
        .run();
      return tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get()!;
    });
  }

  createHandoff(input: {
    readonly actor: CommandActor & {
      readonly agentId: string;
      readonly shadowId: string;
      readonly currentSessionId: string;
      readonly invocationId?: string;
    };
    readonly key: string;
    readonly targetSessionId: string;
    readonly targetAddress: string;
    readonly instruction: string;
    readonly contextRefs?: readonly string[] | undefined;
    readonly expiresInMs?: number | undefined;
    readonly now?: number | undefined;
  }): { readonly command: SessionCommand; readonly request: CorrelatedRequestRow } {
    const now = input.now ?? Date.now();
    if (input.targetSessionId === input.actor.currentSessionId) {
      throw new GatewayError(
        "self_handoff",
        "Cannot hand off to the same session",
        409,
      );
    }
    assertHeartbeatOutboundApproved(this.db, input.actor);
    const requestId = deterministicRequestId(
      input.actor.sourceSessionId,
      input.actor.originId,
      "handoff",
      input.key,
    );
    const existing = this.db
      .select()
      .from(correlatedRequests)
      .where(eq(correlatedRequests.id, requestId))
      .get();
    if (existing && existing.outboundCommandId) {
      const existingCmd = this.commands.get(existing.outboundCommandId);
      if (existingCmd) {
        if (
          existing.instruction !== input.instruction ||
          existing.targetSessionId !== input.targetSessionId
        ) {
          throw new GatewayError(
            "idempotency_conflict",
            "Key already used with different handoff parameters",
            409,
          );
        }
        return { command: existingCmd, request: existing };
      }
    }

    const defaultExpiresMs = resolveProactivitySettings(
      this.db,
      input.actor.agentId,
    ).askDefaultExpiresMs;
    const expiresAt = now + (input.expiresInMs ?? defaultExpiresMs);

    return this.db.transaction(tx => {
      const command = this.commands.accept(
        {
          ...input.actor,
          correlationId: input.actor.correlationId ?? requestId,
        },
        input.targetSessionId,
        "session.invoke",
        input.key,
        {
          content: input.instruction,
          contextRefs: [...(input.contextRefs ?? [])],
        },
        { availableAt: now, expiresAt },
      );

      tx.insert(correlatedRequests)
        .values({
          id: requestId,
          kind: "handoff",
          agentId: input.actor.agentId,
          shadowId: input.actor.shadowId,
          originSessionId: input.actor.sourceSessionId,
          originTurnId: input.actor.originId,
          targetAddress: input.targetAddress,
          targetSessionId: input.targetSessionId,
          targetUserId: null,
          outboundCommandId: command.id,
          outboundMessageId: null,
          instruction: input.instruction,
          contextSummary: null,
          optionsJson: null,
          hops: command.hops,
          status: "pending",
          resultJson: null,
          resolvedByUserId: null,
          returnCommandId: null,
          expiresAt,
          createdByInvocationId: input.actor.invocationId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, requestId))
        .get()!;
      return { command, request };
    });
  }

  resolveHandoff(input: {
    readonly requestId: string;
    readonly shadowId: string;
    readonly targetSessionId: string;
    readonly declined: boolean;
    readonly summaryOrReason: string;
    readonly resolvedByUserId: string;
    readonly now?: number | undefined;
  }): CorrelatedRequestRow {
    const now = input.now ?? Date.now();
    return this.db.transaction(tx => {
      const existing = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, input.requestId))
        .get();
      if (!existing || existing.kind !== "handoff") {
        throw new GatewayError("handoff_not_found", "Handoff request not found", 404);
      }
      if (
        existing.shadowId !== input.shadowId ||
        existing.targetSessionId !== input.targetSessionId
      ) {
        throw new GatewayError(
          "handoff_forbidden",
          "Handoff does not target this session",
          403,
        );
      }
      if (existing.status !== "pending") return existing;

      const status = input.declined ? "declined" : "done";
      const resultJson = input.declined
        ? { reason: input.summaryOrReason.trim() }
        : { summary: input.summaryOrReason.trim() };

      tx.update(correlatedRequests)
        .set({
          status,
          resultJson,
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
      const returnCmdId = queueReturnToOrigin(
        this.db,
        this.commands,
        updated,
        "request-result:",
        now,
      );
      if (returnCmdId) {
        tx.update(correlatedRequests)
          .set({ returnCommandId: returnCmdId })
          .where(eq(correlatedRequests.id, existing.id))
          .run();
      }
      return tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get()!;
    });
  }

  /**
   * Automatically settles a pending handoff when its target `session.invoke` turn ends,
   * unless the target Runner already explicitly resolved it via `resolveHandoff`.
   */
  settleHandoffFromTrigger(
    command: SessionCommand,
    outcome: "completed" | "failed",
    failure: string | null = null,
    now = Date.now(),
  ): void {
    const existing = this.db
      .select()
      .from(correlatedRequests)
      .where(
        and(
          eq(correlatedRequests.outboundCommandId, command.id),
          eq(correlatedRequests.kind, "handoff"),
          eq(correlatedRequests.status, "pending"),
        ),
      )
      .get();
    if (!existing) return;

    this.db.transaction(tx => {
      const fresh = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, existing.id))
        .get();
      if (!fresh || fresh.status !== "pending") return;

      let status: "done" | "declined" | "failed";
      let resultJson: Record<string, unknown>;
      if (outcome === "failed") {
        status = "failed";
        resultJson = { error: failure ?? "Target trigger execution failed" };
      } else {
        const sentMessages = tx
          .select()
          .from(sessionCommands)
          .where(
            and(
              eq(sessionCommands.originId, command.id),
              eq(sessionCommands.kind, "message.send"),
            ),
          )
          .all()
          .filter(r => !["failed", "cancelled"].includes(r.status));
        if (sentMessages.length > 0) {
          status = "done";
          resultJson = {
            deliveredCount: sentMessages.length,
            messages: sentMessages.map(m =>
              String(m.payload.content ?? "").slice(0, 500),
            ),
          };
        } else {
          status = "declined";
          resultJson = { reason: "Target session chose to stay silent" };
        }
      }

      tx.update(correlatedRequests)
        .set({
          status,
          resultJson,
          updatedAt: now,
        })
        .where(eq(correlatedRequests.id, fresh.id))
        .run();

      const updated = tx
        .select()
        .from(correlatedRequests)
        .where(eq(correlatedRequests.id, fresh.id))
        .get()!;
      const returnCmdId = queueReturnToOrigin(
        this.db,
        this.commands,
        updated,
        "request-result:",
        now,
      );
      if (returnCmdId) {
        tx.update(correlatedRequests)
          .set({ returnCommandId: returnCmdId })
          .where(eq(correlatedRequests.id, fresh.id))
          .run();
      }
    });
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
    if (!req || req.kind !== "ask") {
      return {
        toast: { type: "warning", content: "未找到对应的确认请求。" },
      };
    }

    // Verify the callback arrived on the channel bound to this request's Shadow.
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

    if (req.status === "answered") {
      return {
        toast: { type: "info", content: "该请求已被处理，无需重复操作。" },
      };
    }
    if (req.status !== "pending") {
      return {
        toast: { type: "warning", content: `该请求已处于 ${req.status} 状态。` },
      };
    }

    const { request: settledReq, alreadyResolved } = this.answerAsk({
      requestId: req.id,
      answer: option,
      selectedOption: option,
      resolvedByUserId: resolvedUserId,
      source: "card",
    });
    const finalOption = String(
      settledReq.resultJson?.selectedOption ??
        settledReq.resultJson?.answer ??
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
      // Check channelUserBindings first.
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
      // Check userIdentityLinks (`#link` claims).
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
      // Check accountIdentityClaims (e.g. Feishu OAuth owner account).
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
      readonly kind?: "ask" | "handoff" | undefined;
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
          options.kind ? eq(correlatedRequests.kind, options.kind) : undefined,
          options.targetSessionId
            ? eq(correlatedRequests.targetSessionId, options.targetSessionId)
            : undefined,
        ),
      )
      .orderBy(desc(correlatedRequests.createdAt))
      .limit(limit)
      .all();
  }

  /** Pending asks targeting `sessionId` (and matching `senderUserIds` when `targetUserId` is set). */
  pendingAsksForTurn(
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
          eq(correlatedRequests.kind, "ask"),
          eq(correlatedRequests.status, "pending"),
        ),
      )
      .orderBy(desc(correlatedRequests.createdAt))
      .all()
      .filter(r => r.expiresAt === null || r.expiresAt > now);

    if (!senderUserIds?.length) return rows;
    const senders = new Set(senderUserIds);
    return rows.filter(
      r => r.targetUserId === null || senders.has(r.targetUserId),
    );
  }
}

/**
 * Self-routine that expires overdue `pending` asks and handoffs and returns
 * an `expired` `request_result` back to each request's `originSessionId`.
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
            eq(correlatedRequests.status, "pending"),
            lte(correlatedRequests.expiresAt, now),
          ),
        )
        .all();
      const candidates: CorrelatedRequestRow[] = [];
      for (const req of overdue) {
        const origin = db
          .select()
          .from(sessions)
          .where(eq(sessions.id, req.originSessionId))
          .get();
        if (!origin || origin.status !== "active") {
          // Origin session gone: mark expired immediately so it is not scanned again.
          db.update(correlatedRequests)
            .set({
              status: "expired",
              resultJson: { reason: "Expired without response" },
              updatedAt: now,
            })
            .where(
              and(
                eq(correlatedRequests.id, req.id),
                eq(correlatedRequests.status, "pending"),
              ),
            )
            .run();
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
    instruction({ now }, req) {
      const envelope: RequestResultEnvelope = {
        requestId: req.id,
        kind: req.kind,
        status: "expired",
        instruction: req.instruction,
        contextSummary: req.contextSummary,
        targetAddress: req.targetAddress,
        targetSessionId: req.targetSessionId,
        resolvedByUserId: null,
        result: { reason: "Expired without response", expiredAt: now },
      };
      return formatRequestResultInstruction(envelope);
    },
    onQueued({ db, now }, req, command) {
      const envelope: RequestResultEnvelope = {
        requestId: req.id,
        kind: req.kind,
        status: "expired",
        instruction: req.instruction,
        contextSummary: req.contextSummary,
        targetAddress: req.targetAddress,
        targetSessionId: req.targetSessionId,
        resolvedByUserId: null,
        result: { reason: "Expired without response", expiredAt: now },
      };
      // Attach structured `requestResult` onto the queued session.invoke payload for Event Envelope rendering.
      db.update(sessionCommands)
        .set({
          correlationId: req.id,
          payload: { ...command.payload, requestResult: envelope },
        })
        .where(eq(sessionCommands.id, command.id))
        .run();
      db.update(correlatedRequests)
        .set({
          status: "expired",
          resultJson: { reason: "Expired without response", expiredAt: now },
          returnCommandId: command.id,
          updatedAt: now,
        })
        .where(eq(correlatedRequests.id, req.id))
        .run();
    },
  };
}
