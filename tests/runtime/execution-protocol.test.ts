import {fixtureJobScope} from "../helpers/job-scope";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRequest, type Assignment, type EventBatch, type JobSnapshot } from "@luna/runner-protocol";
import { contentHash } from "@luna/execution-store";
import { openRuntimeDatabase } from "../../src/runtime/database";
import { SchedulerStore } from "../../src/runtime/scheduler-store";
import { RuntimeEventStore } from "../../src/runtime/event-store";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function input() {
  return { version: 2 as const, ...fixtureJobScope(), jobId: "job_1", invocationId: "inv_1", environmentId: "luna", runnerContextId: "ctx_1", scopeKey: "session:ctx_1", runnerKind: "main" as const, sessionId: "session_1", input: { runnerType: "claude" as const, prompt: "hello" }, credentialsRevision: 1, timeoutMs: 30_000 };
}

function assigned(store: SchedulerStore): Assignment {
  const job = store.submit(input());
  const reserved = store.reserve(job.jobId, "worker_a");
  const assignment = { scope:job.job.scope, jobId: job.jobId, assignmentId: reserved.assignmentId!, workerId: "worker_a", reservationId: "reservation_1", instanceId: "instance_1", executionEnvironmentId: "env_1", contextId: job.job.runnerContextId, scopeKey: job.job.scopeKey, requestHash: job.requestHash };
  store.bind(job.jobId, assignment);
  return assignment;
}

function batch(assignment: Assignment): EventBatch {
  return { version: 1, assignmentId: assignment.assignmentId, instanceId: assignment.instanceId, streamId: "stream_1", events: [{ seq: 1, at: 100, kind: "provider", data: { status: "stream", text: "output" } }] };
}

describe("execution contracts and durable acceptance", () => {
  test("rejects injected fields and missing role identity, accepts existing scope keys", () => {
    expect(JobRequest.parse(input()).scopeKey).toBe("session:ctx_1");
    expect(() => JobRequest.parse({ ...input(), executable: "/bin/sh" })).toThrow();
    expect(() => JobRequest.parse({ ...input(), runnerKind: "task" })).toThrow();
    expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
  });

  test("project identity is optional for old Jobs and immutable for accepted requests", () => {
    const db = openRuntimeDatabase(":memory:");
    try {
      const jobs = new SchedulerStore(db);
      expect(JobRequest.parse(input())).not.toHaveProperty("projectId");
      const request = { ...input(), projectId: "original-project" };
      expect(jobs.submit(request).job.projectId).toBe(request.projectId);
      expect(jobs.submit(request).job.projectId).toBe(request.projectId);
      expect(() => jobs.submit({ ...request, projectId: "other" })).toThrow("job_conflict");
      expect(() => jobs.submit(input())).toThrow("job_conflict");
      expect(() => JobRequest.parse({ ...request, projectId: "/host/path" })).toThrow();
    } finally { db.close(); }
  });

  test("submission and placement survive restart; an uncertain Job cannot move Workers", () => {
    const directory = mkdtempSync(join(tmpdir(), "luna-runtime-")); temporary.push(directory);
    const file = join(directory, "runtime.sqlite");
    let db = openRuntimeDatabase(file);
    let jobs = new SchedulerStore(db);
    const assignment = assigned(jobs);
    db.close();
    db = openRuntimeDatabase(file); jobs = new SchedulerStore(db);
    expect(jobs.submit(input()).assignment).toEqual(assignment);
    expect(() => jobs.reserve("job_1", "worker_b")).toThrow("worker_affinity_conflict");
    expect(() => jobs.submit({ ...input(), input: { runnerType: "claude", prompt: "changed" } })).toThrow("job_conflict");
    db.close();
  });

  test("a cancelled queued Job cannot be placed when a Worker appears", () => {
    const db = openRuntimeDatabase(":memory:"); const jobs = new SchedulerStore(db);
    jobs.submit(input()); jobs.cancel("job_1");
    expect(jobs.submit(input()).terminalResult?.state).toBe("cancelled");
    expect(() => jobs.reserve("job_1", "worker_a")).toThrow("job_cancelled"); db.close();
  });

  test("live updates tolerate gaps, ignore old sequences, and validate the assignment", () => {
    const db = openRuntimeDatabase(":memory:");
    const assignment = assigned(new SchedulerStore(db));
    const events = new RuntimeEventStore(db);
    const payload = batch(assignment);
    events.ingest("job_1", "instance_1", payload);
    events.ingest("job_1", "instance_1", payload);
    expect(events.list("job_1")).toHaveLength(1);
    expect(() => events.ingest("job_1", "other_instance", payload)).toThrow("event_assignment_denied");
    expect(() => events.ingest("job_1", "instance_1", { ...payload, streamId: "replacement" })).toThrow("stream_conflict");
    events.ingest("job_1", "instance_1", { ...payload, events: [{ ...payload.events[0], seq: 3 }] });
    events.ingest("job_1", "instance_1", { ...payload, events: [{ ...payload.events[0], seq: 2 }] });
    expect(events.list("job_1").map(event => (event.data as { executorSeq: number }).executorSeq)).toEqual([1, 3]);
    db.close();
  });

  test("querying the original Executor recovers its terminal state after missed live output", () => {
    const db = openRuntimeDatabase(":memory:");
    const jobs = new SchedulerStore(db);
    const assignment = assigned(jobs);
    const events = new RuntimeEventStore(db);
    const snapshot: JobSnapshot = { jobId: "job_1", assignmentId: assignment.assignmentId, instanceId: "instance_1", streamId: "stream_1", bootId: "boot_1", requestHash: assignment.requestHash, state: "succeeded", result: "LUNA_NOTHING_TO_SEND", lastSeq: 9, createdAt: 100, endedAt: 200 };
    events.observe("job_1", snapshot);
    events.observe("job_1", snapshot);
    events.ingest("job_1", "instance_1", batch(assignment));
    expect(jobs.require("job_1")).toMatchObject({ execution: snapshot, placementState: "terminal" });
    expect(events.list("job_1")).toMatchObject([{ data: { event: { kind: "terminal", data: snapshot } } }]);
    db.close();
  });
});


test("Job v2 requires explicit scope, generation and the pinned resource selection",()=>{
 const request=input();expect(JobRequest.parse(request)).toEqual(request);
 for(const invalid of [{...request,version:1},{...request,scope:undefined},{...request,resources:undefined},
  {...request,scope:{...request.scope,placementGeneration:0}},{...request,resourceRevision:"0".repeat(64)}]){
  expect(()=>JobRequest.parse(invalid)).toThrow();
 }
});

test("Scheduler assignment cannot change the accepted Job's Shadow or placement generation",()=>{
 const db=openRuntimeDatabase(":memory:");
 try{
  const jobs=new SchedulerStore(db),binding=assigned(jobs);
  for(const scope of [{...binding.scope,shadowId:"other"},{...binding.scope,placementGeneration:2}]){
   expect(()=>jobs.bind(binding.jobId,{...binding,scope})).toThrow();
  }
  expect(jobs.require(binding.jobId).assignment).toEqual(binding);
 }finally{db.close();}
});
