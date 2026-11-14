import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openExecutionDatabase,type SqlDatabase} from "@luna/execution-store";
import {WorkerRegistry} from "@/runtime/worker-registry";
import {ShadowPlacements} from "@/runtime/shadow-placements";
let home:string,db:SqlDatabase,workers:WorkerRegistry,placements:ShadowPlacements;
const image=`sha256:${"a".repeat(64)}`,scope={agentId:"agent-a",shadowId:"shadow-a"};
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-shadow-placements-"));db=openExecutionDatabase(join(home,"runtime.sqlite"));workers=new WorkerRegistry(db,"local");
 placements=new ShadowPlacements(db,workers);
 for(const id of ["one","two"]){workers.register({reverse:true,workerId:id,endpoint:"http://127.0.0.1:1",controlToken:"t".repeat(43),executorHost:"127.0.0.1",executorPortStart:41000,executorPortEnd:41100});online(id);}
});
afterEach(()=>{db.close();rmSync(home,{recursive:true,force:true});});
function online(workerId:string,occupied=0,capabilities=["shadow-scope-v2"]){workers.heartbeat(workerId,{workerId,imageDigest:image,ready:true,capacity:2,occupied,capabilities,projects:["project"]});}
test("new contexts prefer an existing Shadow Worker and spill over when it is full",()=>{
 online("one",1);
 const first=placements.bindContext(scope,"main","session:main",["one","two"]);
 expect(first.workerId).toBe("two");expect(first.generation).toBe(1);
 online("two",1);online("one",0);
 expect(placements.bindContext(scope,"second","session:second",["one","two"]).workerId).toBe("two");
 online("two",2);
 expect(placements.bindContext(scope,"task","task:task",["one","two"],"project").workerId).toBe("one");
 expect(placements.bindContext(scope,"main","session:main",["one","two"])).toEqual(first);
 expect(placements.require(scope,"one",1).workerId).toBe("one");
 expect(()=>placements.require(scope,"one",1,"main")).toThrow("shadow_placement_mismatch");
 expect(placements.route({...scope,shadowId:"other"},["one","two"]).workerId).toBe("one");
 expect(()=>placements.bindContext({...scope,shadowId:"other"},"main","session:main",["one","two"])).toThrow("context_placement_conflict");
 expect(()=>placements.bindContext(scope,"main","different",["one","two"])).toThrow("context_placement_conflict");
 expect(()=>placements.bindContext(scope,"main","session:main",["one","two"],"project")).toThrow("context_placement_conflict");
});
test("offline, drain, lost capability, or revoked access never selects a new Worker",()=>{
 const first=placements.route(scope,["one"]);
 workers.drain("one");expect(()=>placements.route(scope,["one","two"])).toThrow("shadow_worker_unavailable");
 workers.resume("one");online("one",0,[]);expect(()=>placements.route(scope,["one","two"])).toThrow("shadow_worker_unavailable");
 online("one");expect(()=>placements.route(scope,["two"])).toThrow("agent_worker_access_denied");
 const state=workers.require("one");state.lastSeen=0;db.prepare("UPDATE runtime_workers SET state=? WHERE worker_id='one'").run(JSON.stringify(state));
 expect(()=>placements.route(scope,["one","two"])).toThrow("shadow_worker_unavailable");
 expect(placements.find(scope)).toEqual(first);
 expect(()=>workers.remove("one")).toThrow("worker_still_referenced");
});
test("empty authorization and old Worker capabilities cannot create placement",()=>{
 expect(()=>placements.route(scope,[])).toThrow("agent_workers_not_configured");
 online("one",0,[]);expect(()=>placements.route(scope,["one"])).toThrow("no_scoped_worker_available");
 expect(placements.find(scope)).toBeUndefined();
 expect(()=>placements.route(scope,["two"],"foreign-project")).toThrow("no_scoped_worker_available");
 expect(placements.find(scope)).toBeUndefined();
});
test("placement survives database restart and rejects scope, Worker and generation substitution",()=>{
 const first=placements.route(scope,["one"]);
 db.close();db=openExecutionDatabase(join(home,"runtime.sqlite"));workers=new WorkerRegistry(db,"local");placements=new ShadowPlacements(db,workers);
 expect(placements.find(scope)).toEqual(first);
 expect(()=>placements.route(scope,["one","two"])).toThrow("shadow_worker_unavailable");
 online("one");expect(placements.route(scope,["one","two"])).toEqual(first);
 expect(()=>placements.require(scope,"two",1)).toThrow("shadow_placement_mismatch");
 expect(()=>placements.require(scope,"one",2)).toThrow("shadow_placement_mismatch");
 expect(()=>placements.find({...scope,agentId:"foreign"})).toThrow("shadow_placement_scope_mismatch");
 expect(()=>db.prepare("UPDATE shadow_placements SET worker_id='two'").run()).toThrow("shadow_placement_immutable");
});
test("full capacity retains ownership and waits for scheduler reservation instead of losing intent",()=>{
 online("one",2);online("two",2);
 const first=placements.route(scope,["one","two"]);expect(first.workerId).toBe("one");
 online("two",0);expect(placements.route(scope,["one","two"])).toEqual(first);
});

test("Workers with different images can own contexts in the same Shadow",()=>{
 workers.heartbeat("two",{workerId:"two",imageDigest:`sha256:${"b".repeat(64)}`,ready:true,capacity:2,occupied:0,capabilities:["shadow-scope-v2"],projects:["project"]});
 const first=placements.bindContext(scope,"general","session:general",["one"]);
 online("one",2);
 const second=placements.bindContext(scope,"android","session:android",["one","two"]);
 expect(first.workerId).toBe("one"); expect(second.workerId).toBe("two");
 expect(workers.imageDigest("one")).toBe(image);
 expect(workers.imageDigest("two")).toBe(`sha256:${"b".repeat(64)}`);
});
