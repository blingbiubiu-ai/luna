import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import type {BoundWorkerResolver} from "./shadow-placements";
import { WorkerGateway, type AssignBoundWorker, type WorkerResourceSource } from "./worker-gateway";
import type { Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { environmentKey, ExecutionError, openPlatformExecutionDatabase, readPrivateJson, type SqlDatabase } from "@luna/execution-store";
import { TokenAuthority, closeExecutionServer } from "@luna/execution-transport";
import { Id, Sequence, type Credentials, type JobRequest, type RuntimeEvent } from "@luna/runner-protocol";
import { RuntimeConfig } from "./config";
import type { ExecutionRuntime, PreparedContext, ContextPreparation } from "./execution-runtime";
import { RuntimeFiles } from "./files";
import { RuntimeScheduler, type AllowedWorkers } from "./scheduler";
import { runtimeServer } from "./server";
import { OrphanCleanupStore } from "./orphan-cleanup";

/** Workers that report their Shadows and remove the data of those Service no longer knows. */
export const SCOPE_RECONCILE_CAPABILITY = "scope-reconcile-v1";
export interface WorkerScopeReport {
  workerId: string;
  result?: { stopped: ResourceScope[]; purged: ResourceScope[]; busy: ResourceScope[] };
  error?: string;
}

/** Service owns the scheduler, database and Executor callback/admin listener. */
export class Runtime implements ExecutionRuntime {
  gateway?: WorkerGateway;
  private db: SqlDatabase | undefined;
  private server: Server | undefined;
  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private polling: Promise<void> | undefined;
  private ticking: Promise<void> | undefined;
  private closing?: Promise<void>;
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private orphanCleanupStore?: OrphanCleanupStore;
  private readonly scopeReconciledAt = new Map<string, number>();

  constructor(
    private readonly scheduler: RuntimeScheduler,
    private readonly fileOperations: RuntimeFiles,
    readonly sharedProject: { projectId: string } | undefined = undefined,
  ) {}
  get config(): RuntimeConfig { return this.scheduler.config; }

  static async start(file: string, allowedWorkers?: AllowedWorkers, resourceSource?:WorkerResourceSource,preparationSettled?:(id:string)=>boolean, assignBoundWorker?: AssignBoundWorker,boundWorker?: BoundWorkerResolver): Promise<Runtime> {
    const config = RuntimeConfig.parse(readPrivateJson(file));
    const db = openPlatformExecutionDatabase(join(config.dataRoot, "runtime.sqlite"));
    let runtime: Runtime;
    try {
      const grants = new TokenAuthority(db);
      grants.register("deployment-admin", config.adminToken, { role: "runtime", id: config.runtimeId });
      const scheduler = new RuntimeScheduler(db, config, grants, allowedWorkers,preparationSettled,boundWorker);
      runtime = new Runtime(scheduler, new RuntimeFiles(scheduler), config.sharedProject);
      runtime.db = db;
      runtime.gateway = new WorkerGateway(db, scheduler, resourceSource, assignBoundWorker);
      runtime.server = runtimeServer(grants, scheduler, runtime.gateway);
    } catch (error) { db.close(); throw error; }
    try {
      await new Promise<void>((resolve, reject) => {
        runtime.server!.once("error", reject);
        runtime.server!.listen(config.port, config.listenHost, () => { runtime.server!.removeListener("error", reject); resolve(); });
      });
      await runtime.scheduler.workers.poll();
      runtime.pollTimer = setInterval(() => {
        runtime.polling ??= runtime.scheduler.workers.poll()
          .catch(() => { console.error("Runtime Worker health reconciliation failed"); })
          .finally(() => { runtime.polling = undefined; });
      }, 5000);
      runtime.tickTimer = setInterval(() => {
        runtime.ticking ??= runtime.scheduler.tick()
          .catch(() => { console.error("Runtime Job reconciliation failed"); })
          .finally(() => { runtime.ticking = undefined; });
      }, 200);
      return runtime;
    } catch (error) {
      await runtime.close();
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`Runtime port ${config.port} is already in use. Stop the old standalone Luna Runtime before starting Service.`, { cause: error });
      throw error;
    }
  }

  preparedContext(id: string): PreparedContext | undefined { return this.scheduler.preparation.cached(id); }
  contextWorkerId(scope: ResourceScope, contextId: string): string | null {
    return this.scheduler.placements.context(scope, contextId)?.workerId ?? null;
  }
  prepareContext(input: ContextPreparation, signal?: AbortSignal): Promise<PreparedContext> {
    return this.run(async () => {
      this.scheduler.mode.requireAdmission();
      return this.scheduler.preparation.prepare(input, AbortSignal.any([this.stopped.signal, ...(signal ? [signal] : [])]));
    }, signal);
  }
  get runtimeId(): string { return this.scheduler.config.runtimeId; }
  get environmentId(): string { return this.scheduler.config.environmentId; }
  async verify(): Promise<void> { this.check(); }
  files<T>(input: Parameters<ExecutionRuntime["files"]>[0], signal?: AbortSignal): Promise<T> {
    return this.run(() => this.fileOperations.execute(structuredClone(input)) as Promise<T>, signal);
  }
  submit(job: JobRequest, signal?: AbortSignal) { return this.run(() => this.scheduler.submit(structuredClone(job)), signal); }
  query(id: string, signal?: AbortSignal) {
    return this.run(() => ({ ...this.scheduler.jobs.require(Id.parse(id)), lastSeq: this.scheduler.events.lastSequence(id) }), signal);
  }
  credentials(id: string, credentials: Credentials): Promise<void> { return this.run(() => this.scheduler.putCredentials(Id.parse(id), structuredClone(credentials))); }
  cancel(id: string, signal?: AbortSignal) { return this.run(() => this.scheduler.cancel(Id.parse(id)), signal); }
  cancelIntent(job: JobRequest, signal?: AbortSignal) { return this.run(() => this.scheduler.cancelIntent(structuredClone(job)), signal); }
  /** Called after Service closes Shadow admission and settles its invocations. */
  drainShadow(scope: ResourceScope, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      const placement = this.scheduler.placements.find(scope);
      if (!placement) return;
      if (this.fileOperations.isBusy(scope.shadowId) || this.scheduler.preparation.hasActiveShadow(scope.shadowId) ||
        this.scheduler.jobs.list(true).some(job => job.job.scope.shadowId === scope.shadowId))
        throw new ExecutionError(409, "shadow_execution_pending");
      const id = environmentKey({environmentId: this.config.environmentId, scope: {...scope, placementGeneration: placement.generation}});
      const workerIds = new Set([...this.scheduler.placements.workerIds(scope), ...this.scheduler.preparation.previousWorkers(scope.shadowId)]);
      for (const workerId of workerIds) {
        try {
          await this.scheduler.workers.client(workerId).call("DELETE", `/v1/environments/${id}`, undefined,
            AbortSignal.any([this.stopped.signal, AbortSignal.timeout(4000), ...(signal ? [signal] : [])]));
        } catch (error) {
          if (!(error instanceof ExecutionError) || error.code !== "environment_not_found") throw error;
        }
      }
    }, signal);
  }
  /**
   * Permanently delete a deleted Shadow's data on every Worker that held it, then forget
   * its placement. Called after drainShadow; retried by the caller until it succeeds.
   */
  purgeShadow(scope: ResourceScope, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      if (this.fileOperations.isBusy(scope.shadowId) || this.scheduler.preparation.hasActiveShadow(scope.shadowId) ||
        this.scheduler.jobs.list(true).some(job => job.job.scope.shadowId === scope.shadowId))
        throw new ExecutionError(409, "shadow_execution_pending");
      const workerIds = new Set([...this.scheduler.placements.workerIds(scope), ...this.scheduler.preparation.previousWorkers(scope.shadowId)]);
      for (const workerId of workerIds) {
        await this.scheduler.workers.client(workerId).call("DELETE",
          `/v1/shadows/${encodeURIComponent(scope.agentId)}/${encodeURIComponent(scope.shadowId)}`, undefined,
          AbortSignal.any([this.stopped.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]));
      }
      this.scheduler.preparation.forgetShadow(scope.shadowId);
      this.scheduler.placements.forget(scope);
    }, signal);
  }
  /** Shadows that still have a placement (and possibly Worker data). */
  placedShadows(): ResourceScope[] { return this.scheduler.placements.placed(); }
  /** The platform's setting for Worker data Service no longer knows. */
  orphanCleanup(): OrphanCleanupStore {
    this.check();
    return this.orphanCleanupStore ??= new OrphanCleanupStore(this.db!);
  }
  /**
   * Ask each connected Worker that supports it which Shadows it holds and tell it which of
   * those `live` still names; the Worker removes the others' data. A Worker reconciled
   * within `intervalMs` is skipped, so one that connects later is reconciled on the next call.
   */
  reconcileWorkerScopes(live: (scopes: ResourceScope[]) => ResourceScope[], intervalMs: number, retentionMs: number): Promise<WorkerScopeReport[]> {
    return this.run(async () => {
      const reports: WorkerScopeReport[] = [];
      for (const worker of this.scheduler.workers.list()) {
        if (worker.lastSeen <= Date.now() - 30000 || !worker.health?.capabilities?.includes(SCOPE_RECONCILE_CAPABILITY)) continue;
        if ((this.scopeReconciledAt.get(worker.workerId) ?? 0) > Date.now() - intervalMs) continue;
        this.scopeReconciledAt.set(worker.workerId, Date.now());
        try {
          const client = this.scheduler.workers.client(worker.workerId);
          const { scopes } = await client.call<{ scopes: ResourceScope[] }>("GET", "/v1/scopes", undefined,
            AbortSignal.any([this.stopped.signal, AbortSignal.timeout(30000)]));
          const result = await client.call<NonNullable<WorkerScopeReport["result"]>>("POST", "/v1/scopes/reconcile", { checked: scopes, valid: live(scopes), retentionMs },
            AbortSignal.any([this.stopped.signal, AbortSignal.timeout(600000)]));
          reports.push({ workerId: worker.workerId, result });
        } catch (error) {
          reports.push({ workerId: worker.workerId, error: error instanceof ExecutionError ? error.code : error instanceof Error ? error.message : String(error) });
        }
      }
      return reports;
    });
  }
  delete(id: string, signal?: AbortSignal): Promise<void> { return this.run(() => this.scheduler.delete(Id.parse(id)), signal); }
  async *events(id: string, after: number, detach: AbortSignal): AsyncGenerator<RuntimeEvent> {
    Id.parse(id);
    let cursor = Sequence.parse(after);
    const signal = AbortSignal.any([detach, this.stopped.signal]);
    while (!signal.aborted) {
      this.check();
      const events = this.scheduler.events.list(id, cursor);
      for (const event of events) {
        if (signal.aborted) return;
        if (event.seq !== cursor + 1) throw new ExecutionError(409, "runtime_sequence_mismatch");
        yield structuredClone(event);
        cursor = event.seq;
      }
      if (signal.aborted) return;
      if (this.scheduler.jobs.require(id).placementState === "terminal" && this.scheduler.events.lastSequence(id) === cursor) return;
      if (!events.length) await delay(100, undefined, { signal }).catch(() => {});
    }
  }
  private check(signal?: AbortSignal): void {
    if (this.stopped.signal.aborted) throw new ExecutionError(503, "runtime_stopped");
    signal?.throwIfAborted();
  }
  private run<T>(action: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    // Register before invoking asynchronous work so shutdown cannot close its database.
    const operation = Promise.resolve().then(() => { this.check(signal); return action(); }).then(value => structuredClone(value));
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    clearInterval(this.pollTimer); clearInterval(this.tickTimer);
    this.gateway?.close();
    this.scheduler.stop();
    this.stopped.abort();
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([this.polling, this.ticking]);
    if (this.server?.listening) await closeExecutionServer(this.server);
    this.db?.close();
  }
}

export function runtimeConfigFile(home: string, sandbox: { runtimeConfigFile?: string | undefined }): string {
  return sandbox.runtimeConfigFile ?? join(home, "runtime", "runtime.json");
}
