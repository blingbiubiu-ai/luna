import {executionReferenceSchema} from "@/agent-config/execution-reference";
import {resolveInvocationScope, validateInvocationSnapshot} from "./invocation-scope";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { agentProfiles, agentProfileRevisions, runnerInvocations, runnerJobs, invocationResourceSnapshots, runnerResourceSnapshots } from "@/data/schema";
import { RunnerContextStore } from "./runner-context-store";
import { contentHash, ExecutionError } from "@luna/execution-store";
import { Credentials, ExecutorEvent, Id, JobRequest, type RuntimeEvent } from "@luna/runner-protocol";

export type InvocationRecord = typeof runnerInvocations.$inferSelect;
export type RunnerJobRecord = typeof runnerJobs.$inferSelect;
type NewInvocation = Pick<InvocationRecord, "id" | "runnerKind" | "actorUserId" | "runnerContextId" | "sessionId" | "taskId" | "taskRunId" | "originId" | "inputSnapshot" | "contextPackIds"> & Partial<Pick<InvocationRecord,"agentConfig">>;

/** Service ledger owns invocation eligibility and cursor/settlement transactions. */
export class InvocationStore {
  constructor(private readonly db: DrizzleDB) {}

  register(input: NewInvocation): InvocationRecord {
    Id.parse(input.id); Id.parse(input.runnerContextId);
    if (input.inputSnapshot.version !== 1 || !input.actorUserId || !input.originId ||
      (input.runnerKind === "task" ? !input.taskId || !input.taskRunId : !input.sessionId)) throw new ExecutionError(422, "invalid_invocation");
    return this.db.transaction(() => {
      const scope=resolveInvocationScope(this.db,input);
      validateInvocationSnapshot(input, scope);
      if(input.agentConfig) {
        const ref=executionReferenceSchema.parse(input.agentConfig);
        const revision=this.db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id,ref.revisionId)).get();
        const profile=this.db.select().from(agentProfiles).where(eq(agentProfiles.id,ref.profileId)).get();
        if(ref.agentId!==scope.agentId || profile?.agent_id!==scope.agentId || profile.deleted_at!==null || revision?.validation_state!=="validated" || revision?.profile_id!==profile.id ||
          revision.config_fingerprint!==ref.configFingerprint || profile.agent_type!==ref.agentType || revision.model!==ref.model)
          throw new ExecutionError(409,"invocation_config_mismatch");
      }
      const previous = this.find(input.id);
      if (previous) {
        const original = Object.fromEntries(Object.keys(input).map((key) => [key, previous[key as keyof InvocationRecord]]));
        if (contentHash(original) !== contentHash(input)) throw new ExecutionError(409, "invocation_conflict");
        return previous; // Registration never revives revoked or settled authority.
      }
      this.db.insert(runnerInvocations).values({ ...input, ...scope, state: "active", createdAt: Date.now() }).run();
      return this.require(input.id);
    });
  }
  find(id: string): InvocationRecord | undefined { return this.db.select().from(runnerInvocations).where(eq(runnerInvocations.id, id)).get(); }
  /** Only Runtime's persisted preparation intents may use this check. */
  canReleasePreparation(id: string): boolean {
    const invocation = this.find(id);
    // Owner deletion removes invocation rows only after settlement.
    return invocation === undefined || invocation.settledAt !== null;
  }
  require(id: string): InvocationRecord {
    const record = this.find(id); if (!record) throw new ExecutionError(404, "invocation_not_found"); return record;
  }
  active(): InvocationRecord[] { return this.db.select().from(runnerInvocations).where(eq(runnerInvocations.state, "active")).all(); }
  pending(): InvocationRecord[] { return this.db.select().from(runnerInvocations).where(isNull(runnerInvocations.settledAt)).all(); }
  findActive(input: { runnerKind: "main" | "work" | "task"; originId?: string; sessionId?: string; taskRunId?: string }): InvocationRecord | undefined {
    return this.db.select().from(runnerInvocations).where(and(eq(runnerInvocations.state, "active"), eq(runnerInvocations.runnerKind, input.runnerKind),
      ...(input.originId ? [eq(runnerInvocations.originId, input.originId)] : []), ...(input.sessionId ? [eq(runnerInvocations.sessionId, input.sessionId)] : []),
      ...(input.taskRunId ? [eq(runnerInvocations.taskRunId, input.taskRunId)] : []))).get();
  }
  jobsFor(id: string): RunnerJobRecord[] { return this.db.select().from(runnerJobs).where(eq(runnerJobs.invocationId, id)).all(); }
  /** Domain completion may include multiple provider attempts under one invocation. */
  finish(id: string, complete: () => void = () => {}): void {
    this.db.transaction(() => {
      const invocation = this.require(id);
      if (invocation.settledAt !== null) return;
      const jobs = this.jobsFor(id);
      if (jobs.some((job) => !["terminal", "settled"].includes(job.state))) throw new ExecutionError(409, "invocation_jobs_active");
      complete();
      this.db.update(runnerJobs).set({ state: "settled", updatedAt: Date.now() }).where(and(eq(runnerJobs.invocationId, id), eq(runnerJobs.state, "terminal"))).run();
      this.db.update(runnerInvocations).set({ state: invocation.state === "revoked" ? "revoked" : "settled", settledAt: Date.now() })
        .where(eq(runnerInvocations.id, id)).run();
    });
  }
  /** Business state and every provider attempt settle together in Service. */
  finishOrigin(input: { originId: string; sessionId?: string; runnerKind?: "main" | "work" | "task" }, complete: () => void): void {
    this.db.transaction(() => {
      const invocations = this.db.select().from(runnerInvocations).where(and(eq(runnerInvocations.originId, input.originId),
        ...(input.sessionId ? [eq(runnerInvocations.sessionId, input.sessionId)] : []),
        ...(input.runnerKind ? [eq(runnerInvocations.runnerKind, input.runnerKind)] : []))).all();
      for (const invocation of invocations) this.finish(invocation.id);
      complete();
    });
  }
  revoke(id: string, reason: string): void {
    this.require(id);
    this.db.update(runnerInvocations).set({ state: "revoked", revokedAt: Date.now(), revokeReason: reason })
      .where(and(eq(runnerInvocations.id, id), eq(runnerInvocations.state, "active"))).run();
  }
  bindToken(id: string, tokenId: string): void {
    if (this.require(id).state !== "active") throw new ExecutionError(409, "invocation_inactive");
    this.db.update(runnerInvocations).set({ tokenId }).where(eq(runnerInvocations.id, id)).run();
  }

  /** Store the exact request before sending it; retries reuse this Job and hash. */
  createJob(runtimeId: string, input: unknown): RunnerJobRecord {
    Id.parse(runtimeId); const request = JobRequest.parse(input);
    return this.db.transaction(() => {
      const invocation = this.require(request.invocationId);
      if (invocation.runnerKind !== request.runnerKind || invocation.runnerContextId !== request.runnerContextId ||
        invocation.sessionId !== (request.sessionId ?? null) || invocation.taskId !== (request.taskId ?? null) || invocation.taskRunId !== (request.taskRunId ?? null)) throw new ExecutionError(403, "invocation_job_mismatch");
      if(request.scope.agentId!==invocation.agentId || request.scope.shadowId!==invocation.shadowId)
        throw new ExecutionError(403,"invocation_job_scope_mismatch");
      const reference=this.db.select().from(invocationResourceSnapshots).where(eq(invocationResourceSnapshots.invocationId,invocation.id)).get();
      const snapshot=reference && this.db.select().from(runnerResourceSnapshots).where(eq(runnerResourceSnapshots.digest,reference.digest)).get();
      if(!snapshot)throw new ExecutionError(409,"invocation_resources_missing");
      if(snapshot.digest!==request.resourceRevision || contentHash(snapshot.selection)!==contentHash(request.resources))
        throw new ExecutionError(409,"invocation_job_resources_mismatch");
      const prior = this.job(request.jobId);
      if (prior) {
        if (prior.runtimeId !== runtimeId || prior.requestHash !== contentHash(request)) throw new ExecutionError(409, "job_conflict");
        return prior;
      }
      if (invocation.state !== "active") throw new ExecutionError(409, "invocation_inactive");
      if (invocation.activeJobId) {
        const active = this.job(invocation.activeJobId);
        if (!active || !["terminal", "settled"].includes(active.state)) throw new ExecutionError(409, "invocation_job_active");
      }
      const now = Date.now();
      this.db.insert(runnerJobs).values({ id: request.jobId, runtimeId, invocationId: invocation.id, request, requestHash: contentHash(request), state: "pending", createdAt: now, updatedAt: now }).run();
      this.db.update(runnerInvocations).set({ activeJobId: request.jobId }).where(eq(runnerInvocations.id, invocation.id)).run();
      return this.job(request.jobId)!;
    });
  }
  job(id: string): RunnerJobRecord | undefined { return this.db.select().from(runnerJobs).where(eq(runnerJobs.id, id)).get(); }
  /** Persist a monotonic revision before sending secrets; retries of the same body reuse it. */
  credentials(id: string, input: Omit<Credentials, "revision">): Credentials {
    return this.db.transaction(() => {
      const job = this.job(id);
      if (!job || !["pending", "active"].includes(job.state)) throw new ExecutionError(409, "job_not_active");
      if (this.require(job.invocationId).state !== "active") throw new ExecutionError(409, "invocation_inactive");
      const body = Credentials.parse({ ...input, revision: 1 });
      const hash = contentHash({ expiresAt: body.expiresAt, env: body.env });
      const revision = job.credentialsHash === hash ? job.credentialsRevision : Math.max(job.credentialsRevision + 1, job.request.credentialsRevision);
      this.db.update(runnerJobs).set({ credentialsRevision: revision, credentialsHash: hash, updatedAt: Date.now() }).where(eq(runnerJobs.id, id)).run();
      return { ...body, revision };
    });
  }

  /** The synchronous projection callback and cursor commit together in the Service DB. */
  consume(event: RuntimeEvent, project: (event: RuntimeEvent, current: RunnerJobRecord) => void): boolean {
    return this.db.transaction(() => {
      const job = this.job(event.jobId); if (!job) throw new ExecutionError(404, "job_not_found");
      if (event.seq <= job.cursor) return false;
      if (event.seq !== job.cursor + 1 || ["terminal", "settled"].includes(job.state)) throw new ExecutionError(409, "job_event_sequence_conflict");
      const terminal = terminalEvent(event);
      const providerState = { ...(job.providerState ?? {}) };
      if (event.kind === "execution") {
        const execution = ExecutorEvent.parse((event.data as { event: unknown }).event);
        if (execution.kind === "terminal" && execution.data.state === "succeeded" && execution.data.finalText !== undefined) {
          providerState.text = execution.data.finalText;
        }
        if (execution.kind === "state" && execution.data.state === "starting" && (execution.data.retry?.attempt ?? 0) > 1) {
          delete providerState.text; delete providerState.error;
        }
        if (execution.kind === "state" && execution.data.state === "retry_wait"
          && execution.data.retry?.reason === "session_unusable" && job.request.runnerKind === "work") {
          delete providerState.sessionId; delete providerState.checkpoint;
          new RunnerContextStore(this.db).clearRunnerSessionId(job.request.runnerContextId);
        }
        if (execution.kind === "provider") {
          const output = execution.data;
          if (output.status === "init") providerState.sessionId = output.sessionId;
          else if (output.status === "checkpoint") providerState.checkpoint = true;
          else if (output.status === "stream" && output.text) providerState.text = output.text;
          else if (output.status === "success") {
            if (!providerState.text) providerState.text = output.result;
            if (output.newSessionId) providerState.sessionId = output.newSessionId;
          } else if (output.status === "error") providerState.error = output;
        }
      }
      project(event, job);
      this.db.update(runnerJobs).set({ cursor: event.seq, providerState, state: terminal ? "terminal" : "active", lastEvent: event,
        terminalSequence: terminal ? event.seq : null, updatedAt: Date.now() }).where(eq(runnerJobs.id, job.id)).run();
      return true;
    });
  }

  /** Existing Main/Work/Task business settlement runs in this same transaction. */
  settle(id: string, settleBusiness: (job: RunnerJobRecord, invocation: InvocationRecord) => void): number {
    return this.db.transaction(() => {
      const job = this.job(id);
      if (!job || job.terminalSequence === null || !["terminal", "settled"].includes(job.state)) throw new ExecutionError(409, "job_not_terminal");
      if (job.state === "settled") return job.terminalSequence;
      const invocation = this.require(job.invocationId);
      if (invocation.activeJobId !== id) throw new ExecutionError(409, "job_superseded");
      settleBusiness(job, invocation);
      this.db.update(runnerJobs).set({ state: "settled", updatedAt: Date.now() }).where(eq(runnerJobs.id, id)).run();
      this.db.update(runnerInvocations).set({ state: invocation.state === "revoked" ? "revoked" : "settled", settledAt: Date.now() })
        .where(eq(runnerInvocations.id, invocation.id)).run();
      return job.terminalSequence;
    });
  }

}
function terminalEvent(event: RuntimeEvent): boolean {
  if (event.kind === "execution") {
    const data = event.data as { event?: unknown };
    const execution = ExecutorEvent.parse(data.event);
    return execution.kind === "terminal";
  }
  return (event.data as { placementState?: string } | null)?.placementState === "terminal";
}
