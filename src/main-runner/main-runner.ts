import { memoryInjection } from "@/agents/agent-memory-injection";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import {RunnerContextStore as ExecutionContextStore} from "@/runners/runner-context-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import type {AgentScope} from "@/agents/agent-store";
import { contextFileSurface, prepareRunnerDirectory, syncAgentCompatibility, turnAttempt } from "@/runners/session-runner-turn";
import { finalizeRunnerReply } from "@/messaging/runner-answer";
import { resolvePersistedSurfaceKind } from "@/channels/directory-store";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { ExecutionError } from "@luna/execution-store";
import { InvocationStore } from "@/runners/invocation-store";
import { decodeInvocation } from "@/runners/invocation-codec";
import { randomUUID } from "node:crypto";
import { mainInvocations, mainMessageOrigin } from "@/runners/main-invocation-registry";
import type { AgentExecutionSnapshot } from "@/agent-config";
import type { DrizzleDB } from "@/data";
import { channelSurfaces, correlatedRequests, runnerOperations, sessions, tasks } from "@/data/schema";
import { CorrelatedRequestService, isHeartbeatSession, type CorrelatedRequestRow } from "@/messaging/correlated-request-service";
import {
  buildMainCapabilities,
  compactTurnCapabilities,
  isMainSelfRoutineInput,
  resolveMainAllowSilent,
  resolveMainTriggerClassification,
  type RunnerCapabilitiesManifest,
} from "@/runners/capabilities";
import {
  requestedIdentityFromInbound,
  requiresExplicitRequesterIdentity,
} from "@/identity/requested-identity";
import { buildLunaServiceRunnerEnv } from "@/runners/luna-service-env";
import {
  invokeSessionAgent,
  type SessionAgentInvocationResult,
} from "@/runners/session-agent-invocation";
import type {
  ResolvedRunnerContext,
  RunnerContextStore,
} from "@/runners/runner-context-store";
import {
  type AgentRunner,
} from "@/shared";
import {
  type SessionRunnerAttemptRow,
  type SessionRunnerAttemptStore,
} from "@/sessions/session-runner-attempt-store";
import { and, eq } from "drizzle-orm";

import type { ActivationContextMessage, MainRunnerCompletion, MainRunnerContextPack, MainRunnerInput } from "./types";
import { addressingFacts, compact, dataBlock, joinBlocks, messageItem, turnClock, turnEvent, zonedIso, type PeopleResolver } from "@/runners/turn-envelope";
import { shadowPeople } from "@/runners/shadow-people";
import { runnerArtifactAllowlistFromInput } from "./artifact-allowlist";

/**
 * Configuration options for Main Runner main runner behavior in session.
 */
export interface MainRunnerOptions {
  readonly runner?: AgentRunner;
  readonly resolveAgentExecution?: (scope: AgentScope, invocationId?:string) => {
    readonly runner: AgentRunner;
    readonly snapshot: AgentExecutionSnapshot;
  };
  readonly runnerContextStore?: Pick<
    RunnerContextStore,
    | "clearRunnerSessionId"
    | "persistRunnerSessionId"
    | "syncInstructionFingerprint"
    | "syncAgentCompatibility"
  >;
  readonly attemptStore?: SessionRunnerAttemptStore;
  readonly serviceAuthDb?: DrizzleDB;
  readonly accessTokenSigningSecret?: string;
  readonly serviceAuthNow?: number;
}

/**
 * Input contract for Main Runner main runner run operations in session.
 */
export interface MainRunnerRunInput {
  readonly input: MainRunnerInput;
  readonly runnerContext: ResolvedRunnerContext;
  readonly turnId?: string;
  readonly invocationId?: string;
  readonly signal?: AbortSignal;
}

/**
 * Runs Main Runner flows for session Main Runner.
 */
export class MainRunner {
  constructor(private readonly _options: MainRunnerOptions) {}

  async run(input: MainRunnerRunInput): Promise<MainRunnerCompletion> {
    const db = this._options.serviceAuthDb;
    const prior = db && mainMessageOrigin(input) ? new InvocationStore(db).findActive({
      runnerKind: "main", originId: mainMessageOrigin(input), sessionId: input.input.context.sessionId,
    }) : undefined;
    const restored = prior ? decodeInvocation(prior.inputSnapshot) : undefined;
    if (restored && restored.kind !== "main") throw new Error("Main invocation snapshot kind mismatch");
    const runOnce = async (invocationId: string): Promise<MainRunnerCompletion> => {
      const scopedInput = { ...(restored?.input ?? input), invocationId, ...(input.signal ? { signal: input.signal } : {}) } as MainRunnerRunInput;
      if (db) mainInvocations(db).set(invocationId, scopedInput);
      try {
        return await this._run(scopedInput);
      } finally {
        if (db) mainInvocations(db).delete(invocationId);
      }
    };
    const invocationId = prior?.id ?? input.invocationId ?? randomUUID();
    try {
      return await runOnce(invocationId);
    } catch (error) {
      if (
        db &&
        prior &&
        !prior.activeJobId &&
        error instanceof ExecutionError &&
        ["invocation_preparation_conflict", "context_preparation_conflict"].includes(error.code)
      ) {
        const store = new InvocationStore(db);
        if (!store.jobsFor(prior.id).length) {
          store.finish(prior.id);
          return await runOnce(randomUUID());
        }
      }
      throw error;
    }
  }

  private async _run(input: MainRunnerRunInput): Promise<MainRunnerCompletion> {
    let scope: AgentScope = {agentId: input.runnerContext.agent_id, shadowId: input.runnerContext.shadow_id};
    if (this._options.serviceAuthDb) {
      const scopes = new TaskScopeResolver(this._options.serviceAuthDb);
      const owner = scopes.session(input.input.context.sessionId);
      scopes.assertSame(owner, scope);
      scope = owner;
    }
    const execution = this._options.resolveAgentExecution?.(scope,input.invocationId);
    if (execution && execution.snapshot.agentId !== scope.agentId) throw new Error("Agent execution snapshot scope mismatch");
    const runner = execution?.runner ?? this._options.runner;
    if (runner === undefined) throw new Error("Main Runner has no configured Agent runner");
    let compatibleContext = input.runnerContext;
    if(execution && compatibleContext.runner_type!==execution.snapshot.agentType) {
      if(!this._options.serviceAuthDb) throw new Error("Model type change requires an owned Runner context");
      compatibleContext=new ExecutionContextStore(this._options.serviceAuthDb).resolveForSession(input.input.context.sessionId,execution.snapshot.agentType);
      input={...input,runnerContext:compatibleContext};
      if(input.invocationId) mainInvocations(this._options.serviceAuthDb).set(input.invocationId,input);
    }
    compatibleContext = syncAgentCompatibility(this._options.runnerContextStore, input.runnerContext, execution?.snapshot);
    const serviceEnv = buildMainRunnerServiceEnv({...input,runnerContext:compatibleContext},this._options,scope.agentId,execution?.snapshot);
    const invocationStore = this._options.serviceAuthDb ? new InvocationStore(this._options.serviceAuthDb) : undefined;
    const invocation = input.invocationId ? invocationStore?.find(input.invocationId) : undefined;
    let runnerContext = compatibleContext;
    if (!invocation?.activeJobId) {
      const prepared = await prepareRunnerDirectory({ store: this._options.runnerContextStore, runnerContext: compatibleContext,
        contextFile: buildMainRunnerContextFile(input.input, this._options.serviceAuthDb), invocationId: input.invocationId, signal: input.signal });
      runnerContext = prepared.runnerContext;
      if (invocationStore && invocation && prepared.runnerSessionInvalidated && (input.input.type === "user_messages" || input.input.type === "session_trigger" || input.input.type === "task_result")) {
        invocationStore.finish(invocation.id);
        throw new MainRunnerFreshLaunchReplayRequiredError();
      }
    }

    const memory = this._options.serviceAuthDb && invocation
      ? memoryInjection(this._options.serviceAuthDb, {...scope, actorUserId: invocation.actorUserId, sessionId: input.input.context.sessionId, taskId: null, runnerContextId: runnerContext.id},
        input.input.type === "user_messages" ? input.input.messages.map(message => message.text).join("\n") : undefined)
      : undefined;
    const senderIds = input.input.type === "user_messages"
      ? input.input.messages.map(m => m.senderUserId).filter((id): id is string => Boolean(id))
      : undefined;
    const openRequests = this._options.serviceAuthDb && input.input.type === "user_messages"
      ? new CorrelatedRequestService(this._options.serviceAuthDb, () => undefined)
          .openRequestsForTurn(input.input.context.sessionId, senderIds)
      : undefined;
    const capabilities = buildMainCapabilities(this._options.serviceAuthDb, input.input, {
      agentId: scope.agentId,
      shadowId: scope.shadowId,
      actorUserId: invocation?.actorUserId,
    });
    const prompt = renderMainRunnerPrompt(input.input, {
      ...(memory?.text ? { memory: memory.text } : {}),
      capabilities,
      ...(openRequests?.length ? { openRequests } : {}),
      ...(this._options.serviceAuthDb ? {
        db: this._options.serviceAuthDb,
        people: shadowPeople(this._options.serviceAuthDb, scope),
        timezone: new PlatformSettingsStore(this._options.serviceAuthDb).get().general.timezone,
      } : {}),
    });
    const primaryAttempt = this._options.attemptStore && input.turnId !== undefined
      ? turnAttempt(this._options.attemptStore, { sessionId: sessionIdFromInput(input.input), turnId: input.turnId,
        runnerContext: input.runnerContext, runnerType: this._options.runner?.type ?? "container", inputPrompt: prompt })
      : undefined;
    let primaryOutput: SessionAgentInvocationResult;
    try {
      primaryOutput = await invokeSessionAgent({
        runner,
        runnerContext,
        ...(this._options.runnerContextStore !== undefined
          ? { runnerContextStore: this._options.runnerContextStore }
          : {}),
        runnerKind: "main",
        messageId: mainRunnerMessageId(input.input),
        prompt,
        env: {
          ...(execution?.snapshot.env ?? {}),
          ...serviceEnv,
        },
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        onRunnerSessionInvalidated: () => {
          throw new MainRunnerFreshLaunchReplayRequiredError();
        },
      });
    } catch (err) {
      if (err instanceof RuntimeDetachedError) throw err;
      if (err instanceof MainRunnerFreshLaunchReplayRequiredError && this._options.serviceAuthDb && input.invocationId) {
        const store = new InvocationStore(this._options.serviceAuthDb);
        if (store.find(input.invocationId) && !store.jobsFor(input.invocationId).length) {
          store.finish(input.invocationId);
        }
      }
      this._markAttemptRunnerFailed(primaryAttempt, {
        rawOutput: "",
        error: err,
      });
      throw err;
    }

    memory?.commit();
    const db = this._options.serviceAuthDb;
    if (input.signal?.aborted) throw new Error("Runner was cancelled before final reply");
    const ignoreTerminalOutput =
      isMainSelfRoutineInput(db, input.input) ||
      (db ? isHeartbeatSession(db, input.input.context.sessionId) : false);
    try {
      if (db && !ignoreTerminalOutput) finalizeRunnerReply(db, {
        sessionId: input.input.context.sessionId, originId: mainMessageOrigin(input),
        ...(input.invocationId && new InvocationStore(db).find(input.invocationId) ? { invocationId: input.invocationId } : {}),
        text: primaryOutput.text,
        allowSilent: resolveMainAllowSilent(db, input.input),
        actorUserId: requestedByUserIdForServiceEnv(input, db) ?? (input.input.type === "user_messages" ? input.input.messages.at(-1)?.senderUserId : undefined),
      });
    } catch (error) {
      this._markAttemptRunnerFailed(primaryAttempt, { rawOutput: primaryOutput.text, error });
      throw error;
    }
    const released = db?.select().from(runnerOperations)
      .where(eq(runnerOperations.sessionId, input.input.context.sessionId)).all()
      .some(row => row.status === "applied" && row.originId === mainMessageOrigin(input) && row.request.kind === "session.release") ?? false;
    const completion: MainRunnerCompletion = { status: "completed", followupReleased: released };
    this._markAttemptParsed(primaryAttempt, { rawOutput: primaryOutput.text, parsedActionJson: completion,
      ...(primaryOutput.runnerSessionId ? { runnerSessionId: primaryOutput.runnerSessionId } : {}) });
    return completion;
  }

  private _markAttemptParsed(
    attempt: SessionRunnerAttemptRow | undefined,
    input: {
      readonly rawOutput: string;
      readonly parsedActionJson: MainRunnerCompletion;
      readonly runnerSessionId?: string;
    },
  ): void {
    if (attempt === undefined) {
      return;
    }
    this._options.attemptStore?.markParsed(attempt.id, input);
  }

  private _markAttemptRunnerFailed(
    attempt: SessionRunnerAttemptRow | undefined,
    input: {
      readonly rawOutput: string;
      readonly error: unknown;
    },
  ): void {
    if (attempt === undefined) {
      return;
    }
    this._options.attemptStore?.markRunnerFailed(attempt.id, input);
  }
}

function buildMainRunnerServiceEnv(
  input: MainRunnerRunInput,
  options: Pick<
    MainRunnerOptions,
    "serviceAuthDb" | "accessTokenSigningSecret" | "serviceAuthNow"
  >,
  agentId: string,
  agentConfig?: AgentExecutionSnapshot,
): Record<string, string> {
  // Only a Task result turn acts for one Task; other turns read the session's Tasks by session access.
  const taskId = input.input.type === "task_result" ? input.input.taskId : undefined;
  const requestedByIdentity =
    input.input.type === "user_messages"
      ? requestedIdentityFromInbound(input.input.latestMessage)
      : undefined;
  return buildLunaServiceRunnerEnv({
    runnerKind: "main",
    agentId,
    ...(agentConfig ? {agentConfig} : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    runnerContextId: input.runnerContext.id,
    sessionId: input.input.context.sessionId,
    taskId,
    ...(input.input.type === "task_result" ? {taskRunId: input.input.result.taskRunId} : {}),
    artifactIds: runnerArtifactAllowlistFromInput(input.input),
    requestedByIdentity,
    requestedByUserId: requestedByUserIdForServiceEnv(input, options.serviceAuthDb),
    ...(options.serviceAuthDb === undefined ? {} : { db: options.serviceAuthDb }),
    ...(options.accessTokenSigningSecret === undefined
      ? {}
      : { accessTokenSigningSecret: options.accessTokenSigningSecret }),
    ...(options.serviceAuthNow === undefined ? {} : { now: options.serviceAuthNow }),
  });
}

function requestedByUserIdForServiceEnv(
  input: MainRunnerRunInput,
  db: DrizzleDB | undefined,
): string | undefined {
  if (input.input.type === "session_trigger") return input.input.requesterUserId;
  if (input.input.type === "user_messages" && input.input.latestMessage.sender.kind === "bot")
    return input.input.messages.at(-1)?.senderUserId ?? undefined;
  if (
    input.input.type === "user_messages" &&
    requestedIdentityFromInbound(input.input.latestMessage) === undefined &&
    !requiresExplicitRequesterIdentity(input.input.latestMessage)
  ) {
    return input.input.requesterUserId;
  }
  if (input.input.type !== "task_result" || db === undefined) {
    return undefined;
  }
  return db
    .select({ creatorUserId: tasks.creator_user_id })
    .from(tasks)
    .where(eq(tasks.id, input.input.taskId))
    .get()
    ?.creatorUserId ?? undefined;
}

function mainRunnerMessageId(input: MainRunnerInput): string {
  if (input.type === "session_trigger") return input.triggerId;
  if (input.type === "user_messages") {
    return input.latestMessage.id;
  }
  return `task-result-${input.taskId}`;
}

function sessionIdFromInput(input: MainRunnerInput): string {
  if (input.type === "task_result") {
    return input.sessionId;
  }
  return input.context.sessionId;
}

function buildMainRunnerContextFile(input: MainRunnerInput, db?: DrizzleDB) {
  const sessionId = sessionIdFromInput(input);
  const sessionRow = db?.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (input.type === "user_messages") {
    return {
      schemaVersion: 1,
      runnerKind: "main",
      owner: { type: "session", id: sessionId },
      stableContext: {
        session: {
          id: sessionId,
          kind: "ordinary",
          ...(sessionRow?.title ? { title: sessionRow.title } : {}),
          channel: input.latestMessage.channel,
          surface: contextFileSurface(input.latestMessage.surface),
          ...(input.latestMessage.thread !== undefined
            ? { thread: input.latestMessage.thread }
            : {}),
        },
      },
    } as const;
  }
  const surfaceRow = sessionRow?.group_id
    ? db?.select().from(channelSurfaces).where(and(
        eq(channelSurfaces.channelType, sessionRow.channel_type),
        eq(channelSurfaces.channelId, sessionRow.channel_id),
        eq(channelSurfaces.externalId, sessionRow.group_id),
      )).get()
    : undefined;
  let providerIds: Record<string, unknown> | undefined;
  if (surfaceRow?.providerIdsJson) {
    try {
      const parsed = JSON.parse(surfaceRow.providerIdsJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) providerIds = parsed as Record<string, unknown>;
    } catch { /* ignore malformed cached providerIds */ }
  }
  return {
    schemaVersion: 1,
    runnerKind: "main",
    owner: { type: "session", id: sessionId },
    stableContext: {
      session: {
        id: sessionId,
        kind: "ordinary",
        ...(sessionRow?.title ? { title: sessionRow.title } : {}),
        ...(sessionRow
          ? {
              channel: {
                type: sessionRow.channel_type,
                id: sessionRow.channel_id,
              },
              ...(sessionRow.group_id !== null
                ? {
                    surface: {
                      externalId: sessionRow.group_id,
                      kind: (() => {
                        const resolved = surfaceRow ? resolvePersistedSurfaceKind(surfaceRow) : undefined;
                        return resolved === "p2p" || resolved === "group" ? resolved : "group";
                      })(),
                      ...(surfaceRow?.displayName ? { displayName: surfaceRow.displayName } : {}),
                      ...(surfaceRow?.avatarUrl ? { avatarUrl: surfaceRow.avatarUrl } : {}),
                      ...(providerIds ? { providerIds } : {}),
                    },
                  }
                : {}),
              ...(sessionRow.thread_key !== null
                ? {
                    thread: {
                      externalId: sessionRow.thread_key,
                      ...(sessionRow.root_message_key !== null
                        ? { rootMessageExternalId: sessionRow.root_message_key }
                        : {}),
                    },
                  }
                : {}),
            }
          : {}),
      },
    },
  } as const;
}

export interface MainRunnerPromptOptions {
  /** Agent memory sections for this turn, already rendered as text. */
  readonly memory?: string;
  /** Capability manifest for Protocol v2. */
  readonly capabilities?: RunnerCapabilitiesManifest;
  /** Open correlated requests targeting this session. */
  readonly openRequests?: readonly CorrelatedRequestRow[];
  readonly db?: DrizzleDB;
  /** Relation of each sender to this Shadow. */
  readonly people?: PeopleResolver;
  readonly now?: Date;
  readonly timezone?: string;
}

/** The turn input for Main (Protocol v2): capabilities, background context, clock, then `<events>`. */
export function renderMainRunnerPrompt(input: MainRunnerInput, options: MainRunnerPromptOptions = {}): string {
  const clock = turnClock(options.now, options.timezone);
  const context = input.context;
  const capabilities = options.capabilities ?? buildMainCapabilities(options.db, input);
  const openRequestIds = new Set((options.openRequests ?? []).map((req) => req.id));
  const pack = (value: MainRunnerContextPack | undefined) => value && compact({
    kind: value.kind,
    omittedOutOfBandCount: value.omittedOutOfBandCount,
    items: value.items.map((item) => {
      const requestSnapshot = renderDeltaItemRequestSnapshot(
        options.db,
        item,
        openRequestIds,
        clock.timezone,
      );
      return compact({
        role: item.messageRole,
        text: item.text,
        entryId: item.entryId,
        messageId: item.messageId,
        source: item.source,
        sourceSessionId: item.sourceSessionId,
        reason: item.reason,
        via: item.via,
        originSessionId: item.originSessionId,
        correlationId: item.correlationId,
        request: requestSnapshot,
      });
    }),
  });
  const activation = input.type === "user_messages" ? input.activationContextMessages?.map((message) => activationItem(message, options.people, clock.timezone)) : undefined;
  const history = compact({ launchSeed: pack(context.launchSeed), deltaContext: pack(context.deltaContext), activationContext: activation });

  const events: ReturnType<typeof turnEvent>[] = [];
  if (context.clarification) {
    events.push(turnEvent({
      id: `clarification:${context.sessionId}`,
      kind: "clarification",
      time: clock.now,
      source: `session:${context.sessionId}`,
      actor: input.requesterUserId ?? undefined,
      payload: clarificationFacts(context.clarification) as Record<string, unknown>,
    }));
  }
  for (const req of options.openRequests ?? []) {
    const res = (req.resultJson ?? null) as Record<string, unknown> | null;
    events.push(turnEvent({
      id: req.id,
      kind: "open_request",
      time: zonedIso(new Date(req.createdAt), clock.timezone),
      source: req.originTaskId ? `task:${req.originTaskId}` : `session:${req.originSessionId}`,
      actor: req.targetUserId ?? undefined,
      correlationId: req.id,
      payload: compact({
        mode: req.mode,
        status: req.status,
        goal: req.instruction,
        context: req.contextSummary ?? undefined,
        options: req.optionsJson ?? undefined,
        originSessionId: req.originSessionId,
        originTaskId: req.originTaskId ?? undefined,
        latestProgress: typeof res?.latestProgress === "string" ? res.latestProgress : undefined,
        expiresAt: req.expiresAt ? zonedIso(new Date(req.expiresAt), clock.timezone) : undefined,
      }) as Record<string, unknown>,
    }));
  }

  const { primaryEvents, text } = buildPrimaryMainEvents(input, clock, options.people, options.db);
  events.push(...primaryEvents);

  return joinBlocks([
    dataBlock("capabilities", { json: compactTurnCapabilities(capabilities) }),
    dataBlock("memory", { text: options.memory ?? "" }),
    Object.keys(history).length ? dataBlock("history", { json: history }) : "",
    dataBlock("now", { json: clock }),
    dataBlock("events", { json: events, ...(text ? { text } : {}) }),
  ]);
}

/**
 * What is still missing, without the question that was asked: the provider session already
 * holds it, and a fresh session gets it again through `launchSeed`.
 */
function clarificationFacts(clarification: NonNullable<MainRunnerInput["context"]["clarification"]>) {
  const { lastReply: _lastReply, ...facts } = clarification;
  return facts;
}

function renderDeltaItemRequestSnapshot(
  db: DrizzleDB | undefined,
  item: MainRunnerContextPack["items"][number],
  openRequestIds: ReadonlySet<string>,
  timezone: string,
): Record<string, unknown> | undefined {
  if (!db || !item.correlationId) return undefined;
  if (openRequestIds.has(item.correlationId)) return undefined;
  const req = db
    .select()
    .from(correlatedRequests)
    .where(eq(correlatedRequests.id, item.correlationId))
    .get();
  if (!req) return undefined;
  const resultJson = (req.resultJson ?? null) as Record<string, unknown> | null;
  const selectedOption =
    typeof resultJson?.selectedOption === "string"
      ? resultJson.selectedOption
      : undefined;
  const summary =
    typeof resultJson?.summary === "string"
      ? resultJson.summary
      : typeof resultJson?.answer === "string"
        ? resultJson.answer
        : undefined;
  return compact({
    mode: req.mode,
    status: req.status,
    originTaskId: req.originTaskId ?? undefined,
    contextSummary: req.contextSummary ?? undefined,
    options: req.optionsJson ?? undefined,
    selectedOption,
    summary: summary && summary !== selectedOption ? summary : undefined,
    resolvedBy: req.resolvedByUserId ? `user:${req.resolvedByUserId}` : undefined,
    resolvedAt:
      req.status !== "open" && req.status !== "in_progress"
        ? zonedIso(new Date(req.updatedAt), timezone)
        : undefined,
  }) as Record<string, unknown>;
}

function buildPrimaryMainEvents(
  input: MainRunnerInput,
  clock: ReturnType<typeof turnClock>,
  people: PeopleResolver | undefined,
  db: DrizzleDB | undefined,
): { readonly primaryEvents: ReturnType<typeof turnEvent>[]; readonly text?: string | undefined } {
  if (input.type === "task_result") {
    const { userVisibleReport, artifactIds, ...result } = input.result;
    const visible = input.result.artifactRefs !== undefined ? result : { ...result, artifactIds };
    return {
      primaryEvents: [
        turnEvent({
          id: input.result.taskRunId,
          kind: "task_result",
          time: clock.now,
          source: `task:${input.result.taskId}`,
          actor: input.requesterUserId ?? undefined,
          payload: compact({
            sessionId: input.sessionId,
            surface: input.surface,
            requesterUserId: input.requesterUserId,
            sourceMessageId: input.sourceMessageId,
            ...visible,
          }) as Record<string, unknown>,
        }),
      ],
      text: userVisibleReport,
    };
  }
  if (input.type === "session_trigger") {
    const classified = resolveMainTriggerClassification(
      db,
      input.triggerId,
      input.sourceSessionId,
      input.context.sessionId,
    );
    if (classified.originKind === "self_routine") {
      return {
        primaryEvents: [
          turnEvent({
            id: input.triggerId,
            kind: "routine",
            time: clock.now,
            source: "system",
            actor: input.requesterUserId ?? undefined,
            payload: compact({
              routineKind: classified.routineKind,
              sessionId: input.context.sessionId,
            }) as Record<string, unknown>,
          }),
        ],
        text: input.instruction,
      };
    }
    if (classified.originKind === "request_update") {
      return {
        primaryEvents: [
          turnEvent({
            id: input.triggerId,
            kind: "request_update",
            time: clock.now,
            source: `session:${String(classified.requestUpdate?.targetSessionId ?? input.sourceSessionId)}`,
            actor:
              (classified.requestUpdate?.resolvedByUserId as string | undefined) ??
              input.requesterUserId ??
              undefined,
            correlationId: input.correlationId,
            payload: (classified.requestUpdate ?? {}) as Record<string, unknown>,
          }),
        ],
        text: input.instruction,
      };
    }
    if (classified.originKind === "request_opened") {
      const opened = classified.requestOpened ?? {};
      return {
        primaryEvents: [
          turnEvent({
            id: input.triggerId,
            kind: "request_opened",
            time: clock.now,
            source: String(opened.source ?? `session:${input.sourceSessionId}`),
            actor: input.requesterUserId ?? undefined,
            correlationId: input.correlationId,
            payload: compact({
              ...opened,
              hops: input.hops,
              artifactRefs: input.artifactRefs,
            }) as Record<string, unknown>,
          }),
        ],
        text: input.instruction,
      };
    }
    if (classified.originKind === "request_message") {
      const msg = classified.requestMessage ?? {};
      return {
        primaryEvents: [
          turnEvent({
            id: input.triggerId,
            kind: "request_message",
            time: clock.now,
            source: String(msg.source ?? `session:${input.sourceSessionId}`),
            actor: input.requesterUserId ?? undefined,
            correlationId: input.correlationId,
            payload: compact({
              ...msg,
              hops: input.hops,
              artifactRefs: input.artifactRefs,
            }) as Record<string, unknown>,
          }),
        ],
        text: input.instruction,
      };
    }
    if (classified.originKind === "peer_message") {
      const peer = classified.peerMessage ?? {};
      return {
        primaryEvents: [
          turnEvent({
            id: input.triggerId,
            kind: "peer_message",
            time: clock.now,
            source: String(peer.source ?? `session:${input.sourceSessionId}`),
            actor: input.requesterUserId ?? undefined,
            payload: compact({
              sourceSessionId: input.sourceSessionId,
              ...(typeof peer.taskId === "string" ? { taskId: peer.taskId } : {}),
              ...(typeof peer.taskRunId === "string" ? { taskRunId: peer.taskRunId } : {}),
              hops: input.hops,
              artifactRefs: input.artifactRefs,
            }) as Record<string, unknown>,
          }),
        ],
        text: input.instruction,
      };
    }
    return {
      primaryEvents: [
        turnEvent({
          id: input.triggerId,
          kind: "schedule_fired",
          time: clock.now,
          source: `session:${input.sourceSessionId}`,
          actor: input.requesterUserId ?? undefined,
          correlationId: input.correlationId,
          payload: compact({
            sourceSessionId: input.sourceSessionId,
            hops: input.hops,
            artifactRefs: input.artifactRefs,
          }) as Record<string, unknown>,
        }),
      ],
      text: input.instruction,
    };
  }

  const rawById = new Map(input.messages.map((message) => [message.messageId, message.rawMessage]));
  const surface = input.latestMessage.thread
    ? "thread"
    : input.latestMessage.surface.kind !== "unknown"
      ? input.latestMessage.surface.kind
      : undefined;
  const lastIdx = input.messages.length - 1;
  return {
    primaryEvents: input.messages.map((message, idx) =>
      turnEvent({
        id: message.messageId,
        kind: "message",
        time: zonedIso(new Date(message.createdAt), clock.timezone),
        source: `session:${input.context.sessionId}`,
        actor: message.senderUserId ?? message.sender.externalId,
        payload: compact({
          ...messageItem(message, people, rawById.get(message.messageId), clock.timezone),
          surface,
          ...(idx === lastIdx
            ? {
                requesterUserId: input.requesterUserId,
                listening: input.ambient,
                addressing: addressingFacts(input.latestMessage),
                activationSource:
                  input.activationSourceMessage &&
                  activationItem(input.activationSourceMessage, people, clock.timezone),
              }
            : {}),
        }) as Record<string, unknown>,
      }),
    ),
  };
}

function activationItem(message: ActivationContextMessage, people: PeopleResolver | undefined, timezone?: string) {
  return compact({
    id: message.messageId,
    from: message.senderUserId ? { id: message.senderUserId, ...people?.(message.senderUserId) } : undefined,
    at: zonedIso(new Date(message.createdAt), timezone),
    text: message.text,
  });
}

export class MainRunnerFreshLaunchReplayRequiredError extends Error {
  constructor() {
    super(
      "Main Runner persisted resume state was invalidated; rebuild context and replay as a fresh launch.",
    );
    this.name = "MainRunnerFreshLaunchReplayRequiredError";
  }
}
