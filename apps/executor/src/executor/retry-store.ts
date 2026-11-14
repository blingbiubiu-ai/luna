import { initializeExecutorSchema } from "./schema";
import { RetryPolicy } from "@luna/runner-protocol";
import { canonicalJson, ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";

const LEGACY_RETRY_POLICY: RetryPolicy = { maxConsecutiveRetries: 5, maxTotalRetries: 10, baseDelayMs: 2000, maxDelayMs: 30000 };

export interface RetryRecord {
  jobId: string;
  policy: RetryPolicy;
  deadlineAt: number;
  attempt: number;
  totalRetries: number;
  consecutiveRetries: number;
  state: "ready" | "running" | "retry_wait" | "cancel_requested" | "finished";
  nextRetryAt: number | null;
  reason: string | null;
  /** Once reset, the immutable request resume ID must never be reused. */
  sessionReset?: boolean;
}

/** Durable attempt admission; callers retain process ownership until cleanup is proven. */
export class ExecutorRetryStore {
  constructor(private readonly db: SqlDatabase) {
    initializeExecutorSchema(db);
  }

  initialize(jobId: string, input: RetryPolicy | undefined, deadlineAt: number): RetryRecord {
    const policy = RetryPolicy.parse(input ?? LEGACY_RETRY_POLICY);
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw new ExecutionError(422, "invalid_execution_deadline");
    return transaction(this.db, () => {
      const old = this.find(jobId);
      if (old) {
        if ((input !== undefined && canonicalJson(old.policy) !== canonicalJson(policy)) || old.deadlineAt !== deadlineAt) throw new ExecutionError(409, "retry_policy_conflict");
        return old;
      }
      const record: RetryRecord = { jobId, policy, deadlineAt, attempt: 0, totalRetries: 0, consecutiveRetries: 0, state: "ready", nextRetryAt: null, reason: null };
      if (!this.db.prepare("UPDATE executor_jobs SET retry_json=? WHERE job_id=?").run(JSON.stringify(record), jobId).changes) throw new ExecutionError(404, "job_not_found");
      return record;
    });
  }

  /** A persisted startup claim cannot be claimed again after a lost response. */
  claim(jobId: string, now: number): RetryRecord | null {
    return transaction(this.db, () => {
      const row = this.require(jobId);
      if (!["ready", "retry_wait"].includes(row.state)) return null;
      if (now >= row.deadlineAt) { row.state = "finished"; row.reason = "deadline_exceeded"; row.nextRetryAt = null; this.save(row); return null; }
      if (row.nextRetryAt !== null && now < row.nextRetryAt) return null;
      row.attempt++; row.state = "running"; row.nextRetryAt = null;
      this.db.prepare("INSERT INTO executor_attempts(job_id,attempt,started_at) VALUES (?,?,?)").run(jobId, row.attempt, now);
      this.save(row); return row;
    });
  }

  /** Persist the PID birth time as well as UID; PID alone cannot identify a reused process. */
  recordProcess(jobId: string, attempt: number, identity: { pid: number; startTime: string; uid: number }): void {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.startTime) || !Number.isSafeInteger(identity.uid) || identity.uid < 1) throw new ExecutionError(422, "invalid_attempt_process");
    this.recordFact(jobId, attempt, "process_json", identity);
  }

  /** Exit is recorded only once the process and its descendants have been cleaned up. */
  recordExit(jobId: string, attempt: number, exit: { code: number | null; signal: string | null }): void {
    this.recordFact(jobId, attempt, "exit_json", exit);
  }

  private recordFact(jobId: string, attempt: number, column: "process_json" | "exit_json", value: unknown): void {
    transaction(this.db, () => {
      const current = this.require(jobId);
      if (current.attempt !== attempt || !["running", "cancel_requested"].includes(current.state)) throw new ExecutionError(409, "attempt_not_active");
      const old = this.db.prepare(`SELECT ${column} AS value FROM executor_attempts WHERE job_id=? AND attempt=?`).get(jobId, attempt) as { value: string | null };
      const encoded = canonicalJson(value);
      if (old.value !== null && old.value !== encoded) throw new ExecutionError(409, "attempt_fact_conflict");
      this.db.prepare(`UPDATE executor_attempts SET ${column}=? WHERE job_id=? AND attempt=?`).run(encoded, jobId, attempt);
    });
  }

  /** Called only after the failed attempt and all descendants have exited. */
  schedule(jobId: string, attempt: number, input: { now: number; delayMs: number; checkpoint: boolean; reason: string; resetSession?: boolean }): boolean {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) throw new ExecutionError(422, "invalid_retry_delay");
    return transaction(this.db, () => {
      const row = this.require(jobId);
      if (row.state !== "running" || row.attempt !== attempt) return false;
      const consecutive = input.checkpoint ? 0 : row.consecutiveRetries;
      const next = input.now + input.delayMs;
      const exhausted = row.totalRetries >= row.policy.maxTotalRetries || consecutive >= row.policy.maxConsecutiveRetries;
      this.endAttempt(row, input.now, input.reason);
      if (exhausted || next >= row.deadlineAt) {
        row.state = "finished"; row.reason = exhausted ? "retry_budget_exhausted" : "deadline_exceeded";
        this.save(row); return false;
      }
      if (input.resetSession) row.sessionReset = true;
      row.totalRetries++; row.consecutiveRetries = consecutive + 1;
      row.state = "retry_wait"; row.nextRetryAt = next; row.reason = input.reason;
      this.save(row); return true;
    });
  }

  cancel(jobId: string): void {
    transaction(this.db, () => {
      const row = this.require(jobId);
      if (row.state === "finished") return;
      row.state = "cancel_requested"; row.nextRetryAt = null; this.save(row);
    });
  }

  /** Finalization is separate from cancellation intent and requires process cleanup. */
  finish(jobId: string, now: number, reason: string): void {
    transaction(this.db, () => {
      const row = this.require(jobId);
      if (row.state === "finished") return;
      this.endAttempt(row, now, reason);
      row.state = "finished"; row.nextRetryAt = null; row.reason = reason; this.save(row);
    });
  }
  require(jobId: string): RetryRecord {
    const row = this.find(jobId); if (!row) throw new ExecutionError(404, "retry_state_not_found"); return row;
  }
  private find(jobId: string): RetryRecord | undefined {
    const row = this.db.prepare("SELECT retry_json AS body FROM executor_jobs WHERE job_id=?").get(jobId) as { body: string } | undefined;
    return row?.body ? JSON.parse(row.body) as RetryRecord : undefined;
  }
  private save(row: RetryRecord): void { this.db.prepare("UPDATE executor_jobs SET retry_json=? WHERE job_id=?").run(JSON.stringify(row), row.jobId); }
  private endAttempt(row: RetryRecord, now: number, reason: string): void {
    this.db.prepare("UPDATE executor_attempts SET ended_at=?,reason=? WHERE job_id=? AND attempt=? AND ended_at IS NULL").run(now, reason, row.jobId, row.attempt);
  }
}
