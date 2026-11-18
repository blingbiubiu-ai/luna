import type {Context} from "hono";
import type {DrizzleDB} from "@/data";
import {AgentError,AgentStore} from "@/agents/agent-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import {SessionAccessPolicy} from "@/agents/session-access";
import {TaskAccessPolicy} from "@/agents/task-access";
import {InvocationService} from "@/runners/invocation-service";
import {requireAuthenticated,isGuardResponse} from "../auth/guards";
import {actorFor} from "../auth/agent-actor";

/** Request scope comes from persisted Runner authority or an explicitly authorized human selection. */
export function pluginRequestScope(c:Context,db:DrizzleDB){
 const auth=requireAuthenticated(c);if(isGuardResponse(auth))throw new AgentError("authentication_required",403);
 if(auth.authKind==="luna-access-token" && auth.token.source==="runner"){
  if(!auth.token.runnerKind)throw new AgentError("runner_scope_required",403);
  const authority = new InvocationService(db);
  const runnerKind = auth.token.runnerKind;
  const {invocation}=authority.requireActive(auth.token,runnerKind);
  for(const [key,value] of [["agentId",invocation.agentId],["shadowId",invocation.shadowId]]) if(c.req.query(key!) && c.req.query(key!)!==value)throw new AgentError("scope_mismatch",403);
  return {scope:{agentId:invocation.agentId,shadowId:invocation.shadowId},actorUserId:invocation.actorUserId,
   ...(invocation.sessionId ? {sessionId:invocation.sessionId} : {}),...(invocation.taskId ? {taskId:invocation.taskId} : {}),runnerContextId:invocation.runnerContextId,
   validateInvocation: () => {
     const current = authority.requireActive(auth.token, runnerKind).invocation;
     if (current.id !== invocation.id) throw new AgentError("invocation_scope_mismatch",409);
   }};
 }
 const agentId=c.req.query("agentId"),shadowId=c.req.query("shadowId");
 if(!agentId || !shadowId)throw new AgentError("agent_scope_required",400);
 const scope = {agentId, shadowId};
 const {userId}=actorFor(auth,db,agentId);
 new AgentStore(db).requireScope(userId, scope);
 const sessionId=c.req.header("x-luna-session-id"),taskId=c.req.header("x-luna-task-id");
 if(sessionId){new SessionAccessPolicy(db).requireAccess(userId,sessionId);new TaskScopeResolver(db).assertSame(scope,new TaskScopeResolver(db).session(sessionId));}
 if(taskId){new TaskAccessPolicy(db).requireAccess(userId,taskId);new TaskScopeResolver(db).assertSame(scope,new TaskScopeResolver(db).task(taskId));}
 return {scope,actorUserId:userId,...(sessionId ? {sessionId} : {}),...(taskId ? {taskId} : {})};
}
