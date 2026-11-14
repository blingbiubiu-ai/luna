import {fixtureJobScope} from "../helpers/job-scope";
import { describe, expect, test } from "bun:test";
import { openExecutionDatabase, contentHash } from "@luna/execution-store";
import { type Assignment, type JobRequest, type PrepareRequest } from "@luna/runner-protocol";
import { ExecutorStore } from "@luna/executor/executor/store";
import { EnvironmentStore } from "@luna/worker/environment-store";

const job: JobRequest = { version: 2, ...fixtureJobScope(), jobId: "job1", invocationId: "inv1", environmentId: "luna", runnerContextId: "ctx1", scopeKey: "session:ctx1", runnerKind: "main", sessionId: "session1", input: { runnerType: "claude", prompt: "hello" }, credentialsRevision: 1, timeoutMs: 60_000 };
const binding: Assignment = { scope:job.scope, jobId: job.jobId, assignmentId: "assignment1", reservationId: "reservation1", instanceId: "instance1", workerId: "worker1", executionEnvironmentId: "env1", contextId: job.runnerContextId, scopeKey: job.scopeKey, requestHash: contentHash(job) };
function prepare(mode: "shared", id = "job1"): PrepareRequest {
  return { requestId: `prep_${id}`, occupant: { kind: "job", invocationId:`inv_${id}`,scope:job.scope, jobId: id, assignmentId: `assignment_${id}`, requestHash: contentHash(job), scopeKey: `session:${id}`, contextId: `ctx_${id}` }, spec: { protocolVersion:2,scope:job.scope,resourceSelection:job.resources,environmentId: "luna", mode, scopeKey: `session:${id}`, imageDigest: `sha256:${"a".repeat(64)}`, callbackRuntimeId: "runtime1", resources: { memory: "1g", cpus: 1, pidsLimit: 128 } } };
}

describe("Executor persistent lifecycle", () => {
  test("registered cancellation fences a late submit before any process exists", () => {
    const db = openExecutionDatabase(":memory:"); const store = new ExecutorStore(db, "instance1");
    store.register(binding); store.transition(job.jobId, "cancelled");
    expect(store.submit({ job, assignment: binding }).state).toBe("cancelled");
    expect(store.request(job.jobId)).toBeNull();
    expect(() => store.transition(job.jobId, "starting")).toThrow("job_already_terminal"); db.close();
  });
  test("recovery keeps stream/sequence and records interruption instead of repeating work", () => {
    const db = openExecutionDatabase(":memory:"); let store = new ExecutorStore(db, "instance1");
    store.register(binding); store.submit({ job, assignment: binding });
    store.transition(job.jobId, "starting"); store.transition(job.jobId, "running");
    store.output(job.jobId, { status: "init", sessionId: "provider1" });
    const before = store.snapshot(job.jobId);
    store = new ExecutorStore(db, "instance1"); store.recoverInterrupted();
    const after = store.snapshot(job.jobId);
    expect(after.streamId).toBe(before.streamId); expect(after.lastSeq).toBe(before.lastSeq + 1);
    expect(after.bootId).not.toBe(before.bootId); expect(after.state).toBe("interrupted");
    expect(after.providerSessionId).toBe("provider1");
    expect(store.takeLiveEvents().get(job.jobId)?.map(event => event.kind)).toEqual(["terminal"]);
    expect(() => new ExecutorStore(db, "other_instance")).toThrow("volume_instance_mismatch"); db.close();
  });
  test("large live output does not expand the durable terminal snapshot", () => {
    const db = openExecutionDatabase(":memory:");
    try {
      const store = new ExecutorStore(db, "instance1");
      store.register(binding); store.submit({ job, assignment: binding });
      store.transition(job.jobId, "starting");
      store.transition(job.jobId, "running");
      const result = "a".repeat(300 * 1024) + "tail";
      expect(store.output(job.jobId, { status: "success", result }).data).toEqual({ status: "success", result });
      const terminal = store.transition(job.jobId, "succeeded");
      expect(terminal.result).toBe(result.slice(-256 * 1024));
    } finally { db.close(); }
  });
  test("only the recorded binding can access a Job; output markers have no control meaning", () => {
    const db = openExecutionDatabase(":memory:"); const store = new ExecutorStore(db, "instance1");
    store.register(binding); store.submit({ job, assignment: binding });
    expect(() => store.authorize(job.jobId, { ...binding, reservationId: "other" })).toThrow("reservation_denied");
    store.output(job.jobId, { status: "success", result: "LUNA_NOTHING_TO_SEND" });
    expect(store.snapshot(job.jobId).state).toBe("queued");
    expect(store.request(job.jobId)).not.toHaveProperty("retryPolicy");
    expect(contentHash(store.request(job.jobId))).toBe(binding.requestHash);
    expect(store.retries.require(job.jobId).policy.maxTotalRetries).toBe(10);
    db.close();
  });
});

describe("Worker durable environment occupancy", () => {
  test("generation changes cannot attach an occupied Shadow to a second environment", () => {
    const db = openExecutionDatabase(":memory:");
    try {
      const store = new EnvironmentStore(db);
      const first = prepare("shared", "first");
      const held = store.prepare(first);
      const second = prepare("shared", "second");
      second.spec.scope={...second.spec.scope,placementGeneration:2};second.occupant.scope=second.spec.scope;
      expect(() => store.prepare(second)).toThrow("shadow_environment_occupied");
      expect(store.list()).toHaveLength(1);
      store.release(first.requestId, held.reservation.reservationId);
      store.stopped(held.environment.id);
      expect(store.prepare(second).environment.spec.mode).toBe("shared");
    } finally { db.close(); }
  });
  test("cancellation arriving before prepare fences a late creation across restart", () => {
    const db = openExecutionDatabase(":memory:"); let store = new EnvironmentStore(db);
    const request = prepare("shared"); store.cancelUnknownPreparation(request.requestId);
    store = new EnvironmentStore(db);
    expect(() => store.prepare(request)).toThrow("preparation_cancelled");
    expect(store.list()).toHaveLength(0); db.close();
  });
  test("same Shadow contexts share an environment while different Shadows remain separate", () => {
    const db = openExecutionDatabase(":memory:"); const store = new EnvironmentStore(db);
    expect(store.prepare(prepare("shared", "one")).environment.id).toBe(store.prepare(prepare("shared", "two")).environment.id);
    const other=prepare("shared","three"),foreign=fixtureJobScope("agent","other");
    other.spec.scope=foreign.scope;other.spec.resourceSelection=foreign.resources;other.occupant.scope=foreign.scope;
    expect(store.prepare(other).environment.id).not.toBe(store.prepare(prepare("shared","four")).environment.id);db.close();
  });
  test("a shared Shadow environment survives store restart and is retained after release", () => {
    const db = openExecutionDatabase(":memory:"); let store = new EnvironmentStore(db);
    const result = store.prepare(prepare("shared"));
    store.ready(result.reservation.requestId, { containerId: "container1", endpoint: "http://localhost:8080", bootId: "boot1" });
    store = new EnvironmentStore(db);
    expect(store.require(result.environment.id).state).toBe("ready");
    store.release(result.reservation.requestId, result.reservation.reservationId);
    expect(store.require(result.environment.id).state).toBe("ready");
    expect(() => store.prepare(prepare("shared", "job1"))).toThrow("preparation_cancelled");
    store.stopped(result.environment.id);
    expect(store.require(result.environment.id).instanceId).toBe(result.environment.instanceId); db.close();
  });
  test("cancelled preparations are tombstones and cannot start after retry", () => {
    const db = openExecutionDatabase(":memory:"); const store = new EnvironmentStore(db);
    const request = prepare("shared"); store.prepare(request);
    expect(store.cancelPreparation(request.requestId, true).state).toBe("cancelled");
    expect(() => store.prepare(request)).toThrow("preparation_cancelled"); db.close();
  });
});

test("Executor refuses a cross-Shadow Job even with an otherwise matching request hash",()=>{
 const db=openExecutionDatabase(":memory:");
 try{
  const store=new ExecutorStore(db,"instance1");
  const wrong={...binding,scope:{...binding.scope,shadowId:"other"}};
  store.register(wrong);
  expect(()=>store.submit({job,assignment:wrong})).toThrow("job_binding_mismatch");
  expect(store.request(job.jobId)).toBeNull();
  expect(()=>store.authorize(job.jobId,binding)).toThrow("reservation_denied");
 }finally{db.close();}
});

test("Worker preparation retains scope and rejects changed scope on replay",()=>{
 const db=openExecutionDatabase(":memory:");
 try{
  const store=new EnvironmentStore(db),request=prepare("shared");
  const result=store.prepare(request);
  expect(result.reservation.occupant).toEqual(request.occupant);
  if(request.occupant.kind!=="job")throw new Error("job fixture required");
  expect(()=>store.prepare({...request,occupant:{...request.occupant,scope:{...job.scope,shadowId:"other"}}})).toThrow("Occupant scope mismatch");
  const restarted=new EnvironmentStore(db);
  expect(restarted.reservation(request.requestId)?.occupant).toEqual(request.occupant);
 }finally{db.close();}
});

test("environment scope, resource revision and protocol are mandatory and cannot drift",()=>{
 const db=openExecutionDatabase(":memory:");
 try{
  const store=new EnvironmentStore(db),request=prepare("shared");
  for(const spec of [{...request.spec,protocolVersion:1},{...request.spec,scope:undefined},{...request.spec,mode:"isolated"}])
   expect(()=>store.prepare({...request,spec})).toThrow();
  expect(()=>store.prepare({...request,resourceRevision:"0".repeat(64)})).toThrow("Resource revision mismatch");
  const first=store.prepare(request),next=prepare("shared","next");
  next.spec.resourceSelection={...next.spec.resourceSelection,digest:"0".repeat(64)};
  expect(()=>store.prepare(next)).toThrow("environment_configuration_conflict");
  expect(store.require(first.environment.id).spec).toEqual(request.spec);
 }finally{db.close();}
});
