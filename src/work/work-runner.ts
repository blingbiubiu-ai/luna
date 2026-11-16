import { memoryInjection } from "@/agents/agent-memory-injection";
import type {AgentExecutionSnapshot} from "@/agent-config";
import { prepareRunnerFiles } from "@/runners/prepare-runner-files";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { InvocationStore } from "@/runners/invocation-store";
import { randomUUID } from "node:crypto";
import { workInvocations } from "@/runners/main-invocation-registry";
import { runnerAnswers, finalizeRunnerReply } from "@/messaging/runner-answer";
import { SessionStore } from "@/sessions/session-store";
import type { NormalizedInboundMessage } from "@/channels";
import type { DrizzleDB } from "@/data";
import { users, channelUserBindings } from "@/data/schema";
import { sessionTimelineEntries } from "@/data/schema";
import type { SessionRow } from "@/sessions/session-store";
import type { MessageRow } from "@/sessions/message-store";
import { MessageStore } from "@/sessions/message-store";
import { SessionTimelineStore } from "@/sessions/session-timeline-store";
import type { SessionTurnExecutionInput } from "@/sessions/session-queue";
import {
  SessionRunnerAttemptStore,
  type SessionRunnerAttemptRow,
} from "@/sessions/session-runner-attempt-store";
import { SessionTurnStore } from "@/sessions/session-turn-store";
import { RunnerContextStore } from "@/runners/runner-context-store";
import { writeRunnerContextFile } from "@/runners/runner-context-file";
import { buildLunaServiceRunnerEnv } from "@/runners/luna-service-env";
import { invokeSessionAgent } from "@/runners/session-agent-invocation";
import {
  normalizeRunnerProgressStep,
  runnerProgressStepFromAssistant,
} from "@/runners/runner-progress-step";
import {
  normalizedInboundFromMessageRow,
  type NormalizedInboundFallback,
  runnerMessageEnvelopeFromRow,
  type RunnerMessageEnvelope,
} from "@/runners/message-envelope";
import { createAgentRunnerForConfig } from "@/kernel/agents";
import { extractSystemCommandMatch } from "@/messaging/gateway/system-command-parser";
import {
  buildTaskStatusCardSteps,
  type TaskStatusCardStepEvent,
} from "@/messaging/notifications/task-status-card-updater";
import { getKernel } from "@/server/routes/kernel";
import {
  createLogger,
  type AgentRunner,
} from "@/shared";
import { eq, and } from "drizzle-orm";
import type { StatusCardOutput } from "./status-card-schema";
import type { WorkReplyChannel } from "./types";
import { ensureWorkRunnerWorkspaceInstructions } from "./workspace-instructions";

const logger = createLogger("work-runner");

const MAX_HISTORY_MESSAGES = 20;
export interface WorkAgentRunInput {
  readonly prompt: string;
  readonly runnerContextId: string;
  readonly signal?: AbortSignal;
  readonly reportProgress?: (summary: string) => Promise<void>;
}

export interface WorkRunnerOptions {
  readonly db: DrizzleDB;
  readonly runnerType: string;
  readonly channelForMessage: (channelId: string) => WorkReplyChannel | undefined;
  readonly runAgent?: (input: WorkAgentRunInput) => Promise<string>;
  readonly createRunner?: () => AgentRunner;
}

interface SentStatusCard {
  readonly providerMessageId: string;
  readonly timelineEntryId?: string;
}

function buildInboundFromMessageRow(
  session: SessionRow,
  row: MessageRow,
): NormalizedInboundMessage {
  return normalizedInboundFromMessageRow(row, workSessionInboundFallback(session));
}

function workSessionInboundFallback(session: SessionRow): NormalizedInboundFallback {
  return {
    channel: { type: session.channel_type, id: session.channel_id },
    surface: {
      externalId: session.group_id ?? session.channel_id,
      kind: session.group_id === null ? "p2p" : "group",
    },
    ...(session.thread_key !== null
      ? {
          thread: {
            externalId: session.thread_key,
            ...(session.root_message_key !== null
              ? { rootMessageExternalId: session.root_message_key }
              : {}),
          },
        }
      : {}),
  };
}

interface WorkRunnerTurnPromptInput {
  readonly type: "work_turn";
  readonly sessionId: string;
  readonly latestMessageAddressing?: NormalizedInboundMessage["addressing"];
  readonly activationFollowupAddressing?: {
    readonly sessionSourceMessageId: string;
    readonly followupCount?: number;
  };
  readonly launchContextMessages?: readonly RunnerMessageEnvelope[];
  readonly orderedMessages: readonly RunnerMessageEnvelope[];
}

/**
 * Work Runner: executes work session turns.
 * Builds prompt from session history + turn messages, runs the agent,
 * accepts command-based replies and maintains execution status cards.
 */
export class WorkRunner {
  private readonly _runnerContexts: RunnerContextStore;
  private readonly _messageStore: MessageStore;
  private readonly _attemptStore: SessionRunnerAttemptStore;
  private readonly _timelineStore: SessionTimelineStore;
  private readonly _turnStore: SessionTurnStore;

  constructor(private readonly _options: WorkRunnerOptions) {
    this._runnerContexts = new RunnerContextStore(_options.db);
    this._messageStore = new MessageStore(_options.db);
    this._attemptStore = new SessionRunnerAttemptStore(_options.db);
    this._timelineStore = new SessionTimelineStore(_options.db);
    this._turnStore = new SessionTurnStore(_options.db);
  }

  async executeWorkTurn(
    input: SessionTurnExecutionInput,
    session: SessionRow,
    signal?: AbortSignal,
  ): Promise<void> {
    const latestMessageRow = input.messageRows.at(-1);
    if (!latestMessageRow) {
      throw new Error("Cannot execute an empty work turn.");
    }

    const channel = this._options.channelForMessage(session.channel_id);
    if (!channel) {
      throw new Error(`No reply channel for work session "${session.id}".`);
    }

    const inbound = buildInboundFromMessageRow(session, latestMessageRow);

    const invocationId = new InvocationStore(this._options.db).findActive({ runnerKind: "work", originId: input.turn.id, sessionId: session.id })?.id ?? randomUUID();
    const snapshot =
      this._options.runAgent === undefined &&
      this._options.createRunner === undefined &&
      this._options.runnerType !== "mock" &&
      this._options.runnerType !== "dummy"
        ? getKernel().resolveAgentExecutionSnapshot({agentId:session.agent_id,shadowId:session.shadow_id}, invocationId)
        : undefined;
    const currentRunnerType = snapshot?.agentType ?? this._options.runnerType;
    const resolvedRunnerContext = this._options.runAgent === undefined
      ? this._runnerContexts.resolveForSession(
        session.id,
        currentRunnerType,
      )
      : undefined;
    const compatibleRunnerContext = resolvedRunnerContext !== undefined && snapshot !== undefined
      ? this._runnerContexts.syncAgentCompatibility(resolvedRunnerContext.id, {
        providerFingerprint: snapshot.providerFingerprint,
        modelFingerprint: snapshot.modelFingerprint,
        resumeOnModelChange: snapshot.resumeOnModelChange,
      }).runnerContext
      : resolvedRunnerContext;
    let runnerContext = compatibleRunnerContext;


    const fallback = workSessionInboundFallback(session);
    const turnMessages = input.messageRows.map((row, index) =>
      runnerMessageEnvelopeFromRow({
        row,
        index: index + 1,
        rawMessage: normalizedInboundFromMessageRow(row, fallback),
        transformText: stripWorkCommand,
      })
    );

    const historyMessages = this._messageStore
      .listMessagesBefore({
        sessionId: session.id,
        beforeCreatedAt: latestMessageRow.created_at,
      })
      .slice(-MAX_HISTORY_MESSAGES)
      .map((row, index) =>
        runnerMessageEnvelopeFromRow({
          row,
          index: index + 1,
          rawMessage: normalizedInboundFromMessageRow(row, fallback),
          transformText: stripWorkCommand,
        })
      )
      .filter((message) => message.text.length > 0);

    const includeLaunchContext = runnerContext === undefined ||
      runnerContext.runner_session_id === null;
    logger.info({
      sessionId: session.id,
      turnId: input.turn.id,
      runnerContextId: runnerContext?.id,
      runnerType: currentRunnerType,
      includeLaunchContext,
      launchContextReason: runnerContext === undefined
        ? "missing_runner_context"
        : runnerContext.runner_session_id === null
          ? "missing_runner_session_id"
          : "existing_runner_session_id",
      existingRunnerSessionId: runnerContext?.runner_session_id ?? null,
      historyMessageCount: historyMessages.length,
    }, "Prepared work runner prompt");

    const prompt = buildWorkTurnPrompt({
      inputJson: buildWorkTurnInputJson({
        sessionId: session.id,
        inbound,
        orderedMessages: turnMessages,
        launchContextMessages: includeLaunchContext ? historyMessages : [],
      }),
      currentTurnMessages: turnMessages,
      launchContext: historyMessages,
      includeLaunchContext,
    });

    // Execute runner
    let rawOutput: string;
    let attempt: SessionRunnerAttemptRow | undefined;
    let statusCard: SentStatusCard | undefined;
    let runnerSessionId = runnerContext?.runner_session_id ?? undefined;
    const progressEvents: TaskStatusCardStepEvent[] = [];
    const reportProgress = async (summary: string): Promise<void> => {
      const stepName = normalizeRunnerProgressStep(summary);
      if (stepName === undefined || progressEvents.at(-1)?.summary === stepName) {
        return;
      }
      progressEvents.push({
        type: "runner.step",
        summary: stepName,
      });
      const stepNames = buildTaskStatusCardSteps({ timelineEvents: progressEvents }) ?? [];
      try {
        const sentCard = await this._sendStatusCard(channel, inbound, {
          title: "工作会话",
          status: "in_progress",
          steps: stepNames.map((name, index) => ({
            name,
            status: index === stepNames.length - 1 ? "active" : "done",
          })),
          summary: "",
        }, latestMessageRow, session.id, {
          ...(statusCard !== undefined
            ? { targetMessageId: statusCard.providerMessageId }
            : {}),
        });
        if (statusCard === undefined) {
          statusCard = sentCard;
        }
        this._attachStatusCardToTurn(input.turn.id, sentCard);
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "failed to update work status card progress");
      }
    };
    await reportProgress("工作会话执行已开始。");
    try {
      if (this._options.runAgent !== undefined) {
        attempt = this._attemptStore.createRunning({
          sessionId: session.id,
          turnId: input.turn.id,
          runnerType: currentRunnerType,
          attemptKind: "primary",
          inputPrompt: prompt,
        });
        rawOutput = await this._options.runAgent({
          prompt,
          runnerContextId: session.id,
          ...(signal !== undefined ? { signal } : {}),
          reportProgress,
        });
      } else {
        if (runnerContext === undefined) {
          throw new Error("Work runner context was not resolved.");
        }
        const attemptContextId=runnerContext.id;
        const memoryActor = this._requestedByUserIdForWorkRunner(latestMessageRow, session);
        const memory = memoryActor === undefined ? undefined : memoryInjection(this._options.db,
          {agentId: session.agent_id, shadowId: session.shadow_id, actorUserId: memoryActor, sessionId: session.id, taskId: null, runnerContextId: runnerContext.id}, inbound.text);
        const turnPrompt = memory?.text ? `${prompt}\n\n${memory.text}` : prompt;
        attempt = this._attemptStore.listForTurn(input.turn.id).find(row => row.status === "running" && row.runnerContextId === attemptContextId) ?? this._attemptStore.createRunning({
          sessionId: session.id,
          turnId: input.turn.id,
          runnerContextId: runnerContext.id,
          runnerType: currentRunnerType,
          runnerSessionId: runnerContext.runner_session_id,
          attemptKind: "primary",
          inputPrompt: turnPrompt,
        });
        const runner = this._options.createRunner?.() ??
          createAgentRunnerForConfig(
            snapshot!,
            getKernel().runtimeAgentTransport,
          );
        workInvocations(this._options.db).set(invocationId, {
          runnerContextId: runnerContext.id, sessionId: session.id,
          turnId: input.turn.id, ...(signal ? { signal } : {}),
        });
        const serviceEnv = this._workRunnerServiceEnv(
          invocationId,
          runnerContext.id,
          latestMessageRow,
          session,
          snapshot,
        );
        const instructions=await prepareRunnerFiles(runnerContext,buildWorkRunnerContextFile(session,inbound),signal,invocationId);
        runnerContext=this._runnerContexts.syncInstructionFingerprint(runnerContext.id,instructions.instructionFingerprint).runnerContext;
        let pendingAssistantStep: string | undefined;
        const invocation = await invokeSessionAgent({
          runner,
          runnerContext,
          runnerContextStore: this._runnerContexts,
          runnerKind: "work",
          messageId: `work-${session.id}-${input.turn.id}`,
          prompt: turnPrompt,
          env: {
            ...(snapshot?.env ?? {}),
            ...(serviceEnv ?? {}),
          },
          ...(signal !== undefined ? { signal } : {}),
          onAssistantEvent: async (event) => {
            if (pendingAssistantStep !== undefined) {
              await reportProgress(pendingAssistantStep);
              pendingAssistantStep = undefined;
            }
            const stepSummary = runnerProgressStepFromAssistant(event);
            if (stepSummary !== undefined) {
              pendingAssistantStep = stepSummary;
            }
          },
        });
        memory?.commit();
        rawOutput = invocation.text;
        runnerSessionId = invocation.runnerSessionId;
      }
      if (!signal?.aborted) {
      finalizeRunnerReply(this._options.db, {
        sessionId: session.id, originId: input.turn.id, text: rawOutput, allowSilent: false,
        ...(new InvocationStore(this._options.db).find(invocationId) ? { invocationId } : {}),
        actorUserId: this._requestedByUserIdForWorkRunner(latestMessageRow, session),
      });
      }
    } catch (err) {
      if (err instanceof RuntimeDetachedError) throw err;
      if (attempt !== undefined) {
        this._attemptStore.markRunnerFailed(attempt.id, {
          error: err,
          ...(runnerSessionId !== undefined ? { runnerSessionId } : {}),
        });
      }
      if (signal?.aborted) {
        const sentCard = await this._sendStatusCard(channel, inbound, {
          title: "工作会话",
          status: "cancelled",
          steps: [],
          summary: "已通过 #steer 取消",
        }, latestMessageRow, session.id, {
          ...(statusCard !== undefined
            ? { targetMessageId: statusCard.providerMessageId }
            : {}),
        });
        this._attachStatusCardToTurn(input.turn.id, sentCard);
        return;
      }
      logger.warn({ err, sessionId: session.id }, "work runner execution failed");
      const sentCard = await this._sendStatusCard(channel, inbound, {
        title: "工作会话",
        status: "blocked",
        steps: [],
        summary: `执行出错：${err instanceof Error ? err.message : String(err)}`,
      }, latestMessageRow, session.id, {
        ...(statusCard !== undefined
          ? { targetMessageId: statusCard.providerMessageId }
          : {}),
      });
      this._attachStatusCardToTurn(input.turn.id, sentCard);
      return;
    } finally {
      workInvocations(this._options.db).delete(invocationId);
    }

    if (signal?.aborted) {
      const sentCard = await this._sendStatusCard(channel, inbound, {
        title: "工作会话",
        status: "cancelled",
        steps: runtimeProgressStepNames(progressEvents).map((name) => ({ name, status: "done" })),
        summary: "已通过 #steer 取消",
      }, latestMessageRow, session.id, {
        ...(statusCard !== undefined
          ? { targetMessageId: statusCard.providerMessageId }
          : {}),
      });
      this._attachStatusCardToTurn(input.turn.id, sentCard);
      return;
    }

    const answers = runnerAnswers(this._options.db, session.id, input.turn.id);
    const card: StatusCardOutput = {
      title: "工作会话",
      status: answers.length ? "completed" : "blocked",
      steps: runtimeProgressStepNames(progressEvents).map(name => ({ name, status: "done" })),
      summary: answers.length ? "执行完成，答复已提交投递。" : "执行结束，未提交最终答复。",
    };
    if (attempt !== undefined) {
      this._attemptStore.markParsed(attempt.id, {
        rawOutput,
        parsedActionJson: card,
        ...(runnerSessionId !== undefined ? { runnerSessionId } : {}),
      });
    }

    // Send final status card
    const sentCard = await this._sendStatusCard(channel, inbound, card, latestMessageRow, session.id, {
      ...(statusCard !== undefined
        ? { targetMessageId: statusCard.providerMessageId }
        : {}),
    });
    this._attachStatusCardToTurn(input.turn.id, sentCard);
  }

  private _workRunnerServiceEnv(
    invocationId: string,
    runnerContextId: string,
    messageRow: MessageRow,
    session: SessionRow,
    agentConfig?:AgentExecutionSnapshot,
  ): Record<string, string> | undefined {
    try {
      return buildLunaServiceRunnerEnv({
        runnerKind: "work",
        ...(agentConfig ? {agentConfig} : {}),
        invocationId,
        runnerContextId,
        sessionId: session.id,
        requestedByUserId: this._requestedByUserIdForWorkRunner(
          messageRow,
          session,
        ),
        db: this._options.db,
      });
    } catch (err) {
      if(agentConfig) throw err;
      logger.warn(
        { err, sessionId: session.id },
        "work runner service env unavailable; artifact registration will be disabled",
      );
      return undefined;
    }
  }

  private _requestedByUserIdForWorkRunner(
    messageRow: MessageRow,
    session: SessionRow,
  ): string | undefined {
    // Persisted messages already carry a canonical user ID, including senders
    // without a channel identity link. Do not replace it with the session owner.
    const senderUserId = messageRow.senderUserId ?? messageRow.sender_user_id;
    if (senderUserId && this._options.db.select({ id: users.id }).from(users).where(eq(users.id, senderUserId)).get()) {
      return senderUserId;
    }
    const senderIdentityId = messageRow.senderIdentityId;
    if (senderIdentityId !== null && senderIdentityId !== undefined) {
      const link = this._options.db
        .select({ userId: channelUserBindings.userId })
        .from(channelUserBindings)
        .where(eq(channelUserBindings.channelIdentityId, senderIdentityId))
        .get();
      if (link !== undefined) {
        return link.userId;
      }
    }
    return session.created_by_user_id ?? undefined;
  }

  private async _sendStatusCard(
    channel: WorkReplyChannel,
    inbound: NormalizedInboundMessage,
    card: StatusCardOutput,
    messageRow: MessageRow,
    sessionId: string,
    options: { readonly targetMessageId?: string } = {},
  ): Promise<SentStatusCard> {
    if (sessionId) new SessionStore(this._options.db).requireReplyUserId(sessionId);
    const steps = card.steps.map((s) => `${s.name}${s.note ? ` — ${s.note}` : ""}`);
    const isCreate = options.targetMessageId === undefined;
    const replyMode = isCreate ? "reply_in_thread" : "update_status_card";
    const createTargetMessageId = inbound.thread?.rootMessageExternalId ?? inbound.thread?.externalId ?? inbound.id;
    const persistedUpdate = options.targetMessageId !== undefined
      ? this._persistStatusCard({
        inbound,
        card,
        steps,
        messageRow,
        sessionId,
        providerMessageId: options.targetMessageId,
      })
      : undefined;
    let outbound;
    try {
      outbound = await channel.send(inbound, {
        replyMode,
        content: card.summary,
        statusCardSteps: steps,
        statusCardState: card.status === "in_progress" ? "active" : "terminal",
        statusCard: {
          taskId: sessionId || "work-session",
          title: card.title,
          summary: card.summary,
          status: card.status,
          hideHeader: true,
        },
        ...(options.targetMessageId !== undefined
          ? { targetMessageId: options.targetMessageId }
          : { targetMessageId: createTargetMessageId }
        ),
        idempotencyKey: [
          "work-card",
          inbound.channel.id,
          messageRow.id,
          card.status,
          options.targetMessageId ?? "create",
          statusCardFingerprint(card, steps),
        ].join(":"),
      });
    } catch (err) {
      if (persistedUpdate !== undefined) {
        logger.warn(
          { err, sessionId, providerMessageId: options.targetMessageId },
          "failed to update work status card provider; final card remains persisted",
        );
        return persistedUpdate;
      }
      throw err;
    }
    const providerMessageId = options.targetMessageId ?? outbound.id;

    // Persist status card as an assistant message for dashboard visibility
    return persistedUpdate ?? this._persistStatusCard({
      inbound,
      card,
      steps,
      messageRow,
      sessionId,
      providerMessageId,
      ...(outbound.sender !== undefined ? { sender: outbound.sender } : {}),
    });
  }

  private _persistStatusCard(input: {
    readonly inbound: NormalizedInboundMessage;
    readonly card: StatusCardOutput;
    readonly steps: readonly string[];
    readonly messageRow: MessageRow;
    readonly sessionId: string;
    readonly providerMessageId: string;
    readonly sender?: NormalizedInboundMessage["sender"];
  }): SentStatusCard {
    if (input.sessionId !== "") {
      const botUserId = new SessionStore(this._options.db).requireReplyUserId(input.sessionId);
      const saved = this._messageStore.appendOrUpdateOnce({
        sessionId: input.sessionId,
        channelMessageKey: input.providerMessageId,
        role: "assistant",
        content: [{
          type: "card",
          cardKind: "status_card",
          presentationKind: "status_card",
          title: input.card.title,
          text: input.card.summary,
          ...(input.steps.length > 0 ? { steps: input.steps } : {}),
          payload: {
            status: input.card.status,
            steps: input.card.steps,
          },
        }],
        channel: input.inbound.channel,
        surface: input.inbound.surface,
        senderUserId: botUserId,
        contentKind: "card",
        presentationKind: "status_card",
        providerMessageType: "interactive",
        rawPayload: {
          origin: "work_status_card",
          status: input.card.status,
          title: input.card.title,
          steps: input.card.steps,
          statusCardState: input.card.status === "in_progress" ? "active" : "terminal",
        },
      });
      const timelineEntry = this._timelineStore.appendMessage({
        sessionId: input.sessionId,
        messageId: saved.row.id,
      });
      const sourceSessionId = this._sourceOwningSessionId(input.messageRow) ??
        input.messageRow.sessionId ??
        input.messageRow.session_id;
      if (sourceSessionId !== "" && sourceSessionId !== input.sessionId) {
        this._timelineStore.appendReference({
          sessionId: sourceSessionId,
          messageId: saved.row.id,
        });
      }
      return {
        providerMessageId: input.providerMessageId,
        timelineEntryId: timelineEntry.id,
      };
    }
    return { providerMessageId: input.providerMessageId };
  }

  private _attachStatusCardToTurn(turnId: string, statusCard: SentStatusCard): void {
    if (statusCard.timelineEntryId === undefined) {
      return;
    }
    if (this._turnStore.getById(turnId) === undefined) {
      return;
    }
    this._turnStore.attachEntries(turnId, [
      { entryId: statusCard.timelineEntryId, role: "output" },
    ]);
  }

  private _sourceOwningSessionId(messageRow: MessageRow): string | undefined {
    return this._options.db
      .select({ sessionId: sessionTimelineEntries.sessionId })
      .from(sessionTimelineEntries)
      .where(and(
        eq(sessionTimelineEntries.messageId, messageRow.id),
        eq(sessionTimelineEntries.entryKind, "message"),
      ))
      .get()?.sessionId;
  }
}

function buildWorkTurnPrompt(input: {
  readonly inputJson: WorkRunnerTurnPromptInput;
  readonly currentTurnMessages: readonly RunnerMessageEnvelope[];
  readonly launchContext: readonly RunnerMessageEnvelope[];
  readonly includeLaunchContext: boolean;
}): string {
  const sections = [
    "# Work Session Turn",
    "",
    "## Work Runner Input",
    "```json",
    JSON.stringify(input.inputJson, null, 2),
    "```",
    "",
  ];
  if (input.includeLaunchContext) {
    sections.push(
      "## Work Launch Context",
      input.launchContext.length > 0
        ? "See launchContextMessages in the JSON input above."
        : "(no prior messages)",
      "",
    );
  }
  sections.push(
    "## Current Turn Messages",
    input.currentTurnMessages.length > 0
      ? "See orderedMessages in the JSON input above."
      : "(no current messages)",
  );
  return sections.join("\n");
}

function buildWorkTurnInputJson(input: {
  readonly sessionId: string;
  readonly inbound: NormalizedInboundMessage;
  readonly launchContextMessages: readonly RunnerMessageEnvelope[];
  readonly orderedMessages: readonly RunnerMessageEnvelope[];
}): WorkRunnerTurnPromptInput {
  return {
    type: "work_turn",
    sessionId: input.sessionId,
    latestMessageAddressing: input.inbound.addressing,
    ...activationFollowupAddressing(input.inbound),
    ...(input.launchContextMessages.length > 0
      ? { launchContextMessages: input.launchContextMessages }
      : {}),
    orderedMessages: input.orderedMessages,
  };
}

function buildWorkRunnerContextFile(
  session: SessionRow,
  inbound: NormalizedInboundMessage,
) {
  return {
    schemaVersion: 1,
    runnerKind: "work",
    owner: { type: "session", id: session.id },
    stableContext: {
      workSession: {
        id: session.id,
        channel: inbound.channel,
        surface: sanitizedSurface(inbound.surface),
        ...(inbound.thread !== undefined ? { thread: inbound.thread } : {}),
        delivery: { replyTarget: "session_thread" },
      },
    },
  } as const;
}

function sanitizedSurface(
  surface: NormalizedInboundMessage["surface"],
): NormalizedInboundMessage["surface"] {
  const { rawProfile: _rawProfile, ...rest } =
    surface as NormalizedInboundMessage["surface"] & { readonly rawProfile?: unknown };
  return rest;
}

function activationFollowupAddressing(
  inbound: NormalizedInboundMessage,
): Pick<WorkRunnerTurnPromptInput, "activationFollowupAddressing"> {
  const inboundRecord = inbound as unknown as Record<string, unknown>;
  const activationFollowup = inboundRecord.activationFollowup;
  if (!isRecord(activationFollowup)) {
    return {};
  }
  const sessionSourceMessageId = activationFollowup.sessionSourceMessageId;
  if (typeof sessionSourceMessageId !== "string") {
    return {};
  }
  const followupCount = activationFollowup.followupCount;
  return {
    activationFollowupAddressing: {
      sessionSourceMessageId,
      ...(typeof followupCount === "number" ? { followupCount } : {}),
    },
  };
}

function stripWorkCommand(text: string): string {
  const trimmed = text.trim();
  const command = extractSystemCommandMatch(trimmed, true);
  if (command?.command !== "#work") {
    return text;
  }
  return trimmed.slice(command.end).trim();
}

function runtimeProgressStepNames(
  progressEvents: readonly TaskStatusCardStepEvent[],
): readonly string[] {
  return buildTaskStatusCardSteps({ timelineEvents: progressEvents }) ?? [];
}

function statusCardFingerprint(
  card: StatusCardOutput,
  renderedSteps: readonly string[],
): string {
  return hashString(JSON.stringify({
    title: card.title,
    status: card.status,
    summary: card.summary,
    steps: renderedSteps,
  }));
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return (hash >>> 0).toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
