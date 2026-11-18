import { memoryInjection } from "@/agents/agent-memory-injection";
import {RunnerContextStore as ExecutionContextStore} from "@/runners/runner-context-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import type {AgentScope} from "@/agents/agent-store";
import { prepareRunnerFiles } from "@/runners/prepare-runner-files";
import { finalizeRunnerReply } from "@/messaging/runner-answer";
import { RuntimeDetachedError } from "@/runners/runtime-detach";
import { InvocationStore } from "@/runners/invocation-store";
import { decodeInvocation } from "@/runners/invocation-codec";
import { randomUUID } from "node:crypto";
import { mainInvocations, mainMessageOrigin } from "@/runners/main-invocation-registry";
import type { AgentExecutionSnapshot } from "@/agent-config";
import type { DrizzleDB } from "@/data";
import { runnerOperations, tasks } from "@/data/schema";
import {
  requestedIdentityFromInbound,
  requiresExplicitRequesterIdentity,
} from "@/identity/requested-identity";
import { buildLunaServiceRunnerEnv } from "@/runners/luna-service-env";
import { writeRunnerContextFile } from "@/runners/runner-context-file";
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
import { addressingFacts, compact, dataBlock, joinBlocks, messageItem, turnClock, zonedIso, type PeopleResolver } from "@/runners/turn-envelope";
import { shadowPeople } from "@/runners/shadow-people";
import { ensureMainRunnerWorkspaceInstructions } from "./workspace-instructions";
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
    const invocationId = prior?.id ?? input.invocationId ?? randomUUID();
    const scopedInput = { ...(restored?.input ?? input), invocationId, ...(input.signal ? { signal: input.signal } : {}) } as MainRunnerRunInput;
    if (db) mainInvocations(db).set(invocationId, scopedInput);
    try {
      return await this._run(scopedInput);
    } finally {
      if (db) mainInvocations(db).delete(invocationId);
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
    if (execution !== undefined) {
      compatibleContext = this._options.runnerContextStore?.syncAgentCompatibility(
        input.runnerContext.id,
        {
          providerFingerprint: execution.snapshot.providerFingerprint,
          modelFingerprint: execution.snapshot.modelFingerprint,
          resumeOnModelChange: execution.snapshot.resumeOnModelChange,
        },
      ).runnerContext ?? input.runnerContext;
    }
    const serviceEnv = buildMainRunnerServiceEnv({...input,runnerContext:compatibleContext},this._options,scope.agentId,execution?.snapshot);
    const invocationStore = this._options.serviceAuthDb ? new InvocationStore(this._options.serviceAuthDb) : undefined;
    const invocation = input.invocationId ? invocationStore?.find(input.invocationId) : undefined;
    let runnerContext = compatibleContext;
    if (!invocation?.activeJobId) {
      const instructions = await prepareRunnerFiles(compatibleContext, buildMainRunnerContextFile(input.input), input.signal, input.invocationId);
      const synced = this._options.runnerContextStore?.syncInstructionFingerprint(
        compatibleContext.id,
        instructions.instructionFingerprint,
      );
      runnerContext = synced?.runnerContext ?? compatibleContext;
      if (invocationStore && invocation && synced?.runnerSessionInvalidated && input.input.type === "user_messages") {
        invocationStore.finish(invocation.id);
        throw new MainRunnerFreshLaunchReplayRequiredError();
      }
    }

    const memory = this._options.serviceAuthDb && invocation
      ? memoryInjection(this._options.serviceAuthDb, {...scope, actorUserId: invocation.actorUserId, sessionId: input.input.context.sessionId, taskId: null, runnerContextId: runnerContext.id},
        input.input.type === "user_messages" ? input.input.messages.map(message => message.text).join("\n") : undefined)
      : undefined;
    const prompt = renderMainRunnerPrompt(input.input, {
      ...(memory?.text ? { memory: memory.text } : {}),
      ...(this._options.serviceAuthDb ? { people: shadowPeople(this._options.serviceAuthDb, scope) } : {}),
    });
    const primaryAttempt = this._createAttempt(input, {
      attemptKind: "primary",
      inputPrompt: prompt,
    });
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
    try {
      if (db) finalizeRunnerReply(db, {
        sessionId: input.input.context.sessionId, originId: mainMessageOrigin(input),
        ...(input.invocationId && new InvocationStore(db).find(input.invocationId) ? { invocationId: input.invocationId } : {}),
        text: primaryOutput.text,
        allowSilent: input.input.type !== "user_messages" || input.input.latestMessage.surface.kind !== "p2p",
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

  private _createAttempt(
    input: MainRunnerRunInput,
    attempt: {
      readonly attemptKind: "primary" | "repair";
      readonly inputPrompt: string;
      readonly repairSourceAttemptId?: string;
    },
  ): SessionRunnerAttemptRow | undefined {
    if (this._options.attemptStore === undefined || input.turnId === undefined) {
      return undefined;
    }
    const running = this._options.attemptStore.listForTurn(input.turnId).find(row => row.status === "running" && row.runnerContextId === input.runnerContext.id);
    if (running) return running;
    return this._options.attemptStore.createRunning({
      sessionId: sessionIdFromInput(input.input),
      turnId: input.turnId,
      runnerContextId: input.runnerContext.id,
      runnerType: this._options.runner?.type ?? "container",
      runnerSessionId: input.runnerContext.runner_session_id,
      attemptKind: attempt.attemptKind,
      inputPrompt: attempt.inputPrompt,
      ...(attempt.repairSourceAttemptId !== undefined
        ? { repairSourceAttemptId: attempt.repairSourceAttemptId }
        : {}),
    });
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
  const taskId =
    input.input.type === "task_result"
      ? input.input.taskId
      : input.input.context.boundTask?.taskId;
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

function buildMainRunnerContextFile(input: MainRunnerInput) {
  const sessionId = sessionIdFromInput(input);
  if (input.type === "user_messages") {
    return {
      schemaVersion: 1,
      runnerKind: "main",
      owner: { type: "session", id: sessionId },
      stableContext: {
        session: {
          id: sessionId,
          kind: "ordinary",
          channel: input.latestMessage.channel,
          surface: sanitizedMainSurface(input.latestMessage.surface),
          ...(input.latestMessage.thread !== undefined
            ? { thread: input.latestMessage.thread }
            : {}),
        },
      },
    } as const;
  }
  return {
    schemaVersion: 1,
    runnerKind: "main",
    owner: { type: "session", id: sessionId },
    stableContext: {
      session: {
        id: sessionId,
        kind: "ordinary",
      },
    },
  } as const;
}

function sanitizedMainSurface(
  surface: Extract<MainRunnerInput, { readonly type: "user_messages" }>["latestMessage"]["surface"],
) {
  const { rawProfile: _rawProfile, ...rest } =
    surface as typeof surface & { readonly rawProfile?: unknown };
  return rest;
}

export interface MainRunnerPromptOptions {
  /** Agent memory sections for this turn, already rendered as text. */
  readonly memory?: string;
  /** Relation of each sender to this Shadow. */
  readonly people?: PeopleResolver;
  readonly now?: Date;
}

/** The turn input for Main: background blocks first, this turn's input last. */
export function renderMainRunnerPrompt(input: MainRunnerInput, options: MainRunnerPromptOptions = {}): string {
  const clock = turnClock(options.now);
  const context = input.context;
  const pack = (value: MainRunnerContextPack | undefined) => value && {
    kind: value.kind,
    items: value.items.map((item) => compact({
      role: item.messageRole, text: item.text, entryId: item.entryId, messageId: item.messageId,
      source: item.source, sourceSessionId: item.sourceSessionId, reason: item.reason,
    })),
  };
  const activation = input.type === "user_messages" ? input.activationContextMessages?.map((message) => activationItem(message, options.people)) : undefined;
  const history = compact({ launchSeed: pack(context.launchSeed), deltaContext: pack(context.deltaContext), activationContext: activation });
  const tasks = compact({ bound: context.boundTask, candidates: context.candidateOpenTasks });
  return joinBlocks([
    dataBlock("memory", { text: options.memory ?? "" }),
    Object.keys(history).length ? dataBlock("history", { json: history }) : "",
    Object.keys(tasks).length ? dataBlock("tasks", { json: tasks }) : "",
    context.clarification ? dataBlock("clarification", { json: clarificationFacts(context.clarification) }) : "",
    mainTurnBlock(input, clock, options.people),
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

function mainTurnBlock(input: MainRunnerInput, clock: ReturnType<typeof turnClock>, people: PeopleResolver | undefined): string {
  if (input.type === "task_result") {
    const { userVisibleReport, artifactIds, ...result } = input.result;
    // Timeline IDs remain in business persistence, never masquerade as download IDs.
    const visible = input.result.artifactRefs !== undefined ? result : { ...result, artifactIds };
    return dataBlock("task_result", { json: { ...clock, sessionId: input.sessionId, ...visible }, text: userVisibleReport });
  }
  if (input.type === "session_trigger") {
    const { instruction, context: _context, type: _type, ...trigger } = input;
    return dataBlock("trigger", { json: { ...clock, ...trigger }, text: instruction });
  }
  const rawById = new Map(input.messages.map((message) => [message.messageId, message.rawMessage]));
  return dataBlock("messages", {
    json: compact({
      ...clock,
      requesterUserId: input.requesterUserId,
      addressing: addressingFacts(input.latestMessage),
      activationSource: input.activationSourceMessage && activationItem(input.activationSourceMessage, people),
      items: input.messages.map((message) => messageItem(message, people, rawById.get(message.messageId))),
    }),
  });
}

function activationItem(message: ActivationContextMessage, people: PeopleResolver | undefined) {
  return compact({
    id: message.messageId,
    from: message.senderUserId ? { id: message.senderUserId, ...people?.(message.senderUserId) } : undefined,
    at: zonedIso(new Date(message.createdAt)),
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
