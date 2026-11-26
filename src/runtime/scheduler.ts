import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import {ShadowPlacements, type BoundWorkerResolver} from "./shadow-placements";
import { ContextPreparationManager } from "./context-preparation";
import { CONTEXT_RESET_NOTICE, retryableDelivery } from "./delivery";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Assignment, Credentials, EnvironmentHandle, JobSnapshot, isTerminal, JobRequest } from "@luna/runner-protocol";
import { contentHash, ExecutionError, transaction, readPrivateJson, writePrivateJson, type SqlDatabase } from "@luna/execution-store";
import { ExecutionClient, TokenAuthority, type RpcClient } from "@luna/execution-transport";
import { SchedulerStore, type ScheduledJob } from "./scheduler-store";
import { RuntimeEventStore } from "./event-store";
import { WorkerRegistry } from "./worker-registry";
import { ContextRouter } from "./context-router";
import type { RuntimeConfig } from "./config";
import { RuntimeModeController } from "./mode-controller";
import { rewriteLocalhostForContainer } from "@/runners/container-service-url";

interface Binding { submissionAttempts?: number; nextQueryAt?: number; handle: EnvironmentHandle; configured: boolean; submitted?: boolean; credentialsRevision?: number; }
interface PrivateCredential { credentialId: string; token: string; }
interface PreparationReply { handle: unknown; controlCredential: PrivateCredential; }
interface CancelPreparationReply { state: string; handle?: unknown; controlCredential?: PrivateCredential; }

export type AllowedWorkers = (scope: ResourceScope, options?: {includePaused?: boolean}) => readonly string[];

/** Reconciles durable assignments; uncertain execution always stays on its original Worker. */
/** Expected waits before execution; these never count toward the preparation failure deadline. */
const PREPARATION_WAIT_CODES = new Set(["capacity_exhausted", "context_busy", "preparation_cancellation_pending"]);

export class RuntimeScheduler {
  readonly jobs: SchedulerStore;
  readonly events: RuntimeEventStore;
  readonly workers: WorkerRegistry;
  readonly contexts: ContextRouter;
  readonly placements:ShadowPlacements;
  readonly preparation: ContextPreparationManager;
  readonly mode: RuntimeModeController;
  isContextFileBusy: (contextId: string) => boolean = () => false;
  private readonly inflight = new Set<string>();
  private stopping = false;
  constructor(private readonly db: SqlDatabase, readonly config: RuntimeConfig, private readonly grants: TokenAuthority, readonly allowedWorkers?: AllowedWorkers,readonly preparationSettled?:(id:string)=>boolean,boundWorker?: BoundWorkerResolver) {
    this.jobs = new SchedulerStore(db); this.events = new RuntimeEventStore(db);
    this.workers = new WorkerRegistry(db, config.homeWorkerId); this.contexts = new ContextRouter(db, this.workers);
    this.placements=new ShadowPlacements(db,this.workers,boundWorker);
    this.preparation = new ContextPreparationManager(db, this);
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_bindings (job_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_released_jobs (job_id TEXT PRIMARY KEY);`);
    db.exec("UPDATE scheduled_jobs SET pending=0 WHERE job_id IN (SELECT job_id FROM runtime_released_jobs)");
    for (const row of db.prepare("SELECT job_id FROM scheduled_jobs WHERE json_extract(record_json,'$.placementState')='terminal'").all() as { job_id: string }[]) rmSync(this.secretPath("job", row.job_id), { force: true });
    this.mode = new RuntimeModeController(db, config);
  }
  submit(input: unknown): ScheduledJob {
    return transaction(this.db, () => {
      const parsed = parseJobRequest(input);
      if (!this.jobs.find(parsed.jobId) && this.db.prepare("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(parsed.jobId)) throw new ExecutionError(410, "job_deleted");
      const job = this.jobs.submit(parsed);
      if (!this.events.list(job.jobId).length) {
        this.mode.requireAdmission();
        const prepared = this.preparation.cached(job.job.runnerContextId);
        if (prepared?.workerId) { job.contextWorkerId = prepared.workerId; this.jobs.save(job); }
      }
      if (!this.events.list(job.jobId).length) this.events.append(job.jobId, "placement", job);
      return job;
    });
  }
  putCredentials(id: string, input: unknown): void {
    const job = this.jobs.require(id);
    if (job.placementState === "terminal") throw new ExecutionError(409, "job_already_terminal");
    const credentials = Credentials.parse(input);
    if(contentHash(credentials.modelProvider??null)!==contentHash(job.job.input.modelProvider??null))throw new ExecutionError(409,"model_job_binding_conflict");
    const prior = this.credentials(id);
    if (credentials.revision < job.job.credentialsRevision || (prior && (credentials.revision < prior.revision || (credentials.revision === prior.revision && contentHash(credentials) !== contentHash(prior))))) throw new ExecutionError(409, "credentials_revision_conflict");
    writePrivateJson(this.secretPath("job", id), credentials);
  }
  cancel(id: string): ScheduledJob {
    return transaction(this.db, () => {
      const before = this.jobs.require(id); const result = this.jobs.cancel(id);
      if (!before.cancelRequested && before.placementState !== "terminal") this.events.append(id, "placement", result);
      return result;
    });
  }
  /** Cancel a persisted Service submit intent even while admission is drained. */
  cancelIntent(input: unknown): ScheduledJob {
    return transaction(this.db, () => {
      const parsed = parseJobRequest(input);
      if (!this.jobs.find(parsed.jobId) && this.db.prepare("SELECT 1 FROM runtime_released_jobs WHERE job_id=?").get(parsed.jobId)) throw new ExecutionError(410, "job_deleted");
      const job = this.jobs.submit(parsed); // Never dispatches, including during drain.
      return this.cancel(job.jobId);
    });
  }
  async tick(): Promise<void> {
    if (this.stopping) return;
    const jobs = this.jobs.list(true);
    const draining = this.mode.state().draining;
    const actions: Promise<void>[] = [];
    for (const job of jobs) {
      if (this.inflight.has(job.jobId)) continue;
      if (draining && !job.workerId && job.placementState !== "terminal") continue;
      this.inflight.add(job.jobId);
      actions.push(this.reconcile(job.jobId).catch((error: unknown) => {
        transaction(this.db, () => {
          const current = this.jobs.require(job.jobId);
          const code = error instanceof ExecutionError ? error.code : "execution_connection_failed";
          if ((code === "resource_revision_changed" || code === "worker_delivery_failed") && !current.assignment) {
            current.placementState = "terminal"; current.terminalResult = { state: "failed", reason: code };
            this.jobs.save(current); this.events.append(job.jobId, "placement", current); return;
          }
          if (!current.assignment && !current.cancelRequested && !PREPARATION_WAIT_CODES.has(code)) {
            // Nothing has executed yet, so a persistent failure is settled instead of retried silently forever.
            const since = current.preparationFailingSince ?? Date.now();
            if (Date.now() - since >= this.config.preparationFailureTimeoutMs) {
              current.failureReason = code; current.lastError = { code, at: Date.now() };
              this.jobs.save(current);
              const settled = this.jobs.cancel(job.jobId);
              this.events.append(job.jobId, "placement", settled);
              return;
            }
            if (current.preparationFailingSince === undefined) { current.preparationFailingSince = since; this.jobs.save(current); }
          }
          if (current.lastError?.code === code) return;
          current.lastError = { code, at: Date.now() };
          if (current.workerId && current.placementState !== "terminal") current.placementState = "reconnecting";
          this.jobs.save(current);
          // A terminal execution event remains the final SSE event used for settlement.
          if (current.placementState !== "terminal") this.events.append(job.jobId, "placement", current);
        });
      }).finally(() => { this.inflight.delete(job.jobId); }));
    }
    await Promise.all(actions);
    await this.preparation.releaseSettled();
  }
  stop(): void { this.stopping = true; }
  binding(id: string): Binding | null {
    const row = this.db.prepare("SELECT body FROM runtime_bindings WHERE job_id=?").get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Binding : null;
  }
  executor(id: string): RpcClient {
    const binding = this.binding(id); if (!binding) throw new ExecutionError(503, "job_not_placed");
    this.workers.validateExecutor(binding.handle.workerId, binding.handle.executorEndpoint);
    const credential = readPrivateJson(this.secretPath("control", binding.handle.instanceId)) as PrivateCredential;
    if (this.workers.require(binding.handle.workerId).reverse || this.jobs.require(id).job.input.modelProvider) {
      return { call: (method, path, body, signal) => this.workers.client(binding.handle.workerId).call("POST", "/v1/executor", { environmentId: binding.handle.environmentId, method, path, body, token: credential.token }, signal) };
    }
    return new ExecutionClient(binding.handle.executorEndpoint, credential.token);
  }

  private async reconcile(id: string): Promise<void> {
    let current = this.jobs.require(id);
    if (current.placementState === "terminal") { await this.release(current); return; }
    if (!current.workerId) {
      const input = this.preparation.pendingInput(current.job.invocationId);
      const prepared = this.preparation.cached(current.job.runnerContextId);
      const route = input && contentHash(input.scope) === contentHash({agentId:current.job.scope.agentId,shadowId:current.job.scope.shadowId})
        ? this.placements.context(input.scope, current.job.runnerContextId) : undefined;
      if (input?.contextId === current.job.runnerContextId && route && route.generation === current.job.scope.placementGeneration
        && input.scopeKey === current.job.scopeKey && input.projectId === current.job.projectId && input.runnerKind === current.job.runnerKind
        && input.resources.digest === current.job.resourceRevision && contentHash(input.resources) === contentHash(current.job.resources)
        && (!prepared || !this.workers.hasRecentHeartbeat(route.workerId))) {
        await this.preparation.prepare(input);
      }
      current = this.jobs.require(id);
      if (current.placementState === "terminal") return;
      current = transaction(this.db, () => {
        if (this.preparation.isBusy(current.job.runnerContextId)) throw new ExecutionError(503, "context_busy");
        const active = this.db.prepare(`SELECT count(*) AS count FROM scheduled_jobs
          WHERE json_extract(record_json, '$.workerId') IS NOT NULL
            AND json_extract(record_json, '$.placementState') != 'terminal'`).get() as { count: number };
        if (active.count >= this.config.maxConcurrentJobs) throw new ExecutionError(503, "capacity_exhausted");
        const prepared = this.preparation.cached(current.job.runnerContextId);
        const input=this.preparation.input(current.job.runnerContextId);
        if(!prepared || !input)throw new ExecutionError(409,"context_preparation_required");
        if(contentHash(input.modelProvider??null)!==contentHash(current.job.input.modelProvider??null) || (current.job.input.modelProvider && prepared.workerId!==current.job.input.modelProvider.workerId))throw new ExecutionError(409,"model_job_binding_conflict");
        if(input.invocationId!==current.job.invocationId || input.scopeKey!==current.job.scopeKey || input.projectId!==current.job.projectId || input.runnerKind!==current.job.runnerKind)
          throw new ExecutionError(409,"context_preparation_mismatch");
        if(contentHash(current.job.scope)!==contentHash(prepared.scope))throw new ExecutionError(409,"context_preparation_mismatch");
        if(contentHash(current.job.resources)!==contentHash(prepared.resources))throw new ExecutionError(409,"resource_revision_changed");
        if(current.job.resourceRevision!==prepared.resourceRevision)throw new ExecutionError(409,"resource_revision_changed");
        this.placements.require(prepared.scope,prepared.workerId,prepared.scope.placementGeneration,current.job.runnerContextId);
        const route=this.placements.bindContext(prepared.scope,current.job.runnerContextId,current.job.scopeKey,
          this.allowedWorkers?.(prepared.scope)??[],current.job.projectId);
        this.contexts.requireCapacity(route.workerId);
        if (current.contextWorkerId && current.contextWorkerId !== route.workerId) {
          const previous = this.db.prepare("SELECT 1 FROM runtime_previous_preparations WHERE invocation_id=? AND worker_id=?")
            .get(current.job.invocationId, current.contextWorkerId);
          if (!previous) throw new ExecutionError(409, "context_placement_conflict");
          if (!current.originalRequestHash) {
            current.originalRequestHash = current.requestHash;
            current.job.input = { ...current.job.input, prompt: CONTEXT_RESET_NOTICE + current.job.input.prompt };
            delete current.job.input.sessionId;
            current.requestHash = contentHash(current.job);
          }
          current.contextWorkerId = route.workerId;
          this.jobs.save(current);
        }
        const reserved = this.jobs.reserve(id, route.workerId);
        delete reserved.lastError; delete reserved.preparationFailingSince;
        this.jobs.save(reserved);
        this.events.append(id, "placement", reserved);
        return reserved;
      });
    }
    let binding = this.binding(id);
    if (binding?.nextQueryAt && binding.nextQueryAt > Date.now() && !current.cancelRequested) return;
    if (!binding || (current.placementState === "reconnecting" && !binding.submissionAttempts)) {
      const worker = this.workers.client(current.workerId!);
      const request = this.prepareRequest(current);
      let reply: PreparationReply;
      if (current.cancelRequested) {
        const cancelled = await worker.call<CancelPreparationReply>(
          "POST", `/v1/preparations/${request.requestId}/cancel`, undefined, AbortSignal.timeout(35000),
        );
        if (cancelled.state === "cancelled" && !current.assignment && !cancelled.handle) {
          transaction(this.db, () => {
            const job = this.jobs.require(id);
            job.placementState = "terminal";
            job.terminalResult = job.failureReason ? { state: "failed", reason: job.failureReason } : { state: "cancelled", reason: "cancelled_during_preparation" };
            delete job.lastError;
            this.jobs.save(job);
            this.events.append(id, "placement", job);
          });
          return;
        }
        if (cancelled.state !== "cancelling" || !cancelled.handle || !cancelled.controlCredential) {
          throw new ExecutionError(503, "preparation_cancellation_pending");
        }
        reply = { handle: cancelled.handle, controlCredential: cancelled.controlCredential };
      } else {
        reply = await worker.call<PreparationReply>(
          "POST", "/v1/environments/prepare", request, AbortSignal.timeout(35000),
        );
      }
      const handle = EnvironmentHandle.parse(reply.handle);
      if (contentHash(handle.scope)!==contentHash(current.job.scope) || handle.workerId !== current.workerId || handle.occupant.kind !== "job" || handle.occupant.jobId !== id || handle.occupant.assignmentId !== current.assignmentId || contentHash(handle.occupant.scope)!==contentHash(current.job.scope)) throw new ExecutionError(403, "environment_binding_denied");
      this.workers.validateExecutor(current.workerId!, handle.executorEndpoint);
      const assignment: Assignment = { scope:current.job.scope, jobId: id, assignmentId: current.assignmentId!, workerId: current.workerId!, instanceId: handle.instanceId, executionEnvironmentId: handle.environmentId, reservationId: handle.reservationId, contextId: current.job.runnerContextId, scopeKey: current.job.scopeKey, requestHash: current.requestHash };
      this.jobs.bind(id, assignment);
      writePrivateJson(this.secretPath("control", handle.instanceId), reply.controlCredential);
      binding = { handle, configured: false }; this.saveBinding(id, binding);
    }
    current = this.jobs.require(id);
    const client = this.executor(id);
    if (!binding.configured) {
      const ingest = this.ingestCredential(binding.handle.instanceId);
      await client.call("PUT", "/v1/ingest-credentials", { ...ingest, runtimeId: this.config.runtimeId });
      binding.configured = true; this.saveBinding(id, binding);
    }
    if (current.cancelRequested) {
      const snapshot = JobSnapshot.parse(await client.call("POST", `/v1/jobs/${id}/cancel`, { assignment: current.assignment }));
      this.events.observe(id, snapshot);
      return;
    }
    const credentials = this.credentials(id);
    let snapshot;
    if (binding.submitted) {
      try {
        snapshot = JobSnapshot.parse(await client.call("POST", `/v1/jobs/${id}/query`, { assignment: current.assignment }, AbortSignal.timeout(5000)));
        delete binding.nextQueryAt; this.saveBinding(id, binding);
      } catch {
        binding.nextQueryAt = Date.now() + 5000; this.saveBinding(id, binding);
        throw new ExecutionError(503, "execution_state_unknown");
      }
    } else if ((binding.submissionAttempts ?? 0) >= 2) {
      snapshot = await this.deliver(current, binding, client);
    } else {
      if (current.job.retryPolicy) {
        const health = await client.call<{ instanceId: string; capabilities?: string[] }>("GET", "/v1/health");
        if (health.instanceId !== current.assignment!.instanceId || !health.capabilities?.includes("job-retry-v1")) {
          throw new ExecutionError(409, "executor_retry_unsupported");
        }
      }
      await client.call("POST", "/v1/contexts", { scope:current.job.scope,contextId: current.job.runnerContextId });
      snapshot = await this.deliver(current, binding, client);
    }
    this.events.observe(id, snapshot);
    if (isTerminal(snapshot.state)) return;
    // Cancellation could have arrived during provision/submission.
    if (this.jobs.require(id).cancelRequested) { await client.call("POST", `/v1/jobs/${id}/cancel`, { assignment: current.assignment }); return; }
    if (credentials && credentials.expiresAt > Date.now() && credentials.revision !== binding.credentialsRevision) {
      const prepared = this.preparation.cached(current.job.runnerContextId);
      const serviceUrl = prepared?.workerId === current.workerId ? prepared?.env.LUNA_SERVICE_URL : undefined;
      const effectiveCredentials = { ...credentials, env: rewriteLocalhostForContainer({ ...credentials.env, ...(serviceUrl ? { LUNA_SERVICE_URL: serviceUrl } : {}) }) };
      await client.call("PUT", `/v1/jobs/${id}/credentials`, { assignment: current.assignment, credentials: effectiveCredentials });
      binding.credentialsRevision = credentials.revision; this.saveBinding(id, binding);
    }
    const after = this.jobs.require(id);
    if (after.placementState !== "terminal" && after.placementState !== "assigned") {
      transaction(this.db, () => {
        after.placementState = "assigned"; delete after.lastError; this.jobs.save(after); this.events.append(id, "placement", after);
      });
    }
  }
  private async deliver(current: ScheduledJob, binding: Binding, client: RpcClient): Promise<JobSnapshot> {
    const id = current.jobId;
    // Persist before sending: restart cannot reset the retry budget or replay a
    // third submission. Every send uses the original job and assignment IDs.
    while ((binding.submissionAttempts ?? 0) < 2) {
      binding.submissionAttempts = (binding.submissionAttempts ?? 0) + 1;
      this.saveBinding(id, binding);
      try {
        const snapshot = JobSnapshot.parse(await client.call("POST", "/v1/jobs", { job: current.job, assignment: current.assignment }, AbortSignal.timeout(10000)));
        binding.submitted = true; delete binding.nextQueryAt; this.saveBinding(id, binding);
        return snapshot;
      } catch (error) {
        if (!retryableDelivery(error)) {
          binding.submissionAttempts = 2; this.saveBinding(id, binding);
          break;
        }
      }
      try {
        const snapshot = JobSnapshot.parse(await client.call("POST", `/v1/jobs/${id}/query`, { assignment: current.assignment }, AbortSignal.timeout(5000)));
        // Reservation alone is queued with seq=0; it does not prove submission.
        if (snapshot.lastSeq > 0 || isTerminal(snapshot.state)) {
          binding.submitted = true; this.saveBinding(id, binding); return snapshot;
        }
      } catch { /* Retry once with the same id; never reassign an uncertain send. */ }
    }
    binding.nextQueryAt = Date.now() + 5000; this.saveBinding(id, binding);
    let snapshot: JobSnapshot;
    try { snapshot = JobSnapshot.parse(await client.call("POST", `/v1/jobs/${id}/query`, { assignment: current.assignment }, AbortSignal.timeout(5000))); }
    catch { throw new ExecutionError(503, "execution_state_unknown"); }
    if (snapshot.lastSeq > 0 || isTerminal(snapshot.state)) {
      binding.submitted = true; delete binding.nextQueryAt; this.saveBinding(id, binding); return snapshot;
    }
    // Fence delayed submissions with a durable cancellation before declaring
    // delivery failed. A mere negative query is not a barrier to a late POST.
    try { snapshot = JobSnapshot.parse(await client.call("POST", `/v1/jobs/${id}/cancel`, { assignment: current.assignment }, AbortSignal.timeout(5000))); }
    catch { throw new ExecutionError(503, "execution_state_unknown"); }
    if (!isTerminal(snapshot.state)) throw new ExecutionError(503, "execution_state_unknown");
    const job = this.jobs.require(id);
    job.terminalResult = { state: "failed", reason: "worker_delivery_failed" }; this.jobs.save(job);
    return snapshot;
  }
  private async release(job: ScheduledJob): Promise<void> {
    rmSync(this.secretPath("job", job.jobId), { force: true });
    if (job.assignment) {
      const binding = this.binding(job.jobId);
      if (!binding || !job.execution || !isTerminal(job.execution.state)) return;
      await this.workers.client(job.workerId!).call("POST", `/v1/environments/${binding.handle.environmentId}/release`, {
        reservationId: binding.handle.reservationId,
        proof: { kind: "job", assignmentId: job.assignment.assignmentId, terminalSeq: job.execution.lastSeq },
      });
    }
    transaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO runtime_released_jobs VALUES (?)").run(job.jobId);
      this.db.prepare("UPDATE scheduled_jobs SET pending=0 WHERE job_id=?").run(job.jobId);
    });
  }

  async delete(id: string): Promise<void> {
    const job = this.jobs.find(id);
    if (!job) return;
    if (job.placementState !== "terminal" || this.inflight.has(id)) throw new ExecutionError(409, "job_not_released");
    this.inflight.add(id);
    try {
      if (!this.db.prepare("SELECT 1 FROM scheduled_jobs WHERE job_id=? AND pending=0").get(id)) await this.release(job);
      if (!this.db.prepare("SELECT 1 FROM scheduled_jobs WHERE job_id=? AND pending=0").get(id)) throw new ExecutionError(409, "job_not_released");
      transaction(this.db, () => {
        for (const table of ["runtime_events", "execution_streams", "runtime_bindings", "scheduled_jobs"]) this.db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(id);
      });
      rmSync(this.secretPath("job", id), { force: true });
    } finally { this.inflight.delete(id); }
  }

  private prepareRequest(job: ScheduledJob) {
    return { requestId: `prep_${job.assignmentId}`, ...(job.job.resourceRevision ? { resourceRevision: job.job.resourceRevision } : {}), ...(job.job.projectId ? { projectId: job.job.projectId } : {}), occupant: { kind: "job", invocationId:job.job.invocationId,scope:job.job.scope, jobId: job.jobId, assignmentId: job.assignmentId, requestHash: job.requestHash, scopeKey: job.job.scopeKey, contextId: job.job.runnerContextId },
      spec: { protocolVersion:2,scope:job.job.scope,resourceSelection:job.job.resources,...(job.job.rootAccess ? { rootAccess: true } : {}),environmentId: job.job.environmentId, scopeKey: job.job.scopeKey, mode: this.config.mode, imageDigest: this.workers.imageDigest(job.workerId!), callbackRuntimeId: this.config.runtimeId, resources: this.config.resources } };
  }
  private ingestCredential(instanceId: string): PrivateCredential {
    const file = this.secretPath("ingest", instanceId);
    const credential = existsSync(file) ? readPrivateJson(file) as PrivateCredential : { credentialId: `upload_${instanceId}`, token: randomBytes(32).toString("base64url") };
    if (!existsSync(file)) writePrivateJson(file, credential);
    this.grants.register(credential.credentialId, credential.token, { role: "executor", id: instanceId });
    return credential;
  }
  private credentials(id: string): Credentials | null {
    const file = this.secretPath("job", id); return existsSync(file) ? Credentials.parse(readPrivateJson(file)) : null;
  }
  private secretPath(kind: string, id: string): string { return join(this.config.dataRoot, "credentials", `${kind}_${contentHash(id)}.json`); }
  private saveBinding(id: string, binding: Binding): void {
    this.db.prepare("INSERT INTO runtime_bindings VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET body=excluded.body").run(id, JSON.stringify(binding));
  }
}

function parseJobRequest(input:unknown):JobRequest {
 if(!input || typeof input!=="object" || !("version" in input) || input.version!==2)throw new ExecutionError(422,"unsupported_protocol");
 return JobRequest.parse(input);
}
