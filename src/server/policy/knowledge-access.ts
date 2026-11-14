import {GatewayError} from "../gateway-error";
import type {Context} from "hono";
import type {DrizzleDB} from "@/data";
import {AgentError,AgentStore} from "@/agents/agent-store";
import {InvocationService} from "@/runners/invocation-service";
import {requireAuthenticated,isGuardResponse} from "../auth/guards";
import {AuthorizationRuleStore} from "./authorization-rule-store";
import {ruleMatchesOperation} from "./operation-policy";

/** HTTP and MCP resolve the same authorized Agent before creating or accessing any repository. */
export function requireKnowledgeAgent(c:Context,db:DrizzleDB,operationId:string):string {
 const auth=requireAuthenticated(c);if(isGuardResponse(auth)) throw new GatewayError("401_unauthorized","authentication required",401);
 let agentId=c.req.query("agentId");
 const runner=auth.authKind==="luna-access-token" && auth.token.source==="runner";
 if(runner){
  if(!auth.token.runnerKind) throw new AgentError("runner_scope_required",403);
  const {invocation}=new InvocationService(db).requireActive(auth.token,auth.token.runnerKind);
  if(agentId && agentId!==invocation.agentId) throw new AgentError("scope_mismatch",403);
  agentId=invocation.agentId;
 }
 if(!agentId) throw new AgentError("agent_scope_required",400);
 const agents = new AgentStore(db);
 if (!runner) agents.requireOwner(auth.user.id, agentId);
 agents.requireAccess(auth.user.id, agentId);
 const grants=new AuthorizationRuleStore(db,{kind:"agent",agentId}).getEffectiveGrantsForUser(auth.user.id);
 if(grants.some(g=>g.effect==="deny" && ruleMatchesOperation(g,operationId))) throw new AgentError("knowledge_access_denied",403);
 if(!runner) return agentId;
 if(!grants.some(g=>g.effect==="allow" && ruleMatchesOperation(g,operationId))) throw new AgentError("knowledge_access_denied",403);
 return agentId;
}
