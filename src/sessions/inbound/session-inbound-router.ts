import { AgentError, AgentStore } from "@/agents/agent-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import { prepareRunnerFiles } from "@/runners/prepare-runner-files";
import { completeProcessingOnce } from "@/messaging/processing-markers";
import { reportSessionExecutionError } from "@/messaging/session-execution-error";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { bindSessionBot } from "@/channels/session-bot";
import { and, asc, eq } from "drizzle-orm";

import { TaskRunSupervisor } from "@/tasks/task-run-supervisor";
import type { NormalizedInboundMessage } from "@/channels/types";
import { SessionInboxStore } from "@/sessions/session-inbox-store";
import {
  SessionQueue,
  type SessionTurnExecutionInput,
} from "@/sessions/session-queue";
import { SessionResolver } from "@/sessions/session-resolver";
import { SessionStore } from "@/sessions/session-store";
import { SessionTimelineStore } from "@/sessions/session-timeline-store";
import { SessionTimelineEventStore } from "@/sessions/session-timeline-event-store";
import { SessionTurnStore } from "@/sessions/session-turn-store";
import { SessionRunnerAttemptStore } from "@/sessions/session-runner-attempt-store";
import { MessageStore, type MessageRow } from "@/sessions/message-store";
import type { DrizzleDB } from "@/data";
import {
  messages,
  sessionInbox,
  sessionTimelineEntries,
  users,
} from "@/data/schema";
import { selectActivationContext } from "@/main-runner/activation-context";
import { MainRunnerContextBuilder } from "@/main-runner/context-builder";
import { ContextPackStore, LaunchContextBuilder } from "@/context";
import {
  canonicalUserIdForRequestedIdentity,
  requestedIdentityFromInbound,
} from "@/identity/requested-identity";
import {
  MainRunner,
  MainRunnerFreshLaunchReplayRequiredError,
  renderMainRunnerPrompt,
} from "@/main-runner/main-runner";
import type {
  ActivationContextMessage,
  MainRunnerCompletion,
  MainRunnerContextPack,
  MainRunnerInput,
} from "@/main-runner/types";
import { RunnerContextStore } from "@/runners/runner-context-store";
import {
  normalizedInboundFromMessageRow,
  runnerMessageEnvelopeFromRow,
  textFromContentBlocks,
  textFromMessageRow,
} from "@/runners/message-envelope";
import { createAgentRunnerForConfig } from "@/kernel/agents/factory";
import { getKernel } from "@/server/routes/kernel";
import { config, createLogger, type SessionConfig } from "@/shared";

import { decideGroupActivationFollowup } from "./group-activation-followup";
import { WorkRunner } from "@/work/work-runner";
import { decideInboundAddressing } from "./group-addressing";
import {
  appendInputFromNormalizedInbound,
  artifactizeInboundMessageResources,
  renderNormalizedMentions,
  resolveInboundSenderUserId,
} from "./inbound-message-persistence";
import { BotBindingStore } from "@/agents/bot-binding-store";
import type { ReplyChannel } from "@/channels/outbound";

const logger = createLogger("session-inbound-router");

const explicitActivationReasons = new Set<
  NonNullable<NormalizedInboundMessage["addressing"]>["reason"]
>(["mention", "reply_to_bot", "alias"]);

/**
 * Configuration options for routing inbound channel messages into sessions.
 */
export interface SessionInboundRouterOptions {
  readonly db: DrizzleDB;
  readonly channel: ReplyChannel;
  readonly runnerType: string;
  readonly mainRunner?: MainRunner;
  readonly taskRunSupervisor?: Pick<TaskRunSupervisor, "waitForIdle">;
  readonly sessionQueue?: SessionQueue;
  readonly sessionConfig?: SessionConfig;
  readonly prepareSession?: (sessionId: string) => void;
}

export interface SessionTurnProcessorOptions {
  readonly db: DrizzleDB;
  readonly runnerType: string;
  readonly channelForMessage: (
    message: NormalizedInboundMessage,
  ) => ReplyChannel | undefined;
  readonly mainRunner?: MainRunner;
  readonly taskRunSupervisor?: Pick<TaskRunSupervisor, "waitForIdle">;
  readonly sessionConfig?: SessionConfig;
  readonly workRunner?: WorkRunner;
}

/**
 * Routes inbound channel messages to the correct durable session and queue.
 */
export class SessionInboundRouter {
  private readonly _prepareSession: ((sessionId: string) => void) | undefined;
  private readonly _db: DrizzleDB;
  private readonly _channel: ReplyChannel;
  private readonly _sessionConfig: SessionConfig;
  private readonly _sessionResolver: SessionResolver;
  private readonly _messageStore: MessageStore;
  private readonly _inboxStore: SessionInboxStore;
  private readonly _timelineStore: SessionTimelineStore;
  private readonly _turnStore: SessionTurnStore;
  private readonly _sessionQueue: SessionQueue;
  private readonly _taskRunSupervisor: Pick<TaskRunSupervisor, "waitForIdle">;
  private readonly _sessionInboundLocks = new Map<string, Promise<void>>();

  constructor(options: SessionInboundRouterOptions) {
    this._db = options.db;
    this._prepareSession = options.prepareSession;
    this._channel = options.channel;
    this._sessionConfig = options.sessionConfig ?? config.session;
    this._sessionResolver = new SessionResolver(
      new SessionStore(options.db),
    );
    this._messageStore = new MessageStore(options.db);
    this._inboxStore = new SessionInboxStore(options.db);
    this._timelineStore = new SessionTimelineStore(options.db);
    this._turnStore = new SessionTurnStore(options.db);
    this._taskRunSupervisor =
      options.taskRunSupervisor ??
      new TaskRunSupervisor({
        db: options.db,
        runnerType: options.runnerType,
      });
    this._sessionQueue = options.sessionQueue ??
      new SessionQueue({
        db: options.db,
        config: this._sessionConfig,
        executeTurn: (input, signal) =>
          new SessionTurnProcessor({
            db: options.db,
            runnerType: options.runnerType,
            channelForMessage: () => this._channel,
            ...(options.mainRunner !== undefined
              ? { mainRunner: options.mainRunner }
              : {}),
            taskRunSupervisor: this._taskRunSupervisor,
            sessionConfig: this._sessionConfig,
            workRunner: new WorkRunner({
              db: options.db,
              runnerType: options.runnerType,
              channelForMessage: () => this._channel,
            }),
          }).execute(input, signal),
      });
  }

  async route(message: NormalizedInboundMessage): Promise<void> {
    if (this._senderBlocked(message)) return;
    const session = this._sessionResolver.resolveFromNormalizedInbound(message);
    bindSessionBot(this._db, session.id, message.channel, this._channel.getBotIdentity?.());
    this._prepareSession?.(session.id);
    await this._serializeSessionInbound(session.id, async () => {
      const durableMessage = artifactizeInboundMessageResources({
        db: this._db,
        sessionId: session.id,
        message,
      });
      const appendInput = appendInputFromNormalizedInbound({
        db: this._db,
        sessionId: session.id,
        message: durableMessage,
      });
      if (
        this._appendThreadRootRedeliveryReference({
          sessionId: session.id,
          message: durableMessage,
          rawPayload: appendInput.rawPayload,
        })
      ) {
        return;
      }
      const persistedInbound = {
        ...durableMessage,
        text: renderNormalizedMentions(durableMessage.text, durableMessage.mentions),
      };
      const userMessageResult = this._messageStore.appendOnce(appendInput);
      const botSender = durableMessage.sender.kind === "bot";
      const selfBot = botSender && (
        durableMessage.sender.externalId === this._channel.getBotIdentity?.()?.externalId ||
        userMessageResult.row.senderUserId === new SessionStore(this._db).requireReplyUserId(session.id)
      );
      const baseAddressing = selfBot
        ? { addressedToBot: false as const, reason: "silent_group" as const }
        : decideInboundAddressing({
            message: durableMessage,
            config: this._sessionConfig,
            repliesToBotMessage: !botSender && this._repliesToBotMessage(session.id, durableMessage),
          });
      const followupDecision = !botSender && !baseAddressing.addressedToBot
        ? decideGroupActivationFollowup({
            messageStore: this._messageStore,
            sessionTimelineEventStore: new SessionTimelineEventStore(this._db),
            sessionId: session.id,
            candidateRow: userMessageResult.row,
            message: durableMessage,
            config: this._sessionConfig,
          })
        : undefined;
      let addressing: typeof baseAddressing = baseAddressing;
      if (followupDecision?.addressedToBot === true) {
        addressing = {
          addressedToBot: true,
          reason: "activation_followup",
        };
      }
      const addressedMessage = {
        ...persistedInbound,
        addressing,
        ...(followupDecision?.addressedToBot === true
          ? {
              activationFollowup: {
                sessionSourceMessageId: followupDecision.sessionSourceMessageId,
                followupCount: followupDecision.followupCount,
              },
            }
          : {}),
      };
      if (followupDecision?.addressedToBot === true) {
        logger.info(
          {
            sessionId: session.id,
            channelMessageKey: message.id,
            senderUserId: message.sender.externalId,
            sessionSourceMessageId: followupDecision.sessionSourceMessageId,
            followupCount: followupDecision.followupCount,
          },
          "Accepted group activation follow-up",
        );
      }
      if (!addressing.addressedToBot) {
        const userMessage = this._messageStore.updateRawPayload(
          userMessageResult.row.id,
          addressedMessage,
        );
        const entry = this._timelineStore.appendMessage({
          sessionId: session.id,
          messageId: userMessage.id,
        });
        this._turnStore.createSkipTurn({
          sessionId: session.id,
          entryId: entry.id,
          reason: addressing.reason,
        });
        return;
      }

      const userMessage = this._messageStore.updateRawPayload(
        userMessageResult.row.id,
        addressedMessage,
      );
      if (!botSender && isSteerCommand(message.text)) {
        const senderUserId = userMessage.senderUserId ?? userMessage.sender_user_id;
        if (!senderUserId) throw new AgentError("active_user_required", 403);
        new AgentStore(this._db).requireAccess(senderUserId, session.agent_id);
        const entry = this._timelineStore.appendMessage({
          sessionId: session.id,
          messageId: userMessage.id,
        });
        this._turnStore.createSkipTurn({
          sessionId: session.id,
          entryId: entry.id,
          reason: "steer_control",
        });
        this._sessionQueue.abort(session.id);
        this._sessionQueue.schedule(session.id);
        return;
      }
      const enqueueResult = this._inboxStore.enqueueOnce({
        sessionId: session.id,
        message: userMessage,
      });
      if (
        (enqueueResult.created || enqueueResult.requeued) &&
        baseAddressing.addressedToBot
      ) {
        await this._channel.beginProcessing?.(addressedMessage);
      }
      if (enqueueResult.row.status === "pending") {
        this._sessionQueue.schedule(session.id);
      }
    });
  }

  async waitForIdle(): Promise<void> {
    await this._sessionQueue.waitForIdle();
    await this._taskRunSupervisor.waitForIdle();
  }

  async recoverPending(): Promise<void> {
    await this._sessionQueue.recoverPending();
  }

  private async _serializeSessionInbound(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const prev = this._sessionInboundLocks.get(sessionId) ??
      Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this._sessionInboundLocks.get(sessionId) === next) {
          this._sessionInboundLocks.delete(sessionId);
        }
      });
    this._sessionInboundLocks.set(sessionId, next);
    await next;
  }

  private _repliesToBotMessage(
    sessionId: string,
    message: NormalizedInboundMessage,
  ): boolean {
    if (message.channel.type === "dashboard") return false;
    const channelMessageKeys = replyTargetChannelMessageIds(message);
    return (
      this._messageStore.hasAssistantChannelMessage({
        sessionId,
        channelMessageKeys,
      }) ||
      this._messageStore.hasAssistantChannelMessageOnSurface({
        channelType: message.channel.type,
        channelId: message.channel.id,
        groupId: message.surface.externalId,
        channelMessageKeys,
      })
    );
  }

  /**
   * A user the Agent owner blocked is not heard: nothing is stored in a session
   * and no Runner starts. Senders that cannot be resolved here take the normal path.
   */
  private _senderBlocked(message: NormalizedInboundMessage): boolean {
    if (message.sender.kind !== "user" || message.channel.type === "dashboard") return false;
    try {
      const agentId = new BotBindingStore(this._db).requireActive(message.channel.id).agentId;
      const userId = resolveInboundSenderUserId({ db: this._db, agentId, message });
      const blocked = this._db.select({ status: users.status }).from(users).where(eq(users.id, userId)).get()?.status === "blocked";
      if (blocked) logger.info({ channelId: message.channel.id, messageId: message.id }, "Message from a blocked user ignored");
      return blocked;
    } catch {
      return false;
    }
  }

  private _appendThreadRootRedeliveryReference(input: {
    readonly sessionId: string;
    readonly message: NormalizedInboundMessage;
    readonly rawPayload: unknown;
  }): boolean {
    const rootMessageId = input.message.thread?.rootMessageExternalId;
    if (
      input.message.thread?.externalId === undefined ||
      rootMessageId === undefined ||
      input.message.id !== rootMessageId
    ) {
      return false;
    }

    const rootMessage = this._messageStore.findByExternalMessageId({sessionId:input.sessionId,
      channelType: input.message.channel.type,
      channelId: input.message.channel.id,
      externalMessageId: rootMessageId,
    });
    if (rootMessage === undefined) {
      return false;
    }

    this._messageStore.updateRawPayload(rootMessage.id, input.rawPayload);
    this._timelineStore.appendReference({
      sessionId: input.sessionId,
      messageId: rootMessage.id,
    });
    return true;
  }
}

function isSteerCommand(text: string): boolean {
  return text.trim().toLowerCase().startsWith("#steer");
}

function replyTargetChannelMessageIds(
  message: NormalizedInboundMessage,
): readonly string[] {
  return [
    ...new Set(
      [
        message.thread?.rootMessageExternalId,
        message.thread?.externalId,
        message.id,
        ...rawPayloadReplyTargetIds(message.rawPayload),
      ].filter(isString),
    ),
  ];
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function rawPayloadReplyTargetIds(rawPayload: unknown): string[] {
  const payload = asRecord(rawPayload);
  const message = asRecord(payload?.message);
  return [
    stringField(message, "parent_id"),
    stringField(message, "root_id"),
    stringField(message, "thread_id"),
    stringField(message, "message_id"),
  ].filter(isString);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function isAddressedGroupMessage(message: NormalizedInboundMessage): boolean {
  return message.surface.kind === "group" && message.addressing.addressedToBot === true;
}

export class SessionTurnProcessor {
  private readonly _db: DrizzleDB;
  private readonly _runnerType: string;
  private readonly _runnerContextStore: RunnerContextStore;
  private readonly _contextBuilder: MainRunnerContextBuilder;
  private readonly _contextPackStore: ContextPackStore;
  private readonly _launchContextBuilder: LaunchContextBuilder;
  private readonly _sessionTimelineEvents: SessionTimelineEventStore;
  private readonly _turnStore: SessionTurnStore;
  private readonly _mainRunner: MainRunner;
  private readonly _sessionConfig: SessionConfig;
  private readonly _sessionStore: SessionStore;
  private readonly _workRunner: WorkRunner | undefined;

  constructor(private readonly _options: SessionTurnProcessorOptions) {
    this._db = _options.db;
    this._runnerType = _options.runnerType;
    this._sessionConfig = _options.sessionConfig ?? config.session;
    this._runnerContextStore = new RunnerContextStore(_options.db);
    this._contextBuilder = new MainRunnerContextBuilder(_options.db);
    this._contextPackStore = new ContextPackStore(_options.db);
    this._launchContextBuilder = new LaunchContextBuilder(_options.db);
    this._sessionTimelineEvents = new SessionTimelineEventStore(_options.db);
    this._turnStore = new SessionTurnStore(_options.db);
    this._mainRunner =
      _options.mainRunner ??
      new MainRunner({
        ...(_options.runnerType === "mock"
          ? {runner: createAgentRunnerForConfig({ type: "mock", model: "test" })}
          : {resolveAgentExecution: (scope, invocationId) => {
            const snapshot = getKernel().resolveAgentExecutionSnapshot(scope, invocationId);
            return {snapshot, runner:createAgentRunnerForConfig(snapshot, getKernel().runtimeAgentTransport)};
          }}),
        runnerContextStore: this._runnerContextStore,
        attemptStore: new SessionRunnerAttemptStore(_options.db),
        serviceAuthDb: _options.db,
      });
    this._sessionStore = new SessionStore(_options.db);
    this._workRunner = _options.workRunner;
  }

  async execute(input: SessionTurnExecutionInput, signal?: AbortSignal): Promise<void> {
    const session = this._sessionStore.getById(input.turn.sessionId);
    const inbounds = input.messageRows.map((row) => normalizedInboundFromMessageRow(row));
    const latestMessageRow = input.messageRows.at(-1);
    const latestInbound = inbounds.at(-1);
    if (!latestMessageRow || !latestInbound) {
      throw new Error("Cannot execute an empty session turn.");
    }

    const channel = this._options.channelForMessage(latestInbound);
    if (!channel) {
      throw new Error(
        `No reply channel registered for message channel "${latestInbound.channel.id}".`,
      );
    }

    try {
      if (session?.kind === "work" && this._workRunner !== undefined) {
        await this._workRunner.executeWorkTurn(input, session, signal);
        return;
      }
      const activationContextMessages = this._selectActivationContextMessages({
        sessionId: input.turn.sessionId,
        messageRows: input.messageRows,
        latestInbound,
      });
      const activationSourceMessage = this._selectActivationSourceMessage({
        sessionId: input.turn.sessionId,
        latestInbound,
      });
      const completion = await this._runMain({
        sessionId: input.turn.sessionId,
        turnId: input.turn.id,
        currentEntryIds: input.inboxRows.map((row) => row.entry_id),
        messageRows: input.messageRows,
        inbounds,
        latestInbound,
        activationContextMessages,
        ...(signal !== undefined ? { signal } : {}),
        ...(activationSourceMessage !== undefined
          ? { activationSourceMessage }
          : {}),
      });
      if (signal?.aborted) {
        return;
      }
      this._recordActivationFollowupInterruption({
        sessionId: input.turn.sessionId, turnId: input.turn.id,
        latestMessageRow, latestInbound, completion,
        ...(activationSourceMessage ? { activationSourceMessage } : {}),
      });
    } catch (error) {
      if (!signal?.aborted && !(error instanceof RuntimeDetachedError) && session?.kind !== "work" && latestMessageRow.senderUserId) {
        try {
          reportSessionExecutionError(this._db, {
            sessionId: input.turn.sessionId, turnId: input.turn.id,
            actorUserId: latestMessageRow.senderUserId, error,
            channelFor: id => this._options.channelForMessage({ ...latestInbound, channel: { ...latestInbound.channel, id } }),
          });
        } catch (replyError) {
          logger.error({ err: replyError, turnId: input.turn.id }, "Could not queue execution error reply");
        }
      }
      throw error;
    } finally {
      await this._completeProcessing(channel, inbounds);
    }
  }

  private async _completeProcessing(
    channel: ReplyChannel,
    inbounds: readonly NormalizedInboundMessage[],
  ): Promise<void> {
    if (channel.completeProcessing === undefined) {
      return;
    }
    await Promise.all(
      inbounds.map((inbound) => completeProcessingOnce(channel, inbound)),
    );
  }

  private _contextExcludedEntryIds(input: {
    readonly sessionId: string;
    readonly currentEntryIds: readonly string[];
  }): readonly string[] {
    const excluded = new Set(input.currentEntryIds);
    const queuedRows = this._db
      .select({
        entryId: sessionInbox.entry_id,
        status: sessionInbox.status,
      })
      .from(sessionInbox)
      .where(eq(sessionInbox.session_id, input.sessionId))
      .all();
    for (const row of queuedRows) {
      if (row.status === "pending" || row.status === "claimed") {
        excluded.add(row.entryId);
      }
    }
    return [...excluded];
  }

  private async _runMain(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly currentEntryIds: readonly string[];
    readonly messageRows: readonly MessageRow[];
    readonly inbounds: readonly NormalizedInboundMessage[];
    readonly latestInbound: NormalizedInboundMessage;
    readonly activationContextMessages: readonly ActivationContextMessage[];
    readonly activationSourceMessage?: ActivationContextMessage;
    readonly signal?: AbortSignal;
  }): Promise<MainRunnerCompletion> {
    const triggerEntryId = input.currentEntryIds.at(-1);
    const triggerMessageId = input.messageRows.at(-1)?.id;
    if (triggerEntryId === undefined || triggerMessageId === undefined) {
      throw new Error("Main Runner turn requires a trigger entry and message.");
    }

    try {
      let syncedRunnerContext = this._runnerContextStore.resolveForSession(
        input.sessionId,
        this._currentRunnerType(input.sessionId),
      );
      const contextExcludedEntryIds = this._contextExcludedEntryIds(input);
      // MainRunner prepares the Worker context after it registers the invocation.
      if (!getKernel().executionRuntime) {
        const instructions = await prepareRunnerFiles(syncedRunnerContext, undefined, input.signal);
        const fingerprintSync = this._runnerContextStore.syncInstructionFingerprint(
          syncedRunnerContext.id,
          instructions.instructionFingerprint,
        );
        syncedRunnerContext = fingerprintSync.runnerContext;
        if (fingerprintSync.runnerSessionInvalidated) {
          this._buildSessionRelaunchContext({
            sessionId: input.sessionId,
            turnId: input.turnId,
            triggerEntryId,
            triggerMessageId,
            excludeEntryIds: contextExcludedEntryIds,
          });
        }
      }
      const currentEntryIds = new Set(contextExcludedEntryIds);
      const deltaContextPack = this._createActivationContextPack({
        sessionId: input.sessionId,
        turnId: input.turnId,
        currentEntryIds: input.currentEntryIds,
        messageRows: input.messageRows,
        latestInbound: input.latestInbound,
        activationContextMessages: input.activationContextMessages,
      });
      const contextBuild = this._contextBuilder.buildForSessionWithEntries(
        input.sessionId,
        {
          excludeEntryIds: contextExcludedEntryIds,
          includeLaunchSeed: syncedRunnerContext.runner_session_id === null,
          createdForInvocationId: input.turnId,
          ...(deltaContextPack !== undefined
            ? { deltaContextPackIds: [deltaContextPack.id] }
            : {}),
        },
      );
      if (syncedRunnerContext.runner_session_id === null) {
        this._recordSessionLaunchSeed({
          sessionId: input.sessionId,
          runnerContextId: syncedRunnerContext.id,
          launchSeed: contextBuild.context.launchSeed,
        });
      }
      this._turnStore.attachEntries(
        input.turnId,
        contextBuild.contextEntries
          .filter((entry) => !currentEntryIds.has(entry.entryId))
          .map((entry) => entry),
      );
      const requesterUserId = isAddressedGroupMessage(input.latestInbound)
        ? canonicalUserIdForRequestedIdentity(
            this._db,
            new TaskScopeResolver(this._db).session(input.sessionId).agentId,
            requestedIdentityFromInbound(input.latestInbound),
          )
        : undefined;
      const mainRunnerInput: MainRunnerInput = {
          type: "user_messages",
          messages: input.messageRows.map((row, index) => ({
            ...runnerMessageEnvelopeFromRow({
              row,
              index: index + 1,
              rawMessage: input.inbounds[index] ?? normalizedInboundFromMessageRow(row),
            }),
            rawMessage: input.inbounds[index] ?? normalizedInboundFromMessageRow(row),
          })),
          latestMessage: input.latestInbound,
          context: contextBuild.context,
          ...(input.activationSourceMessage !== undefined
            ? { activationSourceMessage: input.activationSourceMessage }
            : {}),
          ...(requesterUserId !== undefined
            ? { requesterUserId }
            : {}),
        };
      this._turnStore.recordMaterializedPrompt(
        input.turnId,
        renderMainRunnerPrompt(mainRunnerInput),
      );
      const completion = await this._mainRunner.run({
        input: mainRunnerInput,
        runnerContext: syncedRunnerContext,
        turnId: input.turnId,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      return completion;
    } catch (err) {
      if (err instanceof MainRunnerFreshLaunchReplayRequiredError) {
        logger.warn(
          { turnId: input.turnId, sessionId: input.sessionId },
          "Main Runner resume state was invalidated; rebuilding context for a fresh launch replay",
        );
        this._buildSessionRelaunchContext({
          sessionId: input.sessionId,
          turnId: input.turnId,
          triggerEntryId,
          triggerMessageId,
          excludeEntryIds: this._contextExcludedEntryIds(input),
        });
        return await this._runMain(input);
      }
      if (input.signal?.aborted) {
        throw err;
      }
      logger.error({ err, turnId: input.turnId }, "Main Runner execution failed");
      throw err;
    }
  }

  private _currentRunnerType(sessionId: string): string {
    if (this._runnerType === "mock" || this._runnerType === "dummy") {
      return this._runnerType;
    }
    return getKernel().resolveAgentExecutionSnapshot(new TaskScopeResolver(this._db).session(sessionId)).agentType;
  }

  private _buildSessionRelaunchContext(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly triggerEntryId: string;
    readonly triggerMessageId: string;
    readonly excludeEntryIds: readonly string[];
  }): void {
    this._launchContextBuilder.buildForSessionRelaunch({
      sessionId: input.sessionId,
      createdForInvocationId: input.turnId,
      triggerEntryId: input.triggerEntryId,
      triggerMessageId: input.triggerMessageId,
      excludeEntryIds: input.excludeEntryIds,
      maxMessages: this._sessionConfig.activation_context_max_messages,
      maxChars: this._sessionConfig.activation_context_max_chars,
    });
  }

  private _createActivationContextPack(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly currentEntryIds: readonly string[];
    readonly messageRows: readonly MessageRow[];
    readonly latestInbound: NormalizedInboundMessage;
    readonly activationContextMessages: readonly ActivationContextMessage[];
  }): { readonly id: string } | undefined {
    if (
      input.activationContextMessages.length === 0 ||
      !isAddressedGroupMessage(input.latestInbound)
    ) {
      return undefined;
    }
    const latestMessageRow = input.messageRows.at(-1);
    const activationEntryId = input.currentEntryIds.at(-1);
    if (latestMessageRow === undefined || activationEntryId === undefined) {
      return undefined;
    }
    return this._launchContextBuilder.buildForGroupActivation({
      sessionId: input.sessionId,
      activationEntryId,
      activationMessageId: latestMessageRow.id,
      contextMessages: input.activationContextMessages,
      createdForInvocationId: input.turnId,
    });
  }

  private _recordActivationFollowupInterruption(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly latestMessageRow: MessageRow;
    readonly latestInbound: NormalizedInboundMessage;
    readonly completion: MainRunnerCompletion;
    readonly activationSourceMessage?: ActivationContextMessage;
  }): void {
    if (
      input.latestInbound.addressing?.reason !== "activation_followup" ||
      !input.completion.followupReleased ||
      input.activationSourceMessage === undefined
    ) {
      return;
    }

    const sessionSourceMessageId =
      activationSessionSourceMessageId(input.latestInbound) ??
      input.activationSourceMessage.channelMessageKey ??
      input.activationSourceMessage.messageId;

    this._sessionTimelineEvents.appendConversationControl({
      sessionId: input.sessionId,
      eventType: "conversation_control",
      controlKind: "followup_interrupted",
      reasonKind: "focus_shifted",
      sourceMessageId: input.latestMessageRow.id,
      anchorMessageId: input.activationSourceMessage.messageId,
      sessionSourceMessageId,
      turnId: input.turnId,
      summary:
        "Detected conversation focus shift; current Luna follow-up chain was interrupted.",
      payloadJson: {
        latestInboundId: input.latestInbound.id,
      },
    });
  }

  private _recordSessionLaunchSeed(input: {
    readonly sessionId: string;
    readonly runnerContextId: string;
    readonly launchSeed: MainRunnerContextPack | undefined;
  }): void {
    if (input.launchSeed === undefined) {
      return;
    }
    const seedEntryIds = [
      ...new Set(
        input.launchSeed.items.flatMap((item) =>
          item.entryId === null ? [] : [item.entryId],
        ),
      ),
    ];
    const seedContextItemIds = input.launchSeed.items.map(
      (item) => item.contextItemId,
    );
    this._contextPackStore.recordSeed({
      runnerContextId: input.runnerContextId,
      ownerType: "session",
      ownerId: input.sessionId,
      seedContextPackId: input.launchSeed.packId,
      seedHash: stableHash({
        seedContextPackId: input.launchSeed.packId,
        seedEntryIds,
        seedContextItemIds,
      }),
      seedEntryIdsJson: seedEntryIds,
      seedContextItemIdsJson: seedContextItemIds,
    });
  }

  private _selectActivationSourceMessage(input: {
    readonly sessionId: string;
    readonly latestInbound: NormalizedInboundMessage;
  }): ActivationContextMessage | undefined {
    const sessionSourceMessageId = activationSessionSourceMessageId(
      input.latestInbound,
    );
    if (sessionSourceMessageId === undefined) {
      return undefined;
    }

    const row = this._db
      .select({ message: messages })
      .from(sessionTimelineEntries)
      .innerJoin(messages, eq(sessionTimelineEntries.messageId, messages.id))
      .where(
        and(
          eq(sessionTimelineEntries.sessionId, input.sessionId),
          eq(sessionTimelineEntries.entryKind, "message"),
          eq(messages.role, "user"),
          eq(messages.externalMessageId, sessionSourceMessageId),
        ),
      )
      .get();
    if (row === undefined) {
      return undefined;
    }

    return activationContextMessageFromPersistedMessage(row.message);
  }

  private _selectActivationContextMessages(input: {
    readonly sessionId: string;
    readonly messageRows: readonly MessageRow[];
    readonly latestInbound: NormalizedInboundMessage;
  }): ActivationContextMessage[] {
    const activationMessageRow = input.messageRows.at(-1);
    if (
      !isAddressedGroupMessage(input.latestInbound) ||
      activationMessageRow === undefined
    ) {
      return [];
    }

    try {
      return selectActivationContext({
        messageStore: new MessageStore(this._db),
        sessionId: input.sessionId,
        activationMessageRow,
        config: this._sessionConfig,
        ...(explicitActivationReasons.has(input.latestInbound.addressing.reason)
          ? {
              minimumRecentMessages:
                this._sessionConfig.group_activation_followup_recent_messages,
            }
          : {}),
      });
    } catch (err) {
      logger.warn(
        {
          sessionId: input.sessionId,
          activationMessageRowId: activationMessageRow.id,
          channelMessageKey: activationMessageRow.channel_message_key,
          err,
        },
        "Activation context selection failed; continuing without activation context",
      );
      return [];
    }
  }

}

function activationSessionSourceMessageId(
  inbound: NormalizedInboundMessage,
): string | undefined {
  if (!isRecord(inbound)) {
    return undefined;
  }
  const activationFollowup = isRecord(inbound.activationFollowup)
    ? inbound.activationFollowup
    : undefined;
  return typeof activationFollowup?.sessionSourceMessageId === "string"
    ? activationFollowup.sessionSourceMessageId
    : undefined;
}

function activationContextMessageFromRow(row: MessageRow): ActivationContextMessage {
  return {
    messageId: row.id,
    ...(row.channel_message_key !== null
      ? { channelMessageKey: row.channel_message_key }
      : {}),
    ...(row.sender_user_id !== null ? { senderUserId: row.sender_user_id } : {}),
    createdAt: row.created_at,
    text: textFromMessageRow(row),
  };
}

function activationContextMessageFromPersistedMessage(
  row: typeof messages.$inferSelect,
): ActivationContextMessage {
  return {
    messageId: row.id,
    channelMessageKey: row.externalMessageId,
    createdAt: row.occurredAt,
    text: textFromContentBlocks(row.contentJson),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}



function stableHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
