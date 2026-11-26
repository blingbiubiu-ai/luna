import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { config, setLunaHome } from "@/shared";
import { fixtureScope } from "../helpers/platform-fixtures";
import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { ShadowWorkerRoutingStore } from "@/agents/shadow-worker-routing-store";
import { createPlatformAgentRoutes } from "@/server/routes/platform-agents";
import { writePrivateJson } from "@luna/execution-store";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";

let home: string, previousHome: string, db: DataConnection<typeof schema>;
let alice: ReturnType<typeof fixtureScope>, bob: ReturnType<typeof fixtureScope>;
beforeEach(() => {
  previousHome=config.paths.home;
  home=mkdtempSync(join(tmpdir(),"luna-shadow-routing-"));setLunaHome(home);
  db=new DataConnection(schema);alice=fixtureScope(db.db,"alice");bob=fixtureScope(db.db,"bob");
  new AgentWorkerAccessStore(db.db).setOwned("alice",alice.agentId,"worker-a","active");
  new AgentWorkerAccessStore(db.db).setOwned("bob",bob.agentId,"worker-b","active");
});
afterEach(()=>{db.close();setLunaHome(previousHome);rmSync(home,{recursive:true,force:true});});
function app(actor="alice",kind="dashboard-cookie") {
  return new Hono().use("*",async(c,next)=>{
    (c as any).set("dashboardAuthSession",{authenticated: true, account: {id:actor,name:actor,provider:"test"}});
    (c as any).set("lunaRequestAuthKind",kind);await next();
  }).route("/agents",createPlatformAgentRoutes(db.db));
}
const path=()=>`/agents/${alice.agentId}/shadows/${alice.shadowId}/worker-routing`;
const save=(body:object,actor="alice")=>app(actor).request(path(),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

test("existing Shadows default to automatic, and bound policy persists without changing paused admission",async()=>{
  expect(await (await app().request(path())).json()).toEqual({routing:{mode:"automatic",workerId:null}});
  new AgentWorkerAccessStore(db.db).setPaused("alice",alice.agentId,"worker-a",true);
  expect(await (await save({mode:"bound",workerId:"worker-a"})).json()).toEqual({routing:{mode:"bound",workerId:"worker-a"}});
  expect(new ShadowWorkerRoutingStore(db.db).get(alice)).toEqual({mode:"bound",workerId:"worker-a"});
  expect(new AgentWorkerAccessStore(db.db).allowed(alice.agentId)).toEqual([]);
  expect(await (await save({mode:"automatic"})).json()).toEqual({routing:{mode:"automatic",workerId:null}});
});

test("routing rejects foreign, disabled and missing Workers, wrong Shadow scope and non-owner writes",async()=>{
  expect((await save({mode:"bound",workerId:"worker-b"})).status).toBe(409);
  expect((await save({mode:"bound",workerId:"missing"})).status).toBe(409);
  expect((await save({mode:"bound",workerId:"worker-a"},"bob")).status).toBe(403);
  new AgentWorkerAccessStore(db.db).setOwned("alice",alice.agentId,"worker-a","disabled");
  expect((await save({mode:"bound",workerId:"worker-a"})).status).toBe(409);
  expect((await app().request(`/agents/${alice.agentId}/shadows/${bob.shadowId}/worker-routing`)).status).toBe(409);
  expect((await save({mode:"automatic",workerId:"worker-a"})).status).toBe(400);
});

test("local Worker routing rejects non-administrators and hides an old binding after role revocation",async()=>{
  writePrivateJson(join(home,"runtime","runtime.json"),{runtimeId:"runtime",serviceId:"service",dataRoot:home,homeWorkerId:"worker-a",serviceToken:"s".repeat(43),adminToken:"a".repeat(43)});
  expect((await save({mode:"bound",workerId:"worker-a"})).status).toBe(403);
  const grants=new AuthorizationRuleStore(db.db,{kind:"platform"});
  const grant=grants.addGrant({subjectType:"user",subjectId:"alice",target:"system.admin",effect:"allow"});
  expect((await save({mode:"bound",workerId:"worker-a"})).status).toBe(200);
  grants.deleteGrant(grant.id);
  const read=await app().request(path());
  expect(read.status).toBe(403);
  expect(await read.json()).toEqual({status:"error",code:"local_worker_admin_required"});
  expect(new AgentWorkerAccessStore(db.db).allowed(alice.agentId,{includePaused:true})).toEqual([]);
  // The owner can still clear the old routing policy and use their remote Workers.
  expect((await save({mode:"automatic"})).status).toBe(200);
});
