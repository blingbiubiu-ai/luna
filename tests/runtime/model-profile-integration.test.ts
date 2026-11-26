import {afterEach,expect,test} from "bun:test";
import {Hono} from "hono";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DataConnection} from "../../src/data";
import * as schema from "../../src/data/schema";
import {setLunaHome,reloadConfig} from "../../src/shared/config";
import {fixtureScope} from "../helpers/platform-fixtures";
import {AgentProfileStore,AgentSecretCipher,ActiveAgentConfigService} from "../../src/agent-config";
import {createAgentConfigRoutes} from "../../src/server/routes/agent-config";
import {ModelProviderService} from "../../src/model-providers/service";
import {PluginRegistry} from "../../src/plugins/registry";
import {ExecutionError} from "@luna/execution-store";
import {AgentWorkerAccessStore} from "../../src/agents/agent-worker-access-store";
import {WorkerModelLogins} from "../../apps/worker/src/model-providers/logins";
import {fixtureModelRelease} from "../fixtures/worker-model-release";

const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(fn=>fn()));
const reference={kind:"worker-plugin" as const,workerId:"worker",pluginId:"trae-provider",providerId:"trae-code-cn",accountId:"account",credentialRevision:"credential-v1",releaseSha256:"a".repeat(64)};
function setup(){const home=mkdtempSync(join(tmpdir(),"luna-profile-model-"));mkdirSync(join(home,"data"));writeFileSync(join(home,"config.yaml"),"{}\n");setLunaHome(home);reloadConfig();const connection=new DataConnection(schema);const {agentId}=fixtureScope(connection.db,"owner");const cipher=AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:Buffer.alloc(32,1).toString("base64")});clean.push(()=>{connection.close();rmSync(home,{recursive:true,force:true});});return {connection,agentId,cipher};}
test("Profile revisions retain source and source changes alter execution identity without ephemeral gateway keys",()=>{
 const {connection,agentId,cipher}=setup();const store=new AgentProfileStore(connection.db,cipher,agentId);
 const profile=store.createProfile({name:"TRAE",agentType:"codex",model:"fixture",modelProvider:reference});
 const revision=store.createRevision(profile.id,{model:"fixture"});expect(revision.modelProvider).toEqual(reference);
 const active=new ActiveAgentConfigService(connection.db,cipher);const first=active.resolveRevisionSnapshot(agentId,profile.latestRevision.id);
 expect(first.env.OPENAI_API_KEY).toBeUndefined();expect(first.modelProvider).toEqual(reference);
 const updated=store.createRevision(profile.id,{model:"fixture",modelProvider:{...reference,credentialRevision:"credential-v2"}});
 expect(active.resolveRevisionSnapshot(agentId,updated.id).providerFingerprint).not.toBe(first.providerFingerprint);
 expect(store.getRevision(profile.latestRevision.id)?.modelProvider?.credentialRevision).toBe("credential-v1");
 expect(()=>store.createProfile({name:"invalid",agentType:"claude",model:"fixture",modelProvider:reference})).toThrow();
});
test("gateway-to-plugin revision explicitly clears the retained API key",()=>{
 const {connection,agentId,cipher}=setup();const store=new AgentProfileStore(connection.db,cipher,agentId);
 const p=store.createProfile({name:"gateway",agentType:"codex",model:"fixture",env:{CODEX_PROVIDER_MODE:"gateway",OPENAI_BASE_URL:"http://example.test/v1"},secrets:{OPENAI_API_KEY:{set:"old-gateway-secret"}}});
 expect(()=>store.createRevision(p.id,{model:"fixture",modelProvider:reference})).toThrow("cannot retain");
 const revision=store.createRevision(p.id,{model:"fixture",modelProvider:reference,secrets:{OPENAI_API_KEY:{clear:true}}});expect(revision.secrets).toEqual({});
});
test("plugin Profile validation runs on the binding Worker; failed validation cannot activate",async()=>{
 const {connection,agentId,cipher}=setup();let success=false,workerTests=0,localTests=0;
 const service={validateReference:async(_actor:string,_agent:string,ref:unknown)=>ref,test:async(_actor:string,_agent:string,ref:unknown)=>{expect(ref).toEqual(reference);workerTests++;return {success,message:success?"OK":"failed"};}} as unknown as ModelProviderService;
 const app=new Hono().use("*",async(c,next)=>{(c as any).set("lunaAuthorizationDb",connection.db);(c as any).set("lunaRequestAuthKind","dashboard-cookie");(c as any).set("dashboardAuthSession",{authenticated:true,account:{id:"owner",name:"Owner",provider:"fixture"}});await next();}).route("/api",createAgentConfigRoutes({db:connection.db,cipher,modelProviders:service,connectionExecutor:{execute:async()=>{localTests++;return {success:true,output:"LUNA_AGENT_PROFILE_OK"};}}}));
 const call=(path:string,body?:unknown)=>app.request(`/api/${path}?agentId=${agentId}`,{method:"POST",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
 const created=await (await call("profiles",{name:"Worker",agentType:"codex",model:"fixture",modelProvider:reference})).json() as any;const id=created.profile.latestRevision.id;
 expect((await call(`revisions/${id}/test`)).status).toBe(422);expect((await call(`revisions/${id}/activate`)).status).toBe(409);
 success=true;expect((await call(`revisions/${id}/test`)).status).toBe(200);expect((await call(`revisions/${id}/activate`)).status).toBe(200);expect(workerTests).toBe(2);expect(localTests).toBe(0);
});
test("model metadata and imports require the Agent owner and an authorized Worker before touching upstream",async()=>{
 const {connection,agentId}=setup();const service=new ModelProviderService(connection.db,new PluginRegistry(),()=>undefined);
 expect(()=>service.providers("stranger",agentId)).toThrow();
 await expect(service.importAccount("owner",agentId,{workerId:"unassigned",pluginId:"trae-provider",providerId:"trae-code-cn",requestId:"import",expectedRevision:null,credential:{token:"private"}})).rejects.toThrow("agent_worker_access_denied");
});
for(const callbackPath of [undefined,"/oauth/fixture/return","/authorize"]){
test(`Service login uses ${callbackPath??"the default callback"}, binds account metadata, and rejects a different owner/path`,async()=>{
 const {connection,agentId}=setup();new AgentWorkerAccessStore(connection.db).setOwned("owner",agentId,"worker","active");
 const release=fixtureModelRelease();const root=mkdtempSync(join(tmpdir(),"model-login-release-"));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 for(const file of release.files)writeFileSync(join(root,file.path),Buffer.from(file.content,"base64"));writeFileSync(join(root,"checksums.json"),release.checksums);
 const manifest=JSON.parse(Buffer.from(release.files.find(f=>f.path==="manifest.json")!.content,"base64").toString());manifest.workerModelProviders[0].login={type:"oauth",label:"Sign in",...(callbackPath?{callbackPath}:{})};
 const registry=new PluginRegistry();registry.registerPlugin(manifest,()=>({invoke:async()=>({status:"success",summary:"",artifacts:[]})}),{},undefined,{path:root,sha256:release.releaseSha256});
 const summary:any={agentId,pluginId:release.pluginId,providerId:release.providerId,accountId:"account",credentialRevision:"credential",releaseSha256:release.releaseSha256,name:"OAuth account",expiresAt:null,state:"ready",models:[{id:"model",name:"Model"}]};
 let accepted=false;
 const logins=new WorkerModelLogins(async(_input,path)=>Response.json(path==="/login/start"?{id:"plugin-flow",authorizationUrl:"https://sso.example/authorize"}:path==="/login/poll"?accepted?{state:"ready",credential:{access:"private-secret"}}:{state:"pending"}:{accepted:accepted=true}),async()=>summary);
 const client={call:async(_method:string,path:string,body:any)=>{
  if(path.endsWith("/install"))return {};
  if(path.endsWith("/start")){expect(body.workerId).toBeUndefined();const callback=new URL(body.callbackUrl);expect(callback.pathname).toBe(callbackPath??"/api/model-providers/login/callback");expect(callback.searchParams.get("flowId")).toBe(body.flowId);return logins.start(body);}
  if(path.endsWith("/callback"))return logins.callback(body.flowId,body.agentId,body.params);
  if(path.endsWith("/poll"))return logins.poll(body.flowId,body.agentId);
  return {};
 }};
 const runtime:any={gateway:{scheduler:{workers:{require:()=>({health:{ready:true,capabilities:["worker-model-provider-v1"]},lastSeen:Date.now(),draining:false}),client:()=>client}}}};
 const service=new ModelProviderService(connection.db,registry,()=>runtime);
 const started:any=await service.startLogin("owner",agentId,{workerId:"worker",pluginId:release.pluginId,providerId:release.providerId,expectedRevision:null},"https://luna.example");
 expect(service.callbackPaths()).toContain(callbackPath??"/api/model-providers/login/callback");
 expect((await service.pollLogin("owner",agentId,started.flowId)).state).toBe("pending");
 await expect(service.loginCallback("owner",started.flowId,{},"/wrong-provider-callback")).rejects.toThrow("model_login_callback_mismatch");expect(accepted).toBe(false);
 await expect(service.loginCallback("stranger",started.flowId,{},callbackPath??"/api/model-providers/login/callback")).rejects.toThrow();
 await service.loginCallback("owner",started.flowId,{},callbackPath??"/api/model-providers/login/callback");const ready=await service.pollLogin("owner",agentId,started.flowId);
 expect(ready.state).toBe("ready");expect(JSON.stringify(ready)).not.toContain("private-secret");
 expect(JSON.stringify(connection.db.$client.query("SELECT summary_json FROM agent_model_provider_accounts").all())).not.toContain("private-secret");
});

}
