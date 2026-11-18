import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,realpathSync,rmSync,statSync,utimesSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DockerEnvironmentDriver} from "../../apps/worker/src/docker-driver";
import {EnvironmentStore,type EnvironmentRecord} from "../../apps/worker/src/environment-store";
import {EnvironmentManager} from "../../apps/worker/src/environment-manager";
import {WorkerConfig} from "../../apps/worker/src/config";
import {installRunnerRuntime,RUNNER_RUNTIME_MOUNT} from "../../apps/worker/src/runner-runtime";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";

let root:string,home:string,db:Database;
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),"runner-runtime-")));home=join(root,"worker");mkdirSync(home);db=new Database(join(root,"worker.sqlite"));});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
const files=(tag:string)=>({"executor.js":`executor ${tag}`,"job-main.js":`job ${tag}`,"job-process.js":`process ${tag}`,"luna-client.js":`cli ${tag}`});

test("the runtime installs once per version, readable by the container, with current pointing at it",()=>{
 const first=installRunnerRuntime(home,files("one"));
 expect(first.root).toBe(join(home,"runner-runtime"));
 expect(readlinkSync(join(first.root,"current"))).toBe(first.version);
 expect(readFileSync(join(first.root,"current/executor.js"),"utf8")).toBe("executor one");
 expect(statSync(join(first.root,first.version)).mode&0o777).toBe(0o755);
 expect(statSync(join(first.root,first.version,"luna-client.js")).mode&0o777).toBe(0o644);
 expect(installRunnerRuntime(home,files("one"))).toEqual(first);
 const second=installRunnerRuntime(home,files("two"));
 expect(second.version).not.toBe(first.version);
 expect(readFileSync(join(second.root,"current/executor.js"),"utf8")).toBe("executor two");
 // A running Executor may still use the earlier version.
 expect(existsSync(join(second.root,first.version))).toBe(true);
});

test("old versions beyond the three newest are removed, along with abandoned staging",()=>{
 const versions:string[]=[];
 for(const [index,tag] of ["a","b","c","d","e"].entries()){
  const installed=installRunnerRuntime(home,files(tag));versions.push(installed.version);
  utimesSync(join(installed.root,installed.version),new Date(1000*(index+1)),new Date(1000*(index+1)));
 }
 mkdirSync(join(home,"runner-runtime",".staging-left"));
 installRunnerRuntime(home,files("e"));
 expect(readdirSync(join(home,"runner-runtime")).sort()).toEqual(["current",...versions.slice(1)].sort());
});

/** A Docker that keeps containers in memory: created by run, then started and stopped. */
function fakeDocker(driver:DockerEnvironmentDriver){
 const containers=new Map<string,{id:string;running:boolean;labels:Record<string,string>;mounts:{Type:string;Source:string;Destination:string;RW:boolean}[];command:string[]}>();
 const calls:string[]=[];
 (driver as unknown as {docker:(args:string[])=>Promise<string>}).docker=async args=>{
  calls.push(args.slice(0,2).join(" "));
  if(args[0]==="info")return "4";
  if(args[0]==="volume")return "";
  if(args[0]==="container" && args[1]==="inspect"){
   const container=containers.get(args[2]!);
   if(!container)throw Object.assign(new (await import("@luna/execution-store")).ExecutionError(503,"docker_object_missing"));
   return JSON.stringify([{Id:container.id,State:{Running:container.running},Config:{Labels:container.labels},Mounts:container.mounts}]);
  }
  if(args[0]==="container" && ["start","stop"].includes(args[1]!)){
   for(const container of containers.values())if(container.id===args.at(-1))container.running=args[1]==="start";return "";
  }
  if(args[0]==="run"){
   const labels:Record<string,string>={},mounts:{Type:string;Source:string;Destination:string;RW:boolean}[]=[];
   for(let i=0;i<args.length;i++){
    if(args[i]==="--label"){const [key,...value]=args[i+1]!.split("=");labels[key!]=value.join("=");}
    if(args[i]==="--mount"){const fields=Object.fromEntries(args[i+1]!.split(",").map(part=>part.includes("=")?part.split("="):[part,"true"]));
     mounts.push({Type:fields.type,Source:fields.src,Destination:fields.dst,RW:fields.readonly!=="true"});}
   }
   const name=args[args.indexOf("--name")+1]!,id=`id-${containers.size+1}`;
   containers.set(name,{id,running:true,labels,mounts,command:args.slice(args.indexOf("--entrypoint"))});
   return id;
  }
  throw new Error(`unexpected docker ${args.join(" ")}`);
 };
 return {containers,calls};
}

function driverWith(runtime?:ReturnType<typeof installRunnerRuntime>){
 return new DockerEnvironmentDriver(db,WorkerConfig.parse({workerId:"worker",runtimeId:"runtime",dataRoot:home,controlToken:"t".repeat(43),imageDigest:`sha256:${"a".repeat(64)}`,runtimeEndpoint:"http://127.0.0.1:8091"}),runtime);
}
function environment(driver:DockerEnvironmentDriver):EnvironmentRecord{
 const scope={agentId:"agent",shadowId:"shadow",placementGeneration:1};
 const bundle=createScopedResources(scope,[]);
 new ScopedResourceStore(driver.config.dataRoot).publish(bundle,scope,bundle.selection);
 const {environment}=new EnvironmentStore(db).prepare({requestId:"r",occupant:{kind:"maintenance",scope,operationId:"op",operationHash:"a".repeat(64),contextId:"ctx"},
  spec:{protocolVersion:2,scope,resourceSelection:bundle.selection,environmentId:"luna",scopeKey:"session:ctx",mode:"shared",imageDigest:driver.config.imageDigest,callbackRuntimeId:"runtime",resources:{memory:"1g",cpus:1,pidsLimit:128}}});
 return environment;
}

test("containers run the Worker's Executor from the read-only mount, or the image's without one",async()=>{
 const runtime=installRunnerRuntime(home,files("one"));
 const driver=driverWith(runtime),docker=fakeDocker(driver),env=environment(driver);
 await driver.ensure(env);
 const container=[...docker.containers.values()][0]!;
 expect(container.command.slice(-1)).toEqual([`${RUNNER_RUNTIME_MOUNT}/current/executor.js`]);
 expect(container.mounts).toContainEqual({Type:"bind",Source:runtime.root,Destination:RUNNER_RUNTIME_MOUNT,RW:false});
 expect(await driver.executorOutdated(env)).toBe(false);

 const plain=driverWith(),plainDocker=fakeDocker(plain);
 await plain.ensure(environment(plain));
 const baked=[...plainDocker.containers.values()][0]!;
 expect(baked.command.slice(-1)).toEqual(["/app/agent-runner/dist/executor.js"]);
 expect(baked.mounts.some(mount=>mount.Destination===RUNNER_RUNTIME_MOUNT)).toBe(false);
});

test("a new Worker version restarts an idle container onto its Executor, keeping the container",async()=>{
 const first=driverWith(installRunnerRuntime(home,files("one"))),docker=fakeDocker(first),env=environment(first);
 await first.ensure(env);
 // The Worker is upgraded: same database, a new runtime version.
 const upgraded=driverWith(installRunnerRuntime(home,files("two")));
 (upgraded as unknown as {docker:unknown}).docker=(first as unknown as {docker:unknown}).docker;
 expect(await upgraded.executorOutdated(env)).toBe(true);
 const manager=new EnvironmentManager(new EnvironmentStore(db),upgraded);
 let activeJobs=1;
 (manager as unknown as {executor:()=>unknown}).executor=()=>({call:async()=>({instanceId:env.instanceId,activeJobs})});
 const update=(manager as unknown as {updateExecutor:(env:EnvironmentRecord)=>Promise<void>}).updateExecutor.bind(manager);
 await update(env);
 expect(docker.calls).not.toContain("container stop");
 activeJobs=0;
 await update(env);
 expect(docker.calls).toContain("container stop");
 docker.calls.length=0;
 await upgraded.ensure(env);
 expect(docker.calls).toEqual(["container inspect","container start"]);
 expect(docker.containers.size).toBe(1);
 expect(await upgraded.executorOutdated(env)).toBe(false);
});

test("the Executor starts Jobs from the job-main beside it, wherever it is installed",async()=>{
 const {ExecutorDeployment}=await import("@luna/executor/executor/main");
 const config=ExecutorDeployment.parse({protocolVersion:2,scope:{agentId:"a",shadowId:"s",placementGeneration:1},instanceId:"i",runtimeId:"r",workerId:"w",
  runtimeEndpoint:"http://127.0.0.1:1",runnerUid:1000,runnerGid:1000,capacity:1,controlToken:"t".repeat(43),maintenanceToken:"m".repeat(43),runnerLayout:{home:"/h",runners:"/h/runners"}});
 expect(config.runnerEntry).toBe(join(import.meta.dir,"../../apps/executor/src/executor/job-main.ts"));
});
