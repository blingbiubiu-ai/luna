import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import { AgentSettingsStore } from "@/agents/agent-settings-store";
import {InvocationResources} from "./invocation-resources";
import {AgentError} from "@/agents/agent-store";
import {GatewayError} from "@/server/gateway-error";
import { drainExecutionCleanup } from "./execution-cleanup";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { accessTokens } from "@/data/schema";
import { config, createLogger, extractTextContent, type AgentRunOptions, type AssistantMessage, type SystemMessage, type ToolMessage, type UserMessage } from "@/shared";
import type { ExecutionRuntime } from "@/runtime/execution-runtime";
import { rewriteLocalhostForContainer } from "@/runners/container-service-url";
import { ExecutorEvent, JobRequest, type JobSnapshot, type Credentials } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";
import { InvocationStore } from "./invocation-store";
import { InvocationService } from "./invocation-service";
import {InvocationRecoveryPump} from "./invocation-recovery-pump";
import { renewInvocationCredentials } from "./invocation-credentials";
import { resolveLunaAccessTokenSigningSecret } from "./luna-service-env";
import { RunnerFileStore } from "./runner-file-store";
import { bindRunnerContextsToRuntime, RunnerContextStore } from "./runner-context-store";
import { verifyRuntimeContexts } from "./runtime-context-preflight";
import { RunnerOutputState, _containerProtocolError, _containerProtocolErrorCode, _runnerFailure, type RunnerOutputHooks } from "./runner-output";

import { RuntimeDetachedError } from "./runtime-detach";
export { RuntimeDetachedError } from "./runtime-detach";
/** A Task run may take as long as its Agent allows; Main and Work turns keep the Service-wide limit. */
export function jobTimeoutMs(db: DrizzleDB, invocation: { readonly runnerKind: string; readonly agentId: string }): number {
  return invocation.runnerKind === "task"
    ? new AgentSettingsStore(db).get(invocation.agentId).task.runLimitHours * 3_600_000
    : config.sandbox.containerTimeoutMs;
}

export interface AgentAttemptTransport {
  stream(message: UserMessage, options: AgentRunOptions, runnerType: string, model: string | undefined, hooks: RunnerOutputHooks): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage>;
}

/** Transport-only adapter; existing Main/Work/Task callers still own business completion. */
export class RuntimeAgentTransport implements AgentAttemptTransport {
  readonly client: ExecutionRuntime;
  readonly store: InvocationStore;
  private readonly detached = new AbortController();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanup: Promise<void> | undefined;
  private readonly recovery: InvocationRecoveryPump;
  constructor(private readonly db: DrizzleDB, runtime: ExecutionRuntime) {
    this.client = runtime;
    this.store = new InvocationStore(db);
    this.recovery = new InvocationRecoveryPump(db, runtime, this.detached.signal);
    bindRunnerContextsToRuntime(db, this.client);
  }
  recoverCancellations(): void {
    if (!this.cleanupTimer) {
      const cleanup = () => {
        if (this.detached.signal.aborted) return;
        this.recovery.tick();
        if (this.cleanup) return;
        this.cleanup = drainExecutionCleanup(this.db, this.client, this.detached.signal)
          .catch(error => createLogger("runtime-transport").warn({ error }, "Execution cleanup remains pending"))
          .finally(() => { this.cleanup = undefined; });
      };
      cleanup(); this.cleanupTimer = setInterval(cleanup, 1000);
      this.cleanupTimer.unref();
    }
    this.recovery.tick();
  }
  async detach(): Promise<void> {
    this.detached.abort();
    clearInterval(this.cleanupTimer);
    await Promise.all([this.recovery.wait(), this.cleanup]);
  }
  async *stream(message: UserMessage, options: AgentRunOptions, runnerType: string, model: string | undefined, hooks: RunnerOutputHooks) {
    if (this.detached.signal.aborted) throw new RuntimeDetachedError();
    const invocationId = options.env?.LUNA_INVOCATION_ID;
    if (!invocationId || !options.runnerContextId) throw new Error("Runtime execution requires persisted invocation/context identities");
    this.requireInvocationScope(invocationId);
    const invocation = this.store.require(invocationId);
    if(runnerType === "claude" || runnerType === "codex") {
      const pinned=invocation.agentConfig;
      if(!pinned || pinned.agentId!==invocation.agentId || pinned.agentType!==runnerType || (model!==undefined && model!==pinned.model))
        throw new ExecutionError(409,"invocation_config_mismatch");
      model=pinned.model;
    }
    let job = invocation.activeJobId ? this.store.job(invocation.activeJobId) : undefined;
    if (!job) {
      const scopeKey = options.taskId ? `task:${options.taskId}:${runnerType}` : `session:${options.runnerContextId}`;
      let projectId: string | undefined;
      try {
        options.signal?.throwIfAborted();
        await this.client.verify();
        this.requireInvocationScope(invocationId);
        await verifyRuntimeContexts(this.db, this.client, options.runnerContextId);
        this.requireInvocationScope(invocationId);
        projectId = this.client.sharedProject?.projectId;
        const preparing = AbortSignal.any([this.detached.signal, ...(options.signal ? [options.signal] : [])]);
        preparing.throwIfAborted();
        await new RunnerFileStore(this.client).prepare({ contextId: options.runnerContextId, scopeKey, invocationId, localRoot: options.cwd, ...(projectId ? { projectId } : {}) }, preparing);
      } catch (error) {
        if (this.detached.signal.aborted) throw new RuntimeDetachedError();
        if (options.signal?.aborted) {
          new InvocationService(this.db).revoke(invocationId, "user_cancelled");
          options.signal.throwIfAborted();
        }
        throw error;
      }
      options.signal?.throwIfAborted();
      if (this.detached.signal.aborted) throw new RuntimeDetachedError();
      this.requireInvocationScope(invocationId);
      const prepared=this.client.preparedContext?.(options.runnerContextId);
      const resources=new InvocationResources(this.db,config.paths.home).read(invocationId);
      if(!prepared || prepared.scope.agentId!==invocation.agentId || prepared.scope.shadowId!==invocation.shadowId
        || prepared.resources.digest!==resources.selection.digest)throw new ExecutionError(409,"invocation_preparation_mismatch");
      // Container rootAccess follows the Shadow switch; OS-level privileged requires a trusted requester.
      const root = new ShadowRootAccessStore(this.db).invocationPrivileged(invocation);
      const executionDriver = invocation.agentConfig?.executionDriver;
      const ptyIdleTimeoutMs = executionDriver === "pty"
        ? new AgentSettingsStore(this.db).get(invocation.agentId).pty.idleTimeoutMinutes * 60_000
        : undefined;
      const request = JobRequest.parse({ version: 2, jobId: randomUUID(), invocationId, environmentId: this.client.environmentId,
        ...(root.rootAccess ? { rootAccess: true, ...(root.privileged ? { privileged: true } : {}) } : {}),
        scope:prepared.scope,resources:resources.selection,resourceRevision:resources.selection.digest,
        runnerContextId: options.runnerContextId, scopeKey, runnerKind: invocation.runnerKind,
        ...(projectId ? { projectId } : {}),
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}), ...(invocation.taskId ? { taskId: invocation.taskId } : {}), ...(invocation.taskRunId ? { taskRunId: invocation.taskRunId } : {}),
        input: { runnerType, ...(executionDriver && executionDriver !== "stdio" ? { executionDriver, ...(ptyIdleTimeoutMs !== undefined ? { ptyIdleTimeoutMs } : {}) } : {}), prompt: extractTextContent(message), ...(model ? { model } : {}), ...(options.runnerSessionId ? { sessionId: options.runnerSessionId } : {}) },
        retryPolicy: { maxConsecutiveRetries: config.runner.maxTransientRetries, maxTotalRetries: 10, baseDelayMs: 2000, maxDelayMs: 30000 },
        credentialsRevision: 1, timeoutMs: jobTimeoutMs(this.db, invocation) });
      job = this.store.createJob(this.client.runtimeId, request);
    }
    const id = job.id;
    let cancelError: unknown;
    const cancel = () => {
      if (this.detached.signal.aborted) return; // Kernel aborts local handles after detach during shutdown.
      new InvocationService(this.db).revoke(invocationId, "user_cancelled");
      void this.retry(() => this.client.cancelIntent(job!.request)).catch((error: unknown) => { cancelError = error; });
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const submitted = await this.retry(() => {
        if (!this.canProjectInvocation(invocationId)) return this.client.cancelIntent(job!.request, this.detached.signal);
        return this.client.submit(job!.request, this.detached.signal);
      });
      if (options.signal?.aborted) cancel();
      else if (submitted.placementState !== "terminal" && !["terminal", "settled"].includes(job.state)) {
        const token = invocation.tokenId ? this.db.select().from(accessTokens).where(eq(accessTokens.id, invocation.tokenId)).get() : undefined;
        if (!token) throw new Error("Invocation token record is missing");
        const serviceUrl = this.client.preparedContext?.(options.runnerContextId)?.env.LUNA_SERVICE_URL;
        let initialCredentials = { expiresAt: token.expiresAt, env: { ...options.env, ...(serviceUrl ? { LUNA_SERVICE_URL: serviceUrl } : {}) } };
        // Refresh a nearly expired token before submitting credentials for an attempt.
        if (token.expiresAt <= Date.now() + 60000) {
          const secret = resolveLunaAccessTokenSigningSecret();
          if (!secret) throw new Error("Runner token renewal requires a signing secret");
          initialCredentials = renewInvocationCredentials(this.db, invocationId, initialCredentials.env, secret);
        }
        this.requireInvocationScope(invocationId);
        const credentials = this.store.credentials(id, initialCredentials);
        await this.updateCredentials(id, credentials, invocationId);
      }
      let output = new RunnerOutputState(message.session_id, hooks);
      const prior = this.canProjectInvocation(invocationId) ? job.providerState : undefined;
      if (prior?.sessionId) yield* output.accept("init", { sessionId: prior.sessionId });
      if (prior?.checkpoint) output.accept("checkpoint", {});
      if (prior?.text) yield* output.accept("stream", { text: prior.text });
      let failure: unknown = prior?.error ? _containerProtocolError(prior.error) : undefined;
      let terminal: JobSnapshot | undefined;
      for await (const event of this.client.events(id, job.cursor, this.detached.signal)) {
        this.store.consume(event, () => {});
        if (!this.canProjectInvocation(invocationId) || event.kind !== "execution") continue;
        const execution = ExecutorEvent.parse((event.data as { event: unknown }).event);
        if (execution.kind === "state" && execution.data.state === "starting" && (execution.data.retry?.attempt ?? 0) > 1) {
          output = new RunnerOutputState(message.session_id, hooks); failure = undefined;
        }
        if (execution.kind === "provider") {
          const { status, ...data } = execution.data;
          try { yield* output.accept(status, data); } catch (error) { failure = error; }
        } else if (execution.kind === "terminal") terminal = execution.data;
      }
      if (this.detached.signal.aborted) throw new RuntimeDetachedError();
      if (cancelError) throw cancelError;
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Job cancelled");
      this.requireInvocationScope(invocationId);
      terminal ??= (this.store.job(id)?.lastEvent?.data as { event?: { data?: JobSnapshot } } | undefined)?.event?.data;
      if (terminal?.providerSessionId) yield* output.accept("init", { sessionId: terminal.providerSessionId }, true);
      if (terminal?.state === "succeeded") {
        // Only confirmed terminal text can replace progress after reconnect.
        // Never promote an aggregated transcript or streamed commentary to a reply.
        if (terminal.finalText === undefined) throw new Error("Runtime completed without confirmed final output");
        yield* output.accept("success", { result: terminal.finalText }, true);
      }
      if (!failure && terminal?.state === "failed" && terminal.error?.code === "runner_session_not_found") {
        failure = _containerProtocolError({ error: terminal.error.message, code: terminal.error.code });
      }
      if (failure) {
        const missingSession = failure instanceof Error && (_containerProtocolErrorCode(failure) === "runner_session_not_found" || _runnerFailure(failure)?.kind === "session_unusable");
        if (missingSession && terminal?.state === "failed") {
          const clearSession = () => new RunnerContextStore(this.db).clearRunnerSessionId(options.runnerContextId!);
          if (job.request.runnerKind === "main" && job.request.input.sessionId && terminal.retry?.attempt === 1 && !terminal.providerCheckpoint) {
            // The caller rebuilds Main's business context. Retire this failed invocation
            // first, so its active lookup cannot reattach the same terminal Job forever.
            this.store.finish(invocationId, clearSession);
            options.invalidateRunnerSession?.();
          } else clearSession();
        }
        throw failure;
      }
      if (terminal?.state !== "succeeded") {
        const record = await this.client.query(id);
        const reason = record.terminalResult?.reason ?? record.failureReason;
        const error = new Error(reason ?? terminal?.error?.message ?? `Runtime Job ended as ${terminal?.state ?? "cancelled"}`);
        // The Runtime reason is a stable code; session error replies map it to user-facing text.
        throw reason ? Object.assign(error, { code: reason }) : error;
      }
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  }
  /** Authority can change while prepare/submit/credentials is awaiting a remote response. */
  private requireInvocationScope(id: string): void {
    try { new InvocationService(this.db).requireScope(id); }
    catch (error) {
      if ((error instanceof AgentError || error instanceof GatewayError) && this.store.find(id)?.state === "active") {
        new InvocationService(this.db).revoke(id, error.code);
      }
      throw error;
    }
  }
  private canProjectInvocation(id: string): boolean {
    try { this.requireInvocationScope(id); return true; }
    catch (error) { if (error instanceof AgentError || error instanceof GatewayError) return false; throw error; }
  }

  /** A terminal race leaves settlement to the event stream. */
  private async updateCredentials(jobId: string, credentials: Credentials, invocationId: string, signal?: AbortSignal): Promise<boolean> {
    try { await this.retry(() => {
      this.requireInvocationScope(invocationId);
      return this.client.credentials(jobId, credentials);
    }, signal); return true; }
    catch (error) {
      if (error instanceof ExecutionError && error.status === 409 && error.code === "job_already_terminal") return false;
      throw error;
    }
  }
  private async retry<T>(operation: () => Promise<T>, signal: AbortSignal = this.detached.signal): Promise<T> {
    while (!signal.aborted) {
      try { return await operation(); }
      catch (error) { if (error instanceof AgentError || error instanceof GatewayError || (error instanceof ExecutionError && error.status < 500 && error.status !== 429)) throw error; }
      await delay(1000, undefined, { signal }).catch(() => {});
    }
    throw new RuntimeDetachedError();
  }
}
