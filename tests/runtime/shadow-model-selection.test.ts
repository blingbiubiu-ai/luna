import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {config,setLunaHome} from "@/shared";
import {fixtureScope} from "../helpers/platform-fixtures";
import {AgentProfileStore,ActiveAgentConfigService,AgentSecretCipher} from "@/agent-config";
import {executionReference} from "@/agent-config/execution-reference";
import {ShadowModelSelectionStore} from "@/agents/shadow-model-selection-store";
import {createPlatformAgentRoutes} from "@/server/routes/platform-agents";

let home:string,previousHome:string,db:DataConnection<typeof schema>;
let alice:ReturnType<typeof fixtureScope>,bob:ReturnType<typeof fixtureScope>;
let profiles:AgentProfileStore,active:ActiveAgentConfigService;
let first:ReturnType<AgentProfileStore["createProfile"]>,second:typeof first;
beforeEach(()=>{
  previousHome=config.paths.home;home=mkdtempSync(join(tmpdir(),"luna-shadow-model-"));setLunaHome(home);
  db=new DataConnection(schema);alice=fixtureScope(db.db,"alice");bob=fixtureScope(db.db,"bob");
  const cipher=AgentSecretCipher.fromEnvironment({LUNA_AGENT_CONFIG_MASTER_KEY:randomBytes(32).toString("base64")});
  profiles=new AgentProfileStore(db.db,cipher,alice.agentId);active=new ActiveAgentConfigService(db.db,cipher);
  first=profiles.createProfile({name:"First",agentType:"codex",model:"model-first",env:{},secrets:{OPENAI_API_KEY:{set:"first-secret"}}});
  second=profiles.createProfile({name:"Second",agentType:"codex",model:"model-second",env:{},secrets:{OPENAI_API_KEY:{set:"second-secret"}}});
  for(const profile of [first,second])profiles.recordValidation(profile.latestRevision.id,{success:true,message:"ok"});
  active.activate(alice.agentId,first.latestRevision.id,"alice");
});
afterEach(()=>{db.close();setLunaHome(previousHome);rmSync(home,{recursive:true,force:true});});
function app(actor="alice") {
  return new Hono().use("*",async(c,next)=>{
    (c as any).set("dashboardAuthSession",{authenticated:true,user:{id:actor,name:actor,provider:"test"}});
    (c as any).set("lunaRequestAuthKind","dashboard-cookie");await next();
  }).route("/agents",createPlatformAgentRoutes(db.db));
}
const path=()=>`/agents/${alice.agentId}/shadows/${alice.shadowId}/model-selection`;
const save=(body:object,actor="alice")=>app(actor).request(path(),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

test("default follows activation, fixed selection uses its own model and secrets without changing global activation",async()=>{
  expect(active.resolveShadowExecutionSnapshot(alice).model).toBe("model-first");
  expect((await save({mode:"fixed",revisionId:second.latestRevision.id})).status).toBe(200);
  expect(active.resolveShadowExecutionSnapshot(alice)).toMatchObject({profileId:second.id,revisionId:second.latestRevision.id,model:"model-second",env:{OPENAI_API_KEY:"second-secret"}});
  expect(active.resolveExecutionSnapshot(alice.agentId).profileId).toBe(first.id);
  const pinned=executionReference(active.resolveShadowExecutionSnapshot(alice));
  expect((await save({mode:"inherit"})).status).toBe(200);
  expect(active.resolveShadowExecutionSnapshot(alice).model).toBe("model-first");
  expect(active.resolvePinnedSnapshot(alice.agentId,pinned).model).toBe("model-second");
  active.activate(alice.agentId,second.latestRevision.id,"alice");
  expect(active.resolveShadowExecutionSnapshot(alice).model).toBe("model-second");
});

test("fixed selection stays on its selected revision and does not require a global active profile",()=>{
  const store=new ShadowModelSelectionStore(db.db);
  store.save("alice",alice,{mode:"fixed",revisionId:second.latestRevision.id});
  const newer=profiles.createRevision(second.id,{model:"new-model",env:{},secrets:{}});
  profiles.recordValidation(newer.id,{success:true,message:"ok"});
  expect(active.resolveShadowExecutionSnapshot(alice).revisionId).toBe(second.latestRevision.id);
  db.db.delete(schema.activeAgentConfig).run();
  expect(active.resolveShadowExecutionSnapshot(alice).model).toBe("model-second");
});

test("model selection rejects foreign revisions, unvalidated drafts and non-owner updates",async()=>{
  const foreign=new AgentProfileStore(db.db,undefined,bob.agentId).createProfile({name:"Foreign",agentType:"codex",model:"foreign",env:{},secrets:{}});
  expect((await save({mode:"fixed",revisionId:foreign.latestRevision.id})).status).toBe(409);
  const draft=profiles.createRevision(second.id,{model:"draft-model",env:{},secrets:{}});
  expect((await save({mode:"fixed",revisionId:draft.id})).status).toBe(409);
  expect((await save({mode:"fixed",revisionId:second.latestRevision.id},"bob")).status).toBe(403);
  expect((await save({mode:"inherit",revisionId:second.latestRevision.id})).status).toBe(400);
  const publicState=JSON.stringify(await (await app().request(path())).json());
  expect(publicState).not.toContain("first-secret");expect(publicState).not.toContain("second-secret");
});

test("selected profiles cannot be deleted until Shadows release the selection",()=>{
  const store=new ShadowModelSelectionStore(db.db);
  store.save("alice",alice,{mode:"fixed",revisionId:second.latestRevision.id});
  expect(()=>profiles.deleteProfile(second.id)).toThrow("agent_profile_in_use");
  store.save("alice",alice,{mode:"inherit"});profiles.deleteProfile(second.id);
  expect(profiles.getProfile(second.id)?.deletedAt).not.toBeNull();
});
