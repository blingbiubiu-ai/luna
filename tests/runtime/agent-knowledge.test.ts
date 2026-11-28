import {AgentResourceBuilder} from "@/runners/agent-resource-builder";
import {InvocationResources} from "@/runners/invocation-resources";
import {PluginRegistry} from "@/plugins/registry";
import {decodeInvocation} from "@/runners/invocation-codec";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {fixtureScope,fixtureRunnerContext,fixtureUser} from "../helpers/platform-fixtures";
import {SessionStore} from "@/sessions/session-store";
import {InvocationStore} from "@/runners/invocation-store";
import {AccessTokenService} from "@/server/auth/access-token-service";
import {AuthorizationRuleStore} from "@/server/policy/authorization-rule-store";
import {createWorkspaceRoutes} from "@/server/routes/workspaces";
import {createKnowledgeWorkspaceRepository} from "../../extensions/workspace/knowledge/definition";
import {createWorkspaceClient} from "@luna/service-client/workspace-client";
let home:string,connection:DataConnection<typeof schema>,a:ReturnType<typeof fixtureScope>,b:ReturnType<typeof fixtureScope>;
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),"luna-agent-knowledge-"));setLunaHome(home);connection=new DataConnection(schema);a=fixtureScope(connection.db,"alice");b=fixtureScope(connection.db,"bob");});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
function app(actor:string,claims?:ReturnType<AccessTokenService["issueToken"]>["claims"]){
 return new Hono().use("*",async(c,next)=>{
  (c as any).set("dashboardAuthSession",{authenticated: true, account: {id:actor,name:actor,provider:"test"}});
  (c as any).set("lunaRequestAuthKind",claims ? "luna-access-token" : "dashboard-cookie");
  if(claims)(c as any).set("lunaAccessTokenClaims",claims);await next();
 }).route("/workspaces",createWorkspaceRoutes({db:connection.db,serviceHome:home}));
}

test("same knowledge alias resolves separate Agent files and Git roots",async()=>{
 const one=createKnowledgeWorkspaceRepository(home,a.agentId),two=createKnowledgeWorkspaceRepository(home,b.agentId);
 one.writeFile("wiki/note.md","Alice private");two.writeFile("wiki/note.md","Bob private");
 expect(one.readFile("wiki/note.md").content).toBe("Alice private");
 for(const repo of [one,two])expect(spawnSync("git",["rev-parse","--show-toplevel"],{cwd:repo.root,encoding:"utf8"}).stdout.trim()).toBe(repo.root);
 expect(one.gitDiff().diff).not.toContain("Bob private");expect(two.gitDiff().diff).not.toContain("Alice private");
 const http=app("alice");
 expect((await http.request("/workspaces/knowledge/file?path=wiki/note.md")).status).toBe(400);
 expect((await http.request(`/workspaces/knowledge/file?agentId=${b.agentId}&path=wiki/note.md`)).status).toBe(403);
 const result=await http.request(`/workspaces/knowledge/file?agentId=${a.agentId}&path=wiki/note.md`);
 expect(result.status).toBe(200);expect((await result.json() as any).content).toBe("Alice private");
});

test("business grants do not open another owner’s knowledge workspace",async()=>{
 const http=app("bob"),url=`/workspaces/knowledge/glob?agentId=${a.agentId}&pattern=**/*`;
 expect((await http.request(url)).status).toBe(403);
 expect(existsSync(join(home,"agents",a.agentId,"knowledge"))).toBe(false);
 new AuthorizationRuleStore(connection.db,{kind:"agent",agentId:a.agentId}).addGrant({subjectType:"user",subjectId:fixtureUser(connection.db,a.agentId,"bob"),target:"workspace.knowledge.read",effect:"allow"});

 expect((await http.request(url)).status).toBe(403);
});

test("Runner alias uses active invocation scope and requires business grant even for owner",async()=>{
 const session=new SessionStore(connection.db).createLocalSession("user:alice",a);
 const ctxRow = fixtureRunnerContext(connection.db,{id:"context",owner_type:"session",owner_id:session.id,runner_type:"mock",runner_root_path:"/unused",created_at:1,updated_at:1});
 connection.db.insert(schema.runnerContexts).values(ctxRow).run();
 const invocations=new InvocationStore(connection.db);
 const snapshot=decodeInvocation({version:1,kind:"main",input:{input:{type:"session_trigger",triggerId:"turn",instruction:"test",requesterUserId:a.ownerUserId,context:{sessionId:session.id,candidateOpenTasks:[]},artifactRefs:[],sourceSessionId:session.id,correlationId:"corr",hops:0},runnerContext:{...ctxRow,runner_session_id:null,instruction_fingerprint:null,last_run_id:null,workspacePath:"/unused/workspace",ipcPath:"/unused/ipc"},turnId:"turn"}});
 invocations.register({id:"inv",runnerKind:"main",actorUserId:a.ownerUserId,runnerContextId:"context",sessionId:session.id,taskId:null,taskRunId:null,originId:"turn",contextPackIds:[],inputSnapshot:snapshot});
 mkdirSync(join(home, "skills"));
 mkdirSync(join(home, "prompts"));
 const builder = new AgentResourceBuilder(connection.db, home, new PluginRegistry(), {
  bundledSkillsDirectory: join(home, "skills"), promptAssetsDirectory: join(home, "prompts"), repoRoot: home,
 });
 const { selection } = new InvocationResources(connection.db, home).pin("inv", builder);
 invocations.createJob("runtime",{version: 2, scope:{agentId:a.agentId,shadowId:a.shadowId,placementGeneration:1}, resources:selection,resourceRevision:selection.digest, jobId:"job",invocationId:"inv",environmentId:"luna",runnerContextId:"context",scopeKey:"session:context",runnerKind:"main",sessionId:session.id,input:{runnerType:"codex",prompt:"test"},credentialsRevision:1,timeoutMs:1000});
 const issued=new AccessTokenService({db:connection.db,signingSecret:"test"}).issueToken({userId:a.ownerUserId,source:"runner",role:"runner",name:"runner",runnerKind:"main",sourceRunnerJobId:"context",sourceSessionId:session.id,ttlMs:60000,now:Date.now(),metadata:{invocationId:"inv"}});
 const http=app("alice",issued.claims),url="/workspaces/knowledge/glob?pattern=**/*";
 expect((await http.request(url)).status).toBe(403);
 new AuthorizationRuleStore(connection.db,{kind:"agent",agentId:a.agentId}).addGrant({subjectType:"user",subjectId:a.ownerUserId,target:"workspace.knowledge.read",effect:"allow"});
 expect((await http.request(url)).status).toBe(200);
 expect((await http.request(url+`&agentId=${b.agentId}`)).status).toBe(403);
 invocations.revoke("inv","test");expect((await http.request(url)).status).toBe(409);
});

test("knowledge root symlinks and linked Git directories cannot redirect Agent storage",()=>{
 mkdirSync(join(home,"agents"));symlinkSync(home,join(home,"agents",a.agentId));
 expect(()=>createKnowledgeWorkspaceRepository(home,a.agentId)).toThrow("Unsafe knowledge root");
 rmSync(join(home,"agents",a.agentId));mkdirSync(join(home,"agents",a.agentId,"knowledge"),{recursive:true});
 symlinkSync(join(home,"missing"),join(home,"agents",a.agentId,"knowledge",".git"));
 expect(()=>createKnowledgeWorkspaceRepository(home,a.agentId)).toThrow("Unsafe knowledge Git directory");
});

test("workspace client transmits its selected Agent on reads and writes",async()=>{
 const urls:string[]=[];
 const client=createWorkspaceClient({serviceUrl:"http://service",agentId:a.agentId},{fetch:(async(url)=>{urls.push(String(url));return Response.json({});}) as typeof fetch});
 await client.read("knowledge","wiki/note.md");await client.write("knowledge","wiki/note.md","new");await client.gitStatus("knowledge");
 expect(urls).toHaveLength(3);for(const url of urls)expect(new URL(url).searchParams.get("agentId")).toBe(a.agentId);
});
