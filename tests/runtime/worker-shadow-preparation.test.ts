import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ShadowPreparation} from "../../apps/worker/src/shadow-preparation";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
let served:{selection:unknown}|undefined;let root:string,db:Database,server:ReturnType<typeof Bun.serve>,preparer:ShadowPreparation,downloads:number,deny:boolean;
const scope={agentId:"agent",shadowId:"shadow",placementGeneration:1};
const files=["public/prompts/main/filesystem.md","public/prompts/main/input.md","public/prompts/main/messaging.md","public/prompts/main/reply.md","public/prompts/main/role.md","public/prompts/main/routing.md","public/prompts/main/session-commands.md","public/prompts/main/task-commands.md","public/prompts/shared/artifacts.md","public/prompts/shared/confidentiality.md","public/prompts/shared/directories.md","public/prompts/shared/identity.md","public/prompts/shared/memory.md","public/prompts/shared/reply-protocol.md","public/prompts/shared/root-access.md","public/prompts/shared/runner-context.md","public/prompts/shared/runtime.md","public/prompts/task/evidence.md","public/prompts/task/role.md","public/prompts/work/reply.md","public/prompts/work/role.md","public/prompts/extra.md"].map(path=>({path,content:Buffer.from(path.endsWith("/directories.md")?readFileSync(join(import.meta.dir,"../../src/prompts/shared/directories.md"),"utf8"):path).toString("base64"),mode:0o644}));
const bundle=createScopedResources(scope,files);
const input={invocationId:"inv",protocolVersion:2,scope,resources:bundle.selection,contextId:"ctx",runnerId:"ctx",scopeKey:"session:one",runnerKind:"main",context:{sessionId:"one"}};
beforeEach(()=>{
 served=undefined;root=realpathSync(mkdtempSync(join(tmpdir(),"shadow-prepare-")));db=new Database(join(root,"worker.sqlite"));downloads=0;deny=false;
 server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){downloads++;expect(request.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);return deny ? new Response(null,{status:403}) : Response.json(served ?? bundle);}});
 preparer=new ShadowPreparation(db,root,"worker",server.url.origin,"t".repeat(43));
});
afterEach(()=>{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});});
test("v2 prepare downloads fixed resources, writes scoped context, and persists replay without rewriting",async()=>{
 const reply=await preparer.prepare(input);
 expect(reply.scope).toEqual(scope);expect(reply.resources).toEqual(bundle.selection);
 // The container sees HOME at /home/luna; the files are written to the Worker's host directory.
 expect(reply.home).toBe("/home/luna");
 expect(reply.cwd).toBe("/home/luna/runners/ctx");
 expect(reply.hostCwd).toBe(join(root,"agents/agent/shadows/shadow/runners/ctx"));
 expect(JSON.parse(readFileSync(join(reply.hostCwd!,".luna/runner-context.json"),"utf8"))).toEqual(input.context);
 const agents=readFileSync(join(reply.hostCwd!,"AGENTS.md"),"utf8");
 expect(agents).toContain("public/prompts/main/role.md");
 expect(agents).toContain("/home/luna/runners/ctx");expect(agents).not.toContain(root);
 const restarted=new ShadowPreparation(db,root,"worker",server.url.origin,"t".repeat(43));
 expect(await restarted.prepare(input)).toEqual(reply);expect(downloads).toBe(2);
 deny=true;await expect(restarted.prepare(input)).rejects.toMatchObject({code:"scoped_resource_download_failed"});
});
test("preparation keeps context ownership; a new resource version does not wait for older references",async()=>{
 await preparer.prepare(input);
 await expect(preparer.prepare({...input,scopeKey:"session:other"})).rejects.toMatchObject({code:"context_preparation_conflict"});
 await expect(preparer.prepare({...input,scope:{...scope,shadowId:"other"}})).rejects.toMatchObject({code:"context_preparation_conflict"});
 // Another placement of the Shadow still waits until this one is released.
 await expect(preparer.prepare({...input,invocationId:"moved",contextId:"moved",runnerId:"moved",scope:{...scope,placementGeneration:2}})).rejects.toMatchObject({code:"shadow_resources_pending"});
 const next=createScopedResources(scope,[...files,{path:"public/prompts/next.md",content:Buffer.from("next").toString("base64"),mode:0o644}]);
 served=next;
 const reply=await preparer.prepare({...input,invocationId:"next",contextId:"next",runnerId:"next",resources:next.selection});
 expect(reply.resources).toEqual(next.selection);
 expect(preparer.store.newer(scope,next.selection.digest,bundle.selection.digest)).toBe(true);
 expect(preparer.store.newer(scope,bundle.selection.digest,next.selection.digest)).toBe(false);
});
test("legacy and invalid preparations fail before downloading or writing",async()=>{
 await expect(preparer.prepare({...input,protocolVersion:1})).rejects.toMatchObject({code:"invalid_context_preparation"});
 await expect(preparer.prepare({...input,runnerId:"../escape"})).rejects.toMatchObject({code:"invalid_context_preparation"});
 expect(downloads).toBe(0);
 expect(db.prepare("SELECT count(*) AS n FROM worker_shadow_preparations").get()).toEqual({n:0});
});

test("replay rejects missing historical HOME instead of returning stale paths",async()=>{
 await preparer.prepare(input);rmSync(join(root,"agents/agent/shadows/shadow"),{recursive:true});
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
 expect(JSON.parse(readFileSync(join(reply.hostCwd!,".luna/runner-context.json"),"utf8"))).toEqual(next.context);
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
 const agents=readFileSync(join(reply.hostCwd!,"AGENTS.md"),"utf8");
 expect(agents.startsWith('<soul>\n{"name":"影小黑","agent":"悟空","owner":{"id":"owner","name":"王华杰"}}\n\n说话干脆。\n</soul>')).toBe(true);
});

test("contexts of one owner share its directory, so a Runner switch keeps the files",async()=>{
 const codex=await preparer.prepare({...input,runnerId:"session-one"});
 expect(codex.cwd).toBe(join(codex.home,"runners/session-one"));
 await Bun.write(join(codex.hostCwd!,"workspace/notes.md"),"kept");
 preparer.store.release({invocationId:"inv",contextId:"ctx",scope,resourceRevision:bundle.selection.digest});
 const claude=await preparer.prepare({...input,invocationId:"claude",contextId:"ctx-claude",runnerId:"session-one",runnerKind:"main"});
 expect(claude.cwd).toBe(codex.cwd);
 expect(readFileSync(join(claude.hostCwd!,"workspace/notes.md"),"utf8")).toBe("kept");
});

test("a context created before keeps its own directory; a legacy table loses its unique cwd",async()=>{
 const legacy=join(root,"legacy");
 const old=new Database(join(root,"legacy.sqlite"));
 old.exec(`CREATE TABLE worker_shadow_layouts (shadow_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, home TEXT UNIQUE NOT NULL, runners TEXT UNIQUE NOT NULL);
  CREATE TABLE worker_shadow_context_paths (context_id TEXT PRIMARY KEY, shadow_id TEXT NOT NULL REFERENCES worker_shadow_layouts(shadow_id), cwd TEXT UNIQUE NOT NULL);
  CREATE TRIGGER worker_shadow_context_path_immutable BEFORE UPDATE ON worker_shadow_context_paths BEGIN SELECT RAISE(ABORT,'shadow_context_path_immutable'); END;`);
 const {mkdirSync}=await import("node:fs");
 const home=join(legacy,"agents/agent/shadows/shadow"),before=join(home,"runners/old-ctx");
 mkdirSync(before,{recursive:true});mkdirSync(join(legacy,"agents/agent/shadow-resources/shadow/credentials"),{recursive:true});
 old.prepare("INSERT INTO worker_shadow_layouts VALUES (?,?,?,?)").run("shadow","agent",home,join(home,"runners"));
 old.prepare("INSERT INTO worker_shadow_context_paths VALUES (?,?,?)").run("old-ctx","shadow",before);
 const {WorkerShadowLayouts}=await import("../../apps/worker/src/shadow-layout");
 // Opening migrates the table; the old context keeps its directory, new ones share the owner's.
 const layouts=new WorkerShadowLayouts(old,legacy);
 expect((old.prepare("SELECT sql FROM sqlite_master WHERE name='worker_shadow_context_paths'").get() as {sql:string}).sql).not.toContain("UNIQUE");
 expect(layouts.context(scope,"old-ctx","session-one").cwd).toBe(before);
 expect(layouts.context(scope,"a","session-one").cwd).toBe(layouts.context(scope,"b","session-one").cwd);
 expect(()=>old.exec("UPDATE worker_shadow_context_paths SET cwd='x'")).toThrow("shadow_context_path_immutable");
 old.close();
});
