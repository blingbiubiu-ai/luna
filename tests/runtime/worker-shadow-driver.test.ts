import {Database} from "bun:sqlite";
import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DockerEnvironmentDriver} from "../../apps/worker/src/docker-driver";
import {EnvironmentStore} from "../../apps/worker/src/environment-store";
import {WorkerConfig} from "../../apps/worker/src/config";
import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";
let root:string,db:Database,driver:DockerEnvironmentDriver,store:EnvironmentStore;
beforeEach(()=>{
 root=realpathSync(mkdtempSync(join(tmpdir(),"shadow-driver-")));db=new Database(join(root,"worker.sqlite"));
 const home=join(root,"worker"),projects=join(root,"projects");mkdirSync(home);mkdirSync(projects);
 mkdirSync(join(home,".ssh"),{recursive:true});
 writeFileSync(join(home,".ssh/id_ed25519"),"test-key");writeFileSync(join(home,".ssh/known_hosts"),"test-host");
 driver=new DockerEnvironmentDriver(db,WorkerConfig.parse({workerId:"worker",runtimeId:"runtime",dataRoot:home,controlToken:"t".repeat(43),imageDigest:`sha256:${"a".repeat(64)}`,runtimeEndpoint:"http://127.0.0.1:8091",projects:[{projectId:"project",hostPath:projects}]}));store=new EnvironmentStore(db);
});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
function environment(agentId:string,shadowId:string){
 const scope={agentId,shadowId,placementGeneration:1};
 const bundle=createScopedResources(scope,[{path:"agent/tools/commands/note",content:Buffer.from(agentId).toString("base64"),mode:0o644}]);
 new ScopedResourceStore(driver.config.dataRoot).publish(bundle,scope,bundle.selection);
 const {environment}=store.prepare({requestId:shadowId,occupant:{kind:"maintenance",scope,operationId:shadowId,operationHash:"a".repeat(64),contextId:shadowId},spec:{protocolVersion:2,scope,resourceSelection:bundle.selection,environmentId:"luna",scopeKey:`session:${shadowId}`,mode:"shared",imageDigest:driver.config.imageDigest,callbackRuntimeId:"runtime",resources:{memory:"1g",cpus:1,pidsLimit:128}}});
 return environment;
}
test("Docker mount plans use distinct Shadow HOME and resources without mounting host projects or Git files",async()=>{
 const plans=[];
 for(const [agent,shadow] of [["agent","one"],["agent","two"],["other","three"]] as const){
  const env=environment(agent,shadow);await driver.prepareContext(env.spec.scope,shadow,env.spec.scopeKey,"project");
  const plan=driver.mountPlan(env,shadow);plans.push(plan);
  expect(plan.layout.home).toBe(join(driver.config.dataRoot,"agents",agent,"shadows",shadow));
  expect(driver.contextPath(shadow)).toBe(join(plan.layout.home,"runners",shadow));
  expect(plan.mounts.some(m=>m.source===driver.config.dataRoot)).toBe(false);
  expect(plan.mounts.find(m=>m.destination===join(plan.layout.home,".luna-resource-versions"))?.readonly).toBe(true);
  expect(plan.mounts.some(m=>m.destination===join(plan.layout.home,"projects") || m.source===join(root,"projects"))).toBe(false);
 }
 expect(new Set(plans.map(plan=>plan.layout.home)).size).toBe(3);
 for(const plan of plans)expect(plan.mounts.some(m=>["/.ssh","/.runner-gitconfig","/etc/passwd"].some(path=>m.destination.endsWith(path)))).toBe(false);
});
test("Driver rejects foreign contexts",async()=>{
 const first=environment("agent","one"),second=environment("agent","two");
 await driver.prepareContext(first.spec.scope,"ctx","session:ctx","project");
 await expect(driver.prepareContext(second.spec.scope,"ctx","session:ctx","project")).rejects.toMatchObject({code:"context_shadow_conflict"});
 expect(()=>driver.mountPlan(second,"ctx")).toThrow("context_shadow_conflict");
});
