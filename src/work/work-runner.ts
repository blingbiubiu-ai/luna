import { memoryInjection } from "@/agents/agent-memory-injection";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import { addressingFacts, compact, dataBlock, joinBlocks, messageItem, turnClock, type PeopleResolver } from "@/runners/turn-envelope";
import { shadowPeople } from "@/runners/shadow-people";
import type {AgentExecutionSnapshot} from "@/agent-config";
import { contextFileSurface, prepareRunnerDirectory, syncAgentCompatibility, turnAttempt } from "@/runners/session-runner-turn";
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
import { RunnerContextStore, type ResolvedRunnerContext } from "@/runners/runner-context-store";
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
import { BufferedProgress, RECENT_PROGRESS_STEPS } from "@/messaging/notifications/buffered-progress";
import {
  createLogger,
  extractTextContent,
  type AgentRunner,
} from "@/shared";
import { eq, and } from "drizzle-orm";
import type { StatusCardOutput } from "./status-card-schema";
import { AgentSettingsStore } from "@/agents/agent-settings-store";
import type { NativeProgressEntry, ReplyChannel } from "@/channels/outbound";

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
  readonly channelForMessage: (channelId: string) => ReplyChannel | undefined;
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

    const { invocationId, snapshot, runnerType: currentRunnerType, runnerContext: resolvedRunnerContext } =
      this._resolveExecution(session, input.turn.id, this._options.runAgent === undefined);
    let runnerContext = resolvedRunnerContext;


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

    const timezone = new PlatformSettingsStore(this._options.db).get().general.timezone;
    const prompt = buildWorkTurnPrompt({
      inbound,
      people: shadowPeople(this._options.db, { agentId: session.agent_id, shadowId: session.shadow_id }),
      currentTurnMessages: turnMessages,
      launchContext: historyMessages,
      includeLaunchContext,
      timezone,
    });

    // Execute runner
    let rawOutput: string;
    let attempt: SessionRunnerAttemptRow | undefined;
    let statusCard: SentStatusCard | undefined;
    let runnerSessionId = runnerContext?.runner_session_id ?? undefined;
    const progressEvents: TaskStatusCardStepEvent[] = [];
    // The Agent decides whether its Work progress card shows and in which style; a failed or
    // cancelled turn is still reported, so it never ends silently.
    const display = new AgentSettingsStore(this._options.db).get(session.agent_id).work.progressCard;
    const cardOptions = (entries: readonly TaskStatusCardStepEvent[] = progressEvents) => ({
      progressKey: input.turn.id,
      ...(statusCard !== undefined ? { targetMessageId: statusCard.providerMessageId } : {}),
      style: display.style,
      nativeProgress: entries.map(event => ({ id: event.id!, text: event.summary.slice(0, 800) })),
    });
    const progress = new BufferedProgress<TaskStatusCardStepEvent>({
      persist: summary => {
        const entry = {id: randomUUID(), type: "runner.step", summary};
        progressEvents.push(entry);
        if (progressEvents.length > RECENT_PROGRESS_STEPS) progressEvents.shift();
        return entry;
      },
      send: async entries => {
        if (!display.show) return;
        const stepNames = buildTaskStatusCardSteps({timelineEvents: progressEvents}) ?? [];
        const sentCard = await this._sendStatusCard(channel, inbound, {
          title: "工作会话", status: "in_progress",
          steps: stepNames.map((name, index) => ({name, status: index === stepNames.length - 1 ? "active" : "done"})),
          summary: "",
        }, latestMessageRow, session.id, cardOptions(entries));
        if (statusCard === undefined) statusCard = sentCard;
        this._attachStatusCardToTurn(input.turn.id, sentCard);
      },
      onError: error => logger.warn({err: error, sessionId: session.id}, "failed to update work status card progress"),
    });
    const reportProgress = async (summary: string): Promise<void> => {
      const stepName = normalizeRunnerProgressStep(summary);
      if (stepName) progress.summary(stepName);
    };
    await reportProgress("工作会话执行已开始。");
    await progress.waitForCurrentSend();
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
        attempt = turnAttempt(this._attemptStore, { sessionId: session.id, turnId: input.turn.id, runnerContext, runnerType: currentRunnerType, inputPrompt: prompt });
        const memoryActor = this._requestedByUserIdForWorkRunner(latestMessageRow, session);
        const launch = await this._launch({ session, invocationId, originId: input.turn.id, runnerContext, snapshot,
          requestedByUserId: memoryActor, inbound, signal });
        runnerContext = launch.runnerContext;
        // After the fingerprint sync: a new provider session must be told standing memory.
        const memory = memoryActor === undefined ? undefined : memoryInjection(this._options.db,
          {agentId: session.agent_id, shadowId: session.shadow_id, actorUserId: memoryActor, sessionId: session.id, taskId: null, runnerContextId: runnerContext.id},
          turnMessages.map(message => message.text).join("\n"));
        const turnPrompt = joinBlocks([dataBlock("memory", { text: memory?.text ?? "" }), prompt]);
        if (turnPrompt !== prompt) this._attemptStore.updateInputPrompt(attempt.id, turnPrompt);
        const invocation = await invokeSessionAgent({
          runner: launch.runner,
          runnerContext,
          runnerContextStore: this._runnerContexts,
          runnerKind: "work",
          messageId: `work-${session.id}-${input.turn.id}`,
          prompt: turnPrompt,
          env: launch.env,
          ...(signal !== undefined ? { signal } : {}),
          onAssistantEvent: event => {
            for (const block of event.content) if (block.type === "tool_use") progress.toolStart(block.id, block.name);
            const text = extractTextContent(event, {includeThinking: false, includeToolUse: false});
            const step = text.trim() ? runnerProgressStepFromAssistant({...event, content: [{type: "text", text}]}) : undefined;
            if (step) progress.summary(step);
          },
          onToolEvent: event => {
            for (const block of event.content) progress.toolResult(block.tool_use_id, block.content === "工具执行失败");
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
      await progress.close();
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
        }, latestMessageRow, session.id, cardOptions());
        this._attachStatusCardToTurn(input.turn.id, sentCard);
        return;
      }
      logger.warn({ err, sessionId: session.id }, "work runner execution failed");
      const sentCard = await this._sendStatusCard(channel, inbound, {
        title: "工作会话",
        status: "blocked",
        steps: [],
        summary: `执行出错：${err instanceof Error ? err.message : String(err)}`,
      }, latestMessageRow, session.id, cardOptions());
      this._attachStatusCardToTurn(input.turn.id, sentCard);
      return;
    } finally {
      await progress.close();
      workInvocations(this._options.db).delete(invocationId);
    }

    if (signal?.aborted) {
      const sentCard = await this._sendStatusCard(channel, inbound, {
        title: "工作会话",
        status: "cancelled",
        steps: runtimeProgressStepNames(progressEvents).map((name) => ({ name, status: "done" })),
        summary: "已通过 #steer 取消",
      }, latestMessageRow, session.id, cardOptions());
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

    // Send final status card; a turn without a reply is reported even when cards are hidden.
    if (!display.show && card.status === "completed") return;
    const sentCard = await this._sendStatusCard(channel, inbound, card, latestMessageRow, session.id, cardOptions());
    this._attachStatusCardToTurn(input.turn.id, sentCard);
  }

  /**
   * A silent turn Service queues in a Work session, such as a memory
   * reflection. Unlike a Work turn it answers nobody: it sends no status card
   * and may end without a reply. It runs in the session's provider context, so
   * a session that has none yet has nothing to reflect on and is skipped.
   */
  async executeMaintenanceTurn(session: SessionRow, command: {id: string; actorUserId: string; instruction: string}, signal?: AbortSignal): Promise<void> {
    const db = this._options.db;
    const resolved = this._resolveExecution(session, command.id, true);
    const { invocationId, snapshot, runnerType } = resolved;
    let runnerContext = resolved.runnerContext!;
    const latest = this._messageStore.listMessagesBefore({ sessionId: session.id, beforeCreatedAt: Date.now() + 1 }).at(-1);
    if (runnerContext.runner_session_id === null || latest === undefined) return;
    const attempt = turnAttempt(this._attemptStore, { sessionId: session.id, turnId: command.id, runnerContext, runnerType, inputPrompt: command.instruction });
    try {
      const launch = await this._launch({ session, invocationId, originId: command.id, runnerContext, snapshot,
        requestedByUserId: command.actorUserId, inbound: buildInboundFromMessageRow(session, latest), signal });
      runnerContext = launch.runnerContext;
      if (runnerContext.runner_session_id === null) {
        // Changed instructions reset the provider context, and the conversation went with it.
        const invocations = new InvocationStore(db);
        if (invocations.find(invocationId) && !invocations.jobsFor(invocationId).length) invocations.finish(invocationId);
        this._attemptStore.markParsed(attempt.id, { rawOutput: "", parsedActionJson: { title: "记忆维护", status: "completed", steps: [], summary: "会话上下文已重置，跳过" } });
        return;
      }
      const memory = memoryInjection(db, {agentId: session.agent_id, shadowId: session.shadow_id, actorUserId: command.actorUserId,
        sessionId: session.id, taskId: null, runnerContextId: runnerContext.id});
      const timezone = new PlatformSettingsStore(db).get().general.timezone;
      const prompt = joinBlocks([command.instruction, dataBlock("memory", { text: memory.text ?? "" }), dataBlock("now", { json: turnClock(new Date(), timezone) })]);
      if (prompt !== command.instruction) this._attemptStore.updateInputPrompt(attempt.id, prompt);
      const invocation = await invokeSessionAgent({
        runner: launch.runner, runnerContext, runnerContextStore: this._runnerContexts, runnerKind: "work",
        messageId: `work-${session.id}-${command.id}`, prompt,
        env: launch.env,
        ...(signal !== undefined ? { signal } : {}),
      });
      memory.commit();
      if (!signal?.aborted) finalizeRunnerReply(db, {
        sessionId: session.id, originId: command.id, text: invocation.text, allowSilent: true,
        ...(new InvocationStore(db).find(invocationId) ? { invocationId } : {}),
        actorUserId: command.actorUserId,
      });
      this._attemptStore.markParsed(attempt.id, {
        rawOutput: invocation.text, parsedActionJson: { title: "记忆维护", status: "completed", steps: [], summary: "" },
        ...(invocation.runnerSessionId !== undefined ? { runnerSessionId: invocation.runnerSessionId } : {}),
      });
    } catch (err) {
      if (!(err instanceof RuntimeDetachedError)) this._attemptStore.markRunnerFailed(attempt.id, { error: err });
      throw err;
    } finally {
      workInvocations(db).delete(invocationId);
    }
  }

  /**
   * The Agent configuration, Runner type and session Runner context for a turn, and the
   * invocation it resumes or starts. `withContext` false: a test agent that needs no context.
   */
  private _resolveExecution(session: SessionRow, originId: string, withContext: boolean) {
    const invocationId = new InvocationStore(this._options.db).findActive({ runnerKind: "work", originId, sessionId: session.id })?.id ?? randomUUID();
    const snapshot = withContext && this._options.createRunner === undefined && this._options.runnerType !== "mock" && this._options.runnerType !== "dummy"
      ? getKernel().resolveAgentExecutionSnapshot({ agentId: session.agent_id, shadowId: session.shadow_id }, invocationId)
      : undefined;
    const runnerType = snapshot?.agentType ?? this._options.runnerType;
    const runnerContext = withContext
      ? syncAgentCompatibility(this._runnerContexts, this._runnerContexts.resolveForSession(session.id, runnerType), snapshot)
      : undefined;
    return { invocationId, snapshot, runnerType, runnerContext };
  }

  /** Register the invocation, build the agent and its environment, and have the Worker prepare the directory. */
  private async _launch(input: {
    readonly session: SessionRow; readonly invocationId: string; readonly originId: string;
    readonly runnerContext: ResolvedRunnerContext; readonly snapshot: AgentExecutionSnapshot | undefined;
    readonly requestedByUserId: string | undefined; readonly inbound: NormalizedInboundMessage; readonly signal: AbortSignal | undefined;
  }): Promise<{ readonly runner: AgentRunner; readonly env: Record<string, string>; readonly runnerContext: ResolvedRunnerContext }> {
    const { session, invocationId, snapshot, signal } = input;
    workInvocations(this._options.db).set(invocationId, {
      runnerContextId: input.runnerContext.id, sessionId: session.id, turnId: input.originId, ...(signal ? { signal } : {}),
    });
    const runner = this._options.createRunner?.() ?? createAgentRunnerForConfig(snapshot!, getKernel().runtimeAgentTransport);
    const serviceEnv = this._serviceEnv(invocationId, input.runnerContext.id, input.requestedByUserId, session, snapshot);
    const prepared = await prepareRunnerDirectory({ store: this._runnerContexts, runnerContext: input.runnerContext,
      contextFile: buildWorkRunnerContextFile(session, input.inbound), invocationId, signal });
    return { runner, env: { ...(snapshot?.env ?? {}), ...(serviceEnv ?? {}) }, runnerContext: prepared.runnerContext };
  }

  private _serviceEnv(
    invocationId: string,
    runnerContextId: string,
    requestedByUserId: string | undefined,
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
        requestedByUserId,
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
    channel: ReplyChannel,
    inbound: NormalizedInboundMessage,
    card: StatusCardOutput,
    messageRow: MessageRow,
    sessionId: string,
    options: { readonly targetMessageId?: string; readonly style?: "card" | "native"; readonly nativeProgress?: readonly NativeProgressEntry[]; readonly progressKey?: string } = {},
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
        ...(options.style === "native" ? { statusCardStyle: "native" as const, nativeProgress: [...(options.nativeProgress ?? [])] } : {}),
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
        idempotencyKey: options.style === "native" && isCreate ? ["work-progress",inbound.channel.id,options.progressKey ?? messageRow.id,"create"].join(":") : [
          options.style === "native" ? "work-progress" : "work-card",
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

/** The Work turn input: earlier messages on a fresh provider session, then this turn's messages. */
function buildWorkTurnPrompt(input: {
  readonly inbound: NormalizedInboundMessage;
  readonly currentTurnMessages: readonly RunnerMessageEnvelope[];
  readonly launchContext: readonly RunnerMessageEnvelope[];
  readonly includeLaunchContext: boolean;
  readonly people?: PeopleResolver;
  readonly timezone?: string;
}): string {
  const clock = turnClock(new Date(), input.timezone);
  const history = input.includeLaunchContext ? input.launchContext.map((message) => messageItem(message, input.people, undefined, clock.timezone)) : [];
  return joinBlocks([
    history.length ? dataBlock("history", { json: { launchContext: history } }) : "",
    dataBlock("messages", {
      json: {
        ...clock,
        addressing: compact({ ...addressingFacts(input.inbound), ...activationFollowupAddressing(input.inbound) }),
        items: input.currentTurnMessages.map((message) => messageItem(message, input.people, undefined, clock.timezone)),
      },
    }),
  ]);
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
        surface: contextFileSurface(inbound.surface),
        ...(inbound.thread !== undefined ? { thread: inbound.thread } : {}),
        delivery: { replyTarget: "session_thread" },
      },
    },
  } as const;
}

function activationFollowupAddressing(
  inbound: NormalizedInboundMessage,
): { readonly activationSource?: string; readonly followupCount?: number } {
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
    activationSource: sessionSourceMessageId,
    ...(typeof followupCount === "number" ? { followupCount } : {}),
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
