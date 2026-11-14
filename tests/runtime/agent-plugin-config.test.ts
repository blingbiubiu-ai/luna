import {SessionStore} from "@/sessions/session-store";
import {createPluginRuntimeContext} from "@/plugins/runtime-context";
import {AgentStore} from "@/agents/agent-store";
import {createAgentPluginRoutes} from "@/server/routes/agent-plugins";
import {Hono} from "hono";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentSecretCipher} from "@/agent-config/secret-cipher";
import {AgentPluginStore} from "@/plugins/agent-plugin-store";
import {PluginRegistry} from "@/plugins/registry";
import {OperationDispatcher} from "@/plugins/dispatcher";
import {registerPluginOperations} from "@/operations/operation-registry";
import {AuthorizationRuleStore} from "@/server/policy/authorization-rule-store";
import {fixtureScope, fixtureSessionOwnership} from "../helpers/platform-fixtures";
import {ChannelDirectoryStore} from "@/channels/directory-store";
import {feishuIdentityMetadata} from "@/identity/feishu-identity-scopes";
import type {PluginManifest,PluginRuntimeContext} from "@/plugins/manifest";
let home:string,connection:DataConnection<typeof schema>,registry:PluginRegistry,store:AgentPluginStore;
let a:ReturnType<typeof fixtureScope>,b:ReturnType<typeof fixtureScope>,seen:PluginRuntimeContext|undefined;
const manifest:PluginManifest={id:"alpha",displayName:"Alpha",version:"1.0.0",source:"bundled",agentScopeVersion:2,
 requestedHostPermissions:[],operations:[{id:"alpha.echo",title:"Echo",description:"test",riskLevel:"low",artifactPolicy:"none",inputSchema:{type:"object"}}]};
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),"luna-agent-plugin-"));setLunaHome(home);connection=new DataConnection(schema);
 a=fixtureScope(connection.db,"alice");b=fixtureScope(connection.db,"bob");registry=new PluginRegistry();
 registry.registerPlugin(manifest,()=>({invoke:async input=>{seen=input.runtimeContext;return {status:"success",summary:input.runtimeContext?.config,artifacts:[]};}}),{global:"must not use"});
 registerPluginOperations(connection.db,registry.listOperations(),["alpha"],registry);
 store=new AgentPluginStore(connection.db,registry,AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,8).toString("base64")}));seen=undefined;
});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});

test("Agent activation, configuration and secrets remain isolated with CAS and authenticated encryption binding",()=>{
 const first=store.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{label:"Alice"},secrets:{TOKEN:"alice-secret"}});
 const second=store.put("bob",b.agentId,"alpha",{expectedRevision:null,enabled:false,config:{label:"Bob"},secrets:{TOKEN:"bob-secret"}});
 expect(JSON.stringify(first)).not.toContain("alice-secret");expect(first.secretKeys).toEqual(["TOKEN"]);
 expect(store.secret(a.agentId,"alpha",first.revision!,"TOKEN")).toBe("alice-secret");
 expect(()=>store.secret(b.agentId,"alpha",second.revision!,"TOKEN")).toThrow("agent_plugin_disabled");
 expect(()=>store.get("bob",a.agentId,"alpha")).toThrow("agent_access_denied");
 expect(()=>store.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{}})).toThrow("plugin_config_conflict");
 const next=store.put("alice",a.agentId,"alpha",{expectedRevision:first.revision,enabled:true,config:{label:"Updated"}});
 expect(store.secret(a.agentId,"alpha",next.revision!,"TOKEN")).toBe("alice-secret");
 expect(()=>store.secret(a.agentId,"alpha",first.revision!,"TOKEN")).toThrow("plugin_config_changed");
 const rows=connection.db.select().from(schema.agentPluginConfigs).all();
 connection.db.update(schema.agentPluginConfigs).set({secrets:rows.find(row=>row.agentId===b.agentId)!.secrets}).where(eq(schema.agentPluginConfigs.agentId,a.agentId)).run();
 expect(()=>store.secret(a.agentId,"alpha",next.revision!,"TOKEN")).toThrow();
});

test("legacy plugins cannot be enabled and missing scope cannot reach runtime",async()=>{
 const {agentScopeVersion:_,...legacy}=manifest;
 registry.registerPlugin({...legacy,id:"legacy",operations:[]},()=>({invoke:async()=>({status:"success",summary:{},artifacts:[]})}),{});
 expect(()=>store.put("alice",a.agentId,"legacy",{expectedRevision:null,enabled:true,config:{}})).toThrow("plugin_scope_unsupported");
 const result=await new OperationDispatcher({db:connection.db,registry}).invoke({operationId:"alpha.echo",input:{},subject:{userId:"alice",source:"cli"}});
 expect(result.status).toBe("error");expect(result).toHaveProperty("errorCode","agent_scope_required");expect(seen).toBeUndefined();
});

test("dispatcher selects only enabled Agent config and checks scoped grants and ownership",async()=>{
 store.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{label:"Alice"}});
 store.put("bob",b.agentId,"alpha",{expectedRevision:null,enabled:true,config:{label:"Bob"}});
 const dispatcher=new OperationDispatcher({db:connection.db,registry});
 const input={scope:a,operationId:"alpha.echo",input:{},subject:{userId:"alice",source:"cli" as const}};
 expect(await dispatcher.invoke(input)).toHaveProperty("errorCode","operation_not_granted");
 new AuthorizationRuleStore(connection.db,{kind:"agent",agentId:a.agentId}).addGrant({subjectType:"user",subjectId:"alice",target:"alpha.echo",effect:"allow"});
 expect(await dispatcher.invoke(input)).toHaveProperty("status","success");expect(seen?.config).toEqual({label:"Alice"});expect(seen?.scope).toEqual(a);
 expect(await dispatcher.invoke({...input,scope:b})).toHaveProperty("errorCode","operation_not_granted");
 const current=store.get("alice",a.agentId,"alpha");store.put("alice",a.agentId,"alpha",{expectedRevision:current.revision,enabled:false,config:{}});
 expect(()=>seen?.secrets?.get("TOKEN")).toThrow("plugin_invocation_inactive");
 expect(await dispatcher.invoke(input)).toHaveProperty("errorCode","agent_plugin_disabled");
});

test("the same Feishu user can invoke one business operation through both Shadow bindings", async () => {
 const db = connection.db;
 const directory = new ChannelDirectoryStore(db);
 const agentStore = new AgentStore(db);
 const dispatcher = new OperationDispatcher({db, registry});
 const rules = new AuthorizationRuleStore(db, {kind: "agent", agentId: a.agentId});
 store.put("alice", a.agentId, "alpha", {expectedRevision: null, enabled: true, config: {label: "Shared Agent config"}});
 const entries = ["bot-one", "bot-two"].map(channelId => {
  fixtureSessionOwnership(db, "feishu", channelId, "alice");
  const session = new SessionStore(db).resolveByChannelSurface({channelType: "feishu", channelId, groupId: "test-group"});
  const ids = {open_id: "ou_" + channelId, user_id: "same-tenant-user"};
  const identity = directory.upsertIdentity({
   channel: {type: "feishu", id: channelId},
   identity: {externalId: ids.open_id, kind: "user",
    ...feishuIdentityMetadata({environment: "feishu", appId: "test:feishu:" + channelId, tenantKey: "tenant"}, ids)},
  });
  const binding = db.select().from(schema.channelUserBindings)
   .where(eq(schema.channelUserBindings.channelIdentityId, identity.id)).get()!;
  return {userId: binding.userId, sessionId: session.id, scope: {agentId: session.agent_id, shadowId: session.shadow_id}};
 });
 const [first, second] = entries;
 expect(second!.userId).toBe(first!.userId);
 expect(second!.scope.shadowId).not.toBe(first!.scope.shadowId);
 const userId = first!.userId;
 rules.addGrant({subjectType: "user", subjectId: userId, target: "alpha.echo", effect: "allow"});
 for (const entry of entries) {
  expect(await dispatcher.invoke({scope: entry.scope, sessionId: entry.sessionId, operationId: "alpha.echo", input: {},
   subject: {userId: entry.userId, source: "cli"}})).toMatchObject({status: "success"});
  expect(seen?.scope).toEqual(entry.scope);
  expect(seen?.config).toEqual({label: "Shared Agent config"});
 }
 expect(await dispatcher.invoke({scope: b, operationId: "alpha.echo", input: {},
  subject: {userId, source: "cli"}})).toHaveProperty("errorCode", "agent_plugin_disabled");
});


test("host execution has a scoped HOME, no inherited Service secrets, and rechecks revocation",async()=>{
 const old=process.env.LUNA_PLUGIN_TEST_SECRET;process.env.LUNA_PLUGIN_TEST_SECRET="never-inherit";
 try {
  const runtime=createPluginRuntimeContext({db:connection.db,scope:a,validate:()=>{new AgentStore(connection.db).requireScope("alice",a);},
   invocation:{pluginId:"alpha",operationId:"alpha.echo",invocationId:"environment",subject:{userId:"alice",source:"cli"}},
   hostPermissions:["host.exec"],manifest:{allowedExecutables:["/usr/bin/env"],allowedEnvKeys:["EXPLICIT","HOME"]}});
  const result=await runtime.host.exec({cmd:"/usr/bin/env",args:[],env:{EXPLICIT:"allowed",HOME:"/foreign"}});
  expect(result.exitCode).toBe(0);expect(result.stdout).toContain("EXPLICIT=allowed");
  expect(result.stdout).toContain(`agents/${a.agentId}/shadows/${a.shadowId}/plugins/workspaces/alpha/environment`);
  expect(result.stdout).not.toContain("never-inherit");expect(result.stdout).not.toContain("HOME=/foreign");
  connection.db.update(schema.agentShadows).set({status:"disabled"}).where(eq(schema.agentShadows.id,a.shadowId)).run();
  await expect(runtime.host.exec({cmd:"/usr/bin/env",args:[]})).rejects.toThrow("shadow_disabled");
 }finally{if(old===undefined)delete process.env.LUNA_PLUGIN_TEST_SECRET;else process.env.LUNA_PLUGIN_TEST_SECRET=old;}
});

test("Agent plugin management API requires owner and reports CAS conflicts without secret values",async()=>{
 const app=new Hono().use("*",async(c,next)=>{
  (c as any).set("dashboardAuthSession",{authenticated:true,user:{id:"alice",name:"Alice",provider:"test"}});
  (c as any).set("lunaRequestAuthKind","dashboard-cookie");await next();
 }).route("/agents",createAgentPluginRoutes(connection.db,registry));
 expect((await app.request(`/agents/${b.agentId}/plugins/alpha`)).status).toBe(403);
 expect((await app.request(`/agents/${b.agentId}/plugins`)).status).toBe(403);
 const listUrl = `/agents/${a.agentId}/plugins`;
 expect(await (await app.request(listUrl)).json()).toEqual({ plugins: [
  { id: "alpha", name: "Alpha", version: "1.0.0", supported: true, enabled: false },
 ] });
 const url=`/agents/${a.agentId}/plugins/alpha`;
 const put=()=>app.request(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedRevision:null,enabled:true,config:{label:"api"}})});
 const first=await put();expect(first.status).toBe(200);const body=await first.json() as {revision:string};
 expect(await (await app.request(listUrl)).json()).toMatchObject({ plugins: [{ id: "alpha", enabled: true }] });
 const conflict=await put();expect(conflict.status).toBe(409);expect((await conflict.json() as any).currentRevision).toBe(body.revision);
});


test("owner can disable a plugin without decrypting retained credentials",()=>{
 const first=store.put("alice",a.agentId,"alpha",{expectedRevision:null,enabled:true,config:{},secrets:{TOKEN:"keep"}});
 const withoutKey=new AgentPluginStore(connection.db,registry,undefined);
 const disabled=withoutKey.put("alice",a.agentId,"alpha",{expectedRevision:first.revision,enabled:false,config:{}});
 expect(disabled.enabled).toBe(false);expect(disabled.secretKeys).toEqual(["TOKEN"]);
 const enabled=store.put("alice",a.agentId,"alpha",{expectedRevision:disabled.revision,enabled:true,config:{}});
 expect(store.secret(a.agentId,"alpha",enabled.revision!,"TOKEN")).toBe("keep");
});


test("plugin artifact registration cannot use a foreign Agent owner",()=>{
 const sessions=new SessionStore(connection.db),own=sessions.createLocalSession("alice",a),foreign=sessions.createLocalSession("bob",b);
 const runtime=createPluginRuntimeContext({db:connection.db,scope:a,validate:()=>{new AgentStore(connection.db).requireScope("alice",a);},
  invocation:{pluginId:"alpha",operationId:"alpha.echo",invocationId:"artifacts",subject:{userId:"alice",source:"cli"}},hostPermissions:["artifact.create"],manifest:{}});
 const input={scopeType:"session",scopeId:foreign.id,kind:"file",name:"note.txt",content:Buffer.from("test")};
 expect(()=>runtime.artifacts.registerContent(input)).toThrow("task_scope_mismatch");
 expect(connection.db.select().from(schema.managedArtifacts).all()).toHaveLength(0);
 expect(runtime.artifacts.registerContent({...input,scopeId:own.id}).name).toBe("note.txt");
});
