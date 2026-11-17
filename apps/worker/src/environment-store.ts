import { randomUUID } from "node:crypto";
import { PrepareRequest, occupantId, type EnvironmentHandle, EnvironmentSpec, type Occupant } from "@luna/runner-protocol";
import { contentHash, environmentKey, ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";
export { environmentKey } from "@luna/execution-store";

export interface EnvironmentRecord {
  id: string;
  instanceId: string;
  spec: EnvironmentSpec;
  pendingSpec?: EnvironmentSpec;
  state: "creating" | "ready" | "draining" | "reaping" | "stopped" | "failed";
  containerId: string | null;
  endpoint: string | null;
  bootId: string | null;
  idleSince: number | null;
}
export interface ReservationRecord {
  requestId: string;
  environmentId: string;
  occupant: Occupant;
  reservationId: string;
  requestHash: string;
  state: "preparing" | "ready" | "cancelling" | "cancelled" | "released";
  /** False until the reservation is sent to an Executor; absent on older records (treated as possibly sent). */
  executorBound?: boolean;
}

/** Durable occupancy is independent of HTTP connections and process-local locks. */
export class EnvironmentStore {
  constructor(readonly db: SqlDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS worker_cancelled_preparations (request_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS worker_environments (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_reservations (
        request_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES worker_environments(id),
        occupant_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worker_reservations_active ON worker_reservations(environment_id,json_extract(record_json,'$.state'));
      CREATE INDEX IF NOT EXISTS worker_reservations_id ON worker_reservations(environment_id,json_extract(record_json,'$.reservationId'));`);
  }

  prepare(input: unknown): { environment: EnvironmentRecord; reservation: ReservationRecord } {
    const request = PrepareRequest.parse(input);
    return transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM worker_cancelled_preparations WHERE request_id=?").get(request.requestId)) throw new ExecutionError(409, "preparation_cancelled");
      const hash = contentHash(request);
      const existing = this.reservation(request.requestId);
      if (existing) {
        if (existing.requestHash !== hash) throw new ExecutionError(409, "prepare_conflict");
        if (["cancelled", "cancelling", "released"].includes(existing.state)) throw new ExecutionError(409, "preparation_cancelled");
        return { environment: this.require(existing.environmentId), reservation: existing };
      }
      const occupant = this.db.prepare("SELECT request_id FROM worker_reservations WHERE occupant_id=?").get(occupantId(request.occupant));
      if (occupant) throw new ExecutionError(409, "occupant_already_reserved");
      const key = environmentKey(request.spec);
      // Mode changes cannot attach the same storage to another live execution
      // environment while its prior reservation still owns it.
      for (const other of this.list()) {
        if(other.id!==key && other.spec.scope.agentId===request.spec.scope.agentId && other.spec.scope.shadowId===request.spec.scope.shadowId
          && (other.state!=="stopped" || this.active(other.id).length))throw new ExecutionError(409,"shadow_environment_occupied");
        if (other.id !== key && this.active(other.id).some(item => item.occupant.contextId === request.occupant.contextId)) throw new ExecutionError(409, "context_environment_occupied");
      }
      let environment = this.find(key);
      if (environment) {
        if (["draining", "reaping"].includes(environment.state)) throw new ExecutionError(409, "environment_draining");
        if (contentHash(environmentConfiguration(environment.spec)) !== contentHash(environmentConfiguration(request.spec))) throw new ExecutionError(409, "environment_configuration_conflict");
        environment.idleSince = null;
        if (environment.state === "stopped" || environment.state === "failed") environment.state = "creating";
        this.saveEnvironment(environment);
      } else {
        environment = { id: key, instanceId: randomUUID(), spec: request.spec, state: "creating", containerId: null, endpoint: null, bootId: null, idleSince: null };
        this.db.prepare("INSERT INTO worker_environments VALUES (?,?)").run(key, JSON.stringify(environment));
      }
      const reservation: ReservationRecord = { requestId: request.requestId, environmentId: key, occupant: request.occupant, reservationId: randomUUID(), requestHash: hash, state: "preparing", executorBound: false };
      this.db.prepare("INSERT INTO worker_reservations VALUES (?,?,?,?)").run(reservation.requestId, key, occupantId(request.occupant), JSON.stringify(reservation));
      return { environment, reservation };
    });
  }

  cancelUnknownPreparation(requestId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO worker_cancelled_preparations VALUES (?)").run(requestId);
  }

  reservation(id: string): ReservationRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM worker_reservations WHERE request_id=?").get(id) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ReservationRecord : undefined;
  }
  find(id: string): EnvironmentRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM worker_environments WHERE id=?").get(id) as { record_json: string } | undefined;
    return row ? decodeEnvironment(row.record_json) : undefined;
  }
  require(id: string): EnvironmentRecord {
    const record = this.find(id); if (!record) throw new ExecutionError(404, "environment_not_found"); return record;
  }
  list(): EnvironmentRecord[] {
    return (this.db.prepare("SELECT record_json FROM worker_environments").all() as { record_json: string }[]).map((row) => decodeEnvironment(row.record_json));
  }
  reservations(environmentId: string): ReservationRecord[] {
    return (this.db.prepare("SELECT record_json FROM worker_reservations WHERE environment_id=?").all(environmentId) as { record_json: string }[]).map((row) => JSON.parse(row.record_json) as ReservationRecord);
  }
  byReservationId(environmentId: string, reservationId: string): ReservationRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM worker_reservations WHERE environment_id=? AND json_extract(record_json,'$.reservationId')=?").get(environmentId, reservationId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : undefined;
  }
  active(environmentId: string): ReservationRecord[] {
    return (this.db.prepare("SELECT record_json FROM worker_reservations WHERE environment_id=? AND json_extract(record_json,'$.state') IN ('preparing','ready','cancelling')").all(environmentId) as { record_json: string }[]).map(row => JSON.parse(row.record_json));
  }

  /** The caller serializes Docker creation and cancellation under the same environment lock. */
  cancelPreparation(requestId: string, creationDefinitelyStopped: boolean): ReservationRecord {
    return transaction(this.db, () => {
      const reservation = this.reservation(requestId);
      if (!reservation) throw new ExecutionError(404, "preparation_not_found");
      if (["cancelled", "released"].includes(reservation.state)) return reservation;
      const environment = this.require(reservation.environmentId);
      // An Executor never told about this reservation holds no state to fence, so no container is needed to cancel it.
      reservation.state = reservation.executorBound === false || (creationDefinitelyStopped && environment.containerId === null) ? "cancelled" : "cancelling";
      this.saveReservation(reservation);
      this.updateIdle(environment);
      return reservation;
    });
  }

  /** Persist before the Executor call: after a crash the reservation is conservatively treated as sent. */
  markExecutorBound(requestId: string): void {
    transaction(this.db, () => {
      const reservation = this.reservation(requestId);
      if (!reservation) throw new ExecutionError(404, "preparation_not_found");
      if (reservation.executorBound !== true) { reservation.executorBound = true; this.saveReservation(reservation); }
    });
  }

  ready(requestId: string, details: { containerId: string; endpoint: string; bootId: string }): void {
    transaction(this.db, () => {
      const reservation = this.reservation(requestId);
      if (!reservation) throw new ExecutionError(404, "preparation_not_found");
      const environment = this.require(reservation.environmentId);
      Object.assign(environment, details, { state: "ready" });
      this.saveEnvironment(environment);
      if (reservation.state !== "preparing" && reservation.state !== "ready") throw new ExecutionError(409, "preparation_cancelled");
      reservation.state = "ready";
      this.saveReservation(reservation);
    });
  }

  /** Called only after verifying terminal proof against the Executor. */
  release(requestId: string, reservationId: string): void {
    transaction(this.db, () => {
      const reservation = this.reservation(requestId);
      if (!reservation || reservation.reservationId !== reservationId) throw new ExecutionError(409, "reservation_mismatch");
      if (["released", "cancelled"].includes(reservation.state)) return;
      reservation.state = "released";
      this.saveReservation(reservation);
      this.updateIdle(this.require(reservation.environmentId));
    });
  }

  /** Persist the replacement target before any Docker I/O; occupied environments cannot switch. */
  beginReplacement(id: string, target: EnvironmentSpec): void {
    transaction(this.db, () => {
      const env = this.require(id);
      if (environmentKey(target) !== id) throw new ExecutionError(409, "environment_scope_conflict");
      if (this.active(id).length) throw new ExecutionError(503, "environment_mount_pending");
      if (env.pendingSpec && contentHash(environmentConfiguration(env.pendingSpec)) !== contentHash(environmentConfiguration(target))) throw new ExecutionError(409, "environment_replacement_conflict");
      if (!env.pendingSpec && ["draining", "reaping"].includes(env.state)) throw new ExecutionError(409, "environment_draining");
      env.pendingSpec = target;
      env.state = "draining";
      this.saveEnvironment(env);
    });
  }

  /** Adopt a new snapshot or limits for the same container; only an idle environment may switch. */
  retarget(id: string, target: EnvironmentSpec): void {
    transaction(this.db, () => {
      const env = this.require(id);
      if (environmentKey(target) !== id) throw new ExecutionError(409, "environment_scope_conflict");
      if (env.pendingSpec || ["draining", "reaping"].includes(env.state)) throw new ExecutionError(409, "environment_draining");
      if (this.active(id).length) throw new ExecutionError(503, "environment_mount_pending");
      if (env.spec.imageDigest !== target.imageDigest) throw new ExecutionError(409, "environment_replacement_required");
      env.spec = target;
      this.saveEnvironment(env);
    });
  }

  /** Docker absence has been verified; new admission may now create the target container. */
  finishReplacement(id: string): void {
    transaction(this.db, () => {
      const env = this.require(id);
      if (!env.pendingSpec) throw new ExecutionError(409, "environment_replacement_missing");
      if (this.active(id).length) throw new ExecutionError(503, "environment_mount_pending");
      env.spec = env.pendingSpec;
      delete env.pendingSpec;
      env.state = "stopped";
      env.containerId = null; env.endpoint = null; env.bootId = null;
      this.saveEnvironment(env);
    });
  }

  drain(id: string): void { const env = this.require(id); env.state = "draining"; this.saveEnvironment(env); }

  stopped(id: string): void {
    const env = this.require(id);
    if (this.active(id).length) throw new ExecutionError(409, "environment_occupied");
    env.state = "stopped"; env.containerId = null; env.endpoint = null; env.bootId = null;
    this.saveEnvironment(env);
  }

  /** Remove a stopped environment and its settled reservations (Shadow deletion). */
  forget(id: string): void {
    if (this.active(id).length) throw new ExecutionError(409, "environment_occupied");
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM worker_reservations WHERE environment_id=?").run(id);
      this.db.prepare("DELETE FROM worker_environments WHERE id=?").run(id);
    });
  }

  handle(requestId: string, workerId: string): EnvironmentHandle {
    const reservation = this.reservation(requestId);
    if (!reservation) throw new ExecutionError(404, "preparation_not_found");
    const env = this.require(reservation.environmentId);
    if (!env.endpoint || !env.bootId) throw new ExecutionError(503, "environment_not_ready");
    return { scope:env.spec.scope, workerId, environmentId: env.id, instanceId: env.instanceId, bootId: env.bootId, executorEndpoint: env.endpoint, executorIdentity: env.instanceId, imageDigest: env.spec.imageDigest, reservationId: reservation.reservationId, occupant: reservation.occupant };
  }
  saveEnvironment(record: EnvironmentRecord): void { this.db.prepare("UPDATE worker_environments SET record_json=? WHERE id=?").run(JSON.stringify(record), record.id); }
  private saveReservation(record: ReservationRecord): void { this.db.prepare("UPDATE worker_reservations SET record_json=? WHERE request_id=?").run(JSON.stringify(record), record.requestId); }
  private updateIdle(env: EnvironmentRecord): void { if (!this.active(env.id).length) env.idleSince = Date.now(); this.saveEnvironment(env); }
}

function environmentConfiguration(spec: EnvironmentSpec): unknown {
  return {...spec,scopeKey:"shared-within-shadow"};
}

/**
 * Records written before the memory and persona parts left the resource
 * snapshot still carry their two revisions. They are dropped on read so such an
 * environment can still be listed, reaped and replaced; its old digest never
 * matches a current selection, so it is never reused.
 */
function currentSpec(spec:unknown):EnvironmentSpec {
 const selection=(spec as {resourceSelection?:Record<string,unknown>}|null)?.resourceSelection;
 if(selection && typeof selection==="object"){delete selection.agentMemoryRevision;delete selection.shadowConfigRevision;}
 return EnvironmentSpec.parse(spec);
}
function decodeEnvironment(body:string):EnvironmentRecord {
 const record=JSON.parse(body) as EnvironmentRecord;
 record.spec=currentSpec(record.spec);
 if(record.pendingSpec)record.pendingSpec=currentSpec(record.pendingSpec);
 return record;
}
