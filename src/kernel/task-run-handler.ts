import { memoryInjection } from "@/agents/agent-memory-injection";
import { compact, dataBlock, joinBlocks, turnClock, zonedIso } from "@/runners/turn-envelope";
import { promptBlock } from "@luna/host-runtime/prompt-blocks";
import type {AgentExecutionSnapshot} from "@/agent-config";
import {TaskScopeResolver} from "@/agents/task-scope";
import { prepareRunnerFiles } from "@/runners/prepare-runner-files";
import { randomUUID } from "node:crypto";
import {TaskProgressStore,runPredicate} from "@/timeline/task-progress-store";
import { LiveProgress } from "@/messaging/notifications/live-progress";
import type { TaskStatusCardStepEvent } from "@/messaging/notifications/task-status-card-updater";
import type { NativeProgressEntry } from "@/channels/outbound";
import { lookupChannelSurfaceKind } from "@/channels/directory-store";
import { createLogger } from "@/shared";
const progressLogger = createLogger("task-progress");
import { InvocationStore } from "@/runners/invocation-store";
import { taskInvocations, requireTaskReportCompletion } from "@/tasks/task-report-store";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import {
  ContextPackStore,
  type ContextPackItemRow,
  type ContextPackRow,
} from "@/context";
import type { DrizzleDB } from "@/data";
import {
  artifacts as artifactRows,
  messages,
  taskRuns,
  tasks,
  runnerContexts,
  sessionTimelineEntries,
  timelineEvents,
} from "@/data/schema";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import { buildLunaServiceRunnerEnv } from "@/runners/luna-service-env";
import { runnerProgressStepFromAssistant } from "@/runners/runner-progress-step";
import { writeRunnerContextFile } from "@/runners/runner-context-file";
import {
  canonicalUserIdForRequestedIdentity,
  requestedIdentityFromTaskContext,
  type RequestedIdentityContext,
} from "@/identity/requested-identity";
import {
  RunnerContextStore,
  type ResolvedRunnerContext,
} from "@/runners/runner-context-store";
import { FakeSandboxRuntime } from "@/sandbox/fake-sandbox-runtime";
import { ArtifactStore } from "@/timeline/artifact-store";
import { TimelineStore } from "@/timeline/timeline-store";
import {
  createAgentRunnerForConfig,
} from "@/kernel/agents";
import { getKernel } from "@/server/routes/kernel";
import { runnerArtifactAllowlistFromInput } from "@/main-runner/artifact-allowlist";
import { TaskSubscriptionStore } from "@/tasks/task-subscription-store";
import { WAITING_FOR_INPUT, type TaskSubscription } from "@/tasks/types";
import { renderMessageBlocksForRunner } from "@/main-runner/context-builder";
import { PlatformSettingsStore } from "@/platform/platform-settings-store";
import type { MessageContentBlock } from "@/sessions/types";
import { extractTextContent, type UserMessage } from "@/shared";
import { FakeRunnerAdapter } from "../../extensions/runners/mock/fake-runner-adapter";

/**
 * Input contract for reusable Task Runner execution independent from old task rows.
 */
export interface ExecuteTaskRunInput {
  readonly db: DrizzleDB;
  readonly taskRunId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly inputSnapshot: unknown;
  readonly runnerType: string;
  readonly runnerContext: ResolvedRunnerContext;
  readonly runIndex?: number;
  readonly sourceMessageId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (events?: readonly TaskStatusCardStepEvent[], nativeProgress?: readonly NativeProgressEntry[]) => Promise<void> | void;
}

/**
 * Result contract returned by reusable Task Runner execution.
 */
export interface ExecuteTaskRunResult {
  readonly finalReportArtifactId: string;
}

export interface BuildTaskRunPromptInput {
  readonly taskType: string;
  readonly title: string;
  readonly summary: string;
  readonly reason: string;
  readonly pendingText: string;
  readonly launchContext?: readonly TaskRunPromptContextItem[];
  readonly updateContext?: readonly TaskRunPromptContextItem[];
  readonly facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly timezone?: string;
}

export interface TaskRunPromptContextItem {
  readonly packId: string;
  readonly itemId: string;
  readonly packKind: string;
  readonly role: string;
  readonly source: string;
  readonly reason: string;
  readonly text: string;
  readonly occurredAt?: number;
}

/**
 * Executes the Task Runner and persists runner timeline/artifact side effects.
 */
export async function executeTaskRun(
  input: ExecuteTaskRunInput,
): Promise<ExecuteTaskRunResult> {
  const timeline = new TimelineStore(input.db);
  const artifacts = new ArtifactStore(input.db);
  const pendingText = taskRunInputText(input.inputSnapshot);
  _throwIfAborted(input.signal);
  const invocations = new InvocationStore(input.db);
  const activeInvocation = invocations.findActive({ runnerKind: "task", taskRunId: input.taskRunId });
  while (invocations.pending().some(item => item.runnerKind === "task" && item.taskId === input.taskId && item.id !== activeInvocation?.id && item.state === "revoked")) {
    _throwIfAborted(input.signal);
    if (input.runnerType !== "mock") getKernel().runtimeAgentTransport?.recoverCancellations();
    await delay(250, undefined, input.signal ? { signal: input.signal } : {});
  }
  const agentConfig=input.runnerType === "mock" ? undefined : getKernel().resolveAgentExecutionSnapshot(
    new TaskScopeResolver(input.db).task(input.taskId),activeInvocation?.id);
  if(agentConfig) input={...input,runnerType:agentConfig.agentType,
    runnerContext:new RunnerContextStore(input.db).resolveForTask(input.taskId,agentConfig.agentType)};
  if (activeInvocation?.activeJobId) {
    const run = input.db.select().from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).get();
    if (!run?.materialized_prompt) throw new Error("Recoverable Task Run is missing its persisted prompt");
    return _runAgentTask({ ...input, agentConfig, timeline, artifacts, pendingText, runMetadata: _runMetadata(input), materializedPrompt: run.materialized_prompt });
  }
  const taskRow = _taskRowById(input.db, input.taskId);
  const deliverySubscriptions = new TaskSubscriptionStore(input.db).listForTask(input.taskId);
  const instructionFiles = input.runnerType==="mock"
    ? await prepareRunnerFiles(input.runnerContext, _buildTaskRunnerContextFile(input.db, input.taskId, taskRow, deliverySubscriptions), input.signal)
    : undefined;
  const runnerContext = instructionFiles ? new RunnerContextStore(input.db).syncInstructionFingerprint(input.runnerContext.id, instructionFiles.instructionFingerprint).runnerContext : input.runnerContext;
  const promptPackage = _buildTaskRunPromptPackage({
    db: input.db,
    taskId: input.taskId,
    reason: input.reason,
    inputSnapshot: input.inputSnapshot,
    pendingText,
    isNewSession: runnerContext.runner_session_id === null,
  });
  _persistTaskRunPromptPackage({
    db: input.db,
    taskRunId: input.taskRunId,
    materializedPrompt: promptPackage.materializedPrompt,
  });
  if (runnerContext.runner_session_id === null) {
    _recordTaskRunSeedRecords({
      db: input.db,
      taskId: input.taskId,
      runnerContextId: runnerContext.id,
      launchPacks: promptPackage.launchPacks,
      launchItemsByPackId: promptPackage.launchItemsByPackId,
    });
  }

  if (input.runnerType === "mock") {
    return await _runFakeTask({
      taskId: input.taskId,
      reason: input.reason,
      pendingText,
      runnerContext,
      timeline,
      artifacts,
      runMetadata: _runMetadata(input),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.onProgress !== undefined
        ? { onProgress: input.onProgress }
        : {}),
    });
  }

  return await _runAgentTask({
    agentConfig,
    db: input.db,
    taskRunId: input.taskRunId,
    taskId: input.taskId,
    reason: input.reason,
    pendingText,
    runnerType: input.runnerType,
    runnerContext,
    timeline,
    artifacts,
    runMetadata: _runMetadata(input),
    inputSnapshot: input.inputSnapshot,
    materializedPrompt: promptPackage.materializedPrompt,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.onProgress !== undefined
      ? { onProgress: input.onProgress }
      : {}),
  });
}

function _buildTaskRunPromptPackage(input: {
  readonly db: DrizzleDB;
  readonly taskId: string;
  readonly reason: string;
  readonly inputSnapshot: unknown;
  readonly pendingText: string;
  readonly isNewSession: boolean;
}): {
  readonly promptInput: BuildTaskRunPromptInput;
  readonly materializedPrompt: string;
  readonly launchPacks: readonly ContextPackRow[];
  readonly launchItemsByPackId: ReadonlyMap<string, readonly ContextPackItemRow[]>;
} {
  const taskRow = _taskRowById(input.db, input.taskId);
  const contextPackStore = new ContextPackStore(input.db);
  const runContext = _taskRunContextPacks({
    store: contextPackStore,
    taskId: input.taskId,
    reason: input.reason,
    inputSnapshot: input.inputSnapshot,
    isNewSession: input.isNewSession,
  });
  const launchItemsByPackId = new Map<string, readonly ContextPackItemRow[]>();
  for (const pack of runContext.launchPacks) {
    launchItemsByPackId.set(pack.id, contextPackStore.listItemsForPack(pack.id));
  }
  // Use persisted Task context so replayed or restarted runs see the same facts
  // and launch assumptions that were recorded at dispatch time.
  const context = _isRecord(taskRow?.context_json) ? taskRow.context_json : {};
  const promptInput: BuildTaskRunPromptInput = {
    taskType: taskRow?.type ?? "task",
    title: taskRow?.title ?? input.taskId,
    summary: taskRow?.summary ?? "",
    reason: input.reason,
    pendingText: input.pendingText,
    launchContext: _promptContextItemsForPacks({
      db: input.db,
      store: contextPackStore,
      packs: runContext.launchPacks,
    }),
    updateContext: _promptContextItemsForPacks({
      db: input.db,
      store: contextPackStore,
      packs: runContext.updatePacks,
    }),
    facts: _stringList(context.knownFacts),
    assumptions: _stringList(context.assumptions),
    timezone: new PlatformSettingsStore(input.db).get().general.timezone,
  };
  return {
    promptInput,
    materializedPrompt: buildTaskRunPrompt(promptInput),
    launchPacks: runContext.launchPacks,
    launchItemsByPackId,
  };
}

function _taskRowById(db: DrizzleDB, taskId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
}

function _buildTaskRunnerContextFile(
  db: DrizzleDB,
  taskId: string,
  taskRow: typeof tasks.$inferSelect | undefined,
  subscriptions: readonly TaskSubscription[],
) {
  return {
    schemaVersion: 1,
    runnerKind: "task",
    owner: { type: "task", id: taskId },
    stableContext: {
      task: {
        id: taskId,
        type: taskRow?.type ?? "task",
        createdByUserId: taskRow?.creator_user_id ?? null,
        ...(taskRow?.primary_session_id !== null && taskRow?.primary_session_id !== undefined
          ? { primarySessionId: taskRow.primary_session_id }
          : {}),
      },
      deliverySubscriptions: subscriptions
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((subscription) => {
          const resolvedKind = lookupChannelSurfaceKind(
            db,
            { type: subscription.channel_type, id: subscription.channel_id },
            subscription.group_id,
          );
          return {
            sessionId: subscription.session_id,
            channel: {
              type: subscription.channel_type,
              id: subscription.channel_id,
            },
            surface: {
              kind:
                resolvedKind === "p2p" || resolvedKind === "group"
                  ? resolvedKind
                  : subscription.group_id === null
                    ? "p2p"
                    : "group",
              externalId: subscription.group_id ?? subscription.channel_id,
            },
            ...(subscription.thread_key !== null
              ? {
                  thread: {
                    externalId: subscription.thread_key,
                    ...(subscription.root_message_key !== null
                      ? { rootMessageExternalId: subscription.root_message_key }
                      : {}),
                  },
                }
              : {}),
            visibility: subscription.visibility,
          };
        }),
    },
  } as const;
}

function _persistTaskRunPromptPackage(input: {
  readonly db: DrizzleDB;
  readonly taskRunId: string;
  readonly materializedPrompt: string;
}): void {
  input.db
    .update(taskRuns)
    .set({
      materialized_prompt: input.materializedPrompt,
    })
    .where(eq(taskRuns.id, input.taskRunId))
    .run();
}

function _throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    throw new Error(signal.reason);
  }
  throw new Error("Task Run aborted.");
}

async function _runFakeTask(input: {
  readonly taskId: string;
  readonly reason: string;
  readonly pendingText: string;
  readonly runnerContext: ReturnType<RunnerContextStore["resolveForTask"]>;
  readonly timeline: TimelineStore;
  readonly artifacts: ArtifactStore;
  readonly runMetadata: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (events?: readonly TaskStatusCardStepEvent[], nativeProgress?: readonly NativeProgressEntry[]) => Promise<void> | void;
}): Promise<ExecuteTaskRunResult> {
  _throwIfAborted(input.signal);
  const sandbox = new FakeSandboxRuntime({
    timeline: input.timeline,
    artifacts: input.artifacts,
  });
  const runner = new FakeRunnerAdapter({ runnerType: "mock" });
  const execution = runner.buildRun({
    taskId: input.taskId,
    mode: input.reason === "initial" ? "run" : "resume",
    workspacePath: input.runnerContext.workspacePath,
    runnerRootPath: input.runnerContext.runner_root_path,
    payload: { prompt: input.pendingText },
  });
  await input.onProgress?.();
  _throwIfAborted(input.signal);
  await sandbox.run({
    ...execution,
    execute: async () => {
      _throwIfAborted(input.signal);
      if (execution.execute === undefined) {
        throw new Error("Mock runner execution is not available.");
      }
      const result = await execution.execute();
      _throwIfAborted(input.signal);
      return {
        ...result,
        events: result.events.map((event) => ({
          ...event,
          data: {
            ...(event.data ?? {}),
            ...input.runMetadata,
          },
        })),
      };
    },
  });
  _throwIfAborted(input.signal);
  const finalReportArtifactId = _latestReportArtifactId(
    input.artifacts,
    input.taskId,
  );
  if (finalReportArtifactId === undefined) {
    throw new Error("Task runner completed without a final report artifact.");
  }
  return { finalReportArtifactId };
}

async function _runAgentTask(input: {
  readonly agentConfig:AgentExecutionSnapshot | undefined;
  readonly db: DrizzleDB;
  readonly taskRunId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly pendingText: string;
  readonly runnerType: string;
  readonly runnerContext: ReturnType<RunnerContextStore["resolveForTask"]>;
  readonly timeline: TimelineStore;
  readonly artifacts: ArtifactStore;
  readonly runMetadata: Record<string, unknown>;
  readonly inputSnapshot: unknown;
  readonly materializedPrompt: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (events?: readonly TaskStatusCardStepEvent[], nativeProgress?: readonly NativeProgressEntry[]) => Promise<void> | void;
}): Promise<ExecuteTaskRunResult> {
  _throwIfAborted(input.signal);
  if (!["claude", "codex"].includes(input.runnerType)) {
    throw new Error(`Unknown agent type: ${input.runnerType}`);
  }
  const snapshot=input.agentConfig;
  if(!snapshot || snapshot.agentType!==input.runnerType) throw new Error("Task execution configuration is missing or mismatched");
  let runnerContext = new RunnerContextStore(input.db).syncAgentCompatibility(
    input.runnerContext.id,
    {
      providerFingerprint: snapshot.providerFingerprint,
      modelFingerprint: snapshot.modelFingerprint,
      resumeOnModelChange: snapshot.resumeOnModelChange,
    },
  ).runnerContext;
  const taskRow = _taskRowById(input.db, input.taskId);

  input.timeline.append({
    taskId: input.taskId,
    type: "runner.started",
    summary: `Started ${input.runnerType} runner.`,
    data: {
      ...input.runMetadata,
      reason: input.reason,
    },
  });
  await input.onProgress?.();
  _throwIfAborted(input.signal);

  const runner = createAgentRunnerForConfig(
    snapshot,
    getKernel().runtimeAgentTransport,
  );
  const userMessage: UserMessage = {
    id: `task-run-${input.taskRunId}`,
    session_id: runnerContext.id,
    role: "user",
    content: [{ type: "text", text: input.materializedPrompt }],
  };
  let finalText = "";
  const taskContext = taskRow?.context_json;
  const requestedByIdentity = resolveRequestedIdentityForTaskRun({
    reason: input.reason,
    inputSnapshot: input.inputSnapshot,
    taskContext,
  });

  const invocationId = new InvocationStore(input.db).findActive({ runnerKind: "task", taskRunId: input.taskRunId })?.id ?? randomUUID();
  taskInvocations(input.db).set(invocationId, {taskId: input.taskId, taskRunId: input.taskRunId,
    runnerContextId: runnerContext.id, ...(input.signal ? {signal: input.signal} : {})});
  const progressStore=new TaskProgressStore(input.db);
  const progress = new LiveProgress<TaskStatusCardStepEvent>({
    persist: summary => progressStore.text(input.taskRunId,summary) ?? input.timeline.append({taskId:input.taskId,type:"runner.step",summary,
      data:{...input.runMetadata,publicProgress:true,nativeText:summary}}),
    transient: event => {
      const jobId=new InvocationStore(input.db).require(invocationId).activeJobId;
      const job=jobId?new InvocationStore(input.db).job(jobId):undefined;
      return (job?progressStore.tool(job,event.toolCallId!):undefined) ?? {id:event.id,type:"runner.tool",summary:event.toolTitle??event.text,
        data:{...input.runMetadata,toolName:event.toolName,toolCallId:event.toolCallId,nativeCallId:event.toolCallId,
          status:event.toolPhase==="start"?"running":event.text==="工具执行失败"?"failed":"ended",publicProgress:true}};
    },
    entryId: entry => entry.id!,
    send: async entries => {await input.onProgress?.(entries);},
    onError: error => progressLogger.warn({err: error, taskId: input.taskId}, "task progress update failed"),
  });
  try {
  const serviceEnv=buildLunaServiceRunnerEnv({
    runnerKind:"task",agentConfig:snapshot,invocationId,runnerContextId:runnerContext.id,
    sessionId:taskRow?.primary_session_id??undefined,taskId:input.taskId,taskRunId:input.taskRunId,
    artifactIds:runnerArtifactAllowlistFromInput({prompt:input.materializedPrompt,snapshot:input.inputSnapshot}),
    requestedByIdentity,requestedByUserId:canonicalUserIdForRequestedIdentity(input.db,snapshot.agentId,requestedByIdentity),db:input.db,
  });
  if(!new InvocationStore(input.db).require(invocationId).activeJobId){
    const subscriptions=new TaskSubscriptionStore(input.db).listForTask(input.taskId);
    const prepared=await prepareRunnerFiles(runnerContext,_buildTaskRunnerContextFile(input.db,input.taskId,taskRow,subscriptions),input.signal,invocationId);
    runnerContext=new RunnerContextStore(input.db).syncInstructionFingerprint(runnerContext.id,prepared.instructionFingerprint).runnerContext;
  }
  // The artifact allowlist above is derived from the Task prompt alone; memory text must not widen it.
  const actor = new InvocationStore(input.db).require(invocationId).actorUserId;
  // The newest input is what the Run is about; title and summary stand in only when there is none.
  const memory = memoryInjection(input.db, {agentId: runnerContext.agent_id, shadowId: runnerContext.shadow_id, actorUserId: actor,
    sessionId: taskRow?.primary_session_id ?? null, taskId: input.taskId, runnerContextId: runnerContext.id},
    input.pendingText.trim() || [taskRow?.title, taskRow?.summary].filter(Boolean).join("\n"));
  const timezone = new PlatformSettingsStore(input.db).get().general.timezone;
  const turnMessage: UserMessage = {...userMessage, content: [{type: "text", text: joinBlocks([
    input.materializedPrompt, dataBlock("memory", {text: memory.text ?? ""}), dataBlock("now", {json: turnClock(new Date(), timezone)}),
  ])}]};
  for await (const event of runner.stream(turnMessage, {
    cwd: runnerContext.runner_root_path,
    isNewSession: runnerContext.runner_session_id === null,
    runnerContextId: runnerContext.id,
    invalidateRunnerSession: () =>
      _clearRunnerSessionId(input.db, runnerContext.id),
    env: {
      ...snapshot.env,
      ...serviceEnv,
    },
    taskId: input.taskId,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(runnerContext.runner_session_id !== null
      ? { runnerSessionId: runnerContext.runner_session_id }
      : {}),
  })) {
    _throwIfAborted(input.signal);
    if (event.role === "system" && event.subtype === "init") {
      _persistRunnerSessionId(input.db, runnerContext.id, event.id);
    }
    if (event.role === "tool") {
      for (const block of event.content) progress.toolResult(block.tool_use_id, block.content === "工具执行失败");
    }
    if (event.role !== "assistant") continue;
    const publicText = extractTextContent(event, {includeThinking: false, includeToolUse: false});
    for (const block of event.content) {
      if (block.type === "tool_use") progress.toolStart(block.id, block.name, block.displayTitle);
    }
    const stepSummary = publicText.trim() ? runnerProgressStepFromAssistant({...event, content: [{type: "text", text: publicText}]}) : undefined;
    if (stepSummary?.trim() && stepSummary.trim() !== "LUNA_NOTHING_TO_SEND") progress.summary(stepSummary);
    const text = extractTextContent(event, {
      includeThinking: false,
      includeToolUse: false,
    });
    if (text) {
      finalText = text;
    }
  }

  memory.commit();
  _throwIfAborted(input.signal);
  return requireTaskReportCompletion(input.db, input.taskRunId, finalText);
  } finally {
    await progress.close();
    taskInvocations(input.db).delete(invocationId);
  }
}

/**
 * Builds the Task Runner prompt from the durable Task record instead of assuming
 * every Task follows one domain-specific workflow.
 */
/** The persisted input of one Task Run. The current time and memory are added when it is sent. */
export function buildTaskRunPrompt(input: BuildTaskRunPromptInput): string {
  const context = (items: readonly TaskRunPromptContextItem[] | undefined) => (items ?? []).map((item) => compact({
    role: item.role, source: item.source, reason: item.reason, at: item.occurredAt === undefined ? undefined : zonedIso(new Date(item.occurredAt), input.timezone),
    text: item.text.trim(),
  }));
  const launch = context(input.launchContext), update = context(input.updateContext);
  return joinBlocks([
    dataBlock("task", { json: { type: input.taskType, reason: input.reason, title: input.title, summary: input.summary, facts: input.facts, assumptions: input.assumptions } }),
    launch.length ? dataBlock("launch_context", { json: launch }) : "",
    update.length ? dataBlock("update_context", { json: update }) : "",
    dataBlock("user_input", { text: input.pendingText }),
    promptBlock("report_sections", [
      "Submit a report with these sections through `luna task report --request-id final-report --stdin`, then end with LUNA_NOTHING_TO_SEND:",
      ..._outputRequirements(input.taskType),
    ].join("\n")),
  ]);
}

export function buildTaskRunPromptForRunner(
  input: BuildTaskRunPromptInput,
  _runnerWorkspacePath: string,
): string {
  return buildTaskRunPrompt(input);
}

function _taskRunContextPacks(input: {
  readonly store: ContextPackStore;
  readonly taskId: string;
  readonly reason: string;
  readonly inputSnapshot: unknown;
  readonly isNewSession: boolean;
}): {
  readonly launchPacks: readonly ContextPackRow[];
  readonly updatePacks: readonly ContextPackRow[];
} {
  const packs = input.store.listPacksForOwner("task", input.taskId);
  const snapshotPackIds = _contextPackIdsFromInputSnapshot(input.inputSnapshot);
  const selectedPacks = snapshotPackIds.length > 0
    ? packs.filter((pack) => snapshotPackIds.includes(pack.id))
    : packs;
  const launchPacks = input.isNewSession
    ? selectedPacks.filter((pack) => pack.kind === "task_launch")
    : [];
  if (input.reason !== "restart") {
    return { launchPacks, updatePacks: [] };
  }
  const updatePacks = selectedPacks.filter((pack) => pack.kind === "task_update");
  const latestUpdatePack = updatePacks.at(-1);
  return {
    launchPacks,
    updatePacks: latestUpdatePack === undefined ? [] : [latestUpdatePack],
  };
}

function _contextPackIdsFromInputSnapshot(inputSnapshot: unknown): string[] {
  if (!_isRecord(inputSnapshot) || !Array.isArray(inputSnapshot.contextPackIds)) {
    return [];
  }
  return inputSnapshot.contextPackIds.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function _promptContextItemsForPacks(input: {
  readonly db: DrizzleDB;
  readonly store: ContextPackStore;
  readonly packs: readonly ContextPackRow[];
}): TaskRunPromptContextItem[] {
  return input.packs.flatMap((pack) =>
    input.store
      .listItemsForPack(pack.id)
      .map((item) => ({
        item,
        occurredAt: _contextPackItemOccurredAt(input.db, item),
      }))
      .sort(comparePromptContextItems)
      .flatMap((item) => {
        const text = _contextPackItemText(input.db, item.item);
        if (text.length === 0) {
          return [];
        }
        return [
          {
            packId: pack.id,
            itemId: item.item.id,
            packKind: pack.kind,
            role: item.item.role,
            source: _contextPackItemSource(item.item),
            reason: item.item.reason,
            text,
            occurredAt: item.occurredAt,
          },
        ];
      }),
  );
}

function comparePromptContextItems(
  left: { readonly item: ContextPackItemRow; readonly occurredAt: number },
  right: { readonly item: ContextPackItemRow; readonly occurredAt: number },
): number {
  return (
    left.occurredAt - right.occurredAt ||
    left.item.displayOrder - right.item.displayOrder ||
    left.item.id.localeCompare(right.item.id)
  );
}

function _contextPackItemOccurredAt(
  db: DrizzleDB,
  item: ContextPackItemRow,
): number {
  const messageId =
    item.sourceMessageId ??
    (item.itemKind === "message" ? item.itemId : undefined) ??
    _messageIdForTimelineEntry(db, item.sourceEntryId ?? item.itemId);
  if (messageId === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  return db
    .select({ occurredAt: messages.occurredAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()?.occurredAt ?? Number.MAX_SAFE_INTEGER;
}

function _contextPackItemText(
  db: DrizzleDB,
  item: ContextPackItemRow,
): string {
  const messageId =
    item.sourceMessageId ??
    (item.itemKind === "message" ? item.itemId : undefined) ??
    _messageIdForTimelineEntry(db, item.sourceEntryId ?? item.itemId);
  if (messageId !== undefined) {
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    if (row !== undefined) {
      return _messageRowText(row);
    }
  }

  if (_isRecord(item.metadataJson) && typeof item.metadataJson.text === "string") {
    return item.metadataJson.text;
  }
  return "";
}

function _messageIdForTimelineEntry(
  db: DrizzleDB,
  entryId: string | null | undefined,
): string | undefined {
  if (entryId === null || entryId === undefined) {
    return undefined;
  }
  return db
    .select({ messageId: sessionTimelineEntries.messageId })
    .from(sessionTimelineEntries)
    .where(eq(sessionTimelineEntries.id, entryId))
    .get()?.messageId;
}

function _messageRowText(row: typeof messages.$inferSelect): string {
  if (Array.isArray(row.contentJson)) {
    return renderMessageBlocksForRunner(
      row.contentJson as readonly MessageContentBlock[],
    );
  }
  return "";
}

function _contextPackItemSource(item: ContextPackItemRow): string {
  if (item.sourceMessageId !== null) {
    return `message:${item.sourceMessageId}`;
  }
  if (item.sourceEntryId !== null) {
    return `timeline_entry:${item.sourceEntryId}`;
  }
  return `${item.itemKind}:${item.itemId}`;
}

function _recordTaskRunSeedRecords(input: {
  readonly db: DrizzleDB;
  readonly taskId: string;
  readonly runnerContextId: string;
  readonly launchPacks: readonly ContextPackRow[];
  readonly launchItemsByPackId: ReadonlyMap<string, readonly ContextPackItemRow[]>;
}): void {
  if (input.launchPacks.length === 0) {
    return;
  }
  const store = new ContextPackStore(input.db);
  const existingPackIds = new Set(
    store
      .listSeedRecords("task", input.taskId)
      .filter((record) => record.runnerContextId === input.runnerContextId)
      .map((record) => record.seedContextPackId),
  );
  for (const pack of input.launchPacks) {
    if (existingPackIds.has(pack.id)) {
      continue;
    }
    const items = input.launchItemsByPackId.get(pack.id) ?? [];
    const seedEntryIds = [
      ...new Set(
        items.flatMap((item) =>
          item.sourceEntryId === null ? [] : [item.sourceEntryId],
        ),
      ),
    ];
    const seedContextItemIds = items.map((item) => item.id);
    store.recordSeed({
      runnerContextId: input.runnerContextId,
      ownerType: "task",
      ownerId: input.taskId,
      seedContextPackId: pack.id,
      seedHash: _stableHash({
        seedContextPackId: pack.id,
        seedEntryIds,
        seedContextItemIds,
      }),
      seedEntryIdsJson: seedEntryIds,
      seedContextItemIdsJson: seedContextItemIds,
    });
  }
}

function _stableHash(value: unknown): string {
  const text = _stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function _stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => _stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${_stableStringify(record[key])}`)
    .join(",")}}`;
}

function _outputRequirements(taskType: string): string[] {
  switch (taskType) {
    case "question":
      return [
        "- Direct answer",
        "- Supporting evidence",
        "- Remaining uncertainty",
        "- Suggested next checks",
      ];
    case "task":
      return [
        "- Completed work",
        "- Files or systems touched",
        "- Verification",
        "- Residual risks",
        "- Follow-up needed",
      ];
    default:
      return [
        "- Completed work",
        "- Relevant evidence or context",
        "- Verification or confidence level",
        "- Follow-up needed",
      ];
  }
}

function _pendingText(
  pendingInputs: readonly { readonly text: string }[],
): string {
  return pendingInputs.map((message) => message.text).join("\n");
}

function _stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The new user input of a Task Run. A run started by a Main task command has none beyond its
 * context: the messages it names already reach the run as launch or update context, so the
 * command snapshot (raw inbound payload, sender profile) is never shown to the Runner.
 */
export function taskRunInputText(inputSnapshot: unknown): string {
  if (inputSnapshot !== null && typeof inputSnapshot === "object" && typeof (inputSnapshot as {operation?: unknown}).operation === "string") {
    return "";
  }
  return _inputSnapshotText(inputSnapshot);
}

function _inputSnapshotText(inputSnapshot: unknown): string {
  if (typeof inputSnapshot === "string") {
    return inputSnapshot;
  }
  if (inputSnapshot !== null && typeof inputSnapshot === "object") {
    const snapshot = inputSnapshot as {
      readonly prompt?: unknown;
      readonly pendingText?: unknown;
      readonly pendingInputs?: unknown;
      readonly rawInputSnapshot?: unknown;
    };
    if (typeof snapshot.pendingText === "string") {
      return snapshot.pendingText;
    }
    if (typeof snapshot.prompt === "string") {
      return snapshot.prompt;
    }
    if (snapshot.rawInputSnapshot !== undefined) {
      return _inputSnapshotText(snapshot.rawInputSnapshot);
    }
    if (Array.isArray(snapshot.pendingInputs)) {
      return _pendingText(
        snapshot.pendingInputs.filter(
          (message): message is { readonly text: string } =>
            message !== null &&
            typeof message === "object" &&
            typeof (message as { readonly text?: unknown }).text === "string",
        ),
      );
    }
  }
  return JSON.stringify(inputSnapshot, null, 2) ?? "";
}

function _runMetadata(input: ExecuteTaskRunInput): Record<string, unknown> {
  return {
    taskRunId: input.taskRunId,
    ...(input.runIndex !== undefined ? { runIndex: input.runIndex } : {}),
    runReason: input.reason,
    runnerType: input.runnerType,
    ...(input.sourceMessageId !== undefined
      ? { sourceMessageId: input.sourceMessageId }
      : {}),
  };
}

export function resolveRequestedIdentityForTaskRun(input: {
  readonly reason: string;
  readonly inputSnapshot: unknown;
  readonly taskContext: unknown;
}): RequestedIdentityContext | undefined {
  const snapshotIdentity = _validRequestedIdentityOrThrow(
    input.inputSnapshot,
    "Task Run input snapshot",
  );
  if (snapshotIdentity !== undefined) {
    return snapshotIdentity;
  }

  if (_requiresCurrentRunRequesterIdentity(input)) {
    throw new Error(
      "Task Run restart or task update requires current requester identity in the input snapshot.",
    );
  }

  return _validRequestedIdentityOrThrow(input.taskContext, "Task context");
}

function _requiresCurrentRunRequesterIdentity(input: {
  readonly reason: string;
  readonly inputSnapshot: unknown;
}): boolean {
  if (input.reason === "restart") {
    return true;
  }
  return _snapshotOperation(input.inputSnapshot) === "task.update";
}

function _snapshotOperation(value: unknown): string | undefined {
  return _isRecord(value) && typeof value.operation === "string"
    ? value.operation
    : undefined;
}

function _validRequestedIdentityOrThrow(
  value: unknown,
  label: string,
): RequestedIdentityContext | undefined {
  const identity = requestedIdentityFromTaskContext(value);
  if (identity !== undefined || !_hasRequestedIdentityField(value)) {
    return identity;
  }
  throw new Error(`${label} must contain a valid requestedByIdentity.`);
}

function _hasRequestedIdentityField(value: unknown): boolean {
  return _isRecord(value) && Object.hasOwn(value, "requestedByIdentity");
}

function _latestReportArtifactId(
  artifacts: ArtifactStore,
  taskId: string,
): string | undefined {
  const reportArtifact = artifacts
    .listByTask(taskId)
    .filter((artifact) => artifact.type === "report")
    .at(-1);
  return reportArtifact?.id;
}

export function buildTaskResultForMainRunner(
  db: DrizzleDB,
  taskId: string,
  status: TaskResultForMainRunner["status"],
  options: {
    readonly failureMessage?: string;
    readonly finalReportArtifactId?: string;
    readonly artifactIds?: readonly string[];
    readonly taskRunId?: string;
    readonly runIndex?: number;
  } = {},
): TaskResultForMainRunner {
  const taskRow = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  const artifactList = db
    .select()
    .from(artifactRows)
    .where(eq(artifactRows.task_id, taskId))
    .orderBy(asc(artifactRows.created_at), asc(artifactRows.id))
    .all();
  const explicitCompletedRunReportArtifactId =
    status === "completed" && options.taskRunId !== undefined
      ? _requiredTaskRunFinalReportArtifactId(db, taskId, options.taskRunId)
      : undefined;
  const finalReportArtifactId =
    options.finalReportArtifactId ??
    explicitCompletedRunReportArtifactId ??
    (status === "completed"
      ? _latestCompletedTaskRunFinalReportArtifactId(db, taskId)
      : undefined);
  const scopedArtifactIds =
    options.artifactIds ??
    (finalReportArtifactId !== undefined
      ? [finalReportArtifactId]
      : undefined);
  const reportArtifact = _selectReportArtifact(artifactList, {
    ...(finalReportArtifactId !== undefined
      ? { finalReportArtifactId }
      : {}),
    ...(scopedArtifactIds !== undefined
      ? { artifactIds: scopedArtifactIds }
      : {}),
  });
  const report =
    options.failureMessage ??
    _artifactReportText(reportArtifact) ??
    "Task runner completed without a text report.";
  const runScope =
    options.taskRunId !== undefined
      ? { taskRunId: options.taskRunId, runIndex: options.runIndex }
      : finalReportArtifactId !== undefined
      ? _taskRunScopeForFinalReportArtifact(db, taskId, finalReportArtifactId)
      : undefined;
  if (runScope?.taskRunId === undefined) {
    throw new Error(
      `Task result for Task "${taskId}" requires a Task Run id.`,
    );
  }
  const evidenceSummary = _latestRunnerStepSummaries(db, taskId, {
    taskRunId: runScope.taskRunId,
  });
  return {
    taskId,
    taskRunId: runScope.taskRunId,
    ...(runScope?.runIndex !== undefined ? { runIndex: runScope.runIndex } : {}),
    status,
    title: taskRow?.title ?? taskId,
    summary: taskRow?.summary ?? "",
    evidenceSummary:
      evidenceSummary.length > 0
        ? evidenceSummary
        : options.failureMessage !== undefined
          ? [options.failureMessage]
          : [],
    userVisibleReport: report,
    artifactIds:
      scopedArtifactIds !== undefined
        ? [...scopedArtifactIds]
        : [],
    nextActions: [],
    ...(status === "completed" && taskRow?.block_reason === WAITING_FOR_INPUT
      ? { waitingForInput: true }
      : {}),
  };
}

function _selectReportArtifact(
  artifactList: readonly (typeof artifactRows.$inferSelect)[],
  input: {
    readonly finalReportArtifactId?: string;
    readonly artifactIds?: readonly string[];
  },
): typeof artifactRows.$inferSelect | undefined {
  if (input.finalReportArtifactId !== undefined) {
    return artifactList.find(
      (artifact) => artifact.id === input.finalReportArtifactId,
    );
  }
  if (input.artifactIds !== undefined) {
    const artifactIdSet = new Set(input.artifactIds);
    return artifactList.find(
      (artifact) =>
        artifact.type === "report" && artifactIdSet.has(artifact.id),
    );
  }
  return artifactList.find((artifact) => artifact.type === "report");
}

function _latestCompletedTaskRunFinalReportArtifactId(
  db: DrizzleDB,
  taskId: string,
): string | undefined {
  const rows = db
    .select({ finalReportArtifactId: taskRuns.final_report_artifact_id })
    .from(taskRuns)
    .where(and(eq(taskRuns.task_id, taskId), eq(taskRuns.status, "completed")))
    .orderBy(desc(taskRuns.run_index))
    .all();
  return rows.find((row) => row.finalReportArtifactId !== null)
    ?.finalReportArtifactId ?? undefined;
}

function _requiredTaskRunFinalReportArtifactId(
  db: DrizzleDB,
  taskId: string,
  taskRunId: string,
): string | undefined {
  const row = db
    .select({ finalReportArtifactId: taskRuns.final_report_artifact_id })
    .from(taskRuns)
    .where(and(eq(taskRuns.task_id, taskId), eq(taskRuns.id, taskRunId)))
    .get();
  if (
    row?.finalReportArtifactId === null ||
    row?.finalReportArtifactId === undefined
  ) {
    throw new Error(
      `Task result for completed Task Run "${taskRunId}" requires a final report artifact.`,
    );
  }
  return row.finalReportArtifactId;
}

function _taskRunScopeForFinalReportArtifact(
  db: DrizzleDB,
  taskId: string,
  finalReportArtifactId: string,
): { readonly taskRunId: string; readonly runIndex: number } | undefined {
  const run = db
    .select({ id: taskRuns.id, runIndex: taskRuns.run_index })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.task_id, taskId),
        eq(taskRuns.final_report_artifact_id, finalReportArtifactId),
      ),
    )
    .get();
  return run !== undefined
    ? { taskRunId: run.id, runIndex: run.runIndex }
    : undefined;
}

function _artifactReportText(
  artifact: typeof artifactRows.$inferSelect | undefined,
): string | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  if (typeof artifact.content === "string" && artifact.content.trim()) {
    return artifact.content;
  }
  if (artifact.path !== null && existsSync(artifact.path)) {
    try {
      const content = readFileSync(artifact.path, "utf-8");
      return content.trim() ? content : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function _latestRunnerStepSummaries(
  db: DrizzleDB,
  taskId: string,
  options: { readonly taskRunId?: string } = {},
): string[] {
  return db.select().from(timelineEvents)
    .where(and(eq(timelineEvents.task_id,taskId),inArray(timelineEvents.type,["runner.step","runner.failed","runner.cancelled","runner.report_submitted"]),
      options.taskRunId?runPredicate(options.taskRunId):undefined))
    .orderBy(desc(timelineEvents.created_at),desc(timelineEvents.id)).limit(8).all().reverse().map(event=>event.summary);
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _failureHeadline(message: string): string {
  const [firstLine] = message.split(/\n/u);
  return _shorten(firstLine ?? message, 180);
}

function _shorten(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function _persistRunnerSessionId(
  db: DrizzleDB,
  runnerContextId: string,
  runnerSessionId: string,
): void {
  db.update(runnerContexts)
    .set({
      runner_session_id: runnerSessionId,
      updated_at: Date.now(),
    })
    .where(eq(runnerContexts.id, runnerContextId))
    .run();
}

function _clearRunnerSessionId(
  db: DrizzleDB,
  runnerContextId: string,
): void {
  db.update(runnerContexts)
    .set({
      runner_session_id: null,
      updated_at: Date.now(),
    })
    .where(eq(runnerContexts.id, runnerContextId))
    .run();
}
