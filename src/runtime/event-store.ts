import { EventBatch, isTerminal, type JobSnapshot, type RuntimeEvent } from "@luna/runner-protocol";
import { canonicalJson, ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";
import { SchedulerStore } from "./scheduler-store";

interface StreamRow {
  stream_id: string;
  received: number;
}

/** Atomically accepts Executor events and creates the Service-facing projection. */
export class RuntimeEventStore {
  private readonly jobs: SchedulerStore;
  constructor(readonly db: SqlDatabase) {
    this.jobs = new SchedulerStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS execution_streams (
      job_id TEXT PRIMARY KEY REFERENCES scheduled_jobs(job_id), stream_id TEXT NOT NULL,
      received INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runtime_events (
      job_id TEXT NOT NULL REFERENCES scheduled_jobs(job_id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, executor_seq INTEGER,
      PRIMARY KEY(job_id,seq)
    );`);
  }

  ingest(jobId: string, authenticatedInstance: string, input: unknown): void {
    const batch = EventBatch.parse(input);
    transaction(this.db, () => {
      const job = this.jobs.require(jobId);
      const assignment = job.assignment;
      if (!assignment || assignment.instanceId !== authenticatedInstance || batch.instanceId !== authenticatedInstance || assignment.assignmentId !== batch.assignmentId) {
        throw new ExecutionError(403, "event_assignment_denied");
      }
      let stream = this.stream(jobId);
      if (!stream) {
        this.db.prepare("INSERT INTO execution_streams(job_id,stream_id) VALUES (?,?)").run(jobId, batch.streamId);
        stream = this.stream(jobId)!;
      }
      if (stream.stream_id !== batch.streamId) throw new ExecutionError(409, "stream_conflict");
      let previous = 0;
      for (const event of batch.events) {
        if (previous && event.seq <= previous) throw new ExecutionError(422, "batch_not_ordered");
        previous = event.seq;
        if (Buffer.byteLength(canonicalJson(event)) > 8 * 1024 * 1024) throw new ExecutionError(413, "event_too_large");
        if (event.kind !== "provider") {
          const snapshot = event.data;
          if (snapshot.jobId !== jobId || snapshot.assignmentId !== assignment.assignmentId || snapshot.instanceId !== authenticatedInstance || snapshot.streamId !== batch.streamId || snapshot.requestHash !== job.requestHash || snapshot.lastSeq !== event.seq || (event.kind === "terminal") !== isTerminal(snapshot.state)) {
            throw new ExecutionError(422, "invalid_execution_snapshot");
          }
        }
        if (event.seq <= stream.received || job.placementState === "terminal") continue;
        this.append(jobId, "execution", { assignmentId: batch.assignmentId, streamId: batch.streamId, executorSeq: event.seq, event }, event.seq);
        stream.received = event.seq;
        if (event.kind !== "provider" && (job.execution?.lastSeq ?? 0) <= event.seq) {
          job.execution = event.data;
          if (event.kind === "terminal") job.placementState = "terminal";
          this.jobs.save(job);
        }
      }
      this.db.prepare("UPDATE execution_streams SET received=? WHERE job_id=?").run(stream.received, jobId);
    });
  }

  /** Reconcile the current state without requesting lost output. */
  observe(jobId: string, snapshot: JobSnapshot): void {
    if (isTerminal(snapshot.state)) {
      this.ingest(jobId, snapshot.instanceId, {
        version: 1, assignmentId: snapshot.assignmentId, instanceId: snapshot.instanceId, streamId: snapshot.streamId,
        events: [{ seq: snapshot.lastSeq, at: snapshot.endedAt ?? Date.now(), kind: "terminal", data: snapshot }],
      });
      return;
    }
    transaction(this.db, () => {
      const job = this.jobs.require(jobId);
      if (job.assignment?.instanceId !== snapshot.instanceId || job.assignment.assignmentId !== snapshot.assignmentId ||
          snapshot.jobId !== jobId || job.requestHash !== snapshot.requestHash) throw new ExecutionError(403, "event_assignment_denied");
      if (job.placementState === "terminal" || (job.execution?.lastSeq ?? 0) >= snapshot.lastSeq) return;
      job.execution = snapshot;
      this.jobs.save(job);
    });
  }

  list(jobId: string, after = 0, limit = 256): RuntimeEvent[] {
    this.jobs.require(jobId);
    const events: RuntimeEvent[] = []; let bytes = 0;
    for (const row of this.db.prepare("SELECT seq,kind,body FROM runtime_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?").iterate(jobId, after, Math.min(256, limit)) as Iterable<{ seq: number; kind: RuntimeEvent["kind"]; body: string }>) {
      const size = Buffer.byteLength(row.body);
      if (events.length && bytes + size > 16 * 1024 * 1024) break;
      bytes += size; events.push({ jobId, seq: row.seq, kind: row.kind, data: JSON.parse(row.body) as unknown });
    }
    return events;
  }

  lastSequence(jobId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM runtime_events WHERE job_id=?").get(jobId) as { seq: number };
    return row.seq;
  }

  append(jobId: string, kind: RuntimeEvent["kind"], data: unknown, executorSeq: number | null = null): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM runtime_events WHERE job_id=?").get(jobId) as { seq: number };
    this.db.prepare("INSERT INTO runtime_events VALUES (?,?,?,?,?)").run(jobId, row.seq, kind, canonicalJson(data), executorSeq);
    return row.seq;
  }

  private stream(jobId: string): StreamRow | undefined {
    return this.db.prepare("SELECT * FROM execution_streams WHERE job_id=?").get(jobId) as StreamRow | undefined;
  }
}
