import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openExecutionDatabase,type SqlDatabase} from "@luna/execution-store";
import {TokenAuthority} from "@luna/execution-transport";
import {RuntimeConfig} from "@/runtime/config";
import {RuntimeScheduler} from "@/runtime/scheduler";
import {WorkerGateway} from "@/runtime/worker-gateway";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import {WorkerResourceDownload} from "../../apps/worker/src/resource-download";
let home:string,workerHome:string,db:SqlDatabase,scheduler:RuntimeScheduler,gateway:WorkerGateway,server:ReturnType<typeof Bun.serve>;
let allowed:string[],token:string,workerId:string,available:boolean,lookups:number;
const scope={agentId:"agent",shadowId:"shadow"},bundle=createScopedResources(scope,[{path:"agent/memory/a",content:Buffer.from("private-memory").toString("base64"),mode:0o644}]);
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),"luna-resource-gateway-"));workerHome=mkdtempSync(join(tmpdir(),"luna-resource-worker-"));db=openExecutionDatabase(":memory:");allowed=[];available=true;lookups=0;
 const config=RuntimeConfig.parse({runtimeId:"runtime",serviceId:"service",dataRoot:home,serviceToken:"s".repeat(43),adminToken:"a".repeat(43),homeWorkerId:"local"});
 scheduler=new RuntimeScheduler(db,config,new TokenAuthority(db),()=>allowed);
 gateway=new WorkerGateway(db,scheduler,(requested,digest)=>{lookups++;return available && requested.agentId===scope.agentId && requested.shadowId===scope.shadowId && digest===bundle.selection.digest ? bundle : undefined;}, () => {});
 const bound=await gateway.http(new Request("http://localhost/api/worker/bind",{method:"POST",body:JSON.stringify({code:gateway.createCode({ ownerUserId: "owner", agentId: scope.agentId }).code})}));
 ({token,workerId}=await bound.json() as {token:string;workerId:string});allowed=[workerId];
 scheduler.workers.heartbeat(workerId,{workerId,imageDigest:`sha256:${"a".repeat(64)}`,ready:true,capacity:2,occupied:0,capabilities:["shadow-scope-v2"]});
 scheduler.placements.route(scope,allowed);
 server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:request=>gateway.http(request)});
});
afterEach(()=>{server.stop(true);gateway.close();db.close();rmSync(home,{recursive:true,force:true});rmSync(workerHome,{recursive:true,force:true});});
function request(agentId=scope.agentId,shadowId=scope.shadowId,generation="1",credential=token){
 const url=new URL(`/api/worker/resources/${bundle.selection.digest}`,server.url);url.search=new URLSearchParams({agentId,shadowId,placementGeneration:generation}).toString();
 return fetch(url,{headers:{authorization:`Bearer ${credential}`}});
}
test("real HTTP download validates placement, persists scoped bytes and never mounts or replaces HOME",async()=>{
 const downloader=new WorkerResourceDownload(workerHome,server.url.origin,token);
 const path=await downloader.sync({...scope,placementGeneration:1},bundle.selection);
 expect(await Bun.file(join(path,"agent/memory/a")).text()).toBe("private-memory");
 expect(path).toContain(`/agents/${scope.agentId}/shadow-resources/${scope.shadowId}/bundles/${bundle.selection.digest}/`);
 expect(existsSync(join(workerHome,"agents",scope.agentId,"shadows"))).toBe(false);
 expect(await downloader.sync({...scope,placementGeneration:1},bundle.selection)).toBe(path);
});
test("wrong token, scope, generation, revoked approval and unknown snapshots fail before exposure",async()=>{
 expect((await request(scope.agentId,scope.shadowId,"1","x".repeat(43))).status).toBe(401);
 expect((await request("foreign")).status).toBe(409);
 expect((await request(scope.agentId,"other")).status).toBe(409);
 expect((await request(scope.agentId,scope.shadowId,"2")).status).toBe(409);
 expect(lookups).toBe(0);
 allowed=[];expect((await request()).status).toBe(403);expect(lookups).toBe(0);
 allowed=[workerId];available=false;expect((await request()).status).toBe(404);
 gateway.action(workerId,"revoke");expect((await request()).status).toBe(401);
});
test("an authenticated different Worker cannot fetch the assigned Shadow",async()=>{
 const bound=await gateway.http(new Request("http://localhost/api/worker/bind",{method:"POST",body:JSON.stringify({code:gateway.createCode({ ownerUserId: "owner", agentId: scope.agentId }).code})}));
 const other=await bound.json() as {token:string;workerId:string};allowed.push(other.workerId);
 expect((await request(scope.agentId,scope.shadowId,"1",other.token)).status).toBe(409);expect(lookups).toBe(0);
});

test("Worker rejects a substituted bundle before creating local snapshot directories",async()=>{
 const foreign=createScopedResources({agentId:"foreign",shadowId:"foreign"},bundle.files);
 const malicious=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>Response.json(foreign)});
 try{
  const downloader=new WorkerResourceDownload(workerHome,malicious.url.origin,token);
  await expect(downloader.sync({...scope,placementGeneration:1},bundle.selection)).rejects.toThrow("scope");
  expect(existsSync(join(workerHome,"agents"))).toBe(false);
 }finally{malicious.stop(true);}
});

test("authenticated Workers cannot download the removed global resource bundle",async()=>{
 const response=await fetch(new URL("/api/worker/resources",server.url),{headers:{authorization:`Bearer ${token}`}});
 expect(response.status).toBe(404);expect(await response.json()).toEqual({code:"route_not_found"});expect(lookups).toBe(0);
});
