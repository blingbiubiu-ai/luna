import {Hono,type Context} from "hono";
import {z} from "zod";
import {HTTPException} from "hono/http-exception";
import type {DrizzleDB} from "@/data";
import {AgentError} from "@/agents/agent-store";
import {AgentDocumentStore,DocumentConflictError} from "@/agents/agent-document-store";
import {isGuardResponse,requireDashboardOnly} from "../auth/guards";

const memoryWrite=z.object({expectedRevision:z.string().min(1).nullable(),path:z.string().min(1),content:z.string().max(8*1024*1024)}).strict();
const personaWrite=z.object({expectedRevision:z.string().min(1),user:z.string().max(4*1024*1024),soul:z.string().max(4*1024*1024)}).strict();

/** Mounted under /api/agents. Runner memory operations use a separate invocation-scoped boundary. */
export function createAgentDocumentRoutes(db:DrizzleDB,home:string){
 const store=new AgentDocumentStore(db,home);
 const actor=(c:Context)=>{
  const auth=requireDashboardOnly(c);
  if(isGuardResponse(auth)) throw new HTTPException(401);
  return auth.user.id;
 };
 return new Hono().use("*",async(c,next)=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;await next();
 }).onError((error,c)=>{
  if(error instanceof DocumentConflictError) return c.json({status:"error",code:error.code,currentRevision:error.currentRevision},409);
  if(error instanceof AgentError) return c.json({status:"error",code:error.code},error.status);
  if(error instanceof z.ZodError || error instanceof SyntaxError) return c.json({status:"error",code:"invalid_request"},400);
  if(error instanceof HTTPException)return error.getResponse();
  throw error;
 }).get("/:agentId/memory",c=>c.json(store.memory(actor(c),c.req.param("agentId"))))
 .put("/:agentId/memory",async c=>c.json(store.writeMemory(actor(c),c.req.param("agentId"),memoryWrite.parse(await c.req.json()))))
 .get("/:agentId/shadows/:shadowId/config",c=>c.json(store.persona(actor(c),{agentId:c.req.param("agentId"),shadowId:c.req.param("shadowId")})))
 .put("/:agentId/shadows/:shadowId/config",async c=>c.json(store.writePersona(actor(c),{agentId:c.req.param("agentId"),shadowId:c.req.param("shadowId")},personaWrite.parse(await c.req.json()))));
}
