import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import { markUnuploadedRemoteFiles } from "../../src/artifacts/runner-output-artifactizer";
import { execFileSync } from "node:child_process";
import { workerServer } from "../../apps/worker/src/server";
import { closeExecutionServer } from "@luna/execution-transport";
import { contentHash } from "@luna/execution-store";
import { expect, test } from "bun:test";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openExecutionDatabase } from "@luna/execution-store";
import { ReverseChannel, TokenAuthority } from "@luna/execution-transport";
import { collectRunnerResources, validateRunnerResources, resourceDigest } from "@luna/host-runtime/runner-resources";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { RuntimeConfig } from "../../src/runtime/config";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeFiles } from "../../src/runtime/files";
import { WorkerGateway, type WorkerSocketData } from "../../src/runtime/worker-gateway";
import { WorkerConfig } from "../../apps/worker/src/config";
import { DockerEnvironmentDriver } from "../../apps/worker/src/docker-driver";
import { EnvironmentManager } from "../../apps/worker/src/environment-manager";
import { EnvironmentStore } from "../../apps/worker/src/environment-store";
import { ServiceLink } from "../../apps/worker/src/service-link";
const dockerEnabled = process.env.LUNA_DOCKER_INTEGRATION === "1";
const image = dockerEnabled ? execFileSync("docker", ["image", "inspect", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:remote-worker", "--format", "{{.Id}}"], { encoding: "utf8" }).trim() : `sha256:${"a".repeat(64)}`;
async function until(predicate: () => boolean) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await delay(20); } }

test("reverse calls reject on disconnect, do not replay and ignore stale responses", async () => {
  let sent = ""; const channel = new ReverseChannel(value => { sent = value; });
  const call = channel.call("POST", "/v1/test"); const id = JSON.parse(sent).id;
  channel.close(); await expect(call).rejects.toMatchObject({ code: "worker_disconnected" });
  channel.receive({ id, status: 200, body: "late" });
  await expect(channel.call("GET", "/v1/health")).rejects.toMatchObject({ code: "worker_disconnected" });
});

test("resource bundles reject traversal and mismatched bytes", () => {
  const files = [{ path: ".runner-bin/../../escaped", content: "eA==", mode: 0o755 }];
  expect(() => validateRunnerResources({ files, revision: resourceDigest(files) })).toThrow("Invalid resource entry");
  expect(() => validateRunnerResources({ files: [], revision: "0".repeat(64) })).toThrow("digest mismatch");
});

test("remote Worker binds once, downloads its scoped snapshot and renders its own paths", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "luna-remote-worker-")));
  const serviceHome = join(root, "service"); const workerHome = join(root, "worker");
  mkdirSync(join(serviceHome, ".runner-bin"), { recursive: true }); writeFileSync(join(serviceHome, ".runner-bin/tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
  cpSync(join(import.meta.dir, "../../src/prompts"), join(serviceHome, ".runner_prompt"), { recursive: true });
  const db = openExecutionDatabase(":memory:"); const workerDb = openExecutionDatabase(":memory:");
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", environmentId: "environment", dataRoot: join(root, "runtime"), homeWorkerId: "local",  serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
  const scope={agentId:"agent",shadowId:"shadow"};
  const source=collectRunnerResources(serviceHome);
  const bundle=createScopedResources(scope,source.files.map(file=>({...file,path:file.path.replace(".runner_prompt/","public/prompts/").replace(".runner-bin/","public/commands/").replace(".runner-skills/","public/skills/")})));
  const bundles=[bundle,...[{agentId:"agent",shadowId:"second"},{agentId:"other-agent",shadowId:"default"}].map(s=>createScopedResources(s,bundle.files))];
  const allowed:string[]=[];
  const settled = new Set<string>();
  const scheduler = new RuntimeScheduler(db, config, new TokenAuthority(db),()=>allowed,id => settled.has(id));
  const runtime = new Runtime(scheduler, new RuntimeFiles(scheduler));
  const gateway = new WorkerGateway(db, scheduler,(requested,digest)=>bundles.find(b=>b.agentId===requested.agentId && b.shadowId===requested.shadowId && b.selection.digest===digest), (_target, workerId) => { allowed.push(workerId); });
  const server = Bun.serve<WorkerSocketData>({ port: 0, hostname: "127.0.0.1", fetch(req, server) {
    if (new URL(req.url).pathname === "/api/worker/connect") {
      try { const workerId = gateway.authenticate(req); if (server.upgrade(req, { data: { workerId, gateway } })) return; } catch { return new Response("unauthorized", { status: 401 }); }
    }
    return gateway.http(req);
  }, websocket: { open: ws => gateway.open(ws), message: (ws, raw) => gateway.message(ws, raw), close: ws => gateway.closed(ws) } });
  let link: ServiceLink | undefined;
  let manager: EnvironmentManager | undefined;
  let workerServerInstance: ReturnType<typeof workerServer> | undefined;
  try {
    const code = gateway.createCode({ ownerUserId: "owner", agentId: scope.agentId }).code;
    const bind = () => fetch(new URL("/api/worker/bind", server.url), { method: "POST", body: JSON.stringify({ code }) });
    const response = await bind(); expect(response.status).toBe(200);
    const bound = await response.json() as { workerId: string; token: string };
    expect((await bind()).status).toBe(401);
    const workerConfig = WorkerConfig.parse({ workerId: bound.workerId, runtimeId: "runtime", dataRoot: workerHome, runtimeEndpoint: "http://host.docker.internal:8092", controlToken: bound.token, imageDigest: image, network: `remote-test-${bound.workerId}`, executorPortStart: 41090, executorPortEnd: 41100 });
    mkdirSync(workerConfig.dataRoot, { recursive: true });
    manager = new EnvironmentManager(new EnvironmentStore(workerDb), new DockerEnvironmentDriver(workerDb, workerConfig));
    const workerGrants = new TokenAuthority(workerDb);
    if (dockerEnabled) {
      workerGrants.register("control", bound.token, { role: "runtime", id: "runtime" });
      workerServerInstance = workerServer(workerGrants, manager, (job, instance, body) => link!.events(job, instance, body));
      await new Promise<void>(resolve => workerServerInstance!.listen(0, "0.0.0.0", resolve));
      workerConfig.port = (workerServerInstance.address() as { port: number }).port;
      workerConfig.runtimeEndpoint = `http://host.docker.internal:${workerConfig.port}`;
      await manager.driver.preflight();
    }
    if (!dockerEnabled) manager.driver.health=async()=>{}; // This branch verifies transport/filesystem only.
    link = new ServiceLink(manager, workerGrants, server.url.origin, bound.token); link.start();
    await until(() => gateway.list()[0]?.health?.ready === true);

    const client = scheduler.workers.client(bound.workerId);
    const prepared = await scheduler.preparation.prepare({protocolVersion:2,invocationId:"invocation",scope,resources:bundle.selection,
      contextId:"context",runnerId:"context",scopeKey:"session:context",runnerKind:"work",context:{schemaVersion:1,owner:{type:"session",id:"session"}}});
    expect(prepared.cwd).toBe("/home/luna/runners/context");
    expect(prepared.hostCwd).toBe(join(workerHome,"agents/agent/shadows/shadow/runners/context"));
    const instructions = readFileSync(join(prepared.hostCwd!, "AGENTS.md"), "utf8");
    expect(instructions).toContain(prepared.cwd); expect(instructions).not.toContain(serviceHome); expect(instructions).not.toContain(workerHome);
    expect(prepared.instructionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(join(prepared.hostCwd!, ".luna/runner-context.json"), "utf8")).owner.id).toBe("session");
    if (dockerEnabled) {
      scheduler.submit({ version: 2, scope:prepared.scope,resources:bundle.selection, jobId: "remote-job", invocationId: "invocation", environmentId: "environment", runnerContextId: "context", scopeKey: "session:context", runnerKind: "work", sessionId: "session", resourceRevision: bundle.selection.digest, input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 30000 });
      await scheduler.tick();
      const job = scheduler.jobs.require("remote-job");
      expect(job.assignment?.workerId).toBe(bound.workerId);
      expect(job.lastError).toBeUndefined();
      scheduler.cancel("remote-job"); await scheduler.tick();
      const deadline = Date.now() + 10000;
      while (scheduler.jobs.require("remote-job").placementState !== "terminal" && Date.now() < deadline) { await delay(100); await scheduler.tick(); }
      expect(scheduler.jobs.require("remote-job").execution?.state).toBe("cancelled");
      await scheduler.tick();
      expect(manager.store.list().every(e => manager!.store.active(e.id).length === 0)).toBe(true);
      for(const [index,resources] of bundles.slice(1).concat(bundle).entries()){
        const contextId=`context-${index}`,invocationId=`invocation-${index}`,jobId=`job-${index}`;
        const context=await scheduler.preparation.prepare({protocolVersion:2,invocationId,scope:{agentId:resources.agentId,shadowId:resources.shadowId},resources:resources.selection,contextId,runnerId:contextId,scopeKey:`session:${contextId}`,runnerKind:"work"});
        scheduler.submit({version:2,scope:context.scope,resources:resources.selection,resourceRevision:resources.selection.digest,jobId,invocationId,environmentId:"environment",runnerContextId:contextId,scopeKey:`session:${contextId}`,runnerKind:"work",sessionId:contextId,input:{runnerType:"codex",prompt:"test"},credentialsRevision:1,timeoutMs:30000});
        await scheduler.tick();expect(scheduler.jobs.require(jobId).assignment?.workerId).toBe(bound.workerId);
        scheduler.cancel(jobId);
        const end=Date.now()+10000;
        while(scheduler.jobs.require(jobId).placementState!=="terminal" && Date.now()<end){await scheduler.tick();await delay(50);}
        expect(scheduler.jobs.require(jobId).execution?.state).toBe("cancelled");await scheduler.tick();
      }
      const environments=manager.store.list();expect(environments).toHaveLength(3);
      for(const environment of environments){
        expect(manager.store.active(environment.id)).toHaveLength(0);
        const container=await manager.driver.inspect(environment);expect(container?.State.Running).toBe(true);
        const hostHome=join(workerHome,"agents",environment.spec.scope.agentId,"shadows",environment.spec.scope.shadowId),home="/home/luna";
        expect(container!.Mounts.some(m=>m.Destination===home && m.RW && [hostHome,`/host_mnt${hostHome}`].includes(m.Source))).toBe(true);
        for(const other of environments.filter(e=>e.id!==environment.id)){
          const foreign=join(workerHome,"agents",other.spec.scope.agentId,"shadows",other.spec.scope.shadowId);
          expect(container!.Mounts.some(m=>m.Destination===foreign)).toBe(false);
          execFileSync("docker",["exec",container!.Id,"test","!","-e",foreign]);
        }
        execFileSync("docker",["exec",container!.Id,"touch",join(home,"own-write")]);
        expect(readFileSync(join(hostHome,"own-write"),"utf8")).toBe("");
        // Snapshot versions are mounted read-only; .luna-resources is a link into them.
        expect(container!.Mounts.some(m=>m.Destination===join(home,".luna-resource-versions") && !m.RW)).toBe(true);
        expect(()=>execFileSync("docker",["exec",container!.Id,"touch",join(home,".luna-resources/forbidden-write")],{stdio:"ignore"})).toThrow();
      }


      const previous = environments.find(environment => environment.spec.scope.shadowId === scope.shadowId)!;
      const oldContainer = await manager.driver.inspect(previous);
      const updated = createScopedResources(scope, [...bundle.files, {
        path: "public/prompts/SOUL.md",
        content: Buffer.from("updated persona").toString("base64"),
        mode: 0o644,
      }]);
      bundles.push(updated);
      const next = {
        protocolVersion: 2 as const, invocationId: "updated-invocation", scope, resources: updated.selection,
        contextId: "updated-context", runnerId: "updated-context", scopeKey: "session:updated-context", runnerKind: "work" as const,
      };
      await expect(scheduler.preparation.prepare(next)).rejects.toMatchObject({ code: "shadow_resources_pending" });
      settled.add("invocation");
      settled.add("invocation-2");
      await scheduler.tick();
      const context = await scheduler.preparation.prepare(next);
      scheduler.submit({
        version: 2, scope: context.scope, resources: updated.selection, resourceRevision: updated.selection.digest,
        jobId: "updated-job", invocationId: next.invocationId, environmentId: "environment",
        runnerContextId: next.contextId, scopeKey: next.scopeKey, runnerKind: "work", sessionId: next.contextId,
        input: { runnerType: "codex", prompt: "test" }, credentialsRevision: 1, timeoutMs: 30000,
      });
      await scheduler.tick();
      expect(scheduler.jobs.require("updated-job").assignment?.workerId).toBe(bound.workerId);
      await expect(runtime.drainShadow(scope)).rejects.toMatchObject({code: "shadow_execution_pending"});
      const replacement = manager.store.require(previous.id);
      expect(replacement.spec.resourceSelection.digest).toBe(updated.selection.digest);
      expect(manager.store.list()).toHaveLength(3);
      const container = await manager.driver.inspect(replacement);
      // A new snapshot switches the HOME link; the container (and its system disk) stays.
      expect(container?.Id).toBe(oldContainer?.Id);
      expect(execFileSync("docker", ["exec", container!.Id, "cat", join(context.home, ".luna-resources/prompts/SOUL.md")], { encoding: "utf8" })).toBe("updated persona");
      execFileSync("docker", ["exec", container!.Id, "test", "-f", join(context.home, "own-write")]);
      for (const other of environments.filter(environment => environment.id !== previous.id)) {
        expect((await manager.driver.inspect(other))?.Id).toBe(other.containerId ?? undefined);
      }
      scheduler.cancel("updated-job");
      const end = Date.now() + 10000;
      while (scheduler.jobs.require("updated-job").placementState !== "terminal" && Date.now() < end) {
        await scheduler.tick();
        await delay(50);
      }
      expect(scheduler.jobs.require("updated-job").execution?.state).toBe("cancelled");
      await scheduler.tick();
      expect(manager.store.active(previous.id)).toHaveLength(0);
      await expect(runtime.drainShadow(scope)).rejects.toMatchObject({code: "shadow_execution_pending"});
      settled.add(next.invocationId);
      await scheduler.tick();
      await runtime.drainShadow(scope);
      await runtime.drainShadow(scope);
      expect(await manager.driver.inspect(manager.store.require(previous.id))).toBeNull();
      expect(manager.store.require(previous.id).state).toBe("stopped");
      expect(readFileSync(join(workerHome, "agents/agent/shadows/shadow/own-write"), "utf8")).toBe("");
      for (const other of environments.filter(environment => environment.id !== previous.id)) {
        expect((await manager.driver.inspect(other))?.Id).toBe(other.containerId ?? undefined);
      }
    }
    // Deleting the Shadow purges its Worker data for good: environments, HOME and resource files.
    const shadowHome = join(workerHome, "agents/agent/shadows/shadow"), shadowResources = join(workerHome, "agents/agent/shadow-resources/shadow");
    expect(existsSync(shadowHome)).toBe(true);
    const mine = (environment: { spec: { scope: { shadowId: string } } }) => environment.spec.scope.shadowId === scope.shadowId;
    const containers = await Promise.all(manager.store.list().filter(mine).map(environment => manager!.driver.inspect(environment)));
    const others = manager.store.list().filter(environment => !mine(environment));
    const removedIds = manager.store.list().filter(mine).map(environment => environment.id);
    settled.add("invocation"); await scheduler.tick();
    // Without Docker the Worker's HTTP side is not wired, so purge it directly.
    if (dockerEnabled) await runtime.purgeShadow(scope); else await manager.purgeShadow(scope);
    expect(existsSync(shadowHome)).toBe(false);
    expect(existsSync(shadowResources)).toBe(false);
    expect(manager.store.list().filter(environment => environment.spec.scope.shadowId === scope.shadowId)).toEqual([]);
    expect(workerDb.prepare("SELECT count(*) AS n FROM worker_shadow_layouts WHERE shadow_id=?").get(scope.shadowId)).toEqual({ n: 0 });
    for (const container of containers.filter(Boolean)) expect(() => execFileSync("docker", ["container", "inspect", container!.Id], { stdio: "ignore" })).toThrow();
    if (dockerEnabled) for (const id of removedIds)
      expect(execFileSync("docker", ["volume", "ls", "-q", "--filter", `name=${id}`], { encoding: "utf8" }).trim()).toBe("");
    // Other Shadows on the same Worker keep their environments.
    expect(manager.store.list().map(environment => environment.id).sort()).toEqual(others.map(environment => environment.id).sort());
    if (dockerEnabled) {
      expect(scheduler.placements.find(scope)).toBeUndefined();
      expect(runtime.placedShadows().map(placed => placed.shadowId).sort()).toEqual(["default", "second"]);
      await runtime.purgeShadow(scope);
    }
    await manager.purgeShadow(scope);
    gateway.action(bound.workerId, "drain"); expect(gateway.list()[0]!.draining).toBe(true);
    gateway.action(bound.workerId, "resume"); expect(gateway.list()[0]!.draining).toBe(false);
    gateway.action(bound.workerId, "revoke"); await until(() => !gateway.list()[0]!.connected);
    expect((await fetch(new URL("/api/worker/resources", server.url), { headers: { authorization: `Bearer ${bound.token}` } })).status).toBe(401);
  } finally { link?.stop(); gateway.close(); server.stop(true);
    if (workerServerInstance) await closeExecutionServer(workerServerInstance);
    if (dockerEnabled && manager) {
      for (const env of manager.store.list()) { await manager.driver.remove(env); execFileSync("docker", ["volume", "rm", `luna-${contentHash(manager.driver.config.workerId).slice(0, 12)}-${env.id}`], { stdio: "ignore" }); }
      try { execFileSync("docker", ["network", "rm", manager.driver.config.network], { stdio: "ignore" }); } catch {}
    }
    db.close(); workerDb.close(); rmSync(root, { recursive: true, force: true }); }
}, dockerEnabled ? 60000 : 15000);

test("remote output never resolves local files and preserves published references", () => {
  const published = "[report](artifact:report) ![plot](https://example.com/plot.png) //example.com/report.pdf";
  expect(markUnuploadedRemoteFiles(published)).toBe(published);
  expect(markUnuploadedRemoteFiles({ text: "See workspace/report.md" }).text).toContain("文件未上传");
  expect(markUnuploadedRemoteFiles("See /tmp/private/report.md")).not.toContain("/tmp/private");
});

test("container callback listener accepts Executor events but never control operations", async () => {
  const { executorCallbackServer } = await import("../../apps/worker/src/server");
  const { ExecutionClient } = await import("@luna/execution-transport");
  const grants = new TokenAuthority();
  const executor = grants.issue("exec", { role: "executor", id: "instance" });
  const control = grants.issue("control", { role: "runtime", id: "runtime" });
  let received: unknown;
  const server = executorCallbackServer(grants, (job, instance, body) => { received = { job, instance, body }; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const client = new ExecutionClient(origin, executor);
    await client.call("POST", "/v1/ingest/jobs/job/events", { event: "test" });
    expect(received).toEqual({ job: "job", instance: "instance", body: { event: "test" } });
    await expect(client.call("POST", "/v1/environments/prepare", {})).rejects.toMatchObject({ status: 404 });
    await expect(new ExecutionClient(origin, control).call("POST", "/v1/ingest/jobs/job/events", {})).rejects.toMatchObject({ status: 403 });
  } finally { await closeExecutionServer(server); }
});
