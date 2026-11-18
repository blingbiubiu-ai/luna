import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import {fixtureJobScope} from "../helpers/job-scope";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {fixtureNamedSession,fixtureRunnerContext,fixtureExecutionReference} from "../helpers/platform-fixtures";
import {InvocationStore} from "@/runners/invocation-store";
import {InvocationResources} from "@/runners/invocation-resources";
import {AgentResourceBuilder} from "@/runners/agent-resource-builder";
import {PluginRegistry} from "@/plugins/registry";
import {buildLunaServiceRunnerEnv} from "@/runners/luna-service-env";
import {workInvocations} from "@/runners/main-invocation-registry";
import {ActiveAgentConfigService} from "@/agent-config";
let home:string,connection:DataConnection<typeof schema>,store:InvocationStore,resources:InvocationResources,builder:AgentResourceBuilder;
let scope:ReturnType<typeof fixtureNamedSession>;
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-invocation-resources-"));setLunaHome(home);connection=new DataConnection(schema);
 scope=fixtureNamedSession(connection.db,"session","alice");
 connection.db.insert(schema.runnerContexts).values(fixtureRunnerContext(connection.db,{id:"context",owner_type:"session",owner_id:"session",runner_type:"claude",runner_root_path:join(home,"context"),created_at:0,updated_at:0})).run();
 mkdirSync(join(home,"skills"));mkdirSync(join(home,"prompts"));writeFileSync(join(home,"prompts","MAIN.md"),"platform");
 store=new InvocationStore(connection.db);resources=new InvocationResources(connection.db,home);
 builder=new AgentResourceBuilder(connection.db,home,new PluginRegistry(),{bundledSkillsDirectory:join(home,"skills"),promptAssetsDirectory:join(home,"prompts"),repoRoot:home});
});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
function register(id:string){return store.register({id,runnerKind:"work",actorUserId:scope.ownerUserId,runnerContextId:"context",sessionId:"session",taskId:null,taskRunId:null,originId:id,
 inputSnapshot:{version:1,kind:"work",input:{sessionId:"session",runnerContextId:"context",turnId:id}} as never,contextPackIds:[]});}
function job(id:string){const selection=resources.read(id).selection;return {version: 2,scope:{agentId:scope.agentId,shadowId:scope.shadowId,placementGeneration:1},resources:selection,resourceRevision:selection.digest, jobId:`job-${id}`,invocationId:id,environmentId:"luna",runnerContextId:"context",scopeKey:"session:context",runnerKind:"work",sessionId:"session",input:{runnerType:"claude",prompt:"test"},credentialsRevision:1,timeoutMs:10000} as const;}

test("pins once, survives DB reopen, and ignores subsequent resource changes",()=>{
 register("first");const first=resources.pin("first",builder);
 writeFileSync(join(home,"prompts","MAIN.md"),"platform v2");
 expect(resources.pin("first",builder)).toEqual(first);
 register("second");const second=resources.pin("second",builder);
 expect(second.selection.digest).not.toBe(first.selection.digest);
 connection.close();connection=new DataConnection(schema);resources=new InvocationResources(connection.db,home);
 expect(resources.read("first")).toEqual(first);expect(resources.read("second")).toEqual(second);
 expect(resources.retainedReferences(first.selection.digest)).toBe(1);
});
test("revocation keeps references until verified settlement; repeated pin never revives",()=>{
 register("first");const first=resources.pin("first",builder);store.createJob("runtime",job("first"));
 store.revoke("first","test");
 expect(resources.retainedReferences(first.selection.digest)).toBe(1);
 expect(()=>resources.pin("first",builder)).toThrow("invocation_inactive");
 expect(()=>connection.db.delete(schema.invocationResourceSnapshots).where(eq(schema.invocationResourceSnapshots.invocationId,"first")).run()).toThrow("still_referenced");
 expect(()=>store.finish("first")).toThrow("invocation_jobs_active");
 store.consume({jobId:"job-first",seq:1,kind:"placement",data:{placementState:"terminal"}},()=>{});
 store.finish("first");expect(resources.retainedReferences(first.selection.digest)).toBe(0);
 expect(resources.read("first")).toEqual(first);
});
test("refuses to invent a resource snapshot for an existing attempt",()=>{
 register("first");
 const unpinned={version:2,...fixtureJobScope(scope.agentId,scope.shadowId),jobId:"job-first",invocationId:"first",environmentId:"luna",runnerContextId:"context",scopeKey:"session:context",runnerKind:"work",sessionId:"session",input:{runnerType:"claude",prompt:"test"},credentialsRevision:1,timeoutMs:10000};
 expect(()=>store.createJob("runtime",unpinned)).toThrow("invocation_resources_missing");
 // Simulate a damaged persisted attempt, which recovery must not silently repin.
 connection.db.insert(schema.runnerJobs).values({id:"job-first",runtimeId:"runtime",invocationId:"first",request:unpinned as never,requestHash:"broken",state:"pending",createdAt:0,updatedAt:0}).run();
 connection.db.update(schema.runnerInvocations).set({activeJobId:"job-first"}).where(eq(schema.runnerInvocations.id,"first")).run();
 expect(()=>resources.pin("first",builder)).toThrow("invocation_resources_missing");
 expect(()=>resources.read("first")).toThrow("invocation_resources_missing");
});
test("SQL refuses cross-scope references and immutable snapshot changes",()=>{
 register("first");const first=resources.pin("first",builder);
 const other=fixtureNamedSession(connection.db,"other","bob");
 connection.db.insert(schema.runnerContexts).values(fixtureRunnerContext(connection.db,{id:"other-context",owner_type:"session",owner_id:"other",runner_type:"claude",runner_root_path:join(home,"other-context"),created_at:0,updated_at:0})).run();
 store.register({id:"other",runnerKind:"work",actorUserId:other.ownerUserId,runnerContextId:"other-context",sessionId:"other",taskId:null,taskRunId:null,originId:"other",
 inputSnapshot:{version:1,kind:"work",input:{sessionId:"other",runnerContextId:"other-context",turnId:"other"}} as never,contextPackIds:[]});
 expect(()=>connection.db.insert(schema.invocationResourceSnapshots).values({invocationId:"other",digest:first.selection.digest,createdAt:0}).run()).toThrow("scope_mismatch");
 expect(()=>connection.db.update(schema.runnerResourceSnapshots).set({shadowId:"other"}).run()).toThrow("immutable");
 expect(()=>connection.db.update(schema.invocationResourceSnapshots).set({digest:"invalid"}).run()).toThrow("immutable");
});
test("production service env pins resources before issuing model-configured token",()=>{
 const ref=fixtureExecutionReference(connection.db),snapshot=new ActiveAgentConfigService(connection.db,undefined).resolveRevisionSnapshot(scope.agentId,ref.revisionId);
 workInvocations(connection.db).set("first",{sessionId:"session",runnerContextId:"context",turnId:"first"});
 const input={runnerKind:"work" as const,invocationId:"first",runnerContextId:"context",sessionId:"session",requestedByUserId:scope.ownerUserId,db:connection.db,agentConfig:snapshot,resourceBuilder:builder,accessTokenSigningSecret:"test-secret"};
 const env=buildLunaServiceRunnerEnv(input),first=resources.read("first");
 expect(env.LUNA_ACCESS_TOKEN).toBeTruthy();expect(resources.retainedReferences(first.selection.digest)).toBe(1);
 writeFileSync(join(home,"prompts","MAIN.md"),"updated");
 buildLunaServiceRunnerEnv(input);expect(resources.read("first")).toEqual(first);
});

test("Worker preparation rejects missing snapshot before dispatch and rechecks invocation authority",async()=>{
 const {getKernel}=await import("@/server/routes/kernel");
 const {prepareRunnerFiles}=await import("@/runners/prepare-runner-files");
 const kernel=getKernel(),oldRuntime=Object.getOwnPropertyDescriptor(kernel,"executionRuntime"),oldDatabase=Object.getOwnPropertyDescriptor(kernel,"database");
 let calls=0,revokeDuringPrepare=false;
 Object.defineProperty(kernel,"database",{configurable:true,value:connection});
 Object.defineProperty(kernel,"executionRuntime",{configurable:true,value:{prepareContext:async(request:import("@luna/runner-protocol").ContextPreparation)=>{
  calls++;
  expect(request.protocolVersion).toBe(2);expect(request.scope).toEqual({agentId:scope.agentId,shadowId:scope.shadowId});
  expect(request.resources).toEqual(pinned!.selection);
  if(revokeDuringPrepare)store.revoke("first","during preparation");
  expect(resources.read("first").selection.digest).toBe(pinned!.selection.digest);
  return {instructionFingerprint:"prepared"};
 }}});
 let pinned:ReturnType<InvocationResources["pin"]>|undefined;
 const context={id:"context",runner_root_path:join(home,"context"),runner_type:"claude",instruction_fingerprint:null};
 try{
  register("first");
  await expect(prepareRunnerFiles(context,{runnerKind:"work"} as never,undefined,"first")).rejects.toThrow("invocation_resources_missing");
  expect(calls).toBe(0);
  pinned=resources.pin("first",builder);
  await prepareRunnerFiles(context,{runnerKind:"work"} as never,undefined,"first");
  expect(calls).toBe(1);
  revokeDuringPrepare=true;
  await expect(prepareRunnerFiles(context,{runnerKind:"work"} as never,undefined,"first")).rejects.toThrow("invocation_preparation_mismatch");
  expect(calls).toBe(2);
  await expect(prepareRunnerFiles(context,{runnerKind:"work"} as never,undefined,"first")).rejects.toThrow("invocation_preparation_mismatch");
  expect(calls).toBe(2);
 }finally{
  if(oldRuntime)Object.defineProperty(kernel,"executionRuntime",oldRuntime);else delete (kernel as any).executionRuntime;
  if(oldDatabase)Object.defineProperty(kernel,"database",oldDatabase);else delete (kernel as any).database;
 }
});

test("Worker download lookup exposes only referenced snapshots of the exact Shadow",()=>{
 register("first");const first=resources.pin("first",builder);
 expect(resources.download(scope,first.selection.digest)).toEqual(first);
 const other=fixtureNamedSession(connection.db,"foreign","bob");
 expect(resources.download(other,first.selection.digest)).toBeUndefined();
 expect(resources.download(scope,"0".repeat(64))).toBeUndefined();
 store.finish("first");expect(resources.download(scope,first.selection.digest)).toBeUndefined();
 // Internal history remains readable; releasing dispatch references does not erase history.
 expect(resources.read("first")).toEqual(first);
});


test("persisted Job scope and selection must match the invocation resource reference",()=>{
 register("first");resources.pin("first",builder);const request=job("first");
 expect(()=>store.createJob("runtime",{...request,scope:{...request.scope,shadowId:"foreign"}})).toThrow("invocation_job_scope_mismatch");
 const foreign=createScopedResources({agentId:scope.agentId,shadowId:scope.shadowId},[]).selection;
 expect(()=>store.createJob("runtime",{...request,resources:foreign,resourceRevision:foreign.digest})).toThrow("invocation_job_resources_mismatch");
 expect(store.createJob("runtime",request).request).toEqual(request);
});
