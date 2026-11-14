import {fixtureJobScope} from "../helpers/job-scope";
import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime";
import { RuntimeConfig } from "../../src/runtime/config";
import { WorkerConfig } from "@luna/worker/config";
import { DockerEnvironmentDriver } from "@luna/worker/docker-driver";
import { EnvironmentStore } from "@luna/worker/environment-store";
import { EnvironmentManager } from "@luna/worker/environment-manager";
import { workerServer } from "@luna/worker/server";
import { contentHash, openExecutionDatabase, writePrivateJson } from "@luna/execution-store";
import { TokenAuthority, closeExecutionServer, ExecutionClient } from "@luna/execution-transport";

const docker = (...args: string[]) => execFileSync("docker", args, {encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const port = (server.address() as {port:number}).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test.skipIf(process.env.LUNA_DOCKER_INTEGRATION !== "1")("embedded Runtime resumes the same Docker Job after owner restart without replaying the Runner", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),"luna-embedded-docker-")));
  const suffix = contentHash(root).slice(0,12), workerId = `embedded_${suffix}`;
  const baseTag = `luna-embedded-base:${suffix}`, imageTag = `luna-embedded-fixture:${suffix}`;
  const runtimePort = await freePort();
  const db = openExecutionDatabase(join(root,"worker/worker.sqlite"));
  let runtime: Runtime | undefined;
  let worker: ReturnType<typeof workerServer> | undefined;
  let driver: DockerEnvironmentDriver | undefined;
  let store: EnvironmentStore | undefined;
  try {
    docker("tag", process.env.LUNA_RUNNER_TEST_IMAGE ?? "luna-runner:latest", baseTag);
    writeFileSync(join(root,"Dockerfile"),`FROM ${baseTag}\nCOPY job-main.js /app/agent-runner/dist/job-main.js\n`);
    writeFileSync(join(root,"job-main.js"),`
const fs=require('node:fs'); await Bun.stdin.text();
const emit=x=>console.log('---LUNA_OUTPUT_START---\\n'+JSON.stringify(x)+'\\n---LUNA_OUTPUT_END---');
const count=fs.existsSync('attempts')?Number(fs.readFileSync('attempts','utf8'))+1:1;
fs.writeFileSync('attempts',String(count));
emit({status:'init',sessionId:'embedded-provider'});
while(!fs.existsSync('finish')) await Bun.sleep(100);
emit({status:'success',result:'embedded completed'});
`);
    docker("build","--platform", "linux/" + docker("image","inspect",baseTag,"--format","{{.Architecture}}"),"-t",imageTag,root);
    const digest = docker("image","inspect",imageTag,"--format","{{.Id}}");
    const file = join(root,"runtime/runtime.json");
    const config = RuntimeConfig.parse({runtimeId:"runtime",serviceId:"service",dataRoot:join(root,"runtime"),serviceToken:"s".repeat(43),adminToken:"a".repeat(43),homeWorkerId:workerId,port:runtimePort,listenHost:"0.0.0.0",resources:{memory:"1g",cpus:1,pidsLimit:128}});
    writePrivateJson(file,config);
    runtime = await Runtime.start(file);
    const grants = new TokenAuthority(db), token = grants.issue("runtime",{role:"runtime",id:"runtime"});
    const workerConfig = WorkerConfig.parse({workerId,runtimeId:"runtime",dataRoot:join(root,"worker"),runtimeEndpoint:`http://host.docker.internal:${runtimePort}`,controlToken:token,imageDigest:digest,network:`luna-${workerId}`,executorPortStart:43900,executorPortEnd:43910});
    driver = new DockerEnvironmentDriver(db,workerConfig); store = new EnvironmentStore(db);
    await driver.preflight();
    worker = workerServer(grants,new EnvironmentManager(store,driver));
    await new Promise<void>(resolve=>worker!.listen(0,"127.0.0.1",resolve));
    const admin = new ExecutionClient(`http://127.0.0.1:${runtimePort}`,config.adminToken);
    await admin.call("POST","/v1/workers",{workerId,endpoint:`http://127.0.0.1:${(worker.address() as {port:number}).port}`,controlToken:token,executorHost:"127.0.0.1",executorPortStart:43900,executorPortEnd:43910});
    // Reload starts immediate Worker polling and reuses its persisted registration.
    await runtime.close(); runtime = await Runtime.start(file);
    await runtime.files({operationId:"prepare",contextId:"context",scopeKey:"session:context",operation:{kind:"provision"}});
    await runtime.submit({version: 2, ...fixtureJobScope(), jobId:"job",invocationId:"inv",environmentId:"luna",runnerContextId:"context",scopeKey:"session:context",runnerKind:"work",sessionId:"session",input:{runnerType:"codex",prompt:"fixture"},credentialsRevision:1,timeoutMs:60000});
    await runtime.credentials("job",{revision:1,expiresAt:Date.now()+120000,env:{}});
    const deadline=Date.now()+30000;
    let running = await runtime.query("job");
    while(running.execution?.state!=="running" && Date.now()<deadline) {await Bun.sleep(100);running=await runtime.query("job");}
    expect(running.execution?.state).toBe("running");
    const container = docker("ps","-q","--filter",`label=luna.worker=${workerId}`);
    const cwd = driver.contextPath("context")!;
    while(Date.now()<deadline) {try {expect(docker("exec",container,"cat",`${cwd}/attempts`)).toBe("1");break;}catch{await Bun.sleep(100);}}
    expect(docker("exec",container,"cat",`${cwd}/attempts`)).toBe("1");
    await runtime.close(); runtime = undefined;
    // Complete while the owner is offline: recovery must query the durable result.
    writeFileSync(join(cwd,"finish"),"");
    await Bun.sleep(500);
    runtime = await Runtime.start(file);
    let final = await runtime.query("job");
    while(final.placementState!=="terminal" && Date.now()<deadline) {await Bun.sleep(100);final=await runtime.query("job");}
    expect(final.execution).toMatchObject({state:"succeeded",finalText:"embedded completed",bootId:running.execution!.bootId});
    expect(final.assignment).toEqual(running.assignment);
    expect(docker("ps","-q","--filter",`label=luna.worker=${workerId}`)).toBe(container);
    expect(docker("exec",container,"cat",`${cwd}/attempts`)).toBe("1");
    const events=[]; for await(const event of runtime.events("job",running.lastSeq,AbortSignal.timeout(5000)))events.push(event);
    expect(events.some(event=>event.kind==="execution")).toBe(true);
  } finally {
    await runtime?.close(); if(worker) await closeExecutionServer(worker);
    if(driver && store) for(const environment of store.list()) {await driver.remove(environment);docker("volume","rm",`luna-${contentHash(workerId).slice(0,12)}-${environment.id}`);}
    try{docker("network","rm",`luna-${workerId}`);}catch{}
    try{docker("image","rm",imageTag,baseTag);}catch{}
    db.close();rmSync(root,{recursive:true,force:true});
  }
},90000);
