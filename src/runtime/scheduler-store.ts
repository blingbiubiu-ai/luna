import { randomUUID } from "node:crypto";
import { JobRequest, type Assignment, type JobSnapshot } from "@luna/runner-protocol";
import { contentHash, ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";

export interface ScheduledJob {
  jobId: string;
  job: JobRequest;
  requestHash: string;
  originalRequestHash?: string;
  contextWorkerId?: string;
  placementState: "queued" | "preparing" | "dispatching" | "assigned" | "reconnecting" | "terminal";
  workerId: string | null;
  assignmentId: string | null;
  assignment: Assignment | null;
  cancelRequested: boolean;
  terminalResult: { state: "cancelled" | "failed"; reason: string } | null;
  execution?: JobSnapshot;
  lastError?: { code: string; at: number };
  /** First failure before an Executor assignment; bounds silent pre-execution retries. */
  preparationFailingSince?: number;
  /** Set when Runtime gives up before execution; the cancellation that follows settles as this failure. */
  failureReason?: string;
  createdAt: number;
}

/** Persists intent before any Worker or Executor request can be sent. */
export class SchedulerStore {
  constructor(readonly db: SqlDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
      job_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, record_json TEXT NOT NULL
    );`);
    if (!(db.prepare("PRAGMA table_info(scheduled_jobs)").all() as { name: string }[]).some(row => row.name === "pending")) db.exec("ALTER TABLE scheduled_jobs ADD COLUMN pending INTEGER NOT NULL DEFAULT 1");
    db.exec("CREATE INDEX IF NOT EXISTS scheduled_jobs_pending ON scheduled_jobs(pending)");
  }

  submit(input: unknown): ScheduledJob {
    const job = JobRequest.parse(input);
    const hash = contentHash(job);
    return transaction(this.db, () => {
      const existing = this.find(job.jobId);
      if (existing) {
        if ((existing.originalRequestHash ?? existing.requestHash) !== hash) throw new ExecutionError(409, "job_conflict");
        return existing;
      }
      const record: ScheduledJob = {
        jobId: job.jobId, job, requestHash: hash, placementState: "queued",
        workerId: null, assignmentId: null, assignment: null,
        cancelRequested: false, terminalResult: null, createdAt: Date.now(),
      };
      this.db.prepare("INSERT INTO scheduled_jobs(job_id,input_hash,record_json) VALUES (?, ?, ?)").run(job.jobId, hash, JSON.stringify(record));
      return record;
    });
  }

  find(id: string): ScheduledJob | undefined {
    const row = this.db.prepare("SELECT record_json FROM scheduled_jobs WHERE job_id=?").get(id) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ScheduledJob : undefined;
  }

  require(id: string): ScheduledJob {
    const record = this.find(id);
    if (!record) throw new ExecutionError(404, "job_not_found");
    return record;
  }

  list(pendingOnly = false): ScheduledJob[] {
    return (this.db.prepare(`SELECT record_json FROM scheduled_jobs${pendingOnly ? " WHERE pending=1" : ""} ORDER BY rowid`).all() as { record_json: string }[])
      .map((row) => JSON.parse(row.record_json) as ScheduledJob);
  }

  reserve(id: string, workerId: string): ScheduledJob {
    return transaction(this.db, () => {
      const job = this.require(id);
      if (job.workerId !== null) {
        if (job.workerId !== workerId) throw new ExecutionError(409, "worker_affinity_conflict");
        return job;
      }
      if (job.placementState === "terminal" || job.cancelRequested) throw new ExecutionError(409, "job_cancelled");
      job.workerId = workerId;
      job.assignmentId = randomUUID();
      job.placementState = "preparing";
      this.save(job);
      return job;
    });
  }

  bind(id: string, assignment: Assignment): ScheduledJob {
    return transaction(this.db, () => {
      const job = this.require(id);
      if (contentHash(assignment.scope)!==contentHash(job.job.scope) || assignment.jobId !== id || assignment.assignmentId !== job.assignmentId || assignment.workerId !== job.workerId || assignment.requestHash !== job.requestHash || assignment.contextId !== job.job.runnerContextId || assignment.scopeKey !== job.job.scopeKey) {
        throw new ExecutionError(409, "assignment_conflict");
      }
      if (job.assignment && contentHash(job.assignment) !== contentHash(assignment)) throw new ExecutionError(409, "assignment_conflict");
      job.assignment = assignment;
      if (job.placementState !== "terminal") job.placementState = "dispatching";
      this.save(job);
      return job;
    });
  }

  cancel(id: string): ScheduledJob {
    return transaction(this.db, () => {
      const job = this.require(id);
      if (job.placementState === "terminal") return job;
      job.cancelRequested = true;
      if (job.workerId === null) {
        job.placementState = "terminal";
        job.terminalResult = job.failureReason ? { state: "failed", reason: job.failureReason } : { state: "cancelled", reason: "cancelled_before_dispatch" };
      }
      this.save(job);
      return job;
    });
  }

  save(job: ScheduledJob): void {
    this.db.prepare("UPDATE scheduled_jobs SET record_json=? WHERE job_id=?").run(JSON.stringify(job), job.jobId);
  }
}
