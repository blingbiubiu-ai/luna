import {createHash} from "node:crypto";
import {canonicalJson} from "../../src/plugins/marketplace/checksums";
import type {WorkerModelRelease} from "@luna/runner-protocol";

// A self-contained Worker plugin, also used for the real local Dashboard/Runner check.
export const fixtureAdapter=`
export default ()=>({
 async validateCredential(credential){if(credential?.token!=="fixture-secret")throw Object.assign(new Error("invalid"),{status:401,code:"model_credential_rejected"});return {credential,name:"Fixture CN account",expiresAt:Date.now()+86400000,models:[{id:"fixture-model",name:"Fixture model",capabilities:{tools:true,reasoning:true}}]};},
 async models(){return [{id:"fixture-model",name:"Fixture model",capabilities:{tools:true,reasoning:true}}];},
 async respond(credential,request,{sessionId,signal}){
  const input=await request.json();
  if(input.input==="crash"){process.exit(1);}
  if(input.input==="slow")return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("data: first\\n\\n"));const timer=setTimeout(()=>{controller.close()},2000);signal.addEventListener("abort",()=>clearTimeout(timer),{once:true});}}),{headers:{"content-type":"text/event-stream"}});
  const text="LUNA_AGENT_PROFILE_OK";
  const message={id:"msg_fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]};
  const response={id:"resp_fixture",object:"response",created_at:Math.floor(Date.now()/1000),status:"completed",error:null,incomplete_details:null,model:input.model,output:[message],usage:{input_tokens:5,output_tokens:5,total_tokens:10}};
  if(!input.stream)return Response.json({...response,sessionId,received:input});
  const events=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:0,item:{...message,status:"in_progress",content:[]}},{type:"response.content_part.added",item_id:message.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},{type:"response.output_text.delta",item_id:message.id,output_index:0,content_index:0,delta:text},{type:"response.output_text.done",item_id:message.id,output_index:0,content_index:0,text},{type:"response.content_part.done",item_id:message.id,output_index:0,content_index:0,part:message.content[0]},{type:"response.output_item.done",output_index:0,item:message},{type:"response.completed",response}];
  return new Response(events.map((event,sequence_number)=>"event: "+event.type+"\\ndata: "+JSON.stringify({...event,sequence_number})+"\\n\\n").join(""),{headers:{"content-type":"text/event-stream"}});
 }
});`;
export function fixtureModelRelease():WorkerModelRelease{
 const manifest={id:"fixture-model-provider",displayName:"Fixture Worker Model",version:"0.1.0",source:"marketplace",lunaApiVersion:"^0.1.0",agentScopeVersion:2,runtime:{entrypoint:"plugin.js"},requestedHostPermissions:[],allowedExecutables:[],allowedEnvKeys:[],operations:[],commands:[],skills:[],workerModelProviders:[{id:"fixture-cn",displayName:"Fixture CN",entrypoint:"worker.js",protocols:["responses"]}]};
 const contents:Record<string,string>={"manifest.json":JSON.stringify(manifest),"package.json":JSON.stringify({name:"fixture-model-provider",version:"0.1.0"}),"plugin.js":`export default {manifest:${JSON.stringify(manifest)},createRuntime:()=>({invoke:async()=>{throw Error("no operations")}})};`,"worker.js":fixtureAdapter};
 const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
 const checksums=canonicalJson({schemaVersion:1,files:Object.keys(contents).sort().map(path=>({path,sha256:sha(contents[path]!)}))});
 return {pluginId:manifest.id,providerId:"fixture-cn",releaseSha256:sha(checksums),entrypoint:"worker.js",checksums,files:Object.entries(contents).map(([path,content])=>({path,content:Buffer.from(content).toString("base64")}))};
}
