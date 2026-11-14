import {fixtureJobScope} from "../helpers/job-scope";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, ExecutionError, openExecutionDatabase, writePrivateJson } from "@luna/execution-store";
import { TokenAuthority, type RpcClient } from "@luna/execution-transport";
import type { JobRequest, JobSnapshot } from "@luna/runner-protocol";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeScheduler } from "../../src/runtime/scheduler";

const scope={agentId:"agent",shadowId:"shadow"};
const resources=createScopedResources(scope,[]).selection;
const input = { invocationId:"inv",protocolVersion:2 as const,scope,resources,contextId: "ctx", runnerId: "ctx", scopeKey: "session:ctx", runnerKind: "main" as const, projectId: "project" };
const prepared = { protocolVersion:2 as const,scope:{...scope,placementGeneration:1},resources,workerId:"old",home: "/worker", cwd: "/worker/runners/ctx", env: { GIT_CONFIG_GLOBAL: "/worker/gitconfig" }, resourceRevision: resources.digest, instructionFingerprint: "same-templates" };
const job: JobRequest = { version: 2, ...fixtureJobScope(), jobId: "job", invocationId: "inv", environmentId: "luna", runnerContextId: "ctx", scopeKey: "session:ctx", projectId: "project", runnerKind: "main", sessionId: "session", input: { runnerType: "codex", prompt: "Continue task", sessionId: "old-codex-session" }, credentialsRevision: 1, timeoutMs: 1000 };
function fixture(preparationSettled?:(id:string)=>boolean,capacity=8,boundWorker?:()=>string|undefined,allowedWorkers=()=>["old","new"]) {
  const root = mkdtempSync(join(tmpdir(), "luna-failover-"));
  const db = openExecutionDatabase(join(root, "runtime.sqlite"));
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", dataRoot: root, homeWorkerId: "old",  serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
  const scheduler = new RuntimeScheduler(db, config, new TokenAuthority(db),allowedWorkers,preparationSettled,boundWorker);
  for (const workerId of ["old", "new"]) {
    scheduler.workers.register({ workerId, reverse: true, endpoint: "http://127.0.0.1:1", controlToken: "w".repeat(43), executorHost: "127.0.0.1", executorPortStart: 41000, executorPortEnd: 41100 });
    scheduler.workers.heartbeat(workerId, { workerId, imageDigest: `sha256:${"a".repeat(64)}`, capacity, occupied: workerId==="new" ? 1 : 0, ready: true, capabilities:["shadow-scope-v2"],projects: ["project"] });
  }
  function offline() {
    const old = scheduler.workers.require("old"); old.lastSeen = 0; old.lastHeartbeatAt = Date.now() - 31000;
    db.prepare("UPDATE runtime_workers SET state=? WHERE worker_id='old'").run(JSON.stringify(old));
  }
  function attach(id: string, call: (path: string, body: any) => unknown) {
    scheduler.workers.attach(id, { async call<T>(_method: string, path: string, body?: unknown): Promise<T> { return await call(path, body) as T; } });
  }
  return { db, root, config, scheduler, offline, attach, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("simultaneous preparations spread new contexts before the preferred Worker has reserved all its slots",async()=>{
 const f=fixture(undefined,2);
 try{
  f.attach("old",()=>prepared);
  f.attach("new",()=>({...prepared,workerId:"new"}));
  const results=await Promise.all([input,...["two","three"].map(id=>({
   ...input,invocationId:id,runnerId:id,contextId:id,scopeKey:`session:${id}`,
  }))].map(request=>f.scheduler.preparation.prepare(request)));
  expect(results.map(result=>result.workerId)).toEqual(["old","old","new"]);
 }finally{f.close();}
});

test("bound routing selects only its Worker and changing it rebuilds an existing idle context lazily", async () => {
 let bound: string | undefined = "old";
 const f=fixture(undefined,8,()=>bound);
 try {
  f.attach("old",()=>prepared);
  f.attach("new",()=>({...prepared,workerId:"new"}));
  const before=await f.scheduler.preparation.prepare(input);
  f.scheduler.placements.bindContext(scope,"sibling","session:sibling",["old","new"],"project");
  bound="new";
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("old");
  const after=await f.scheduler.preparation.prepare({...input,invocationId:"next"});
  expect(after.workerId).toBe("new");
  expect(after.instructionFingerprint).not.toBe(before.instructionFingerprint);
  expect(f.scheduler.placements.context(scope,"sibling")?.workerId).toBe("old");
  const sibling=await f.scheduler.preparation.prepare({...input,invocationId:"sibling-inv",contextId:"sibling",runnerId:"sibling",scopeKey:"session:sibling"});
  expect(sibling.workerId).toBe("new");
  const fresh=await f.scheduler.preparation.prepare({...input,invocationId:"fresh",contextId:"fresh",runnerId:"fresh",scopeKey:"session:fresh"});
  expect(fresh.workerId).toBe("new");
 } finally {f.close();}
});

test("bound routing does not fail over when its Worker is offline or unauthorized", async () => {
 const f=fixture(undefined,8,()=>"old");
 try {
  f.attach("old",()=>prepared);
  await f.scheduler.preparation.prepare(input);
  f.offline();
  await expect(f.scheduler.preparation.prepare({...input,invocationId:"next"})).rejects.toMatchObject({code:"shadow_worker_unavailable"});
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("old");
  expect(()=>f.scheduler.placements.bindContext(scope,"new-context","session:new",["new"])).toThrow("bound_worker_access_denied");
 } finally {f.close();}
});

test("changing bound routing never moves a context with a reserved execution", async () => {
 let bound="old";
 const f=fixture(undefined,8,()=>bound);
 try {
  f.attach("old",()=>prepared);
  await f.scheduler.preparation.prepare(input);
  f.scheduler.submit(job);
  f.scheduler.jobs.reserve(job.jobId,"old");
  bound="new";
  await expect(f.scheduler.preparation.prepare({...input,invocationId:"next"})).rejects.toMatchObject({code:"context_execution_unknown"});
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("old");
 } finally {f.close();}
});

test("automatic routing replaces an idle paused Worker on the next invocation",async()=>{
 let allowed=["old","new"];
 const f=fixture(undefined,8,undefined,()=>allowed);
 try{
  f.attach("old",()=>prepared);f.attach("new",()=>({...prepared,workerId:"new"}));
  const before=await f.scheduler.preparation.prepare(input);
  allowed=["new"];
  f.scheduler.isContextFileBusy=()=>true;
  await expect(f.scheduler.preparation.prepare({...input,invocationId:"during-files"})).rejects.toMatchObject({code:"context_busy"});
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("old");
  f.scheduler.isContextFileBusy=()=>false;
  const after=await f.scheduler.preparation.prepare({...input,invocationId:"after-pause"});
  expect(after.workerId).toBe("new");
  expect(after.instructionFingerprint).not.toBe(before.instructionFingerprint);
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("new");
 }finally{f.close();}
});

test("automatic rerouting never changes an active reservation or uses an unauthorized alternative",async()=>{
 let allowed=["old","new"];
 const f=fixture(undefined,8,undefined,()=>allowed);
 try{
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  allowed=[];
  await expect(f.scheduler.preparation.prepare({...input,invocationId:"no-worker"})).rejects.toMatchObject({code:"no_scoped_worker_available"});
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("old");
  allowed=["old","new"];
  f.scheduler.submit(job);f.scheduler.jobs.reserve(job.jobId,"old");
  allowed=["new"];
  await expect(f.scheduler.preparation.prepare({...input,invocationId:"paused-active"})).rejects.toMatchObject({code:"agent_worker_access_denied"});
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("old");
 }finally{f.close();}
});

test("idle context retries its original Worker and switches after stale heartbeat without moving sibling contexts",async()=>{
 const f=fixture();
 try{
  f.attach("old",()=>prepared);const before=await f.scheduler.preparation.prepare(input);
  f.scheduler.placements.bindContext(scope,"sibling","session:sibling",["old","new"]);
  const sibling={...job,jobId:"sibling-job",runnerContextId:"sibling",invocationId:"sibling-inv"};
  f.scheduler.submit(sibling);f.scheduler.jobs.reserve(sibling.jobId,"old");
  let attempts=0,newCalls=0;
  f.attach("old",()=>{attempts++;throw new ExecutionError(503,"worker_disconnected");});
  f.attach("new",()=>{newCalls++;return {...prepared,workerId:"new"};});
  await expect(f.scheduler.preparation.prepare(input)).rejects.toMatchObject({code:"worker_delivery_failed"});
  expect(attempts).toBe(2);f.offline();
  const after=await f.scheduler.preparation.prepare(input);
  expect(newCalls).toBe(1);
  expect(after.workerId).toBe("new");
  expect(after.instructionFingerprint).not.toBe(before.instructionFingerprint);
  expect(f.scheduler.placements.context(scope,"sibling")?.workerId).toBe("old");
  expect(f.scheduler.placements.context(scope,"ctx")?.workerId).toBe("new");
  let released=0;
  f.attach("old",(path,body)=>{
   expect(path).toBe("/v2/context-preparations/release");
   expect(body.contextId).toBe("ctx");
   released++;
  });
  await f.scheduler.tick();
  expect(released).toBe(1);
 }finally{f.close();}
});

test("explicit rejection never triggers retries or failover", async () => {
  const f = fixture();
  try {
    f.attach("old", () => prepared); await f.scheduler.preparation.prepare(input);
    let calls = 0; f.attach("old", () => { calls++; throw new ExecutionError(403, "denied"); });
    await expect(f.scheduler.preparation.prepare(input)).rejects.toMatchObject({ code: "denied" });
    expect(calls).toBe(1); expect(f.scheduler.placements.find(scope)?.workerId).toBe("old");
  } finally { f.close(); }
});

test("queued job switches without replaying the old provider session and preserves the original submit hash",async()=>{
 const f=fixture();
 try{
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  const accepted={...job,resourceRevision:resources.digest};f.scheduler.submit(accepted);f.offline();
  f.attach("new",path=>{
   if(path==="/v2/context-prepare")return {...prepared,workerId:"new"};
   throw new ExecutionError(503,"testing_reservation_only");
  });
  await f.scheduler.tick();
  const next=f.scheduler.jobs.require(job.jobId);
  expect(next.workerId).toBe("new");
  expect(next.job.input.sessionId).toBeUndefined();
  expect(next.job.input.prompt).toContain(accepted.input.prompt);
  expect(next.requestHash).toBe(contentHash(next.job));
  expect(next.originalRequestHash).toBe(contentHash(accepted));
  expect(f.scheduler.submit(accepted)).toEqual(next);
 }finally{f.close();}
});

function reserved(f: ReturnType<typeof fixture>) {
  f.scheduler.submit(job);
  const reservation = f.scheduler.jobs.reserve("job", "old");
  const assignment = { scope:job.scope, jobId: "job", assignmentId: reservation.assignmentId!, reservationId: "reservation", instanceId: "instance", workerId: "old", executionEnvironmentId: "environment", contextId: "ctx", scopeKey: "session:ctx", requestHash: reservation.requestHash };
  f.scheduler.jobs.bind("job", assignment);
  const binding = { handle: { workerId: "old", environmentId: "environment", instanceId: "instance", reservationId: "reservation", executorEndpoint: "http://127.0.0.1:41000" }, configured: true };
  f.db.prepare("INSERT INTO runtime_bindings VALUES (?,?)").run("job", JSON.stringify(binding));
  writePrivateJson(join(f.root, "credentials", `control_${contentHash("instance")}.json`), { credentialId: "control", token: "c".repeat(43) });
  const snapshot: JobSnapshot = { jobId: "job", assignmentId: assignment.assignmentId, instanceId: "instance", bootId: "boot", streamId: "stream", requestHash: reservation.requestHash, state: "queued", lastSeq: 0, createdAt: Date.now() };
  return { assignment, snapshot };
}
function retryNow(f: ReturnType<typeof fixture>) {
  const binding = f.scheduler.binding("job")!; delete binding.nextQueryAt;
  f.db.prepare("UPDATE runtime_bindings SET body=? WHERE job_id='job'").run(JSON.stringify(binding));
}

test("lost acknowledgement is recovered by query with no duplicate submission", async () => {
  const f = fixture();
  try {
    const { snapshot } = reserved(f); let posts = 0;
    f.attach("old", (_path, call) => {
      if (call.path === "/v1/contexts") return {};
      if (call.path === "/v1/jobs") { posts++; throw new Error("ack lost"); }
      return { ...snapshot, lastSeq: 1 };
    });
    await f.scheduler.tick();
    expect(posts).toBe(1); expect(f.scheduler.binding("job")?.submitted).toBe(true);
    expect(f.scheduler.jobs.require("job").placementState).toBe("assigned");
  } finally { f.close(); }
});

test("two failed sends keep the same assignment; unknown execution is query-only across restart", async () => {
  const f = fixture();
  try {
    const { assignment } = reserved(f); const sent: unknown[] = [];
    const channel: RpcClient = { async call<T>(_method: string, _path: string, value?: unknown): Promise<T> {
      const call = value as { path: string; body: { assignment?: unknown } };
      if (call.path === "/v1/contexts") return {} as T;
      if (call.path === "/v1/jobs") sent.push(call.body.assignment);
      throw new Error("connection lost");
    } };
    f.scheduler.workers.attach("old", channel);
    await f.scheduler.tick();
    expect(sent).toEqual([assignment, assignment]);
    expect(f.scheduler.jobs.require("job").lastError?.code).toBe("execution_state_unknown");
    expect(f.scheduler.jobs.require("job").placementState).toBe("reconnecting");
    retryNow(f);
    const restarted = new RuntimeScheduler(f.db, f.config, new TokenAuthority(f.db));
    restarted.workers.attach("old", channel);
    await restarted.tick();
    expect(sent).toHaveLength(2); expect(restarted.jobs.require("job").workerId).toBe("old");
  } finally { f.close(); }
});

test("negative query is fenced by cancellation before reporting delivery failure", async () => {
  const f = fixture();
  try {
    const { snapshot } = reserved(f); let posts = 0, cancellations = 0;
    f.attach("old", (_path, call) => {
      if (call.path === "/v1/contexts") return {};
      if (call.path === "/v1/jobs") { posts++; throw new Error("send failed"); }
      if (call.path.endsWith("/cancel")) { cancellations++; return { ...snapshot, state: "cancelled", lastSeq: 1, endedAt: Date.now() }; }
      return snapshot;
    });
    await f.scheduler.tick();
    expect(posts).toBe(2); expect(cancellations).toBe(1);
    expect(f.scheduler.jobs.require("job")).toMatchObject({ placementState: "terminal", terminalResult: { state: "failed", reason: "worker_delivery_failed" } });
  } finally { f.close(); }
});

test("an active reservation prevents idle-context failover", async () => {
  const f = fixture();
  try {
    f.attach("old", () => prepared); await f.scheduler.preparation.prepare(input);
    f.scheduler.submit(job); f.scheduler.jobs.reserve(job.jobId, "old"); f.offline();
    f.attach("new", () => { throw new Error("must not migrate"); });
    await expect(f.scheduler.preparation.prepare(input)).rejects.toMatchObject({code:"shadow_worker_unavailable"});
    expect(f.scheduler.placements.find(scope)?.workerId).toBe("old");
  } finally { f.close(); }
});

test("disconnect retains the last heartbeat instead of immediately authorizing failover", () => {
  const f = fixture();
  try {
    const channel: RpcClient = { async call<T>(): Promise<T> { throw new Error("offline"); } };
    f.scheduler.workers.attach("old", channel);
    f.scheduler.workers.detach("old", channel);
    expect(f.scheduler.workers.require("old").lastSeen).toBe(0);
    expect(f.scheduler.workers.hasRecentHeartbeat("old")).toBe(true);
    f.offline(); expect(f.scheduler.workers.hasRecentHeartbeat("old")).toBe(false);
  } finally { f.close(); }
});

test("offline context stays on its original Worker when the alternative is ineligible", async () => {
  const f = fixture();
  try {
    f.attach("old", () => prepared); await f.scheduler.preparation.prepare(input); f.offline();
    f.attach("old", () => { throw new Error("offline"); });
    f.scheduler.workers.drain("new");
    f.attach("new", () => { throw new Error("unexpected Worker call"); });
    await expect(f.scheduler.preparation.prepare(input)).rejects.toMatchObject({ code: "shadow_worker_unavailable" });
    expect(f.scheduler.placements.find(scope)?.workerId).toBe("old");
    expect(f.scheduler.preparation.cached("ctx")?.workerId).toBe("old");
  } finally { f.close(); }
});

test("unknown submission recovers through query alone without replaying context setup or submission", async () => {
  const f = fixture();
  try {
    const { snapshot } = reserved(f);
    f.attach("old", (_path, call) => { if (call.path === "/v1/contexts") return {}; throw new Error("lost"); });
    await f.scheduler.tick();
    retryNow(f); const paths: string[] = [];
    f.attach("old", (_path, call) => { paths.push(call.path); return { ...snapshot, lastSeq: 1 }; });
    await f.scheduler.tick();
    expect(paths).toEqual(["/v1/jobs/job/query"]);
    expect(f.scheduler.jobs.require("job").placementState).toBe("assigned");
    expect(f.scheduler.jobs.require("job").lastError).toBeUndefined();
  } finally { f.close(); }
});

test("v2 preparation rejects legacy input and forged Worker replies before caching",async()=>{
 const f=fixture();
 try{
  let calls=0;f.attach("old",()=>{calls++;return prepared;});
  const {scope:_,resources:__,protocolVersion:___,...legacy}=input;
  await expect(f.scheduler.preparation.prepare(legacy as never)).rejects.toThrow();expect(calls).toBe(0);
  for(const reply of [{...prepared,scope:{...prepared.scope,shadowId:"other"}},{...prepared,scope:{...prepared.scope,placementGeneration:2}},
   {...prepared,workerId:"new"},{...prepared,resourceRevision:"0".repeat(64)},{...prepared,resources:{...resources,publicRevision:"0".repeat(64)}}]){
   f.attach("old",()=>reply);await expect(f.scheduler.preparation.prepare(input)).rejects.toThrow();
   expect(f.scheduler.preparation.cached(input.contextId)).toBeUndefined();
  }
 }finally{f.close();}
});

test("Worker approval is rechecked after async preparation and foreign response is never cached",async()=>{
 const f=fixture();
 try{
  let allowed=["old","new"];
  const scheduler=new RuntimeScheduler(f.db,f.config,new TokenAuthority(f.db),()=>allowed);
  for(const id of ["old","new"])scheduler.workers.heartbeat(id,{workerId:id,imageDigest:`sha256:${"a".repeat(64)}`,capacity:8,occupied:id==="new" ? 1 : 0,ready:true,capabilities:["shadow-scope-v2"],projects:["project"]});
  scheduler.workers.attach("old",{async call<T>():Promise<T>{allowed=["new"];return prepared as T;}});
  await expect(scheduler.preparation.prepare(input)).rejects.toMatchObject({code:"agent_worker_access_denied"});
  expect(scheduler.preparation.cached(input.contextId)).toBeUndefined();
  expect(scheduler.placements.find(scope)?.workerId).toBe("old");
 }finally{f.close();}
});

test("unprepared jobs cannot fall back to the unscoped context router",async()=>{
 const f=fixture();
 try{
  let calls=0;for(const id of ["old","new"])f.attach(id,()=>{calls++;throw new Error("unexpected dispatch");});
  f.scheduler.submit(job);await f.scheduler.tick();
  expect(calls).toBe(0);
  expect(f.scheduler.jobs.require(job.jobId)).toMatchObject({workerId:null,lastError:{code:"context_preparation_required"}});
  expect(f.scheduler.contexts.find(job.runnerContextId)).toBeNull();
 }finally{f.close();}
});

test("prepared context cannot be reused with another owner key or Runner role",async()=>{
 for(const changed of [{scopeKey:"session:other"},{runnerKind:"work" as const}]){
  const f=fixture();
  try{
   f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
   let calls=0;f.attach("old",()=>{calls++;throw new Error("unexpected dispatch");});
   f.scheduler.submit({...job,...changed,resourceRevision:resources.digest});await f.scheduler.tick();
   expect(calls).toBe(0);
   expect(f.scheduler.jobs.require(job.jobId)).toMatchObject({workerId:null,lastError:{code:"context_preparation_mismatch"}});
  }finally{f.close();}
 }
});

test("stale prepared generation cannot acquire a Worker reservation",async()=>{
 const f=fixture();
 try{
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  f.db.prepare("UPDATE shadow_placements SET generation=2 WHERE shadow_id=?").run(scope.shadowId);
  let calls=0;f.attach("old",()=>{calls++;throw new Error("unexpected dispatch");});
  f.scheduler.submit({...job,resourceRevision:resources.digest});await f.scheduler.tick();
  expect(calls).toBe(0);
  expect(f.scheduler.jobs.require(job.jobId)).toMatchObject({workerId:null,lastError:{code:"shadow_placement_mismatch"}});
 }finally{f.close();}
});

test("Runtime rejects legacy Jobs and will not route a foreign Shadow through a prepared context",async()=>{
 const f=fixture();
 try{
  expect(()=>f.scheduler.submit({...job,version:1})).toThrow("unsupported_protocol");
  expect(f.scheduler.jobs.find(job.jobId)).toBeUndefined();
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  f.scheduler.submit({...job,scope:{...job.scope,shadowId:"foreign"}});await f.scheduler.tick();
  expect(f.scheduler.jobs.require(job.jobId)).toMatchObject({workerId:null,lastError:{code:"context_preparation_mismatch"}});
 }finally{f.close();}
});

test("file maintenance follows prepared Shadow placement and sends the fixed environment scope",async()=>{
 const {RuntimeFiles}=await import("../../src/runtime/files");
 const f=fixture();
 try{
  const files=new RuntimeFiles(f.scheduler),request={operationId:"file-op",contextId:"ctx",scopeKey:input.scopeKey,projectId:input.projectId,operation:{kind:"list",path:"workspace"}};
  await expect(files.execute(request)).rejects.toMatchObject({code:"context_preparation_required"});
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  let body:any;f.attach("old",(path,value)=>{expect(path).toBe("/v1/files");body=value;return [];});
  expect(body).toBeUndefined();
  await files.execute(request);
  expect(body.spec.scope).toEqual(prepared.scope);expect(body.spec.resourceSelection).toEqual(resources);expect(body.spec.protocolVersion).toBe(2);
  await expect(files.execute({...request,scopeKey:"session:other"})).rejects.toMatchObject({code:"context_preparation_mismatch"});
 }finally{f.close();}
});


test("preparation cleanup waits for invocation settlement and retries after Runtime restart",async()=>{
 let settled=false,calls=0;const f=fixture(()=>settled);
 try{
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  f.attach("old",(path,body)=>{expect(path).toBe("/v2/context-preparations/release");expect(body.invocationId).toBe("inv");calls++;throw new ExecutionError(503,"worker_disconnected");});
  await f.scheduler.tick();expect(calls).toBe(0);
  settled=true;await f.scheduler.tick();expect(calls).toBe(1);
  expect(f.db.prepare("SELECT state,error FROM runtime_preparation_intents WHERE invocation_id='inv'").get()).toEqual({state:"active",error:"worker_disconnected"});
  const restarted=new RuntimeScheduler(f.db,f.config,new TokenAuthority(f.db),()=>["old"],()=>true);
  restarted.workers.attach("old",{async call<T>(){calls++;return undefined as T;}});await restarted.tick();
  expect(calls).toBe(2);expect(f.db.prepare("SELECT state,error FROM runtime_preparation_intents WHERE invocation_id='inv'").get()).toEqual({state:"released",error:null});
  await expect(restarted.preparation.prepare(input)).rejects.toMatchObject({code:"invocation_preparation_conflict"});
 }finally{f.close();}
});

test("pre-Job provision returns Worker paths without a maintenance reservation or container startup",async()=>{
 const {RuntimeFiles}=await import("../../src/runtime/files");const f=fixture();
 try{
  f.attach("old",()=>prepared);await f.scheduler.preparation.prepare(input);
  let calls=0;f.attach("old",()=>{calls++;throw new Error("unexpected-maintenance-startup");});
  const request={operationId:"provision",contextId:"ctx",scopeKey:input.scopeKey,projectId:input.projectId,operation:{kind:"provision"}};
  expect(await new RuntimeFiles(f.scheduler).execute(request)).toEqual({home:prepared.home,cwd:prepared.cwd});
  expect(calls).toBe(0);
  await expect(new RuntimeFiles(f.scheduler).execute({...request,contextId:"unknown"})).rejects.toMatchObject({code:"context_preparation_required"});
  expect(calls).toBe(0);
 }finally{f.close();}
});
