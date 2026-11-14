import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,readFileSync,chmodSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq,sql} from "drizzle-orm";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {AgentDocumentStore,DocumentConflictError} from "@/agents/agent-document-store";
import {AuthorizationRuleStore} from "@/server/policy/authorization-rule-store";
import {createPlatformAgentRoutes} from "@/server/routes/platform-agents";
import {fixtureScope} from "../helpers/platform-fixtures";
let home:string,db:DataConnection<typeof schema>,store:AgentDocumentStore;
let a:ReturnType<typeof fixtureScope>,b:ReturnType<typeof fixtureScope>,sibling:string;
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-documents-"));setLunaHome(home);db=new DataConnection(schema);
 a=fixtureScope(db.db,"alice");b=fixtureScope(db.db,"bob");
 sibling=new AgentStore(db.db).createShadow("alice",a.agentId,{name:"sibling"},"sibling").id;
 store=new AgentDocumentStore(db.db,home);
});
afterEach(()=>{db.close();rmSync(home,{recursive:true,force:true});});

test("shared memory uses immutable scoped revisions and stale edits preserve both pointer and files",()=>{
 expect(store.memory("alice",a.agentId).revision).toBeNull();
 const first=store.writeMemory("alice",a.agentId,{expectedRevision:null,path:"用户/偏好.md",content:"first"});
 const second=store.writeMemory("alice",a.agentId,{expectedRevision:first.revision,path:"notes/project.md",content:"second"});
 expect(first.revision).not.toBe(second.revision);
 expect(store.snapshot("memory",a.agentId,null,first.revision!).files).toEqual({"用户/偏好.md":"first"});
 expect(store.memory("alice",a.agentId).files).toEqual({"notes/project.md":"second","用户/偏好.md":"first"});
 expect(()=>store.writeMemory("alice",a.agentId,{expectedRevision:first.revision,path:"notes/project.md",content:"lost update"})).toThrow(DocumentConflictError);
 expect(store.memory("alice",a.agentId).revision).toBe(second.revision);
 expect(store.memory("bob",b.agentId).revision).toBeNull();
 expect(()=>store.snapshot("memory",b.agentId,null,first.revision!)).toThrow("document_revision_not_found");
 expect(()=>db.db.update(schema.lunaAgents).set({memoryRevision:first.revision}).where(eq(schema.lunaAgents.id,b.agentId)).run()).toThrow("memory_revision_scope_mismatch");
 expect(()=>db.db.update(schema.agentDocumentRevisions).set({files:{}}).where(eq(schema.agentDocumentRevisions.id,first.revision!)).run()).toThrow("document_revision_immutable");
});

test("persona is per Shadow; owner and scope are checked and shared memory cannot replace persona or templates",()=>{
 const initial=store.persona("alice",a);
 expect(initial.files).toEqual({"USER.md":"","SOUL.md":""});
 const updated=store.writePersona("alice",a,{expectedRevision:initial.revision!,user:"owner preferences",soul:"main identity"});
 expect(store.persona("alice",{agentId:a.agentId,shadowId:sibling}).files["SOUL.md"]).toBe("");
 expect(()=>store.writePersona("alice",{agentId:a.agentId,shadowId:b.shadowId},{expectedRevision:initial.revision!,user:"",soul:""})).toThrow("scope_mismatch");
 expect(()=>store.persona("bob",a)).toThrow("agent_access_denied");
 expect(()=>db.db.update(schema.agentShadows).set({configRevision:updated.revision}).where(eq(schema.agentShadows.id,sibling)).run()).toThrow("persona_revision_scope_mismatch");
 for(const path of ["USER.md","SOUL.md","MAIN.md","TASK.md","WORK.md"]) expect(()=>store.writeMemory("alice",a.agentId,{expectedRevision:null,path,content:"overwrite"})).toThrow("reserved_memory_path");
});

test("Agent business rules do not give a non-owner access to Dashboard memory",()=>{
 const grants=new AuthorizationRuleStore(db.db,{kind:"agent",agentId:a.agentId});
 grants.addGrant({subjectType:"user",subjectId:"bob",target:"memory.read",effect:"allow"});
 grants.addGrant({subjectType:"user",subjectId:"bob",target:"memory.write",effect:"allow"});
 expect(()=>store.memory("bob",a.agentId)).toThrow("agent_access_denied");
 expect(()=>store.writeMemory("bob",a.agentId,{expectedRevision:null,path:"note.md",content:"edit"})).toThrow("agent_access_denied");
 expect(()=>store.persona("bob",a)).toThrow("agent_access_denied");
});

test("path traversal, symlinked scope roots, and changed published contents fail closed",()=>{
 for(const path of ["/outside","../outside","a/../../outside","a\\outside","a//b","."]) expect(()=>store.writeMemory("alice",a.agentId,{expectedRevision:null,path,content:"bad"})).toThrow("memory_path_invalid");
 mkdirSync(join(home,"agents",a.agentId),{recursive:true});
 const outside=join(home,"outside");mkdirSync(outside);
 symlinkSync(outside,join(home,"agents",a.agentId,"memory"));
 expect(()=>store.writeMemory("alice",a.agentId,{expectedRevision:null,path:"note.md",content:"bad"})).toThrow("document_path_unsafe");
 expect(new AgentStore(db.db).get(a.agentId).memoryRevision).toBeNull();
 rmSync(join(home,"agents",a.agentId,"memory"));
 const revision=store.writeMemory("alice",a.agentId,{expectedRevision:null,path:"note.md",content:"ok"});
 const file=join(home,"agents",a.agentId,"memory",revision.revision!,"note.md");
 expect(readFileSync(file,"utf8")).toBe("ok");chmodSync(file,0o600);writeFileSync(file,"tampered");
 expect(()=>store.memory("alice",a.agentId)).toThrow("document_integrity_error");
});

test("document API rejects missing expectedRevision and reports the current scoped revision on conflict",async()=>{
 const app=new Hono().use("*",async(c,next)=>{
  (c as any).set("dashboardAuthSession",{authenticated:true,user:{id:"alice",name:"Alice",provider:"test"}});
  (c as any).set("lunaRequestAuthKind","dashboard-cookie");await next();
 }).route("/agents",createPlatformAgentRoutes(db.db));
 const url=`/agents/${a.agentId}/memory`;
 const put=(body:unknown)=>app.request(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 expect((await put({path:"note.md",content:"first"})).status).toBe(400);
 const response=await put({expectedRevision:null,path:"note.md",content:"first"});expect(response.status).toBe(200);
 const first=await response.json() as {revision:string};
 const conflict=await put({expectedRevision:null,path:"note.md",content:"second"});
 expect(conflict.status).toBe(409);expect((await conflict.json() as any).currentRevision).toBe(first.revision);
 expect((await app.request(`/agents/${b.agentId}/memory`)).status).toBe(403);
});


test("failed pointer commit rolls back database state and keeps the previous published snapshot",()=>{
 const first=store.writeMemory("alice",a.agentId,{expectedRevision:null,path:"note.md",content:"first"});
 db.db.run(sql`CREATE TRIGGER fail_document_pointer BEFORE UPDATE OF memory_revision ON luna_agents BEGIN SELECT RAISE(ABORT,'injected_commit_failure'); END`);
 expect(()=>store.writeMemory("alice",a.agentId,{expectedRevision:first.revision,path:"note.md",content:"second"})).toThrow("injected_commit_failure");
 expect(store.memory("alice",a.agentId)).toEqual(first);
 expect(db.db.select().from(schema.agentDocumentRevisions).all()).toHaveLength(1);
 db.db.run(sql`DROP TRIGGER fail_document_pointer`);
 const retried=store.writeMemory("alice",a.agentId,{expectedRevision:first.revision,path:"note.md",content:"second"});
 expect(retried.files["note.md"]).toBe("second");
 expect(store.snapshot("memory",a.agentId,null,first.revision!).files["note.md"]).toBe("first");
});
