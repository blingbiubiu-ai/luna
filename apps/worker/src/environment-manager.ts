import {ShadowPreparationStore} from "./shadow-preparation-store";
import { randomUUID } from "node:crypto";
import { FileRequest } from "@luna/runner-protocol";
import { EnvironmentSpec } from "@luna/runner-protocol";
import { contentHash } from "@luna/execution-store";
import { setTimeout as delay } from "node:timers/promises";
import { Assignment, EnvironmentHandle, PrepareRequest, ReleaseProof, isTerminal, type JobSnapshot } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";
import { ExecutionClient } from "@luna/execution-transport";
import { EnvironmentStore, environmentKey, type ReservationRecord, type EnvironmentRecord } from "./environment-store";
import { DockerEnvironmentDriver } from "./docker-driver";
import { ProjectMounts } from "./project-mounts";

interface ExecutorHealth { instanceId: string; bootId: string; activeJobs: number; scope:EnvironmentSpec["scope"]; }
export interface PreparedEnvironment { handle: EnvironmentHandle; controlCredential: { credentialId: string; token: string }; }
export interface ContainerSummary {
  environmentId: string; shadowId: string; mode: EnvironmentSpec["mode"]; state: EnvironmentRecord["state"]; running: boolean;
  activeJobs: number; idleSince: number | null; resources: EnvironmentSpec["resources"]; imageDigest: string;
  /** Root as the container runs it: off, on, or requested but refused by this host. */
  root: { requested: boolean; effective: boolean; reason?: string };
}

/** Serializes the lifecycle of each persistent Shadow environment. */
export class EnvironmentManager {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(readonly store: EnvironmentStore, readonly driver: DockerEnvironmentDriver) {}

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
    if (this.store.active(id).length) throw new ExecutionError(503, "environment_mount_pending");
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
    environment.idleSince = this.store.active(environment.id).length ? null : Date.now();
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
    return this.store.list().filter(environment => environment.spec.scope.agentId === agentId).map(environment => ({
      environmentId: environment.id, shadowId: environment.spec.scope.shadowId, mode: environment.spec.mode, state: environment.state,
      running: states.get(this.driver.name(environment)) === true,
      activeJobs: this.store.active(environment.id).filter(item => item.occupant.kind === "job").length,
      idleSince: environment.idleSince, resources: environment.spec.resources, imageDigest: environment.spec.imageDigest, root: rootSummary(this.driver.rootStatus(environment)),
    }));
  }

  /** Start a stopped container for an interactive stream; retiring or replacing environments are refused. */
  async streamTarget(id: string, agentId: string): Promise<{ containerId: string; home: string }> {
    return this.lock(id, async () => {
      let environment = this.store.require(id);
      if (environment.spec.scope.agentId !== agentId) throw new ExecutionError(403, "environment_agent_mismatch");
      if (environment.pendingSpec || ["draining", "reaping"].includes(environment.state)) throw new ExecutionError(409, "environment_draining");
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

  /**
   * Reset the system disk: remove the container (its writable layer) while HOME stays.
   * The next Job or console recreates it from the image. Refused while work is running.
   */
  async reset(id: string, agentId: string): Promise<void> {
    if (this.store.require(id).spec.scope.agentId !== agentId) throw new ExecutionError(403, "environment_agent_mismatch");
    await this.destroy(id);
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

function rootSummary(status: ReturnType<DockerEnvironmentDriver["rootStatus"]>): ContainerSummary["root"] {
  if (!status) return { requested: false, effective: false };
  return status.allowed ? { requested: true, effective: true } : { requested: true, effective: false, reason: status.reason };
}
