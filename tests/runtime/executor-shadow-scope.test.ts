import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,rmSync,existsSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openExecutionDatabase,contentHash} from "@luna/execution-store";
import {TokenAuthority,ExecutionClient,closeExecutionServer} from "@luna/execution-transport";
import {createExecutor} from "../../apps/executor/src/executor/server";
import {fixtureJobScope} from "../helpers/job-scope";
let root:string,db:ReturnType<typeof openExecutionDatabase>,executor:ReturnType<typeof createExecutor>,worker:ExecutionClient,runtime:ExecutionClient;
const scopedTest=test.skipIf(process.platform!=="linux" || process.getuid?.()!==0);
const fixed=fixtureJobScope(),scope=fixed.scope,foreign={...scope,shadowId:"foreign"};
function configuration(){return {scope,runnerLayout:{home:root,runners:join(root,"runners")},instanceId:"instance",runtimeId:"runtime",workerId:"worker",dataRoot:root,runnerEntry:"unused",runtimeEndpoint:"http://127.0.0.1:1",capacity:1,runnerUid:process.getuid!(),runnerGid:process.getgid!()};}
function job(){return {version:2,...fixed,jobId:"job",invocationId:"inv",environmentId:"environment",runnerContextId:"ctx",scopeKey:"session:ctx",runnerKind:"work",sessionId:"session",input:{runnerType:"codex",prompt:"test"},credentialsRevision:1,timeoutMs:10000};}
function binding(request=job()){return {scope:request.scope,jobId:request.jobId,assignmentId:"assignment",reservationId:"reservation",instanceId:"instance",workerId:"worker",executionEnvironmentId:"environment",contextId:"ctx",scopeKey:request.scopeKey,requestHash:contentHash(request)};}
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),"executor-shadow-"));db=openExecutionDatabase(join(root,"control.sqlite"));
 const authority=new TokenAuthority(),wt=authority.issue("worker",{role:"worker",id:"worker"}),rt=authority.issue("runtime",{role:"runtime",id:"runtime"});
 executor=createExecutor(db,authority,configuration());mkdirSync(join(root,"runners/ctx"),{recursive:true});
 // Worker points HOME at the reserved snapshot version.
 symlinkSync(`.luna-resource-versions/${fixed.resources.digest}`,join(root,".luna-resources"));
 await new Promise<void>(resolve=>executor.server.listen(0,"127.0.0.1",resolve));
 const port=(executor.server.address() as {port:number}).port;
 worker=new ExecutionClient(`http://127.0.0.1:${port}`,wt);runtime=new ExecutionClient(`http://127.0.0.1:${port}`,rt);
});
afterEach(async()=>{if(executor){await executor.stop();await closeExecutionServer(executor.server);}db.close();rmSync(root,{recursive:true,force:true});});
scopedTest("HTTP reservation and Job admission require the container scope and mounted resource version",async()=>{
 const health=await worker.call<any>("GET","/v1/health");expect(health.scope).toEqual(scope);expect(health.resourceSelection).toBeUndefined();
 await expect(worker.call("PUT","/v1/contexts/ctx",{scope:foreign})).rejects.toMatchObject({code:"executor_scope_mismatch"});
 await worker.call("PUT","/v1/contexts/ctx",{scope});
 await expect(worker.call("PUT","/v1/reservations/reservation",{...binding(),scope:foreign})).rejects.toMatchObject({code:"executor_scope_mismatch"});
 expect(executor.store.list()).toEqual([]);
 const request={...job(),resources:{...fixed.resources,digest:"0".repeat(64)},resourceRevision:"0".repeat(64)};
 const assigned=binding(request);await worker.call("PUT","/v1/reservations/reservation",assigned);
 await expect(runtime.call("POST","/v1/jobs",{job:request,assignment:assigned})).rejects.toMatchObject({code:"executor_resources_mismatch"});
 expect(executor.store.request("job")).toBeNull();
});
scopedTest("HTTP files use the registered container context and lease revocation remains a barrier",async()=>{
 await worker.call("PUT","/v1/contexts/ctx",{scope});
 await worker.call("PUT","/v1/file-leases/lease",{contextId:"ctx"});
 const request={leaseId:"lease",contextId:"ctx",operation:{kind:"mkdir",path:"allowed"}};
 expect(existsSync(join(root,"runners/ctx/allowed"))).toBe(false);
 await worker.call("POST","/v1/files",request);expect(existsSync(join(root,"runners/ctx/allowed"))).toBe(true);
 await worker.call("DELETE","/v1/file-leases/lease");
 await expect(worker.call("POST","/v1/files",request)).rejects.toMatchObject({code:"file_lease_released"});
});
scopedTest("an existing control volume cannot be reopened for another Shadow even before the first Job",()=>{
 expect(()=>createExecutor(db,new TokenAuthority(),{...configuration(),scope:foreign})).toThrow("executor_volume_scope_mismatch");
});

scopedTest("matching scoped Job is accepted and its context remains addressable",async()=>{
 await worker.call("PUT","/v1/contexts/ctx",{scope});
 await runtime.call("POST","/v1/contexts",{scope,contextId:"ctx"});
 const request=job(),assigned=binding(request);
 await worker.call("PUT","/v1/reservations/reservation",assigned);
 const result=await runtime.call<any>("POST","/v1/jobs",{job:request,assignment:assigned});
 expect(result.state).toBe("queued");expect(executor.store.request("job")?.scope).toEqual(scope);
});
