import { ExecutorRetryStore, type RetryRecord } from "./retry-store";
import { randomUUID } from "node:crypto";
import { Assignment, JobSubmission, ProviderOutput, isTerminal, type ExecutorEvent, type JobSnapshot, type JobState, type JobRequest } from "@luna/runner-protocol";
import { canonicalJson, contentHash, ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";

interface JobRow {
  binding_json: string;
  request_json: string | null;
  snapshot_json: string;
}

/** Owns Executor process facts and events; every state transition appends atomically. */
export class ExecutorStore {
  private liveEvents = new Map<string, ExecutorEvent[]>();
  onTerminal?: (id: string) => void;
  readonly retries: ExecutorRetryStore;
  readonly instanceId: string;
  readonly bootId = randomUUID();
  constructor(readonly db: SqlDatabase, requestedInstanceId: string) {
    this.retries = new ExecutorRetryStore(db);
    this.instanceId = requestedInstanceId;
    if (db.prepare("SELECT 1 FROM executor_jobs WHERE json_extract(binding_json,'$.instanceId')<>? LIMIT 1").get(requestedInstanceId)) throw new ExecutionError(409, "volume_instance_mismatch");
  }

  register(input: unknown): JobSnapshot {
    const binding = Assignment.parse(input);
    if (binding.instanceId !== this.instanceId) throw new ExecutionError(403, "instance_mismatch");
    return transaction(this.db, () => {
      const row = this.row(binding.jobId);
      if (row) {
        if (row.binding_json !== canonicalJson(binding)) throw new ExecutionError(409, "reservation_conflict");
        return JSON.parse(row.snapshot_json) as JobSnapshot;
      }
      const snapshot: JobSnapshot = {
        jobId: binding.jobId, assignmentId: binding.assignmentId, instanceId: this.instanceId,
        bootId: this.bootId, streamId: randomUUID(), requestHash: binding.requestHash,
        state: "queued", lastSeq: 0, createdAt: Date.now(),
      };
      this.db.prepare("INSERT INTO executor_jobs(job_id,binding_json,snapshot_json) VALUES (?,?,?)").run(binding.jobId, canonicalJson(binding), JSON.stringify(snapshot));
      return snapshot;
    });
  }

  submit(input: unknown): JobSnapshot {
    const { job, assignment } = JobSubmission.parse(input);
    return transaction(this.db, () => {
      this.authorize(job.jobId, assignment);
      if (contentHash(job.scope)!==contentHash(assignment.scope) || contentHash(job) !== assignment.requestHash || job.runnerContextId !== assignment.contextId || job.scopeKey !== assignment.scopeKey || job.jobId !== assignment.jobId) throw new ExecutionError(409, "job_binding_mismatch");
      const row = this.requireRow(job.jobId);
      const snapshot = this.snapshot(job.jobId);
      if (row.request_json !== null) {
        if (row.request_json !== canonicalJson(job)) throw new ExecutionError(409, "job_conflict");
        return snapshot;
      }
      if (isTerminal(snapshot.state)) return snapshot;
      this.db.prepare("UPDATE executor_jobs SET request_json=? WHERE job_id=?").run(canonicalJson(job), job.jobId);
      this.retries.initialize(job.jobId, job.retryPolicy, snapshot.createdAt + job.timeoutMs);
      this.appendState(snapshot, "state");
      return snapshot;
    });
  }

  authorize(id: string, binding: Assignment): void {
    if (canonicalJson(binding) !== this.requireRow(id).binding_json) throw new ExecutionError(403, "reservation_denied");
  }

  binding(id: string): Assignment { return JSON.parse(this.requireRow(id).binding_json) as Assignment; }
  snapshot(id: string): JobSnapshot { return JSON.parse(this.requireRow(id).snapshot_json) as JobSnapshot; }
  request(id: string): JobRequest | null {
    const raw = this.requireRow(id).request_json;
    return raw === null ? null : JSON.parse(raw) as JobRequest;
  }
  list(activeOnly = false): JobSnapshot[] {
    const where = activeOnly ? " WHERE json_extract(snapshot_json,'$.state') IN ('queued','starting','running','retry_wait','cancelling')" : "";
    return (this.db.prepare(`SELECT snapshot_json FROM executor_jobs${where} ORDER BY rowid`).all() as { snapshot_json: string }[]).map((row) => JSON.parse(row.snapshot_json) as JobSnapshot);
  }

  transition(id: string, state: JobState, error?: JobSnapshot["error"]): JobSnapshot {
    return transaction(this.db, () => {
      const snapshot = this.snapshot(id);
      if (isTerminal(snapshot.state)) {
        if (state !== snapshot.state) throw new ExecutionError(409, "job_already_terminal");
        return snapshot;
      }
      const allowed: Record<string, readonly JobState[]> = {
        queued: ["starting", "cancelled", "failed", "interrupted"],
        starting: ["running", "cancelling", "failed", "interrupted"],
        retry_wait: ["starting", "cancelled", "failed", "interrupted"],
        running: ["retry_wait", "cancelling", "succeeded", "failed", "interrupted"],
        cancelling: ["cancelled", "interrupted"],
      };
      if (!allowed[snapshot.state]?.includes(state)) throw new ExecutionError(409, "invalid_job_transition");
      snapshot.state = state;
      snapshot.bootId = this.bootId;
      if (state === "running" && snapshot.startedAt === undefined) snapshot.startedAt = Date.now();
      if (isTerminal(state)) {
        snapshot.endedAt = Date.now();
        this.onTerminal?.(id);
        if (state !== "succeeded") { delete snapshot.result; delete snapshot.finalText; }
      }
      if (error) snapshot.error = error;
      this.appendState(snapshot, isTerminal(state) ? "terminal" : "state");
      return snapshot;
    });
  }

  /** The caller wraps attempt mutation and state transition in the same database transaction. */
  retryState(id: string, retry: RetryRecord, state: JobState): JobSnapshot {
    const snapshot = this.snapshot(id);
    if (state === "retry_wait") { delete snapshot.result; delete snapshot.finalText; }
    if (state === "retry_wait" && retry.reason === "session_unusable" && retry.sessionReset) {
      delete snapshot.providerSessionId;
      delete snapshot.providerCheckpoint;
    }
    snapshot.retry = { attempt: retry.attempt, totalRetries: retry.totalRetries, consecutiveRetries: retry.consecutiveRetries,
      deadlineAt: retry.deadlineAt, nextRetryAt: retry.nextRetryAt, reason: retry.reason };
    this.db.prepare("UPDATE executor_jobs SET snapshot_json=? WHERE job_id=?").run(JSON.stringify(snapshot), id);
    return this.transition(id, state);
  }

  output(id: string, input: unknown): ExecutorEvent {
    const output = ProviderOutput.parse(input);
    return transaction(this.db, () => {
      const snapshot = this.snapshot(id);
      if (isTerminal(snapshot.state)) throw new ExecutionError(409, "event_after_terminal");
      if (output.status === "init") snapshot.providerSessionId = output.sessionId;
      if (output.status === "checkpoint") snapshot.providerCheckpoint = true;
      if (output.status === "stream" && output.text) snapshot.finalText = output.text.slice(-256 * 1024);
      if (output.status === "success") {
        // Success contains only the provider-confirmed final response, not logs.
        snapshot.result = output.result.slice(-256 * 1024);
        snapshot.finalText = snapshot.result;
        if (output.newSessionId) snapshot.providerSessionId = output.newSessionId;
      }
      const event: ExecutorEvent = { seq: ++snapshot.lastSeq, at: Date.now(), kind: "provider", data: output };
      this.append(snapshot, event);
      return event;
    });
  }

  /** Take this tick's live updates. A failed send never puts them back. */
  takeLiveEvents(): Map<string, ExecutorEvent[]> {
    const batches = this.liveEvents;
    this.liveEvents = new Map();
    return batches;
  }

  delete(id: string): void {
    const row = this.row(id);
    if (!row) return;
    if (!isTerminal(JSON.parse(row.snapshot_json).state)) throw new ExecutionError(409, "job_not_terminal");
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM executor_attempts WHERE job_id=?").run(id);
      this.db.prepare("DELETE FROM executor_jobs WHERE job_id=?").run(id);
    });
    this.liveEvents.delete(id);
    this.onTerminal?.(id);
  }

  /** Called only at process boot, when all old container processes are gone. */
  recoverInterrupted(): void {
    for (const snapshot of this.list(true)) {
      if (snapshot.bootId !== this.bootId && !isTerminal(snapshot.state) && this.request(snapshot.jobId) !== null) {
        this.transition(snapshot.jobId, "interrupted", { code: "executor_restarted", message: "Executor process restarted" });
      }
    }
  }

  private appendState(snapshot: JobSnapshot, kind: "state" | "terminal"): void {
    snapshot.lastSeq++;
    this.append(snapshot, { seq: snapshot.lastSeq, at: Date.now(), kind, data: { ...snapshot } });
  }
  private append(snapshot: JobSnapshot, event: ExecutorEvent): void {
    const body = canonicalJson(event);
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new ExecutionError(413, "output_limit_exceeded");
    const events = this.liveEvents.get(snapshot.jobId) ?? [];
    events.push(JSON.parse(body));
    if (events.length > 16) events.shift();
    this.liveEvents.set(snapshot.jobId, events);
    this.db.prepare("UPDATE executor_jobs SET snapshot_json=? WHERE job_id=?").run(JSON.stringify(snapshot), snapshot.jobId);
  }
  private row(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM executor_jobs WHERE job_id=?").get(id) as JobRow | undefined;
  }
  private requireRow(id: string): JobRow {
    const row = this.row(id); if (!row) throw new ExecutionError(404, "job_not_found"); return row;
  }
}
