import {z} from "zod";
import {ExecutionClient,type TokenAuthority} from "@luna/execution-transport";
import {ExecutionError} from "@luna/execution-store";
import {Assignment,Credentials,Id,JobSubmission,isTerminal,type JobState} from "@luna/runner-protocol";
import type {EnvironmentManager} from "../environment-manager";
import type {WorkerModelProviderManager} from "./manager";

export async function proxyExecutor(manager:EnvironmentManager,grants:TokenAuthority,models:WorkerModelProviderManager|undefined,raw:unknown):Promise<unknown>{
 const call=z.object({environmentId:Id,method:z.enum(["GET","POST","PUT","DELETE"]),path:z.string(),body:z.unknown().optional(),token:z.string()}).parse(raw);
 const environment=manager.store.require(call.environmentId);
 if(!/^\/v1\/(health|contexts|ingest-credentials|jobs)(\/|$)/.test(call.path))throw new ExecutionError(403,"executor_route_denied");
 if(call.path==="/v1/ingest-credentials" && call.method==="PUT"){
  const body=z.object({credentialId:Id,token:z.string(),runtimeId:Id}).parse(call.body);
  grants.register(body.credentialId,body.token,{role:"executor",id:environment.instanceId});
 }
 let body=call.body;
 if(call.method==="POST" && call.path==="/v1/jobs"){
  const submission=JobSubmission.parse(body);
  if(submission.job.input.modelProvider){
   if(!models)throw new ExecutionError(409,"worker_model_provider_unsupported");
   if(submission.assignment.executionEnvironmentId!==call.environmentId)throw new ExecutionError(403,"model_execution_scope_invalid");
   models.bindJob(submission);
  }
 }
 const credentialJob=/^\/v1\/jobs\/([^/]+)\/credentials$/.exec(call.path);
 if(call.method==="PUT" && credentialJob){
  const input=z.object({assignment:Assignment,credentials:Credentials}).strict().parse(body);
  if(input.credentials.modelProvider){
   if(!models)throw new ExecutionError(409,"worker_model_provider_unsupported");
   if(input.assignment.jobId!==credentialJob[1] || input.assignment.executionEnvironmentId!==call.environmentId)throw new ExecutionError(403,"model_execution_scope_invalid");
   const {modelProvider,...credentials}=input.credentials;
   const env=models.jobEnvironment(modelProvider,input.assignment,credentials.expiresAt);
   body={assignment:input.assignment,credentials:{...credentials,env:{...credentials.env,...env}}};
  }
 }
 const result=await new ExecutionClient(manager.driver.endpoint(call.environmentId),call.token).call(call.method,call.path,body);
 const queried=/^\/v1\/jobs\/([^/]+)\/(query|cancel)$/.exec(call.path);
 if(queried && result && typeof result==="object" && "state" in result && isTerminal(result.state as JobState))models?.revokeJob(queried[1]!);
 return result;
}
