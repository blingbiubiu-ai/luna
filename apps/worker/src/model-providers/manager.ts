import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { contentHash, ExecutionError, type SqlDatabase } from "@luna/execution-store";
import { Assignment, EventBatch, Id, ModelProviderReference, WorkerModelDescriptor, type WorkerModelRelease, type JobSubmission } from "@luna/runner-protocol";
import type { WorkerModel } from "@luna/plugin-contracts";
import { ModelAccountStore } from "./accounts";
import { installModelRelease } from "./release";
import { ModelProviderProcess } from "./process";
import {WorkerModelLogins} from "./logins";

type Binding = ModelProviderReference;
interface Grant { agentId: string; reference: Binding; model: string; contextId: string; expiresAt: number;
  assignment?: Assignment; testId?: string }
export interface ModelProviderManagerOptions {
  db: SqlDatabase; dataRoot: string; workerId: string;
  ready?: () => boolean; active?: (assignment: Assignment) => boolean;
  test?: (model: string, env: Record<string, string>, driver: "stdio" | "pty") => Promise<{ success: boolean; message: string }>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const importSchema = z.object({ agentId: Id, pluginId: Id, providerId: Id, releaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: Id, expectedRevision: Id.nullable(), credential: z.unknown() }).strict();

export class WorkerModelProviderManager {
  readonly accounts: ModelAccountStore;
  readonly logins:WorkerModelLogins;
  private processes = new Map<string, ModelProviderProcess>();
  private busy = new Set<string>();
  private tests = new Set<string>();
  private activeRequests = new Map<string, Set<AbortController>>();
  private server?: ReturnType<typeof Bun.serve>;
  private stopping = false;
  constructor(readonly options: ModelProviderManagerOptions) {
    this.accounts = new ModelAccountStore(options.db, options.dataRoot, options.workerId);
    this.logins=new WorkerModelLogins((input,path,body)=>this.process(input.agentId,input.pluginId,input.providerId,input.releaseSha256).call(path,body,AbortSignal.timeout(30000)),(input,credential)=>this.importAccount({agentId:input.agentId,pluginId:input.pluginId,providerId:input.providerId,releaseSha256:input.releaseSha256,requestId:input.flowId,expectedRevision:input.expectedRevision,credential}));
    options.db.exec("CREATE TABLE IF NOT EXISTS worker_model_releases(id TEXT PRIMARY KEY,body TEXT NOT NULL)");
    options.db.exec("CREATE TABLE IF NOT EXISTS worker_model_jobs(id TEXT PRIMARY KEY,assignment TEXT NOT NULL,reference TEXT NOT NULL,model TEXT NOT NULL)");
  }
  get port(): number { if (!this.server?.port) throw new ExecutionError(503, "model_listener_unavailable"); return this.server.port; }
  start(port = 0, hostname = "127.0.0.1"): void {
    this.server = Bun.serve({ hostname, port, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024,
      fetch: request => this.fetch(request) });
  }
  install(raw: unknown): { installed: true } {
    const { release } = installModelRelease(this.options.dataRoot, raw);
    this.options.db.prepare("INSERT INTO worker_model_releases VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .run(this.releaseKey(release.pluginId, release.providerId, release.releaseSha256), JSON.stringify(release));
    return { installed: true };
  }
  private releaseKey(pluginId: string, providerId: string, digest: string): string { return JSON.stringify([pluginId, providerId, digest]); }
  private process(agentId: string, pluginId: string, providerId: string, digest: string): ModelProviderProcess {
    const key = JSON.stringify([agentId, pluginId, providerId, digest]);
    const existing = this.processes.get(key);
    if (existing) return existing;
    const row = this.options.db.prepare("SELECT body FROM worker_model_releases WHERE id=?").get(this.releaseKey(pluginId, providerId, digest)) as { body: string } | undefined;
    if (!row) throw new ExecutionError(409, "model_release_not_installed");
    const { entrypoint } = installModelRelease(this.options.dataRoot, JSON.parse(row.body));
    const child = new ModelProviderProcess(this.options.dataRoot, entrypoint, join(this.options.dataRoot, "agents", agentId, "model-providers", pluginId));
    this.processes.set(key, child);
    return child;
  }
  async importAccount(raw: unknown): Promise<ReturnType<ModelAccountStore["summary"]>> {
    const input = importSchema.parse(raw);
    const repeated = this.accounts.imported(input.requestId, input);
    if (repeated) return repeated;
    if ((this.accounts.current(input.agentId, input.pluginId, input.providerId)?.credentialRevision ?? null) !== input.expectedRevision) {
      throw new ExecutionError(409, "model_account_conflict");
    }
    const response = await this.process(input.agentId, input.pluginId, input.providerId, input.releaseSha256)
      .call("/validate", { credential: input.credential }, AbortSignal.timeout(30000));
    if (!response.ok) throw new ExecutionError(422, "model_credential_rejected");
    const checked = z.object({ credential: z.unknown(), name: z.string().min(1).max(512), expiresAt: z.number().nullable(), models: z.array(WorkerModelDescriptor).min(1).max(1000) }).parse(await response.json());
    if (checked.expiresAt !== null && checked.expiresAt <= Date.now()) throw new ExecutionError(422, "model_credential_expired");
    return this.accounts.put({ ...input, identity: input, ...checked });
  }
  async refresh(agentId: string, reference: Binding): Promise<readonly WorkerModel[]> {
    const credential = this.accounts.credential(agentId, reference);
    const response = await this.process(agentId, reference.pluginId, reference.providerId, reference.releaseSha256)
      .call("/models", { credential }, AbortSignal.timeout(30000));
    if (!response.ok){if(response.status===401)this.accounts.unavailable(reference.credentialRevision);throw new ExecutionError(response.status === 401 ? 401 : 503, "model_catalog_unavailable");}
    const models = z.array(WorkerModelDescriptor).min(1).max(1000).parse(await response.json());
    this.accounts.updateModels(reference.credentialRevision, models);
    return models;
  }
  async test(agentId: string, reference: Binding, model: string, env: Record<string, string>, driver: "stdio" | "pty") {
    if (!this.options.test) throw new ExecutionError(409, "model_profile_test_unavailable");
    return this.validationEnvironment(agentId, reference, model, modelEnv => this.options.test!(model, { ...env, ...modelEnv }, driver));
  }
  check(agentId: string, reference: Binding, model: string): void {
    this.accounts.credential(agentId, reference);
    if (!this.accounts.summary(reference.credentialRevision).models.some(row => row.id === model)) throw new ExecutionError(422, "model_not_available");
  }
  executionEnvironment(agentId: string, reference: Binding, assignment: Assignment, expiresAt: number, model: string): Record<string, string> {
    if (assignment.workerId !== this.options.workerId || assignment.scope.agentId !== agentId || !this.options.active?.(assignment)) {
      throw new ExecutionError(403, "model_execution_scope_invalid");
    }
    return this.grant({ agentId, reference, assignment, model, contextId: assignment.contextId, expiresAt });
  }
  bindJob({ job, assignment }: JobSubmission): void {
    const reference = job.input.modelProvider;
    if (!reference) return;
    if (assignment.requestHash !== contentHash(job) || assignment.workerId !== this.options.workerId || reference.workerId !== assignment.workerId
      || assignment.jobId !== job.jobId || contentHash(assignment.scope) !== contentHash(job.scope)) throw new ExecutionError(403, "model_execution_scope_invalid");
    this.check(job.scope.agentId, reference, job.input.model!);
    const prior = this.options.db.prepare("SELECT assignment,reference,model FROM worker_model_jobs WHERE id=?").get(job.jobId) as { assignment: string; reference: string; model: string } | undefined;
    const record = { assignment: JSON.stringify(assignment), reference: JSON.stringify(reference), model: job.input.model! };
    if (prior && contentHash(prior) !== contentHash(record)) throw new ExecutionError(409, "model_job_binding_conflict");
    this.options.db.prepare("INSERT OR IGNORE INTO worker_model_jobs VALUES (?,?,?,?)").run(job.jobId, record.assignment, record.reference, record.model);
  }
  jobEnvironment(reference: Binding, assignment: Assignment, expiresAt: number): Record<string, string> {
    const row = this.options.db.prepare("SELECT assignment,reference,model FROM worker_model_jobs WHERE id=?").get(assignment.jobId) as { assignment: string; reference: string; model: string } | undefined;
    if (!row || contentHash(JSON.parse(row.assignment)) !== contentHash(assignment) || contentHash(JSON.parse(row.reference)) !== contentHash(reference)) throw new ExecutionError(403, "model_execution_scope_invalid");
    return this.executionEnvironment(assignment.scope.agentId, reference, assignment, expiresAt, row.model);
  }
  async validationEnvironment<T>(agentId: string, reference: Binding, model: string, test: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const testId = randomUUID(); this.tests.add(testId);
    const grant = { agentId, reference, model, testId, contextId: `validation:${testId}`, expiresAt: Date.now() + 60000 };
    try { return await test(this.grant(grant)); }
    finally { this.tests.delete(testId); this.revoke(grant); }
  }
  private grant(grant: Grant): Record<string, string> {
    if (grant.expiresAt <= Date.now()) throw new ExecutionError(401, "model_execution_expired");
    this.check(grant.agentId, grant.reference, grant.model);
    const identity = { ...grant, expiresAt: undefined };
    const key = this.accounts.token(identity);
    const prior = this.options.db.prepare("SELECT record FROM worker_model_grants WHERE hash=?").get(hash(key)) as { record: string } | undefined;
    if (prior) grant.expiresAt = Math.max(grant.expiresAt, (JSON.parse(prior.record) as Grant).expiresAt);
    this.options.db.prepare("INSERT INTO worker_model_grants VALUES (?,?) ON CONFLICT(hash) DO UPDATE SET record=excluded.record").run(hash(key), JSON.stringify(grant));
    return { CODEX_PROVIDER_MODE: "gateway", OPENAI_BASE_URL: `http://host.docker.internal:${this.port}/v1`, OPENAI_API_KEY: key,
      CODEX_WEB_SEARCH_MODE:"disabled" };
  }
  private allowed(grant: Grant): boolean {
    // A live reservation is the execution lease; a long model queue must not expire a running Job.
    return !this.stopping && (this.options.ready?.() ?? true) && (grant.assignment!==undefined || grant.expiresAt > Date.now())
      && (grant.testId ? this.tests.has(grant.testId) : !!grant.assignment && !!this.options.active?.(grant.assignment));
  }
  private authorize(request: Request): Grant {
    const value = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new ExecutionError(401, "model_key_required");
    const row = this.options.db.prepare("SELECT record FROM worker_model_grants WHERE hash=?").get(hash(value)) as { record: string } | undefined;
    if (!row) throw new ExecutionError(401, "model_key_invalid");
    const grant = JSON.parse(row.record) as Grant;
    if (!this.allowed(grant)) throw new ExecutionError(401, "model_execution_inactive");
    this.check(grant.agentId, grant.reference, grant.model);
    return grant;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const grant = this.authorize(request);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: grant.model, object: "model", owned_by: grant.reference.providerId }] });
      }
      if (request.method !== "POST" || path !== "/v1/responses") throw new ExecutionError(404, "model_route_not_found");
      const input = await request.json() as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input) || input.model !== grant.model) throw new ExecutionError(403, "model_not_allowed");
      if (this.busy.has(grant.agentId)) throw new ExecutionError(429, "model_provider_busy");
      this.busy.add(grant.agentId);
      const controller = new AbortController();
      const abort = () => controller.abort(); request.signal.addEventListener("abort", abort, { once: true });
      const identity = hash(this.accounts.token({ ...grant, expiresAt: undefined }));
      const running = this.activeRequests.get(identity) ?? new Set<AbortController>();
      running.add(controller); this.activeRequests.set(identity, running);
      let finished = false;
      const done = () => { if (finished) return; finished = true; this.busy.delete(grant.agentId); running.delete(controller);
        if (!running.size) this.activeRequests.delete(identity); request.signal.removeEventListener("abort", abort); };
      try {
        const response = await this.process(grant.agentId, grant.reference.pluginId, grant.reference.providerId, grant.reference.releaseSha256)
          .call("/respond", { credential: this.accounts.credential(grant.agentId, grant.reference), input,
            sessionId: `${grant.agentId}:${grant.contextId}` }, controller.signal);
        if(response.status===401)this.accounts.unavailable(grant.reference.credentialRevision);
        if (!response.body) { done(); return response; }
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>({
          pull: async output => {
            try {
              if (!this.allowed(grant)) { controller.abort(); throw new Error("execution inactive"); }
              const next = await reader.read();
              if (next.done) { done(); output.close(); } else output.enqueue(next.value);
            } catch { done(); controller.abort(); output.error(new Error("model_stream_interrupted")); }
          }, cancel: async () => { done(); controller.abort(); await reader.cancel().catch(() => {}); },
        });
        const headers = new Headers();
        headers.set("content-type", response.headers.get("content-type") ?? "application/json");
        headers.set("cache-control", "no-store");
        const retry=response.headers.get("retry-after");
        if(retry && retry.length<=128 && (/^\d+$/.test(retry)||Number.isFinite(Date.parse(retry))))headers.set("retry-after",retry);
        return new Response(stream, { status: response.status, headers });
      } catch (error) { done(); throw error; }
    } catch (error) {
      const status = error instanceof ExecutionError ? error.status : 422;
      const code = error instanceof ExecutionError ? error.code : "model_request_invalid";
      return Response.json({ error: { code, message: code, type: status === 401 ? "authentication_error" : "api_error" } }, { status });
    }
  }
  private revoke(grant: Grant): void {
    const identity = hash(this.accounts.token({ ...grant, expiresAt: undefined }));
    for (const controller of this.activeRequests.get(identity) ?? []) controller.abort();
    this.options.db.prepare("DELETE FROM worker_model_grants WHERE hash=?").run(identity);
  }
  revokeJob(jobId: string): void {
    for (const row of this.options.db.prepare("SELECT record FROM worker_model_grants").all() as { record: string }[]) {
      const grant = JSON.parse(row.record) as Grant;
      if (grant.assignment?.jobId === jobId) this.revoke(grant);
    }
  }
  observeEvents(jobId:string,instanceId:string,raw:unknown):void{
    const batch=EventBatch.safeParse(raw);
    const row=this.options.db.prepare("SELECT assignment FROM worker_model_jobs WHERE id=?").get(jobId) as {assignment:string}|undefined;
    if(!batch.success || !row)return;
    const assignment=Assignment.parse(JSON.parse(row.assignment));
    if(assignment.instanceId!==instanceId || batch.data.instanceId!==instanceId || batch.data.assignmentId!==assignment.assignmentId)return;
    if(batch.data.events.some(event=>event.kind==="terminal" && event.data.jobId===jobId && event.data.requestHash===assignment.requestHash && event.data.assignmentId===assignment.assignmentId))this.revokeJob(jobId);
  }
  reconcile():void{
    for(const row of this.options.db.prepare("SELECT record FROM worker_model_grants").all() as {record:string}[]){
      const grant=JSON.parse(row.record) as Grant;
      // Connectivity temporarily gates requests; keep a still-live assignment's key for reconnection.
      const ended=grant.testId ? !this.tests.has(grant.testId)||grant.expiresAt<=Date.now() : !grant.assignment||!this.options.active?.(grant.assignment);
      if(ended)this.revoke(grant);
    }
  }
  disable(agentId: string, pluginId: string): void {
    this.logins.disable(agentId,pluginId);
    this.accounts.setEnabled(agentId, pluginId, false);
    for (const row of this.options.db.prepare("SELECT record FROM worker_model_grants").all() as { record: string }[]) {
      const grant = JSON.parse(row.record) as Grant;
      if (grant.agentId === agentId && grant.reference.pluginId === pluginId) this.revoke(grant);
    }
  }
  async close(): Promise<void> {
    this.stopping = true; this.server?.stop(true);
    for (const requests of this.activeRequests.values()) for (const controller of requests) controller.abort();
    await Promise.all([...this.processes.values()].map(child => child.close())); this.processes.clear();
  }
}
