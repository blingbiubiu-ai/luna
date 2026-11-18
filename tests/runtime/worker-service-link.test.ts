import {Database} from "bun:sqlite";
import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TokenAuthority} from "@luna/execution-transport";
import {EnvironmentStore} from "../../apps/worker/src/environment-store";
import {ServiceLink} from "../../apps/worker/src/service-link";
import type {EnvironmentManager} from "../../apps/worker/src/environment-manager";

test("reverse Worker becomes ready with v2 handshake and local health, without global resource sync",async()=>{
 const db=new Database(":memory:"),root=mkdtempSync(join(tmpdir(),"service-link-"));
 let globalDownloads=0;const heartbeats:any[]=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request,server){
  if(new URL(request.url).pathname==="/api/worker/connect" && server.upgrade(request))return;
  globalDownloads++;return new Response(null,{status:500});
 },websocket:{open(ws){ws.send(JSON.stringify({type:"desired",protocolVersion:2}));},message(_ws,raw){heartbeats.push(JSON.parse(String(raw)));}}});
 let finishHealth!:()=>void;const health=new Promise<void>(resolve=>{finishHealth=resolve;});
 const manager={store:new EnvironmentStore(db),driver:{layout:{home:root},config:{dataRoot:root,workerId:"worker",imageDigest:"image",capacity:2,projects:[]},health:()=>health}} as unknown as EnvironmentManager;
 const link=new ServiceLink(manager,new TokenAuthority(db),server.url.origin,"t".repeat(43));
 try{
  link.start();
  for(let i=0;i<100 && !heartbeats.length;i++)await Bun.sleep(10);
  expect(heartbeats.length).toBeGreaterThan(0);expect(link.ready).toBe(false);
  finishHealth();
  for(let i=0;i<100 && !heartbeats.some(x=>x.health?.ready);i++)await Bun.sleep(10);
  expect(link.ready).toBe(true);
  const ready=heartbeats.find(x=>x.health?.ready).health;
  expect(ready.capabilities).toEqual(["shadow-scope-v2","container-streams-v1","scope-reconcile-v1"]);
  expect(ready.revision).toBeUndefined();expect(ready.desiredRevision).toBeUndefined();expect(globalDownloads).toBe(0);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('worker_resource_state','worker_prepared_inputs')").all()).toEqual([]);
 }finally{finishHealth();link.stop();server.stop(true);db.close();rmSync(root,{recursive:true,force:true});}
});
