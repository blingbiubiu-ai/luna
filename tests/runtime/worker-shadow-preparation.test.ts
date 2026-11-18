import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ShadowPreparation} from "../../apps/worker/src/shadow-preparation";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
let root:string,db:Database,server:ReturnType<typeof Bun.serve>,preparer:ShadowPreparation,downloads:number,deny:boolean;
const scope={agentId:"agent",shadowId:"shadow",placementGeneration:1};
const files=["public/prompts/main/filesystem.md","public/prompts/main/input.md","public/prompts/main/messaging.md","public/prompts/main/reply.md","public/prompts/main/role.md","public/prompts/main/routing.md","public/prompts/main/session-commands.md","public/prompts/main/task-commands.md","public/prompts/shared/artifacts.md","public/prompts/shared/confidentiality.md","public/prompts/shared/identity.md","public/prompts/shared/memory.md","public/prompts/shared/reply-protocol.md","public/prompts/shared/root-access.md","public/prompts/shared/runner-context.md","public/prompts/shared/runtime.md","public/prompts/task/evidence.md","public/prompts/task/role.md","public/prompts/work/reply.md","public/prompts/work/role.md","public/prompts/extra.md"].map(path=>({path,content:Buffer.from(path).toString("base64"),mode:0o644}));
const bundle=createScopedResources(scope,files);
const input={invocationId:"inv",protocolVersion:2,scope,resources:bundle.selection,contextId:"ctx",runnerId:"ctx",scopeKey:"session:one",runnerKind:"main",context:{sessionId:"one"}};
beforeEach(()=>{
 root=realpathSync(mkdtempSync(join(tmpdir(),"shadow-prepare-")));db=new Database(join(root,"worker.sqlite"));downloads=0;deny=false;
 server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){downloads++;expect(request.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);return deny ? new Response(null,{status:403}) : Response.json(bundle);}});
 preparer=new ShadowPreparation(db,root,"worker",server.url.origin,"t".repeat(43));
});
afterEach(()=>{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});});
test("v2 prepare downloads fixed resources, writes scoped context, and persists replay without rewriting",async()=>{
 const reply=await preparer.prepare(input);
 expect(reply.scope).toEqual(scope);expect(reply.resources).toEqual(bundle.selection);
 expect(reply.home).toBe(join(root,"agents/agent/shadows/shadow"));
 expect(reply.cwd).toBe(join(reply.home,"runners/ctx"));
 expect(JSON.parse(readFileSync(join(reply.cwd,".luna/runner-context.json"),"utf8"))).toEqual(input.context);
 expect(readFileSync(join(reply.cwd,"AGENTS.md"),"utf8")).toContain("public/prompts/main/role.md");
 const restarted=new ShadowPreparation(db,root,"worker",server.url.origin,"t".repeat(43));
 expect(await restarted.prepare(input)).toEqual(reply);expect(downloads).toBe(2);
 deny=true;await expect(restarted.prepare(input)).rejects.toMatchObject({code:"scoped_resource_download_failed"});
});
test("preparation keeps context ownership and rejects resource replacement while references remain",async()=>{
 await preparer.prepare(input);
 await expect(preparer.prepare({...input,scopeKey:"session:other"})).rejects.toMatchObject({code:"context_preparation_conflict"});
 await expect(preparer.prepare({...input,scope:{...scope,shadowId:"other"}})).rejects.toMatchObject({code:"context_preparation_conflict"});
 const next=createScopedResources(scope,[...files,{path:"agent/tools/new.md",content:"",mode:0o644}]);
 await expect(preparer.prepare({...input,invocationId:"next",contextId:"next",runnerId:"next",resources:next.selection})).rejects.toMatchObject({code:"shadow_resources_pending"});
 expect(downloads).toBe(1);
});
test("legacy and mismatched context IDs fail before downloading or writing",async()=>{
 await expect(preparer.prepare({...input,protocolVersion:1})).rejects.toMatchObject({code:"invalid_context_preparation"});
 await expect(preparer.prepare({...input,runnerId:"other"})).rejects.toMatchObject({code:"runner_context_mismatch"});
 expect(downloads).toBe(0);
 expect(db.prepare("SELECT count(*) AS n FROM worker_shadow_preparations").get()).toEqual({n:0});
});

test("replay rejects missing historical HOME instead of returning stale paths",async()=>{
 const first=await preparer.prepare(input);rmSync(first.home,{recursive:true});
 await expect(preparer.prepare(input)).rejects.toMatchObject({code:"shadow_storage_missing"});
});


test("settled preparation leaves a tombstone while the next invocation can reuse the context",async()=>{
 await preparer.prepare(input);
 const release={invocationId:"inv",contextId:"ctx",scope,resourceRevision:bundle.selection.digest};
 preparer.store.release(release);
 await expect(preparer.prepare(input)).rejects.toMatchObject({code:"context_preparation_released"});
 const next={...input,invocationId:"next",context:{sessionId:"next"}};const reply=await preparer.prepare(next);
 preparer.store.release(release);
 expect(preparer.store.requireLive("next").state).toBe("prepared");
 expect(JSON.parse(readFileSync(join(reply.cwd,".luna/runner-context.json"),"utf8"))).toEqual(next.context);
});
test("cancellation before prepare fences late requests and active Job reservations prevent release",async()=>{
 const release={invocationId:"inv",contextId:"ctx",scope,resourceRevision:bundle.selection.digest};
 preparer.store.release(release);await expect(preparer.prepare(input)).rejects.toMatchObject({code:"context_preparation_released"});expect(downloads).toBe(0);
 const next={...input,invocationId:"next"};await preparer.prepare(next);
 const {EnvironmentStore}=await import("../../apps/worker/src/environment-store");const environments=new EnvironmentStore(db);
 const request={requestId:"job-prep",occupant:{kind:"job",invocationId:"next",scope,jobId:"job",assignmentId:"assignment",requestHash:"a".repeat(64),scopeKey:input.scopeKey,contextId:"ctx"},spec:{protocolVersion:2,scope,resourceSelection:bundle.selection,environmentId:"luna",scopeKey:input.scopeKey,mode:"shared",imageDigest:`sha256:${"a".repeat(64)}`,callbackRuntimeId:"runtime",resources:{memory:"1g",cpus:1,pidsLimit:128}}};
 const held=environments.prepare(request);
 expect(()=>preparer.store.release({...release,invocationId:"next"})).toThrow("preparation_still_reserved");
 environments.release(request.requestId,held.reservation.reservationId);preparer.store.release({...release,invocationId:"next"});
 expect(()=>preparer.store.requireLive("next")).toThrow("context_preparation_released");
});


test("release during download fences the in-flight preparation before HOME or context writes",async()=>{
 server.reload({fetch(){
  preparer.store.release({invocationId:"inv",contextId:"ctx",scope,resourceRevision:bundle.selection.digest});
  return Response.json(bundle);
 }});
 await expect(preparer.prepare(input)).rejects.toMatchObject({code:"context_preparation_released"});
 expect(existsSync(join(root,"agents/agent/shadows/shadow"))).toBe(false);
 expect(preparer.store.get("inv")?.state).toBe("released");
});

test("the soul sent with a preparation heads the Runner instructions",async()=>{
 const reply=await preparer.prepare({...input,soul:{name:"影小黑",agent:"悟空",owner:{id:"owner",name:"王华杰"},persona:["说话干脆。"]}});
 const agents=readFileSync(join(reply.cwd,"AGENTS.md"),"utf8");
 expect(agents.startsWith('<soul>\n{"name":"影小黑","agent":"悟空","owner":{"id":"owner","name":"王华杰"}}\n\n说话干脆。\n</soul>')).toBe(true);
});
