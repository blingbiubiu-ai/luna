import {Hono} from "hono";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {AgentError,AgentStore} from "@/agents/agent-store";
import {AgentWorkerAccessStore} from "@/agents/agent-worker-access-store";
import {isGuardResponse,requireDashboardOnly} from "../auth/guards";
import {getKernel} from "./kernel";

const workerGateway = () => getKernel().executionRuntime?.gateway;

export function createAgentWorkerAccessRoutes(db: DrizzleDB, getGateway = workerGateway) {
 const store=new AgentWorkerAccessStore(db);
 const agents=new AgentStore(db);
 return new Hono().onError((error,c)=>{
  if(error instanceof AgentError)return c.json({status:"error",code:error.code},error.status);
  if(error instanceof z.ZodError || error instanceof SyntaxError)return c.json({status:"error",code:"invalid_request"},400);
  throw error;
 }).get("/:agentId/workers",c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const agent=agents.requireOwner(auth.user.id,c.req.param("agentId"));
  const assignments=store.list(auth.user.id,agent.id);
  const assignedIds=new Set(assignments.map(row=>row.workerId));
  const gateway=getGateway();
  const workers=gateway?.list().flatMap(worker=>{
   const owned=gateway.owner(worker.workerId)===auth.user.id;
   if(!assignedIds.has(worker.workerId))return [];
   const {workerId,connected,revoked,draining,health}=worker;
   return [{workerId,connected,revoked,draining,health,owned,local:gateway.isLocal(workerId),lastHeartbeatAt:worker.lastHeartbeatAt ?? worker.lastSeen}];
  }) ?? [];
  return c.json({assignments,workers,canManageWorkers:true});
 }).post("/:agentId/workers/binding-code",c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const agent=agents.requireOwner(auth.user.id,c.req.param("agentId"));
  if(agent.status!=="active")throw new AgentError("agent_disabled",409);
  const gateway=getGateway();
  if(!gateway)return c.json({status:"error",code:"runtime_not_ready"},503);
  c.header("Cache-Control","no-store");
  return c.json(gateway.createCode({ownerUserId:auth.user.id,agentId:agent.id}));
 }).put("/:agentId/workers/:workerId",async c=>{
  const auth=requireDashboardOnly(c);if(isGuardResponse(auth))return auth;
  const agent=agents.requireOwner(auth.user.id,c.req.param("agentId"));
  const {status}=z.object({status:z.literal("disabled")}).strict().parse(await c.req.json());
  const workerId=c.req.param("workerId");
  const gateway=getGateway();
  if(!gateway)return c.json({status:"error",code:"runtime_not_ready"},503);
  if(gateway.isLocal(workerId))throw new AgentError("local_worker_cannot_unbind",409);
  if(gateway.owner(workerId)!==auth.user.id)throw new AgentError("worker_access_denied",403);
  store.setOwned(auth.user.id,agent.id,workerId,status);
  return c.json({ok:true});
 }).post("/:agentId/workers/:workerId/:action", c => {
  const auth = requireDashboardOnly(c);
  if (isGuardResponse(auth)) return auth;
  const agentId = c.req.param("agentId");
  const workerId = c.req.param("workerId");
  const action = z.enum(["drain", "resume"]).parse(c.req.param("action"));
  const assignments = store.list(auth.user.id, agentId);
  if (!assignments.some(row => row.workerId === workerId && row.status === "active")) {
   throw new AgentError("worker_assignment_not_found", 404);
  }
  const gateway = getGateway();
  if (!gateway) return c.json({status:"error",code:"runtime_not_ready"},503);
  // Pausing changes only this Agent's assignment (setPaused checks the Agent owner).
  const worker = gateway.list().find(row => row.workerId === workerId && !row.revoked);
  if (!worker) throw new AgentError("worker_not_registered", 409);
  store.setPaused(auth.user.id, agentId, workerId, action === "drain");
  return c.json({ok:true});
 });
}
