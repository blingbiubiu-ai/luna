import {MainRunner, type MainRunnerRunInput} from "@/main-runner/main-runner";
import {MainRunnerContextBuilder} from "@/main-runner/context-builder";
import {RunnerContextStore} from "@/runners/runner-context-store";
import {SessionStore} from "@/sessions/session-store";
import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {ActiveAgentConfigService, AgentProfileStore, AgentSecretCipher} from "@/agent-config";
import {createAgentConfigRoutes} from "@/server/routes/agent-config";
import {fixtureScope} from "../helpers/platform-fixtures";
let home: string, connection: DataConnection<typeof schema>, agentA: string, agentB: string;
let one: AgentProfileStore, two: AgentProfileStore, cipher: AgentSecretCipher;
const profileInput = {name:"Codex",agentType:"codex" as const,model:"gpt-5",env:{},secrets:{}};
beforeEach(() => {
 home=mkdtempSync(join(tmpdir(),"luna-model-scope-"));setLunaHome(home);connection=new DataConnection(schema);
 agentA=fixtureScope(connection.db,"alice").agentId;agentB=fixtureScope(connection.db,"bob").agentId;
 cipher=AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,7).toString("base64")});
 one=new AgentProfileStore(connection.db,cipher,agentA);two=new AgentProfileStore(connection.db,cipher,agentB);
});
afterEach(() => {connection.close();rmSync(home,{recursive:true,force:true});});
test("profile names and CRUD are isolated by their owning Agent", () => {
 const a=one.createProfile({...profileInput,secrets:{OPENAI_API_KEY:{set:"alice-secret"}}});
 const b=two.createProfile({...profileInput,secrets:{OPENAI_API_KEY:{set:"bob-secret"}}});
 expect(a.agentId).toBe(agentA);expect(b.agentId).toBe(agentB);
 expect(one.listProfiles().map(row=>row.id)).toEqual([a.id]);
 expect(one.getProfile(b.id)).toBeUndefined();expect(one.getRevision(b.latestRevision.id)).toBeUndefined();
 expect(()=>one.createRevision(b.id,{model:"gpt-5",env:{},secrets:{}})).toThrow("not found");
 expect(()=>one.recordValidation(b.latestRevision.id,{success:true,message:"forged"})).toThrow("not found");
 expect(()=>one.deleteProfile(b.id)).toThrow("not found");
 expect(two.getProfile(b.id)?.latestRevision.validationState).toBe("draft");
 expect(JSON.stringify(one.listProfiles())).not.toContain("alice-secret");
 expect(JSON.stringify(one.listProfiles())).not.toContain("bob-secret");
 expect(()=>connection.db.update(schema.agentProfiles).set({agent_id:agentA}).where(eq(schema.agentProfiles.id,b.id)).run()).toThrow("profile_scope_immutable");
});
test("configuration API requires explicit Agent ownership before reading or decrypting revisions", async () => {
 const foreign=two.createProfile({...profileInput,secrets:{OPENAI_API_KEY:{set:"foreign-secret"}}});
 let executions=0;
 const app=new Hono().use("*",async(c,next)=>{
  (c as any).set("dashboardAuthSession",{authenticated:true,user:{id:"alice",name:"Alice",provider:"test"}});
  (c as any).set("lunaRequestAuthKind","dashboard-cookie");await next();
 }).route("/config",createAgentConfigRoutes({db:connection.db,cipher,connectionExecutor:{execute:async()=>{executions++;return {success:true,output:"LUNA_AGENT_PROFILE_OK"};}}}));
 expect((await app.request("/config/profiles")).status).toBe(400);
 expect((await app.request(`/config/profiles?agentId=${agentB}`)).status).toBe(403);
 expect((await app.request(`/config/profiles/${foreign.id}?agentId=${agentA}`)).status).toBe(404);
 for(const operation of ["test","activate"]) expect((await app.request(`/config/revisions/${foreign.latestRevision.id}/${operation}?agentId=${agentA}`,{method:"POST"})).status).toBe(404);
 expect(executions).toBe(0);
 expect(connection.db.select().from(schema.activeAgentConfig).all()).toHaveLength(0);
});


test("Agent activation isolates secrets, sequence and actual active revision", () => {
 const a=one.createProfile({...profileInput,secrets:{OPENAI_API_KEY:{set:"alice-secret"}}});
 const b=two.createProfile({...profileInput,secrets:{OPENAI_API_KEY:{set:"bob-secret"}}});
 for (const [store,profile] of [[one,a],[two,b]] as const) store.recordValidation(profile.latestRevision.id,{success:true,message:"ok"});
 const active=new ActiveAgentConfigService(connection.db,cipher);
 expect(()=>active.activate(agentA,a.latestRevision.id,"bob")).toThrow();
 expect(()=>active.activate(agentA,b.latestRevision.id,"alice")).toThrow();
 // An unavailable key proves foreign revision rejection happens before decrypting its secrets.
 expect(()=>new ActiveAgentConfigService(connection.db,undefined).resolveRevisionSnapshot(agentA,b.latestRevision.id)).toThrow("No Agent profile");
 const first=active.activate(agentA,a.latestRevision.id,"alice");
 expect(first.agentId).toBe(agentA);expect(first.env.OPENAI_API_KEY).toBe("alice-secret");
 expect(()=>active.resolveExecutionSnapshot(agentB)).toThrow("No Agent profile");
 active.activate(agentB,b.latestRevision.id,"bob");
 const draft=one.createRevision(a.id,{model:"gpt-next",env:{},secrets:{}});
 const status=one.status();
 expect(status.status).toBe("ready");
 if(status.status==="ready") {
  expect(status.revision.id).toBe(a.latestRevision.id);
  expect(status.active.latestRevision.id).toBe(draft.id);
 }
 active.activate(agentA,a.latestRevision.id,"alice");
 expect(active.resolveExecutionSnapshot(agentA).activationSequence).toBe(2);
 expect(active.resolveExecutionSnapshot(agentB).activationSequence).toBe(1);
 expect(active.resolveExecutionSnapshot(agentB).env.OPENAI_API_KEY).toBe("bob-secret");
 connection.db.update(schema.lunaAgents).set({status:"disabled"}).where(eq(schema.lunaAgents.id,agentA)).run();
 expect(()=>active.resolveExecutionSnapshot(agentA)).toThrow("agent_disabled");
 expect(()=>active.resolveActiveAgentType(agentA)).toThrow("agent_disabled");
 expect(active.resolveExecutionSnapshot(agentB).agentId).toBe(agentB);
});

test("activation rollback preserves pointer when secrets cannot be resolved; database rejects foreign profile and revision", () => {
 const a=one.createProfile(profileInput), b=two.createProfile(profileInput);
 one.recordValidation(a.latestRevision.id,{success:true,message:"ok"});
 const active=new ActiveAgentConfigService(connection.db,cipher);
 active.activate(agentA,a.latestRevision.id,"alice");
 const secret=one.createRevision(a.id,{model:"gpt-next",env:{},secrets:{OPENAI_API_KEY:{set:"new-secret"}}});
 one.recordValidation(secret.id,{success:true,message:"ok"});
 expect(()=>new ActiveAgentConfigService(connection.db,undefined).activate(agentA,secret.id,"alice")).toThrow("secret key is unavailable");
 expect(active.resolveExecutionSnapshot(agentA).revisionId).toBe(a.latestRevision.id);
 expect(active.resolveExecutionSnapshot(agentA).activationSequence).toBe(1);
 expect(()=>connection.db.update(schema.activeAgentConfig).set({profile_id:b.id,revision_id:b.latestRevision.id}).where(eq(schema.activeAgentConfig.agent_id,agentA)).run()).toThrow();
 expect(()=>connection.db.update(schema.activeAgentConfig).set({revision_id:b.latestRevision.id}).where(eq(schema.activeAgentConfig.agent_id,agentA)).run()).toThrow();
});


test("Main resolves configuration using the persisted session and rejects a foreign context before configuration access", async () => {
 const calls: string[]=[];
 const main=new MainRunner({serviceAuthDb:connection.db, resolveAgentExecution:scope=>{
  calls.push(scope.agentId);throw new Error("configuration-resolver-reached");
 }});
 const inputs:MainRunnerRunInput[]=[];
 for(const actor of ["alice","bob"]){
  const scope=fixtureScope(connection.db,actor);
  const session=new SessionStore(connection.db).createLocalSession(actor,scope);
  inputs.push({runnerContext:new RunnerContextStore(connection.db).resolveForSession(session.id,"codex"),
   input:{type:"session_trigger",triggerId:"test",instruction:"test",requesterUserId:actor,
    context:new MainRunnerContextBuilder(connection.db).buildForSession(session.id),artifactRefs:[],
    sourceSessionId:session.id,correlationId:"test",hops:0}});
 }
 for(const input of inputs) await expect(main.run(input)).rejects.toThrow("configuration-resolver-reached");
 expect(calls).toEqual([agentA,agentB]);
 await expect(main.run({...inputs[0]!,runnerContext:inputs[1]!.runnerContext})).rejects.toThrow("task_scope_mismatch");
 expect(calls).toHaveLength(2);
 connection.db.update(schema.agentShadows).set({status:"disabled"}).where(eq(schema.agentShadows.id,inputs[0]!.runnerContext.shadow_id)).run();
 await expect(main.run(inputs[0]!)).rejects.toThrow("shadow_disabled");
 expect(calls).toHaveLength(2);
});
