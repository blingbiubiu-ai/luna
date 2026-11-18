import {runWorkerCli} from "../../apps/worker/src/cli";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Hono} from "hono";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {fixtureScope,fixturePlatformAdmin} from "../helpers/platform-fixtures";
import {AgentWorkerAccessStore} from "@/agents/agent-worker-access-store";
import {createAgentWorkerAccessRoutes} from "@/server/routes/agent-worker-access";
import {openExecutionDatabase, ExecutionError, writePrivateJson} from "@luna/execution-store";
import {TokenAuthority} from "@luna/execution-transport";
import {AgentError, AgentStore} from "@/agents/agent-store";
import {WorkerGateway} from "@/runtime/worker-gateway";
import {RuntimeConfig} from "@/runtime/config";
import {RuntimeScheduler} from "@/runtime/scheduler";
let home:string,connection:DataConnection<typeof schema>,store:AgentWorkerAccessStore;
let a:ReturnType<typeof fixtureScope>,b:ReturnType<typeof fixtureScope>;
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),"luna-worker-access-"));setLunaHome(home);connection=new DataConnection(schema);a=fixtureScope(connection.db,"alice");b=fixtureScope(connection.db,"bob");fixturePlatformAdmin(connection.db,"admin");store=new AgentWorkerAccessStore(connection.db);});
afterEach(()=>{connection.close();rmSync(home,{recursive:true,force:true});});
function app(actor:string,gateway?:WorkerGateway){
 return new Hono().use("*",async(c,next)=>{
  (c as any).set("dashboardAuthSession",{authenticated: true, account: {id:actor,name:actor,provider:"test"}});
  (c as any).set("lunaRequestAuthKind","dashboard-cookie");(c as any).set("lunaAuthorizationDb",connection.db);await next();
 }).route("/",createAgentWorkerAccessRoutes(connection.db,()=>gateway));
}
test("a private pairing code assigns a new Worker to the issuing Agent and only its owner can reuse it", async () => {
 const runtimeDb = openExecutionDatabase(":memory:");
 try {
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", environmentId: "environment",
   dataRoot: home, homeWorkerId: "local",
   serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
  const scheduler = new RuntimeScheduler(runtimeDb, config, new TokenAuthority(runtimeDb));
  const gateway = new WorkerGateway(runtimeDb, scheduler, undefined, (target, workerId) => {
   try {
    store.setOwned(target.ownerUserId, target.agentId, workerId, "active");
   } catch (error) {
    if (error instanceof AgentError) throw new ExecutionError(error.status, error.code);
    throw error;
   }
  });
  const alice = app("alice", gateway);
  const bob = app("bob", gateway);
  const bindingPath = `/${a.agentId}/workers/binding-code`;
  const generate = { method: "POST" };
  expect((await bob.request(bindingPath, generate)).status).toBe(403);
  const issued = await alice.request(bindingPath, generate);
  expect(issued.status).toBe(200);
  const { code } = await issued.json() as { code: string };
  const redeem = (body: object, token?: string) => gateway.http(new Request("http://localhost/api/worker/bind",
   { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
  expect((await redeem({ code, agentId: b.agentId })).status).toBe(422);
  const bound = await redeem({ code });
  expect(bound.status).toBe(200);
  const { workerId, token } = await bound.json() as { workerId: string; token: string };
  expect((await redeem({ code })).status).toBe(401);
  expect(gateway.owner(workerId)).toBe("alice");
  expect(store.allowed(a.agentId)).toEqual([workerId]);
  const drainPath = `/${a.agentId}/workers/${workerId}/drain`;
  // Pausing admission is this Agent's own assignment: its owner may, a platform admin may not.
  expect((await app("admin", gateway).request(drainPath, generate)).status).toBe(403);
  expect((await bob.request(drainPath, generate)).status).not.toBe(200);
  expect(store.allowed(a.agentId)).toEqual([workerId]);
  expect((await alice.request(drainPath, generate)).status).toBe(200);
  expect(gateway.list()[0]?.draining).toBe(false);
  expect(store.allowed(a.agentId)).toEqual([]);
  expect((await alice.request(`/${a.agentId}/workers/${workerId}/resume`, generate)).status).toBe(200);
  expect(store.allowed(a.agentId)).toEqual([workerId]);
  const bobCode = await (await bob.request(`/${b.agentId}/workers/binding-code`, generate)).json() as { code: string };
  expect((await redeem({ code: bobCode.code }, token)).status).toBe(403);
  expect(await (await bob.request(`/${b.agentId}/workers`)).json()).toEqual({ workers: [], assignments: [], canManageWorkers: true });
  const second = new AgentStore(connection.db).create("alice", { name: "Second" }, "second-agent");
  const secondPath = `/${second.id}/workers`;
  const update = { method: "PUT", headers: { "Content-Type": "application/json" } };
  expect((await alice.request(`${secondPath}/${workerId}`, { ...update, body: '{"status":"active"}' })).status).toBe(400);
  const secondCode = await (await alice.request(`${secondPath}/binding-code`, generate)).json() as { code: string };

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => gateway.http(request) });
  try {
   const file = join(home, "worker.json");
   writePrivateJson(file, {
    dataRoot: home, imageDigest: `sha256:${"a".repeat(64)}`,
   });
   writePrivateJson(join(home, "binding.json"), { workerId, runtimeId: config.runtimeId, serviceUrl: server.url.origin, controlToken: token });
   const before = readFileSync(file, "utf8");
   const result = await runWorkerCli(["bind", "--service", server.url.origin, "--config", file], {
    LUNA_WORKER_BIND_CODE: secondCode.code,
   });
   expect(result.status).toBe("ok");
   expect(JSON.parse(result.output!)).toEqual({ workerId, agentId: second.id });
   expect(readFileSync(file, "utf8")).toBe(before);
  } finally {
   await server.stop(true);
  }
  expect((await redeem({ code: secondCode.code }, token)).status).toBe(401);
  expect(gateway.list()).toHaveLength(1);
  expect(store.allowed(second.id)).toEqual([workerId]);
  expect((await alice.request(`${secondPath}/${workerId}`, { ...update, body: '{"status":"disabled"}' })).status).toBe(200);
  expect(store.allowed(second.id)).toEqual([]);
  expect(store.allowed(a.agentId)).toEqual([workerId]);
 } finally {
  runtimeDb.close();
 }
});

test("the deployed local Worker can be assigned and paused, but its binding cannot be removed", async () => {
 const runtimeDb = openExecutionDatabase(":memory:");
 try {
  const workerId = "same-host";
  const controlToken = "w".repeat(43);
  const config = RuntimeConfig.parse({
   runtimeId: "runtime", serviceId: "service", dataRoot: home, homeWorkerId: workerId,
    serviceToken: "s".repeat(43), adminToken: "a".repeat(43),
  });
  const scheduler = new RuntimeScheduler(runtimeDb, config, new TokenAuthority(runtimeDb));
  const gateway = new WorkerGateway(runtimeDb, scheduler, undefined, (target, id) =>
   store.setOwned(target.ownerUserId, target.agentId, id, "active"));
  gateway.registerLocal({workerId, controlToken, port: 8092, executorPortStart: 41000, executorPortEnd: 41100});
  const alice = app("alice", gateway);
  const path = `/${a.agentId}/workers`;
  const issued = await alice.request(path + "/binding-code", {method: "POST"});
  const {code} = await issued.json() as {code: string};
  const bound = await gateway.http(new Request("http://localhost/api/worker/bind", {
   method: "POST", headers: {authorization: `Bearer ${controlToken}`}, body: JSON.stringify({code}),
  }));
  expect(bound.status).toBe(200);
  expect(gateway.owner(workerId)).toBe("alice");
  const list = await alice.request(path);
  expect(await list.json()).toMatchObject({
   workers: [expect.objectContaining({workerId, local: true, owned: true})],
   canManageWorkers: true,
  });
  const second = new AgentStore(connection.db).create("alice", {name: "Second"}, "second-local-agent");
  store.setOwned("alice", second.id, workerId, "active");
  const secondScope = {agentId: second.id, shadowId: second.defaultShadowId};
  scheduler.workers.heartbeat(workerId, {
   workerId, imageDigest: `sha256:${"a".repeat(64)}`, ready: true, occupied: 0, capacity: 2,
   capabilities: ["shadow-scope-v2"],
  });
  expect(scheduler.placements.route(a, store.allowed(a.agentId)).workerId).toBe(workerId);
  const workerPath = `${path}/${workerId}`;
  const unbind = await alice.request(workerPath, {method: "PUT", body: '{"status":"disabled"}'});
  expect(unbind.status).toBe(409);
  expect(await unbind.json()).toMatchObject({code: "local_worker_cannot_unbind"});
  expect(() => scheduler.workers.remove(workerId)).toThrow("local_worker_cannot_unbind");
  expect(() => gateway.action(workerId, "revoke")).toThrow("local_worker_cannot_unbind");
  expect((await alice.request(workerPath + "/drain", {method: "POST"})).status).toBe(200);
  expect(gateway.list()[0]?.draining).toBe(false);
  expect(store.allowed(a.agentId)).toEqual([]);
  expect(store.allowed(a.agentId, {includePaused: true})).toEqual([workerId]);
  expect(() => scheduler.placements.route(a, store.allowed(a.agentId))).toThrow();
  expect(scheduler.placements.route(secondScope, store.allowed(second.id)).workerId).toBe(workerId);

  const pausedList = await alice.request(path);
  expect(await pausedList.json()).toMatchObject({
   assignments: [{workerId, status: "active", paused: true}],
  });
  expect((await alice.request(workerPath + "/resume", {method: "POST"})).status).toBe(200);
  expect(store.allowed(a.agentId)).toEqual([workerId]);
  expect(store.allowed(second.id)).toEqual([workerId]);
 } finally {
  runtimeDb.close();
 }
});
