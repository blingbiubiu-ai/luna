import {Hono} from "hono";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {AgentError} from "@/agents/agent-store";
import {AgentPluginStore,PluginConfigConflictError,agentPluginWrite} from "@/plugins/agent-plugin-store";
import type {PluginRegistry} from "@/plugins/registry";
import {isGuardResponse,requireDashboardOnly} from "../auth/guards";

/** Agent owner controls activation and write-only secrets; installation remains a platform operation. */
export function createAgentPluginRoutes(db:DrizzleDB,registry:PluginRegistry){
 const store=new AgentPluginStore(db,registry);
 return new Hono().onError((error,c)=>{
  if(error instanceof PluginConfigConflictError)return c.json({status:"error",code:error.code,currentRevision:error.currentRevision},409);
  if(error instanceof AgentError)return c.json({status:"error",code:error.code},error.status);
  if(error instanceof z.ZodError || error instanceof SyntaxError)return c.json({status:"error",code:"invalid_request"},400);
  throw error;
 }).get("/:agentId/plugins", c => {
  const auth = requireDashboardOnly(c); if (isGuardResponse(auth)) return auth;
  return c.json({ plugins: store.list(auth.user.id, c.req.param("agentId")) });
 }).get("/:agentId/plugins/:pluginId",c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  return c.json(store.get(auth.user.id,c.req.param("agentId"),c.req.param("pluginId")));
 }).put("/:agentId/plugins/:pluginId",async c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const body=agentPluginWrite.parse(await c.req.json());
  return c.json(store.put(auth.user.id,c.req.param("agentId"),c.req.param("pluginId"),body));
 });
}
