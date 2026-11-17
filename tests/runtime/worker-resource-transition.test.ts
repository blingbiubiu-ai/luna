import {Database} from "bun:sqlite";
import {afterEach,expect,test} from "bun:test";
import {EnvironmentManager} from "../../apps/worker/src/environment-manager";
import {EnvironmentStore} from "../../apps/worker/src/environment-store";
import {ShadowPreparationStore} from "../../apps/worker/src/shadow-preparation-store";
import type {DockerEnvironmentDriver} from "../../apps/worker/src/docker-driver";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){
 const db=new Database(":memory:");databases.push(db);
 const store=new EnvironmentStore(db),preparations=new ShadowPreparationStore(db);
 const scope={agentId:"agent",shadowId:"shadow",placementGeneration:1};
 const old=createScopedResources(scope,[]).selection;
 const next=createScopedResources(scope,[{path:"public/prompts/SOUL.md",content:Buffer.from("next").toString("base64"),mode:0o644}]).selection;
 const spec={protocolVersion:2 as const,scope,resourceSelection:old,environmentId:"luna",scopeKey:"session:one",mode:"shared" as const,imageDigest:`sha256:${"a".repeat(64)}`,callbackRuntimeId:"runtime",resources:{memory:"1g",cpus:1,pidsLimit:128}};
 const occupant={kind:"job" as const,invocationId:"old",scope,jobId:"old-job",assignmentId:"old-assignment",requestHash:"a".repeat(64),scopeKey:spec.scopeKey,contextId:"ctx"};
 const held=store.prepare({requestId:"old-request",spec,occupant});
 const input={protocolVersion:2 as const,invocationId:"next",scope,resources:next,contextId:"ctx",runnerId:"ctx",scopeKey:spec.scopeKey,runnerKind:"main" as const};
 preparations.begin(input);preparations.complete("next",{});
 const request={requestId:"new-request",spec:{...spec,resourceSelection:next},occupant:{...occupant,invocationId:"next",jobId:"new-job",assignmentId:"new-assignment"}};
 let removals=0;let duringRemove=()=>{};
 const driver={inspect:async()=>null,remove:async()=>{removals++;duringRemove();},prepareContext:async()=>{throw new Error("reached-context-preparation");}} as unknown as DockerEnvironmentDriver;
 return {store,preparations,request,held,next,scope,manager:new EnvironmentManager(store,driver),removed:()=>removals,setDuringRemove:(fn:()=>void)=>{duringRemove=fn;}};
}
test("new resource mounts wait for Job reservations before replacing the environment",async()=>{
 const f=fixture();
 await expect(f.manager.prepare(f.request)).rejects.toMatchObject({code:"environment_mount_pending"});expect(f.removed()).toBe(0);
 f.store.release("old-request",f.held.reservation.reservationId);
 await expect(f.manager.prepare(f.request)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(1);expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.next);
 expect(f.store.reservation("new-request")?.state).toBe("preparing");
});
test("file maintenance cannot select a new resource version",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 await expect(f.manager.prepare({...f.request,occupant:{kind:"maintenance",scope:f.scope,operationId:"file",operationHash:"a".repeat(64),contextId:"ctx"}})).rejects.toMatchObject({code:"environment_mount_pending"});
 expect(f.removed()).toBe(0);
});
test("preparation released during Docker removal cannot reserve the new environment",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 f.setDuringRemove(()=>f.preparations.release({invocationId:"next",contextId:"ctx",scope:f.scope,resourceRevision:f.next.digest}));
 await expect(f.manager.prepare(f.request)).rejects.toMatchObject({code:"context_preparation_released"});
 expect(f.store.reservation("new-request")).toBeUndefined();
 expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.next);
 expect(f.store.require(f.held.environment.id).state).toBe("stopped");
});

test("an active file lease blocks resource replacement",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 const held=f.store.prepare({requestId:"file-request",spec:f.held.environment.spec,occupant:{kind:"maintenance",scope:f.scope,operationId:"file",operationHash:"a".repeat(64),contextId:"ctx"}});
 await expect(f.manager.prepare(f.request)).rejects.toMatchObject({code:"environment_mount_pending"});expect(f.removed()).toBe(0);
 f.store.release("file-request",held.reservation.reservationId);
 await expect(f.manager.prepare(f.request)).rejects.toThrow("reached-context-preparation");expect(f.removed()).toBe(1);
});

test("failed Docker removal retains the target and a restarted manager resumes it",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 f.setDuringRemove(()=>{throw new Error("docker-unavailable");});
 await expect(f.manager.prepare(f.request)).rejects.toThrow("docker-unavailable");
 const pending=f.store.require(f.held.environment.id);
 expect(pending.state).toBe("draining");expect(pending.pendingSpec?.resourceSelection).toEqual(f.next);
 expect(pending.spec.resourceSelection).toEqual(f.held.environment.spec.resourceSelection);
 expect(()=>f.store.prepare({...f.request,requestId:"another"})).toThrow("environment_draining");
 f.setDuringRemove(()=>{});
 const restarted=new EnvironmentManager(new EnvironmentStore(f.store.db),f.manager.driver);
 await expect(restarted.prepare(f.request)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(2);expect(f.store.require(pending.id).pendingSpec).toBeUndefined();
 expect(f.store.require(pending.id).spec.resourceSelection).toEqual(f.next);
});

test("maintenance sweep completes an abandoned durable replacement without accepting work",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 f.store.beginReplacement(f.held.environment.id,f.request.spec);
 f.preparations.release({invocationId:"next",contextId:"ctx",scope:f.scope,resourceRevision:f.next.digest});
 const restarted=new EnvironmentManager(new EnvironmentStore(f.store.db),f.manager.driver);
 await restarted.reap();
 expect(f.removed()).toBe(1);expect(f.store.require(f.held.environment.id).state).toBe("stopped");
 expect(f.store.require(f.held.environment.id).pendingSpec).toBeUndefined();
 expect(f.store.reservation("new-request")).toBeUndefined();
});
test("changed container limits replace the idle environment instead of conflicting",async()=>{
 const f=fixture();
 const old=f.store.require(f.held.environment.id).spec;
 f.preparations.release({invocationId:"next",contextId:"ctx",scope:f.scope,resourceRevision:f.next.digest});
 const input={protocolVersion:2 as const,invocationId:"limits",scope:f.scope,resources:old.resourceSelection,contextId:"ctx2",runnerId:"ctx2",scopeKey:old.scopeKey,runnerKind:"main" as const};
 f.preparations.begin(input);f.preparations.complete("limits",{});
 const request={requestId:"limits-request",spec:{...old,resources:{memory:"512m",cpus:2,pidsLimit:256}},occupant:{...f.request.occupant,contextId:"ctx2",invocationId:"limits",jobId:"limits-job",assignmentId:"limits-assignment"}};
 await expect(f.manager.prepare(request)).rejects.toMatchObject({code:"environment_mount_pending"});expect(f.removed()).toBe(0);
 f.store.release("old-request",f.held.reservation.reservationId);
 await expect(f.manager.prepare(request)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(1);expect(f.store.require(f.held.environment.id).spec.resources).toEqual({memory:"512m",cpus:2,pidsLimit:256});
 expect(f.store.reservation("limits-request")?.state).toBe("preparing");
});
test("a reservation never sent to an Executor cancels without restarting a vanished container",async()=>{
 const f=fixture();
 const env=f.store.require(f.held.environment.id);env.containerId="vanished";f.store.saveEnvironment(env);
 await expect(f.manager.cancelPreparation("old-request")).resolves.toEqual({state:"cancelled"});
 expect(f.store.reservation("old-request")?.state).toBe("cancelled");
});
test("a reservation sent to an Executor still requires Executor-fenced cancellation",()=>{
 const f=fixture();
 const env=f.store.require(f.held.environment.id);env.containerId="vanished";f.store.saveEnvironment(env);
 f.store.markExecutorBound("old-request");
 expect(f.store.cancelPreparation("old-request",true).state).toBe("cancelling");
});
