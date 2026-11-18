import {ShadowPreparationStore} from "./shadow-preparation-store";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FileRequest } from "@luna/runner-protocol";
import { EnvironmentSpec } from "@luna/runner-protocol";
import { contentHash, transaction } from "@luna/execution-store";
import { setTimeout as delay } from "node:timers/promises";
import { Assignment, EnvironmentHandle, PrepareRequest, ReleaseProof, isTerminal, type JobSnapshot } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";
import { ExecutionClient } from "@luna/execution-transport";
import { ScopedResourceStore } from "@luna/host-runtime/scoped-resource-store";
import { validateScopedResources } from "@luna/host-runtime/scoped-runner-resources";
import { EnvironmentStore, environmentKey, type ReservationRecord, type EnvironmentRecord } from "./environment-store";
import { DockerEnvironmentDriver } from "./docker-driver";
import { ProjectMounts } from "./project-mounts";
import { PruneRequest, ScopeReconcile, WorkerOrphans, scopeKey } from "./orphans";
import { HomeUploads, UploadChunk, type UploadResult } from "./home-upload";
import { join } from "node:path";
import type { ResourceScope } from "@luna/host-runtime/scoped-runner-resources";

export interface ReconcileResult { stopped: ResourceScope[]; purged: ResourceScope[]; busy: ResourceScope[]; }
export interface PrunePlan {
  shadows: (ResourceScope & { orphanSince: number | null; containers: string[]; volumes: string[]; directories: string[] })[];
  strays: { containers: string[]; volumes: string[] };
  applied: boolean;
  /** Shadows left in place because work still runs in them. */
  busy: ResourceScope[];
}

interface ExecutorHealth { instanceId: string; bootId: string; activeJobs: number; scope:EnvironmentSpec["scope"]; }
export interface PreparedEnvironment { handle: EnvironmentHandle; controlCredential: { credentialId: string; token: string }; }
export interface ContainerSummary {
  environmentId: string; shadowId: string; mode: EnvironmentSpec["mode"]; state: EnvironmentRecord["state"]; running: boolean;
  activeJobs: number; activeStreams: number; idleSince: number | null; resources: EnvironmentSpec["resources"]; imageDigest: string;
  /** Root as the container runs it: off, on, or requested/refused by this host. */
  root: { requested: boolean; effective: boolean; hostAllowed: boolean; reason?: string };
}

/** Serializes the lifecycle of each persistent Shadow environment. */
export class EnvironmentManager {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly streamCounts = new Map<string, number>();
  private streamCloser?: (environmentId: string, reason: string) => void;
  readonly orphans: WorkerOrphans;
  private uploads?: HomeUploads;
  constructor(readonly store: EnvironmentStore, readonly driver: DockerEnvironmentDriver) { this.orphans = new WorkerOrphans(store.db); }

  setStreamCloser(closer: (environmentId: string, reason: string) => void): void { this.streamCloser = closer; }
  activeStreams(id: string): number { return this.streamCounts.get(id) ?? 0; }
  acquireStream(id: string): void {
    this.streamCounts.set(id, this.activeStreams(id) + 1);
    const env = this.store.find(id);
    if (env && env.idleSince !== null) { env.idleSince = null; this.store.saveEnvironment(env); }
  }
  releaseStream(id: string): void {
    const next = this.activeStreams(id) - 1;
    if (next > 0) { this.streamCounts.set(id, next); return; }
    this.streamCounts.delete(id);
    const env = this.store.find(id);
    if (env && !this.store.active(id).length) { env.idleSince = Date.now(); this.store.saveEnvironment(env); }
  }

  async prepare(input: unknown): Promise<PreparedEnvironment> {
    const request = PrepareRequest.parse(input);
    const id = environmentKey(request.spec);
    return this.lock(id, () => this.prepareLocked(request));
  }

  private async prepareLocked(input: PrepareRequest): Promise<PreparedEnvironment> {
      new ShadowPreparationStore(this.store.db).requireJob(input);
      const id = environmentKey(input.spec);
      await this.resumeReplacement(id);
      const previous = this.store.find(id);
      // Only a Job carries the Shadow's root switch; file maintenance keeps the current container's.
      const request = input.occupant.kind === "job" || !previous ? input : { ...input, spec: withRootAccess(input.spec, previous.spec.rootAccess === true) };
      const rootChanged = previous && (previous.spec.rootAccess === true) !== (request.spec.rootAccess === true);
      const resourcesChanged = previous && contentHash(previous.spec.resourceSelection) !== contentHash(request.spec.resourceSelection);
      const limitsChanged = previous && contentHash(previous.spec.resources) !== contentHash(request.spec.resources);
      // A maintenance request cannot choose a new snapshot. A live Job preparation owns
      // the target version and prevents old-version preparation.
      if (resourcesChanged && request.occupant.kind !== "job") throw new ExecutionError(503, "environment_mount_pending");
      if (previous && (previous.spec.imageDigest !== request.spec.imageDigest || rootChanged)) {
        // A new image is a new system disk, and the root switch is a launch option
        // (no-new-privileges): either way the container is replaced once idle.
        this.store.beginReplacement(id, request.spec);
        await this.resumeReplacement(id);
      } else if (previous && (resourcesChanged || limitsChanged)) {
        // Snapshots switch through the HOME link and limits through `docker update`, so the
        // container and its writable system layer stay. Running Jobs keep their version.
        if (this.store.active(id).length) throw new ExecutionError(503, "environment_mount_pending");
        if (limitsChanged) await this.driver.updateLimits(previous, request.spec.resources);
        this.store.retarget(id, request.spec);
      }
      // A release can race inspection/removal. The durable transition completes,
      // but a released invocation must never obtain a reservation afterward.
      new ShadowPreparationStore(this.store.db).requireJob(request);
      const { environment, reservation } = this.store.prepare(request);
      const context = await this.driver.prepareContext(request.spec.scope,request.occupant.contextId, request.spec.scopeKey, request.projectId, request.cwd);
      const containerId = await this.ensureMounts(environment, context.contextId);
      // Persist creation evidence before any network wait; restart must find the same container.
      environment.containerId = containerId; environment.endpoint = this.driver.endpoint(id);
      this.store.saveEnvironment(environment);
      const health = await this.waitReady(id, environment.instanceId);
      const project = new ProjectMounts(this.store.db, this.driver.config).forContext(context.contextId);
      this.store.markExecutorBound(request.requestId);
      await this.executor(id).call("PUT", `/v1/contexts/${context.contextId}`, { scope:request.spec.scope,cwd: this.driver.contextPath(context.contextId), ...(project ? { project: { projectId: project.projectId } } : {}) });
      if (reservation.occupant.kind === "job") {
        await this.executor(id).call("PUT", `/v1/reservations/${reservation.reservationId}`, this.binding(reservation));
      } else {
        await this.executor(id).call("PUT", `/v1/file-leases/${request.requestId}`, { contextId: context.contextId });
      }
      this.store.ready(request.requestId, { containerId, endpoint: environment.endpoint, bootId: health.bootId });
      const handle = EnvironmentHandle.parse(this.store.handle(request.requestId, this.driver.config.workerId));
      return { handle, controlCredential: { credentialId: `control_${environment.instanceId}`, token: this.driver.deployment(id).controlToken } };
  }

  /** Resume the persisted removal boundary before allowing any new environment admission. */
  private async resumeReplacement(id: string): Promise<void> {
    const previous = this.store.find(id);
    if (!previous?.pendingSpec) return;
    if (this.store.active(id).length || this.activeStreams(id) > 0) throw new ExecutionError(503, "environment_mount_pending");
    const actual = await this.driver.inspect(previous);
    if (actual?.State.Running) {
      const health = await this.executor(id).call<ExecutorHealth>("GET", "/v1/health");
      if (health.instanceId !== previous.instanceId) throw new ExecutionError(409, "executor_identity_conflict");
      if (health.activeJobs) throw new ExecutionError(503, "environment_mount_pending");
    }
    await this.driver.remove(previous);
    this.store.finishReplacement(id);
  }

  /** A mount update may replace only an idle container, never a live execution. */
  private async ensureMounts(environment: EnvironmentRecord, contextId: string): Promise<string> {
    try { return await this.driver.ensure(environment, contextId); }
    catch (error) {
      if (!(error instanceof ExecutionError) || !["project_mount_update_required", "context_mount_update_required", "container_configuration_update_required"].includes(error.code)) throw error;
    }
    // Preparing reservations have not returned a handle and cannot have submitted
    // work. Ready/cancelling reservations retain ownership until terminal proof.
    if (this.store.active(environment.id).some(item => item.state !== "preparing")) throw new ExecutionError(503, "environment_mount_pending");
    const health = await this.executor(environment.id).call<ExecutorHealth>("GET", "/v1/health");
    if (health.instanceId !== environment.instanceId) throw new ExecutionError(409, "executor_identity_conflict");
    if (health.activeJobs) throw new ExecutionError(503, "environment_mount_pending");
    // Same environment lock covers all prepare/release operations. Container name
    // and persistent instance/volumes make a crash between remove and ensure recoverable.
    await this.driver.remove(environment);
    return this.driver.ensure(environment, contextId);
  }

  async cancelPreparation(requestId: string): Promise<{ state: string; handle?: EnvironmentHandle; controlCredential?: PreparedEnvironment["controlCredential"] }> {
    const initial = this.store.reservation(requestId);
    if (!initial) { this.store.cancelUnknownPreparation(requestId); return { state: "cancelled" }; }
    return this.lock(initial.environmentId, async () => {
      const current = this.store.reservation(requestId)!;
      if (current.state === "cancelled" || current.state === "released") return { state: current.state };
      const environment = this.store.require(initial.environmentId);
      const actual = await this.driver.inspect(environment);
      if (actual) {
        environment.containerId = actual.Id; this.store.saveEnvironment(environment);
      }
      const reservation = this.store.cancelPreparation(requestId, !actual);
      if (reservation.state === "cancelling") {
        // Recover the original Executor from its control volume after Docker removal.
        if (!actual?.State.Running) { environment.containerId = await this.driver.ensure(environment); this.store.saveEnvironment(environment); }
        const health = await this.waitReady(environment.id, environment.instanceId);
        environment.endpoint = this.driver.endpoint(environment.id); environment.bootId = health.bootId;
        this.store.saveEnvironment(environment);
        if (reservation.occupant.kind === "job") await this.executor(environment.id).call("PUT", `/v1/reservations/${reservation.reservationId}`, this.binding(reservation));
        return { state: reservation.state, handle: this.store.handle(requestId, this.driver.config.workerId),
          controlCredential: { credentialId: `control_${environment.instanceId}`, token: this.driver.deployment(environment.id).controlToken } };
      }
      return { state: reservation.state };
    });
  }

  async release(id: string, reservationId: string, input: unknown): Promise<void> {
    const proof = ReleaseProof.parse(input);
    await this.lock(id, async () => {
      const reservation = this.store.byReservationId(id, reservationId);
      if (!reservation) throw new ExecutionError(404, "reservation_not_found");
      if (reservation.state === "cancelled") return;
      const environment = this.store.require(id);
      const actual = await this.driver.inspect(environment);
      if (!actual?.State.Running) {
        environment.containerId = await this.driver.ensure(environment);
        environment.state = "ready";
        environment.endpoint = this.driver.endpoint(id);
        environment.bootId = (await this.waitReady(id, environment.instanceId)).bootId;
        this.store.saveEnvironment(environment);
      }
      if (proof.kind !== "job" || reservation.occupant.kind !== "job") throw new ExecutionError(409, "occupant_type_mismatch");
      const binding = this.binding(reservation);
      if (proof.assignmentId !== binding.assignmentId) throw new ExecutionError(403, "release_assignment_denied");
      if (reservation.state === "released") {
        await this.executor(id).call("DELETE", `/v1/jobs/${reservation.occupant.jobId}`);
        return;
      }
      const result = await this.executor(id).call<{ execution: JobSnapshot }>("POST", "/v1/inspect", { assignment: binding });
      if (!isTerminal(result.execution.state) || result.execution.lastSeq !== proof.terminalSeq) throw new ExecutionError(409, "execution_not_terminal");
      this.store.release(reservation.requestId, reservation.reservationId);
      await this.executor(id).call("DELETE", `/v1/jobs/${reservation.occupant.jobId}`);
    });
  }

  /** File work is synchronous in Executor; revoking the memory lease is a completion barrier after a lost response. */
  async files(input: unknown): Promise<unknown> {
    const request = FileRequest.extend({ spec: EnvironmentSpec }).parse(input);
    const id = environmentKey(request.spec);
    return this.lock(id, async () => {
      const requestId = `file_${randomUUID()}`;
      try {
        await this.prepareLocked({ requestId, spec: request.spec, ...(request.projectId ? { projectId: request.projectId } : {}), ...(request.cwd ? { cwd: request.cwd } : {}),
          occupant: { kind: "maintenance", scope:request.spec.scope, operationId: requestId, operationHash: contentHash(request.operation), contextId: request.contextId } });
        return await this.executor(id).call("POST", "/v1/files", { contextId: request.contextId, operation: request.operation, leaseId: requestId });
      } finally {
        const reservation = this.store.reservation(requestId);
        if (reservation) await this.releaseFile(reservation);
      }
    });
  }

  private async releaseFile(reservation: ReservationRecord): Promise<void> {
    const environment = this.store.require(reservation.environmentId);
    const actual = await this.driver.inspect(environment);
    if (actual?.State.Running) await this.executor(environment.id).call("DELETE", `/v1/file-leases/${reservation.requestId}`);
    this.store.db.prepare("DELETE FROM worker_reservations WHERE request_id=?").run(reservation.requestId);
    environment.idleSince = this.store.active(environment.id).length || this.activeStreams(environment.id) > 0 ? null : Date.now();
    this.store.saveEnvironment(environment);
  }

  async reap(): Promise<void> {
    for (const environment of this.store.list()) {
      await this.lock(environment.id, async () => {
        await this.resumeReplacement(environment.id);
        for (const reservation of this.store.active(environment.id)) {
          if (reservation.occupant.kind === "maintenance") await this.releaseFile(reservation);
        }
      });
    }
  }
  /** Dashboard view of one Agent's environments on this Worker. */
  async containers(agentId: string): Promise<ContainerSummary[]> {
    const states = await this.driver.containerStates();
    return this.store.list().filter(environment => environment.spec.scope.agentId === agentId)
      .map(environment => this.summarize(environment, states.get(this.driver.name(environment)) === true));
  }

  /**
   * Create or start a Shadow's container on demand from the Dashboard before its first Job.
   * Publishes the verified snapshot so Jobs arriving later reuse the same environment.
   */
  async provision(raw: unknown): Promise<ContainerSummary> {
    const { bundle, spec } = z.object({ bundle: z.unknown(), spec: EnvironmentSpec }).strict().parse(raw);
    const verified = validateScopedResources(bundle, spec.scope, spec.resourceSelection);
    new ScopedResourceStore(this.driver.config.dataRoot).publish(verified, spec.scope, spec.resourceSelection);
    const id = environmentKey(spec);
    return this.lock(id, async () => {
      await this.resumeReplacement(id);
      let environment = this.store.find(id);
      if (environment) {
        if (environment.pendingSpec || ["draining", "reaping"].includes(environment.state)) throw new ExecutionError(409, "environment_draining");
        const rootChanged = (environment.spec.rootAccess === true) !== (spec.rootAccess === true);
        const resourcesChanged = contentHash(environment.spec.resourceSelection) !== contentHash(spec.resourceSelection);
        const limitsChanged = contentHash(environment.spec.resources) !== contentHash(spec.resources);
        if (environment.spec.imageDigest !== spec.imageDigest || rootChanged) {
          this.store.beginReplacement(id, spec);
          await this.resumeReplacement(id);
          environment = this.store.require(id);
        } else if ((resourcesChanged || limitsChanged) && !this.store.active(id).length) {
          if (limitsChanged) await this.driver.updateLimits(environment, spec.resources);
          this.store.retarget(id, spec);
          environment = this.store.require(id);
        }
      } else {
        environment = transaction(this.store.db, () => {
          for (const other of this.store.list()) {
            if (other.id !== id && other.spec.scope.agentId === spec.scope.agentId && other.spec.scope.shadowId === spec.scope.shadowId
              && (other.state !== "stopped" || this.store.active(other.id).length)) throw new ExecutionError(409, "shadow_environment_occupied");
          }
          const created: EnvironmentRecord = { id, instanceId: randomUUID(), spec, state: "creating", containerId: null, endpoint: null, bootId: null, idleSince: Date.now() };
          this.store.db.prepare("INSERT INTO worker_environments VALUES (?,?)").run(id, JSON.stringify(created));
          return created;
        });
      }
      const actual = await this.driver.inspect(environment);
      if (!actual?.State.Running) {
        environment.containerId = await this.driver.ensure(environment);
        environment.endpoint = this.driver.endpoint(id);
        environment.bootId = (await this.waitReady(id, environment.instanceId)).bootId;
        environment.state = "ready";
        environment.idleSince = this.store.active(id).length || this.activeStreams(id) > 0 ? null : Date.now();
        this.store.saveEnvironment(environment);
      }
      return this.summarize(environment, true);
    });
  }

  /** Start a stopped container for an interactive stream; retiring or replacing environments are refused. */
  async streamTarget(id: string, agentId: string, options?: { root?: boolean }): Promise<{ containerId: string; home: string }> {
    return this.lock(id, async () => {
      let environment = this.store.require(id);
      if (environment.spec.scope.agentId !== agentId) throw new ExecutionError(403, "environment_agent_mismatch");
      if (environment.pendingSpec || ["draining", "reaping"].includes(environment.state)) throw new ExecutionError(409, "environment_draining");
      if (options?.root) {
        // Root terminals face the same host setuid risk as sudo Jobs: enforce the same host check.
        const hostRoot = this.driver.hostRootStatus(environment);
        if (!hostRoot.allowed) throw new ExecutionError(403, hostRoot.reason);
      }
      const actual = await this.driver.inspect(environment);
      if (actual?.State.Running) return { containerId: actual.Id, home: this.driver.home(environment) };
      // The Worker moved to another image while this container was stopped: like a Job would,
      // replace it (a new system disk) instead of refusing the console.
      const { imageDigest, runtimeId } = this.driver.config;
      if (environment.spec.imageDigest !== imageDigest || environment.spec.callbackRuntimeId !== runtimeId) {
        if (this.store.active(id).length) throw new ExecutionError(503, "environment_mount_pending");
        this.store.beginReplacement(id, { ...environment.spec, imageDigest, callbackRuntimeId: runtimeId });
        await this.resumeReplacement(id);
        environment = this.store.require(id);
      }
      environment.containerId = await this.driver.ensure(environment);
      environment.endpoint = this.driver.endpoint(id);
      environment.bootId = (await this.waitReady(id, environment.instanceId)).bootId;
      environment.state = "ready";
      this.store.saveEnvironment(environment);
      return { containerId: environment.containerId, home: this.driver.home(environment) };
    });
  }

  /** Stop the container's on-demand VNC desktop and desktop Chrome so Jobs can reuse the profile. */
  async stopDesktop(id: string, agentId: string): Promise<void> {
    await this.lock(id, async () => {
      const environment = this.store.require(id);
      if (environment.spec.scope.agentId !== agentId) throw new ExecutionError(403, "environment_agent_mismatch");
      await this.driver.stopDesktop(environment);
    });
  }

  /**
   * Reset the system disk: remove the container (its writable layer) while HOME stays.
   * The next Job or console recreates it from the image. Refused while work is running.
   */
  async reset(id: string, agentId: string): Promise<void> {
    if (this.store.require(id).spec.scope.agentId !== agentId) throw new ExecutionError(403, "environment_agent_mismatch");
    this.streamCloser?.(id, "system_disk_reset");
    await this.destroy(id);
  }

  /**
   * Permanently delete a deleted Shadow's data on this Worker: its containers, /data volumes,
   * environment records, HOME and resource directories. Refused while any of its work runs.
   */
  async purgeShadow(scope: { agentId: string; shadowId: string }): Promise<void> {
    const environments = this.store.list().filter(environment =>
      environment.spec.scope.agentId === scope.agentId && environment.spec.scope.shadowId === scope.shadowId);
    for (const environment of environments) {
      this.streamCloser?.(environment.id, "shadow_deleted");
      await this.destroy(environment.id);
      await this.lock(environment.id, async () => {
        await this.driver.removeVolume(environment);
        this.store.forget(environment.id);
      });
    }
    await this.driver.purgeShadowFiles(scope);
  }

  /**
   * Write a piece of a file the owner uploads into this environment's Shadow HOME. The
   * container need not run: HOME is a host directory it mounts at the same path.
   */
  upload(id: string, raw: unknown): UploadResult {
    const chunk = UploadChunk.parse(raw);
    const environment = this.store.require(id);
    if (environment.spec.scope.agentId !== chunk.agentId || environment.spec.scope.shadowId !== chunk.shadowId) throw new ExecutionError(403, "environment_agent_mismatch");
    this.uploads ??= new HomeUploads(join(this.driver.config.dataRoot, ".home-uploads"));
    return this.uploads.write(this.driver.home(environment), chunk);
  }

  /** Every Shadow this Worker holds data for: its environments and its HOME layouts. */
  heldScopes(): ResourceScope[] {
    const scopes = new Map<string, ResourceScope>();
    for (const { spec: { scope } } of this.store.list()) scopes.set(scopeKey(scope), { agentId: scope.agentId, shadowId: scope.shadowId });
    for (const scope of this.driver.layoutScopes()) scopes.set(scopeKey(scope), scope);
    return [...scopes.values()];
  }

  /**
   * Act on Service's answer for the Shadows this Worker reported. A Shadow Service no longer
   * knows loses its containers now; its /data volumes and HOME go once it has stayed unknown
   * for the retention period. A Shadow Service knows again is no longer an orphan. Shadows with
   * running work are left for the next round.
   */
  async reconcileScopes(raw: unknown, now = Date.now()): Promise<ReconcileResult> {
    const { checked, valid, retentionMs } = ScopeReconcile.parse(raw);
    const known = new Set(valid.map(scopeKey));
    const held = new Set(this.heldScopes().map(scopeKey));
    const result: ReconcileResult = { stopped: [], purged: [], busy: [] };
    for (const scope of checked) {
      if (known.has(scopeKey(scope)) || !held.has(scopeKey(scope))) { this.orphans.clear(scope); continue; }
      const since = this.orphans.mark(scope, now);
      try {
        if (now - since >= retentionMs) { await this.purgeShadow(scope); this.orphans.clear(scope); result.purged.push(scope); }
        else { await this.stopShadow(scope); result.stopped.push(scope); }
      } catch (error) {
        if (!(error instanceof ExecutionError) || error.status !== 409) throw error;
        result.busy.push(scope);
      }
    }
    return result;
  }

  /**
   * What `luna worker prune` deletes: Shadows Service declared orphaned (and, with
   * `keepAgents`, every Shadow of another Agent) plus this Worker's containers and volumes
   * that no environment names. Only lists them unless `apply`; applying skips the retention.
   */
  async prune(raw: unknown): Promise<PrunePlan> {
    const { keepAgents, apply } = PruneRequest.parse(raw);
    const orphanSince = new Map(this.orphans.list().map(orphan => [scopeKey(orphan), orphan.since]));
    const environments = this.store.list();
    const shadows = this.heldScopes()
      .filter(scope => orphanSince.has(scopeKey(scope)) || (keepAgents !== undefined && !keepAgents.includes(scope.agentId)))
      .map(scope => {
        const own = environments.filter(environment => scopeKey(environment.spec.scope) === scopeKey(scope));
        return { ...scope, orphanSince: orphanSince.get(scopeKey(scope)) ?? null, containers: own.map(environment => this.driver.name(environment)),
          volumes: own.map(environment => this.driver.volume(environment)), directories: this.driver.shadowDirectories(scope) };
      });
    const strays = await this.driver.strays(environments);
    const plan: PrunePlan = { shadows, strays, applied: apply, busy: [] };
    if (!apply) return plan;
    for (const shadow of shadows) {
      const scope = { agentId: shadow.agentId, shadowId: shadow.shadowId };
      try { await this.purgeShadow(scope); this.orphans.clear(scope); }
      catch (error) {
        if (!(error instanceof ExecutionError) || error.status !== 409) throw error;
        plan.busy.push(scope);
      }
    }
    await this.driver.removeStrays(strays);
    return plan;
  }

  /** Remove a Shadow's containers; its /data volumes, HOME and records stay. */
  private async stopShadow(scope: ResourceScope): Promise<void> {
    for (const environment of this.store.list().filter(item => scopeKey(item.spec.scope) === scopeKey(scope))) {
      if (environment.state === "stopped" && environment.containerId === null && !(await this.driver.inspect(environment))) continue;
      this.streamCloser?.(environment.id, "shadow_orphaned");
      await this.destroy(environment.id);
    }
  }

  async drain(id: string): Promise<void> { await this.lock(id, async () => { this.store.drain(id); }); }
  async destroy(id: string): Promise<void> {
    await this.lock(id, async () => {
      const environment = this.store.require(id);
      if (this.store.active(id).length) throw new ExecutionError(409, "environment_occupied");
      const actual = await this.driver.inspect(environment);
      if (actual?.State.Running) {
        const health = await this.executor(id).call<ExecutorHealth>("GET", "/v1/health");
        if (health.activeJobs) throw new ExecutionError(409, "environment_not_settled");
      }
      this.store.drain(id); await this.driver.remove(environment); this.store.stopped(id);
    });
  }

  private summarize(environment: EnvironmentRecord, running: boolean): ContainerSummary {
    const activeStreams = this.activeStreams(environment.id);
    return {
      environmentId: environment.id, shadowId: environment.spec.scope.shadowId, mode: environment.spec.mode, state: environment.state,
      running, activeJobs: this.store.active(environment.id).filter(item => item.occupant.kind === "job").length,
      activeStreams, idleSince: activeStreams > 0 ? null : environment.idleSince,
      resources: environment.spec.resources, imageDigest: environment.spec.imageDigest,
      root: rootSummary(Boolean(environment.spec.rootAccess), this.driver.hostRootStatus(environment)),
    };
  }
  private binding(reservation: ReservationRecord): Assignment {
    if (reservation.occupant.kind !== "job") throw new ExecutionError(422, "job_reservation_required");
    const environment = this.store.require(reservation.environmentId);
    return { scope:reservation.occupant.scope, jobId: reservation.occupant.jobId, assignmentId: reservation.occupant.assignmentId, requestHash: reservation.occupant.requestHash,
      contextId: reservation.occupant.contextId, scopeKey: reservation.occupant.scopeKey, workerId: this.driver.config.workerId,
      executionEnvironmentId: environment.id, instanceId: environment.instanceId, reservationId: reservation.reservationId };
  }
  private executor(id: string): ExecutionClient { return new ExecutionClient(this.driver.endpoint(id), this.driver.deployment(id).maintenanceToken); }
  private async waitReady(id: string, instanceId: string): Promise<ExecutorHealth> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const health = await this.executor(id).call<ExecutorHealth>("GET", "/v1/health", undefined, AbortSignal.timeout(1000));
        if (health.instanceId !== instanceId) throw new ExecutionError(409, "executor_identity_conflict");
        const spec=this.store.require(id).spec;
        if(contentHash(health.scope)!==contentHash(spec.scope))throw new ExecutionError(409,"executor_scope_mismatch");
        return health;
      } catch (error) { if (error instanceof ExecutionError && [401, 403, 409].includes(error.status)) throw error; }
      await delay(100);
    }
    throw new ExecutionError(503, "executor_not_ready");
  }
  private async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
}

function withRootAccess(spec: EnvironmentSpec, rootAccess: boolean): EnvironmentSpec {
  const { rootAccess: _, ...rest } = spec;
  return rootAccess ? { ...rest, rootAccess: true } : rest;
}

function rootSummary(requested: boolean, host: ReturnType<DockerEnvironmentDriver["hostRootStatus"]>): ContainerSummary["root"] {
  if (host.allowed) return { requested, effective: requested, hostAllowed: true };
  return { requested, effective: false, hostAllowed: false, reason: host.reason };
}
