import {afterEach,expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync,rmSync,readFileSync,statSync,symlinkSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {canonicalJson} from "../../src/plugins/marketplace/checksums";
import {contentHash} from "@luna/execution-store";
import {JobRequest,type Assignment,type ModelProviderReference} from "@luna/runner-protocol";
import {fixtureModelRelease} from "../fixtures/worker-model-release";
import {fixtureJobScope} from "../helpers/job-scope";
import {WorkerModelProviderManager} from "../../apps/worker/src/model-providers/manager";
import {installModelRelease} from "../../apps/worker/src/model-providers/release";
import {ContextPreparationManager} from "../../src/runtime/context-preparation";

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function harness(){
 const root=mkdtempSync(join(tmpdir(),"luna-models-")),db=new Database(":memory:");let active=true,ready=true;
 const manager=new WorkerModelProviderManager({db,dataRoot:root,workerId:"worker",active:()=>active,ready:()=>ready});manager.start();
 cleanup.push(async()=>{await manager.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {root,db,manager,deactivate:()=>active=false,disconnect:()=>ready=false,reconnect:()=>ready=true};
}
async function account(manager:WorkerModelProviderManager,agentId="agent",expectedRevision:string|null=null,requestId=crypto.randomUUID(),release=fixtureModelRelease()){
 manager.install(release);
 const summary=await manager.importAccount({agentId,pluginId:release.pluginId,providerId:release.providerId,releaseSha256:release.releaseSha256,expectedRevision,requestId,credential:{token:"fixture-secret"}});
 const reference:ModelProviderReference={kind:"worker-plugin",workerId:"worker",pluginId:release.pluginId,providerId:release.providerId,accountId:summary.accountId,credentialRevision:summary.credentialRevision,releaseSha256:release.releaseSha256};
 return {summary,reference};
}
function request(env:Record<string,string>,body:unknown){return new Request("http://model/v1/responses",{method:"POST",headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`,"content-type":"application/json"},body:JSON.stringify(body)});}

test("release validation rejects tampering, path escape, symlinks and mutated cache",()=>{
 const {root}=harness();const release=fixtureModelRelease();installModelRelease(root,release);
 const broken=structuredClone(release);broken.files[0]!.content=Buffer.from("bad").toString("base64");expect(()=>installModelRelease(root,broken)).toThrow("model_release_files_invalid");
 const escaped=structuredClone(release);escaped.files[0]!.path="../outside";expect(()=>installModelRelease(root,escaped)).toThrow("model_release_path_invalid");
 const linked=join(root,"plugins","releases","other");symlinkSync(tmpdir(),linked);expect(()=>installModelRelease(root,{...release,pluginId:"other"})).toThrow("model_release_symlink");
});
test("accounts encrypt at rest, bind ownership, keep immutable old credentials and enforce import CAS/idempotency",async()=>{
 const {manager,db,root}=harness();const id=crypto.randomUUID();const first=await account(manager,"agent",null,id);
 expect((statSync(join(root,"model-provider-secrets","master.key")).mode&0o077)).toBe(0);
 expect(JSON.stringify(db.query("SELECT * FROM worker_model_accounts").all())).not.toContain("fixture-secret");
 expect((await account(manager,"agent",null,id)).summary.credentialRevision).toBe(first.summary.credentialRevision);
 await expect(account(manager,"agent",null)).rejects.toThrow("model_account_conflict");
 expect(()=>manager.accounts.credential("other",first.reference)).toThrow();
 expect(()=>manager.accounts.credential("agent",{...first.reference,workerId:"other"})).toThrow();
 const second=await account(manager,"agent",first.summary.credentialRevision);
 expect(second.summary.credentialRevision).not.toBe(first.summary.credentialRevision);
 expect(manager.accounts.credential("agent",first.reference)).toEqual({token:"fixture-secret"});
 db.query("UPDATE worker_model_accounts SET tag=? WHERE revision=?").run(Buffer.alloc(16).toString("base64"),first.summary.credentialRevision);
 expect(()=>manager.accounts.credential("agent",first.reference)).toThrow();
});
test("invalid imports preserve current account and do not echo credentials",async()=>{
 const {manager}=harness();const first=await account(manager);
 await expect(manager.importAccount({agentId:"agent",pluginId:first.reference.pluginId,providerId:first.reference.providerId,releaseSha256:first.reference.releaseSha256,expectedRevision:first.summary.credentialRevision,requestId:crypto.randomUUID(),credential:{token:"rejected-secret"}})).rejects.toThrow("model_credential_rejected");
 expect(manager.accounts.current("agent",first.reference.pluginId,first.reference.providerId)?.credentialRevision).toBe(first.summary.credentialRevision);
});
test("validation keys scope models, stream Responses and cannot access management routes",async()=>{
 const {manager}=harness();const {reference}=await account(manager);let env!:Record<string,string>;
 await manager.validationEnvironment("agent",reference,"fixture-model",async current=>{
  env=current;expect(env.CODEX_WEB_SEARCH_MODE).toBe("disabled");expect((await manager.fetch(new Request("http://model/v1/models"))).status).toBe(401);
  expect((await manager.fetch(request(env,{model:"other"}))).status).toBe(403);
  expect((await manager.fetch(new Request("http://model/v1/model-providers/import",{headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`}}))).status).toBe(404);
  const response=await manager.fetch(request(env,{model:"fixture-model",stream:true,input:[{type:"reasoning",summary:[]},{type:"function_call_output",call_id:"call-1",output:"ok"}],tools:[{type:"function",name:"tool",parameters:{}}]}));
  expect(response.headers.get("content-type")).toBe("text/event-stream");expect(await response.text()).toContain("response.completed");
  const plain=await (await manager.fetch(request(env,{model:"fixture-model",input:"hello"}))).json() as any;expect(plain.received.input).toBe("hello");expect(plain.sessionId).toStartWith("agent:validation:");
 });
 expect((await manager.fetch(request(env,{model:"fixture-model"}))).status).toBe(401);
});
test("accepted Job pins model/source, renewal keeps key, termination and disconnection revoke access",async()=>{
 const h=harness();const {manager}=h;const {reference}=await account(manager);
 const job=JobRequest.parse({version:2,jobId:"job",invocationId:"inv",...fixtureJobScope(),environmentId:"env",runnerContextId:"context",scopeKey:"session:context",runnerKind:"main",sessionId:"session",input:{runnerType:"codex",model:"fixture-model",modelProvider:reference,prompt:"hi"},credentialsRevision:1,timeoutMs:60000});
 const assignment:Assignment={jobId:"job",assignmentId:"assignment",reservationId:"reservation",instanceId:"instance",workerId:"worker",executionEnvironmentId:"env",contextId:"context",scopeKey:job.scopeKey,scope:job.scope,requestHash:contentHash(job)};
 expect(()=>manager.jobEnvironment(reference,assignment,Date.now()+10000)).toThrow();manager.bindJob({job,assignment});
 const env=manager.jobEnvironment(reference,assignment,Date.now()+10000);expect(manager.jobEnvironment(reference,assignment,Date.now()+20000).OPENAI_API_KEY).toBe(env.OPENAI_API_KEY);
 expect(()=>manager.jobEnvironment({...reference,accountId:"other"},assignment,Date.now()+10000)).toThrow();
 h.disconnect();expect((await manager.fetch(request(env,{model:"fixture-model"}))).status).toBe(401);
 manager.reconcile();h.reconnect();const resumed=await manager.fetch(request(env,{model:"fixture-model"}));expect(resumed.status).toBe(200);await resumed.text();
 h.deactivate();manager.reconcile();expect((await manager.fetch(request(env,{model:"fixture-model"}))).status).toBe(401);
 manager.revokeJob("job");expect((await manager.fetch(request(env,{model:"fixture-model"}))).status).toBe(401);
});
test("stream cancellation releases Agent concurrency; crash fails once and a later request rebuilds the child",async()=>{
 const {manager}=harness();const {reference}=await account(manager);
 await manager.validationEnvironment("agent",reference,"fixture-model",async env=>{
  const response=await manager.fetch(request(env,{model:"fixture-model",input:"slow"}));const reader=response.body!.getReader();await reader.read();
  expect((await manager.fetch(request(env,{model:"fixture-model"}))).status).toBe(429);await reader.cancel();
  expect((await manager.fetch(request(env,{model:"fixture-model",input:"crash"}))).status).toBe(502);
  await Bun.sleep(50);const next=await manager.fetch(request(env,{model:"fixture-model"}));expect(next.status).toBe(200);await next.text();
  manager.disable("agent",reference.pluginId);expect((await manager.fetch(request(env,{model:"fixture-model"}))).status).toBe(401);
 });
});
test("plugin preparation rejects a conflicting Shadow Worker and old Workers",async()=>{
 const {reference}=await account(harness().manager);const db=new Database(":memory:");cleanup.push(async()=>db.close());
 let worker="other";const scheduler={allowedWorkers:()=>["worker","other"],placements:{boundWorkerId:()=>worker,context:()=>undefined},workers:{require:()=>({health:{capabilities:[]}})}} as any;
 const preparation=new ContextPreparationManager(db,scheduler);
 const input={protocolVersion:2 as const,scope:{agentId:"agent",shadowId:"shadow"},resources:fixtureJobScope().resources,invocationId:"inv",contextId:"ctx",runnerId:"ctx",scopeKey:"session:ctx",runnerKind:"main" as const,modelProvider:reference};
 await expect(preparation.prepare(input)).rejects.toThrow("model_worker_binding_conflict");worker="worker";
 await expect(preparation.prepare(input)).rejects.toThrow("worker_model_provider_unsupported");
});

test("Worker forwards exact cache usage and retry-after while filtering unrelated response headers",async()=>{
 const {manager}=harness();const release=fixtureModelRelease();const file=release.files.find(f=>f.path==="worker.js")!;
 let code=Buffer.from(file.content,"base64").toString().replace('const input=await request.json();','const input=await request.json();if(input.input==="rate-limit")return Response.json({error:{type:"rate_limit_error"}},{status:429,headers:{"retry-after":"7","set-cookie":"private-provider-cookie"}});');
 code=code.replace('usage:{input_tokens:5,output_tokens:5,total_tokens:10}','usage:{input_tokens:1200,output_tokens:40,total_tokens:1240,input_tokens_details:{cached_tokens:1000,cache_write_tokens:100},output_tokens_details:{reasoning_tokens:12}}');
 file.content=Buffer.from(code).toString("base64");const sums=JSON.parse(release.checksums);sums.files.find((f:any)=>f.path==="worker.js").sha256=createHash("sha256").update(code).digest("hex");release.checksums=canonicalJson(sums);release.releaseSha256=createHash("sha256").update(release.checksums).digest("hex");
 const {reference}=await account(manager,"agent",null,crypto.randomUUID(),release);
 await manager.validationEnvironment("agent",reference,"fixture-model",async env=>{
  const limited=await manager.fetch(request(env,{model:"fixture-model",input:"rate-limit"}));expect(limited.status).toBe(429);expect(limited.headers.get("retry-after")).toBe("7");expect(limited.headers.get("set-cookie")).toBeNull();await limited.text();
  const stream=await (await manager.fetch(request(env,{model:"fixture-model",stream:true,input:"hello"}))).text();
  const event=stream.split("\n").filter(l=>l.startsWith("data: ")).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==="response.completed");
  expect(event.response.usage.input_tokens_details).toEqual({cached_tokens:1000,cache_write_tokens:100});expect(event.response.usage.input_tokens).toBe(1200);expect(event.response.usage.output_tokens_details.reasoning_tokens).toBe(12);
 });
});
