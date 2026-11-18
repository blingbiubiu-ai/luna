import { Hono } from "hono";
import type { DrizzleDB } from "@/data";
import { ChannelConfigStore } from "@/channels/config-store";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { requireDashboardOnly, isGuardResponse } from "../auth/guards";
import { getKernel } from "./kernel";
export function createChannelConfigRoutes(options:{db:DrizzleDB;store?:ChannelConfigStore;reload?:(id:string)=>Promise<void>}){
 const store=options.store??new ChannelConfigStore(options.db);
 let mutation:Promise<unknown>=Promise.resolve();
 const reload=options.reload??(id=>getKernel().reloadChannel(id));
 function enqueue<T>(run:()=>Promise<T>) {
  const result=mutation.then(run,run);
  mutation=result.catch(()=>{});
  return result;
 }
 return new Hono().use("*",async(c,next)=>{const admin=requireDashboardOnly(c);if(isGuardResponse(admin))return admin;await next();})
 .onError((error,c)=>{if(error instanceof AgentError)return c.json({code:error.code},error.status);throw error;})
 .get("/",c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const agentId=c.req.query("agentId");if(!agentId)return c.json({code:"agent_scope_required"},400);
  new AgentStore(options.db).requireOwner(auth.account.id,agentId);
  return c.json({channels:store.list().filter(channel=>channel.agentId===agentId)});
 })
 .post("/",async c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const body=await c.req.json().catch(()=>null);
  return enqueue(async()=>{
   let saved;
   try{saved=await store.save(body,auth.account.id);}catch(error){if(error instanceof AgentError)return c.json({code:error.code},error.status);return c.json({message:"保存失败：请检查应用信息、App Secret 或重复的通道配置。"},400);}
   try{await reload(saved.id);}
   catch{return c.json({saved:true,channel:saved,message:"配置已保存，但运行时应用失败。请检查连接后重新保存，或重启服务。"},503);}
   return c.json({channel:saved,saved:true});
  });
 })
 .delete("/:channelId/bindings/:bindingId",async c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const agentId=c.req.query("agentId");if(!agentId)return c.json({code:"agent_scope_required"},400);
  const {channelId,bindingId}=c.req.param();
  return enqueue(async()=>{
   store.retire(auth.account.id,agentId,channelId,bindingId);
   try{await reload(channelId);}
   catch{return c.json({saved:true,message:"绑定已解除，但运行时应用失败。请重试。"},503);}
   return c.json({saved:true});
  });
 });
}
