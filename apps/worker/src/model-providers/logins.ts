import {z} from "zod";
import {ExecutionError,contentHash} from "@luna/execution-store";
import {Id,type ModelAccountSummary} from "@luna/runner-protocol";

const startInput=z.object({agentId:Id,pluginId:Id,providerId:Id,releaseSha256:z.string().regex(/^[a-f0-9]{64}$/),flowId:Id,expectedRevision:Id.nullable(),callbackUrl:z.url()}).strict();
type Input=z.infer<typeof startInput>;
interface Flow {input:Input;id:string;authorizationUrl:string;expiresAt:number;account?:ModelAccountSummary;busy?:Promise<ModelAccountSummary|null>;failed?:boolean}
export class WorkerModelLogins {
 private flows=new Map<string,Flow>();
 constructor(private call:(input:Input,path:string,body:unknown)=>Promise<Response>,private save:(input:Input,credential:unknown)=>Promise<ModelAccountSummary>){}
 async start(raw:unknown){
  const input=startInput.parse(raw);const prior=this.flows.get(input.flowId);
  if(prior){if(contentHash(prior.input)!==contentHash(input))throw new ExecutionError(409,"model_login_conflict");return {flowId:input.flowId,authorizationUrl:prior.authorizationUrl,expiresAt:prior.expiresAt};}
  for(const [id,flow] of this.flows){if(flow.expiresAt<Date.now())this.flows.delete(id);}
  if(this.flows.size>=64)throw new ExecutionError(429,"model_login_busy");
  const response=await this.call(input,"/login/start",{callbackUrl:input.callbackUrl});
  if(!response.ok)throw new ExecutionError(422,"model_login_unsupported");
  const result=z.object({id:Id,authorizationUrl:z.url()}).strict().parse(await response.json());
  const url=new URL(result.authorizationUrl);if(url.protocol!=="https:" || url.username || url.password)throw new ExecutionError(422,"model_login_url_invalid");
  const flow:Flow={input,id:result.id,authorizationUrl:result.authorizationUrl,expiresAt:Date.now()+600000};this.flows.set(input.flowId,flow);
  return {flowId:input.flowId,authorizationUrl:flow.authorizationUrl,expiresAt:flow.expiresAt};
 }
 private require(flowId:string,agentId:string):Flow{
  const flow=this.flows.get(flowId);if(!flow || flow.input.agentId!==agentId || flow.expiresAt<Date.now() || flow.failed)throw new ExecutionError(409,"model_login_inactive");return flow;
 }
 async callback(flowId:string,agentId:string,params:Record<string,string>){
  const flow=this.require(flowId,agentId);const response=await this.call(flow.input,"/login/callback",{id:flow.id,params});
  if(!response.ok)throw new ExecutionError(401,"model_login_rejected");await response.body?.cancel();return {accepted:true};
 }
 async poll(flowId:string,agentId:string){
  const flow=this.require(flowId,agentId);if(flow.account)return {state:"ready",account:flow.account};
  flow.busy??=(async()=>{
   const response=await this.call(flow.input,"/login/poll",{id:flow.id});if(!response.ok)throw new ExecutionError(409,"model_login_inactive");
   const result=z.discriminatedUnion("state",[z.object({state:z.literal("pending")}),z.object({state:z.literal("failed")}),z.object({state:z.literal("ready"),credential:z.unknown()})]).parse(await response.json());
   if(result.state==="failed"){flow.failed=true;throw new ExecutionError(401,"model_login_rejected");}
   if(result.state==="pending")return null;
   this.require(flowId,agentId);flow.account=await this.save(flow.input,result.credential);
   await this.call(flow.input,"/login/cancel",{id:flow.id}).catch(()=>{});return flow.account;
  })().finally(()=>{delete flow.busy;});
  const account=await flow.busy;return account?{state:"ready",account}:{state:"pending"};
 }
 async cancel(flowId:string,agentId:string){const flow=this.flows.get(flowId);if(!flow || flow.input.agentId!==agentId)return;this.flows.delete(flowId);await this.call(flow.input,"/login/cancel",{id:flow.id}).catch(()=>{});}
 disable(agentId:string,pluginId:string){for(const [id,flow] of this.flows){if(flow.input.agentId===agentId && flow.input.pluginId===pluginId)void this.cancel(id,agentId);}}
}
