import type { AgentExecutionSnapshot } from "@/agent-config";
import type { NormalizedInboundMessage } from "@/channels";
import type { SessionRunnerAttemptRow, SessionRunnerAttemptStore } from "@/sessions/session-runner-attempt-store";
import { prepareRunnerFiles } from "./prepare-runner-files";
import type { RunnerContextFile } from "./runner-context-file";
import type { ResolvedRunnerContext, RunnerContextStore } from "./runner-context-store";

/*
 * Steps every session Runner turn (Main and Work) takes around its provider call. What a turn
 * puts in its prompt, and how it answers, stays with each Runner.
 */

/** Follow the Agent's provider and model; a change may drop the context's provider session. */
export function syncAgentCompatibility(
  store: Pick<RunnerContextStore, "syncAgentCompatibility"> | undefined,
  runnerContext: ResolvedRunnerContext,
  snapshot: AgentExecutionSnapshot | undefined,
): ResolvedRunnerContext {
  if (store === undefined || snapshot === undefined) return runnerContext;
  return store.syncAgentCompatibility(runnerContext.id, {
    providerFingerprint: snapshot.providerFingerprint,
    modelFingerprint: snapshot.modelFingerprint,
    resumeOnModelChange: snapshot.resumeOnModelChange,
  }).runnerContext ?? runnerContext;
}

/**
 * Have the Worker prepare the context's directory and instructions, and record their
 * fingerprint. `runnerSessionInvalidated` says the instructions changed under a provider session.
 */
export async function prepareRunnerDirectory(input: {
  readonly store: Pick<RunnerContextStore, "syncInstructionFingerprint"> | undefined;
  readonly runnerContext: ResolvedRunnerContext;
  readonly contextFile: RunnerContextFile;
  readonly invocationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ readonly runnerContext: ResolvedRunnerContext; readonly runnerSessionInvalidated: boolean }> {
  const instructions = await prepareRunnerFiles(input.runnerContext, input.contextFile, input.signal, input.invocationId);
  const synced = input.store?.syncInstructionFingerprint(input.runnerContext.id, instructions.instructionFingerprint);
  return { runnerContext: synced?.runnerContext ?? input.runnerContext, runnerSessionInvalidated: synced?.runnerSessionInvalidated === true };
}

/** The turn's attempt in this context: one still running (a resumed turn) or a new one. */
export function turnAttempt(store: SessionRunnerAttemptStore, input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runnerContext: ResolvedRunnerContext;
  readonly runnerType: string;
  readonly inputPrompt: string;
}): SessionRunnerAttemptRow {
  return store.listForTurn(input.turnId).find(row => row.status === "running" && row.runnerContextId === input.runnerContext.id)
    ?? store.createRunning({
      sessionId: input.sessionId, turnId: input.turnId, runnerContextId: input.runnerContext.id, runnerType: input.runnerType,
      runnerSessionId: input.runnerContext.runner_session_id, attemptKind: "primary", inputPrompt: input.inputPrompt,
    });
}

/** The surface as written into a context file: the sender's raw provider profile stays out. */
export function contextFileSurface(surface: NormalizedInboundMessage["surface"]): NormalizedInboundMessage["surface"] {
  const { rawProfile: _rawProfile, ...rest } = surface as NormalizedInboundMessage["surface"] & { readonly rawProfile?: unknown };
  return rest;
}
