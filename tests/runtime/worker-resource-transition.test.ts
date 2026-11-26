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
 // An older Task prepared the old snapshot first; it is still running when the next version arrives.
 preparations.begin({protocolVersion:2 as const,invocationId:"older",scope,resources:old,contextId:"older-ctx",runnerId:"older-ctx",scopeKey:"task:older:codex",runnerKind:"task" as const});
 preparations.complete("older",{});
 const input={protocolVersion:2 as const,invocationId:"next",scope,resources:next,contextId:"ctx",runnerId:"ctx",scopeKey:spec.scopeKey,runnerKind:"main" as const};
 preparations.begin(input);preparations.complete("next",{});
 const request={requestId:"new-request",spec:{...spec,resourceSelection:next},occupant:{...occupant,invocationId:"next",jobId:"new-job",assignmentId:"new-assignment"}};
 let removals=0;let duringRemove=()=>{};const limitUpdates:unknown[]=[];
 const driver={inspect:async()=>null,remove:async()=>{removals++;duringRemove();},updateLimits:async(_env:unknown,limits:unknown)=>{limitUpdates.push(limits);},
  prepareContext:async()=>{throw new Error("reached-context-preparation");}} as unknown as DockerEnvironmentDriver;
 // An image change is the only transition that still replaces the container.
 const imageRequest={...request,spec:{...request.spec,imageDigest:`sha256:${"b".repeat(64)}`}};
 const olderRequest={requestId:"older-request",spec:{...spec,scopeKey:"task:older:codex"},occupant:{...occupant,invocationId:"older",jobId:"older-job",assignmentId:"older-assignment",scopeKey:"task:older:codex",contextId:"older-ctx"}};
 return {store,preparations,request,imageRequest,olderRequest,held,next,old,scope,manager:new EnvironmentManager(store,driver),removed:()=>removals,limitUpdates,setDuringRemove:(fn:()=>void)=>{duringRemove=fn;}};
}
test("a newer snapshot switches under a running Job without replacing the container",async()=>{
 const f=fixture();
 await expect(f.manager.prepare(f.request)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(0);expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.next);
 expect(f.store.require(f.held.environment.id).state).not.toBe("draining");
 expect(f.store.reservation("old-request")?.state).toBe("preparing");
 expect(f.store.reservation("new-request")?.state).toBe("preparing");
});
test("a Job prepared with an older snapshot runs on the current one instead of switching back",async()=>{
 const f=fixture();
 await expect(f.manager.prepare(f.request)).rejects.toThrow("reached-context-preparation");
 await expect(f.manager.prepare(f.olderRequest)).rejects.toThrow("reached-context-preparation");
 expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.next);
 expect(f.store.reservation("older-request")?.state).toBe("preparing");
});
test("file maintenance runs on the current snapshot and does not select another",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 await expect(f.manager.prepare({...f.request,occupant:{kind:"maintenance",scope:f.scope,operationId:"file",operationHash:"a".repeat(64),contextId:"ctx"}})).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(0);expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.old);
});
test("preparation released during image replacement cannot reserve the new environment",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 f.setDuringRemove(()=>f.preparations.release({invocationId:"next",contextId:"ctx",scope:f.scope,resourceRevision:f.next.digest}));
 await expect(f.manager.prepare(f.imageRequest)).rejects.toMatchObject({code:"context_preparation_released"});
 expect(f.store.reservation("new-request")).toBeUndefined();
 expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.next);
 expect(f.store.require(f.held.environment.id).state).toBe("stopped");
});

test("an active file lease does not hold back a snapshot switch",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 f.store.prepare({requestId:"file-request",spec:f.held.environment.spec,occupant:{kind:"maintenance",scope:f.scope,operationId:"file",operationHash:"a".repeat(64),contextId:"ctx"}});
 await expect(f.manager.prepare(f.request)).rejects.toThrow("reached-context-preparation");expect(f.removed()).toBe(0);
 expect(f.store.require(f.held.environment.id).spec.resourceSelection).toEqual(f.next);
});

test("failed Docker removal on an image change retains the target and a restarted manager resumes it",async()=>{
 const f=fixture();f.store.release("old-request",f.held.reservation.reservationId);
 f.setDuringRemove(()=>{throw new Error("docker-unavailable");});
 await expect(f.manager.prepare(f.imageRequest)).rejects.toThrow("docker-unavailable");
 const pending=f.store.require(f.held.environment.id);
 expect(pending.state).toBe("draining");expect(pending.pendingSpec?.resourceSelection).toEqual(f.next);
 expect(pending.spec.resourceSelection).toEqual(f.held.environment.spec.resourceSelection);
 expect(()=>f.store.prepare({...f.request,requestId:"another"})).toThrow("environment_draining");
 f.setDuringRemove(()=>{});
 const restarted=new EnvironmentManager(new EnvironmentStore(f.store.db),f.manager.driver);
 await expect(restarted.prepare(f.imageRequest)).rejects.toThrow("reached-context-preparation");
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
test("changed container limits apply in place to the idle environment",async()=>{
 const f=fixture();
 const old=f.store.require(f.held.environment.id).spec;
 f.preparations.release({invocationId:"next",contextId:"ctx",scope:f.scope,resourceRevision:f.next.digest});
 const input={protocolVersion:2 as const,invocationId:"limits",scope:f.scope,resources:old.resourceSelection,contextId:"ctx2",runnerId:"ctx2",scopeKey:old.scopeKey,runnerKind:"main" as const};
 f.preparations.begin(input);f.preparations.complete("limits",{});
 const request={requestId:"limits-request",spec:{...old,resources:{memory:"512m",cpus:2,pidsLimit:256}},occupant:{...f.request.occupant,contextId:"ctx2",invocationId:"limits",jobId:"limits-job",assignmentId:"limits-assignment"}};
 await expect(f.manager.prepare(request)).rejects.toMatchObject({code:"environment_mount_pending"});expect(f.removed()).toBe(0);
 f.store.release("old-request",f.held.reservation.reservationId);
 await expect(f.manager.prepare(request)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(0);expect(f.limitUpdates).toEqual([{memory:"512m",cpus:2,pidsLimit:256}]);
 expect(f.store.require(f.held.environment.id).spec.resources).toEqual({memory:"512m",cpus:2,pidsLimit:256});
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
test("system disk reset is refused for another Agent or a running Job, then removes only the container",async()=>{
 const f=fixture(),id=f.held.environment.id;
 await expect(f.manager.reset(id,"other-agent")).rejects.toMatchObject({code:"environment_agent_mismatch"});
 await expect(f.manager.reset(id,"agent")).rejects.toMatchObject({code:"environment_occupied"});expect(f.removed()).toBe(0);
 f.store.release("old-request",f.held.reservation.reservationId);
 await f.manager.reset(id,"agent");
 expect(f.removed()).toBe(1);expect(f.store.require(id).state).toBe("stopped");
 // The same environment record (HOME binding, instance) is reused by the next preparation.
 expect(f.store.require(id).instanceId).toBe(f.held.environment.instanceId);
});
test("a console on a stopped environment from an older image replaces it with the Worker's image",async()=>{
 const f=fixture(),id=f.held.environment.id;
 f.store.release("old-request",f.held.reservation.reservationId);
 const ensured:string[]=[];
 Object.assign(f.manager.driver,{config:{imageDigest:`sha256:${"c".repeat(64)}`,runtimeId:"runtime"},home:()=>"/home",
  ensure:async(env:{spec:{imageDigest:string}})=>{ensured.push(env.spec.imageDigest);throw new Error("reached-ensure");}});
 await expect(f.manager.streamTarget(id,"agent")).rejects.toThrow("reached-ensure");
 expect(f.removed()).toBe(1);expect(ensured).toEqual([`sha256:${"c".repeat(64)}`]);
 expect(f.store.require(id).spec.imageDigest).toBe(`sha256:${"c".repeat(64)}`);
});
test("turning the Shadow root switch on replaces the idle container; file maintenance keeps the current switch",async()=>{
 const f=fixture(),id=f.held.environment.id;
 f.store.release("old-request",f.held.reservation.reservationId);
 // Maintenance with the same snapshot never changes root, so it reaches context preparation without replacement.
 const file={...f.request,spec:{...f.held.environment.spec,rootAccess:true},occupant:{kind:"maintenance" as const,scope:f.scope,operationId:"file",operationHash:"a".repeat(64),contextId:"ctx"}};
 await expect(f.manager.prepare(file)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(0);expect(f.store.require(id).spec.rootAccess).toBeUndefined();
 f.store.db.prepare("DELETE FROM worker_reservations WHERE request_id=?").run("new-request");
 f.store.db.prepare("DELETE FROM worker_reservations WHERE json_extract(record_json,'$.occupant.kind')='maintenance'").run();
 const job={...f.request,requestId:"root-request",spec:{...f.request.spec,rootAccess:true}};
 await expect(f.manager.prepare(job)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(1);expect(f.store.require(id).spec.rootAccess).toBe(true);
});
test("active console streams defer background replacement during reap, and system disk reset notifies streamCloser",async()=>{
 const f=fixture(),id=f.held.environment.id;
 f.store.release("old-request",f.held.reservation.reservationId);
 expect(f.store.require(id).idleSince).not.toBeNull();
 f.manager.acquireStream(id);
 expect(f.store.require(id).idleSince).toBeNull();
 f.store.beginReplacement(id,f.imageRequest.spec);
 // While a stream is open, background reap must not delete the container out from under the user.
 await expect(f.manager.reap()).rejects.toMatchObject({code:"environment_mount_pending"});
 expect(f.removed()).toBe(0);
 f.manager.releaseStream(id);
 await f.manager.reap();
 expect(f.removed()).toBe(1);
 expect(f.store.require(id).idleSince).not.toBeNull();

 const closed:string[]=[];
 f.manager.setStreamCloser((envId,reason)=>closed.push(`${envId}:${reason}`));
 await f.manager.reset(id,"agent");
 expect(closed).toEqual([`${id}:system_disk_reset`]);
});

test("reconciles stale ready reservations when the backing container vanished so image replacement succeeds",async()=>{
 const f=fixture(),id=f.held.environment.id;
 f.store.ready("old-request",{containerId:"vanished-container",endpoint:"http://127.0.0.1:41000",bootId:"boot-1"});
 expect(f.store.active(id)).toHaveLength(1);
 // Backing container is gone (inspect returns null): prepare with a new image auto-releases the stale reservation and replaces.
 await expect(f.manager.prepare(f.imageRequest)).rejects.toThrow("reached-context-preparation");
 expect(f.removed()).toBe(1);
 expect(f.store.reservation("old-request")?.state).toBe("released");
 expect(f.store.require(id).spec.imageDigest).toBe(f.imageRequest.spec.imageDigest);
});

test("reap reconciles stale ready reservations when the backing container is stopped",async()=>{
 const f=fixture(),id=f.held.environment.id;
 f.store.ready("old-request",{containerId:"stopped-container",endpoint:"http://127.0.0.1:41000",bootId:"boot-1"});
 const stoppedDriver={...(f.manager.driver as object),inspect:async()=>({Id:"stopped-container",State:{Running:false}})} as unknown as DockerEnvironmentDriver;
 const manager=new EnvironmentManager(f.store,stoppedDriver);
 await manager.reap();
 expect(f.store.reservation("old-request")?.state).toBe("released");
 expect(f.store.active(id)).toHaveLength(0);
});

test("preserves ready reservations while the backing container is still running",async()=>{
 const f=fixture(),id=f.held.environment.id;
 f.store.ready("old-request",{containerId:"live-container",endpoint:"http://127.0.0.1:41000",bootId:"boot-1"});
 const liveDriver={...(f.manager.driver as object),inspect:async()=>({Id:"live-container",State:{Running:true}})} as unknown as DockerEnvironmentDriver;
 const manager=new EnvironmentManager(f.store,liveDriver);
 await expect(manager.prepare(f.imageRequest)).rejects.toMatchObject({code:"environment_mount_pending"});
 expect(f.store.reservation("old-request")?.state).toBe("ready");
 expect(f.removed()).toBe(0);
});
