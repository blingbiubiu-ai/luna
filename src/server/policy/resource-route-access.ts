import {and,eq,sql} from "drizzle-orm";
import type {Context} from "hono";
import {HTTPException} from "hono/http-exception";
import type {DrizzleDB} from "@/data";
import {sessions,taskSubscriptions,tasks} from "@/data/schema";
import {AgentError,AgentStore} from "@/agents/agent-store";
import {SessionAccessPolicy} from "@/agents/session-access";
import {TaskAccessPolicy} from "@/agents/task-access";
import {requireAuthenticated,requireDashboardOnly,isGuardResponse} from "../auth/guards";
import {actorFor} from "../auth/agent-actor";

type ResourceType="session"|"task";
type RunnerClaims={runnerKind?:string;sessionId?:string;taskId?:string};

/** Main and Work act for a session, so they may read the Tasks bound to it; a Task Runner reads only its own Task. */
function sessionRunner(token:RunnerClaims):string|undefined{
  return (token.runnerKind==="main"||token.runnerKind==="work") ? token.sessionId : undefined;
}

const tasksOfSession=(sessionId:string)=>sql`${tasks.id} IN (SELECT ${taskSubscriptions.task_id} FROM ${taskSubscriptions} WHERE ${taskSubscriptions.session_id} = ${sessionId})`;

/** Shared HTTP boundary; a Runner never inherits its human owner's broad management view. */
export class ResourceRouteAccess {
  constructor(private readonly db:DrizzleDB){}
  private actor(c:Context){
    const auth=requireAuthenticated(c);
    if(isGuardResponse(auth))throw new HTTPException(401,{message:"authentication required"});
    return auth;
  }
  require(c:Context,type:ResourceType,id:string){
    const auth=this.actor(c);
    if(auth.authKind==="luna-access-token"&&auth.token.source==="runner"){
      if(!this.runnerMayRead(auth.token,type,id))throw new AgentError("runner_resource_access_denied",403);
    }
    const options = {readHistory: auth.authKind === "dashboard-cookie" && c.req.method === "GET"};
    const agentId = this.agentOf(type, id);
    const {userId} = actorFor(auth, this.db, agentId, {includeDeleted: options.readHistory});
    const row = type === "session"
      ? new SessionAccessPolicy(this.db).requireAccess(userId, id, options)
      : new TaskAccessPolicy(this.db).requireAccess(userId, id, options);
    this.requireAgentMatch(c, type, row.agent_id);
    return row;
  }
  requireDeletion(c: Context, type: ResourceType, id: string) {
    const auth = requireDashboardOnly(c);
    if (isGuardResponse(auth)) throw new HTTPException(auth.status as 401 | 403, { res: auth });
    const rows = type === "session" ? sessions : tasks;
    const row = this.db.select({ agentId: rows.agent_id }).from(rows).where(eq(rows.id, id)).get();
    const tombstone = type === "session"
      ? sql`SELECT agent_id AS agentId FROM session_deletions WHERE session_id=${id}`
      : sql`SELECT agent_id AS agentId FROM task_deletions WHERE task_id=${id}`;
    const agentId = row?.agentId ?? this.db.all<{ agentId: string | null }>(tombstone)[0]?.agentId;
    if (!agentId) throw new AgentError(type === "session" ? "session_not_found" : "task_not_found", 404);
    this.requireAgentMatch(c, type, agentId);
    new AgentStore(this.db).requireOwner(auth.account.id, agentId);
  }
  /** The Agent of a session or task; a missing one is reported as not found. */
  private agentOf(type: ResourceType, id: string): string {
    const rows = type === "session" ? sessions : tasks;
    const row = this.db.select({ agentId: rows.agent_id }).from(rows).where(eq(rows.id, id)).get();
    if (!row) throw new AgentError(type === "session" ? "session_not_found" : "task_not_found", 404);
    return row.agentId;
  }
  private isRunner(auth: ReturnType<ResourceRouteAccess["actor"]>): boolean {
    return auth.authKind === "luna-access-token" && auth.token.source === "runner";
  }

  private requireAgentMatch(c: Context, type: ResourceType, agentId: string) {
    const requestedAgentId = c.req.query("agentId");
    if (requestedAgentId !== undefined && requestedAgentId !== agentId) {
      throw new AgentError(`${type}_not_found`, 404);
    }
  }

  listPredicate(c:Context,type:ResourceType){
    const auth=this.actor(c),agentId=c.req.query("agentId");
    if(!agentId)throw new AgentError("agent_scope_required",400);
    const options = {readHistory: auth.authKind === "dashboard-cookie"};
    const {userId}=actorFor(auth,this.db,agentId,{includeDeleted: options.readHistory});
    const predicate=type==="session"?new SessionAccessPolicy(this.db).listPredicate(userId,agentId,options):new TaskAccessPolicy(this.db).listPredicate(userId,agentId,options);
    const shadowId=c.req.query("shadowId");
    if(shadowId)new AgentStore(this.db).requireScope(userId,{agentId,shadowId},options);
    let runnerId:string|undefined,runnerSession:string|undefined;
    if(auth.authKind==="luna-access-token"&&auth.token.source==="runner"&&type==="task"&&sessionRunner(auth.token)){
      runnerSession=sessionRunner(auth.token)!;
      const row=this.require(c,"session",runnerSession);
      if(row.agent_id!==agentId)throw new AgentError("scope_mismatch",403);
    }else if(auth.authKind==="luna-access-token"&&auth.token.source==="runner"){
      runnerId=type==="session"?auth.token.sessionId:auth.token.taskId;
      if(!runnerId)throw new AgentError("runner_resource_access_denied",403);
      const row=this.require(c,type,runnerId);
      if(row.agent_id!==agentId)throw new AgentError("scope_mismatch",403);
    }
    return and(predicate,shadowId?eq(type==="session"?sessions.shadow_id:tasks.shadow_id,shadowId):undefined,
      runnerId?eq(type==="session"?sessions.id:tasks.id,runnerId):undefined,
      runnerSession?tasksOfSession(runnerSession):undefined);
  }
  private runnerMayRead(token:RunnerClaims,type:ResourceType,id:string):boolean{
    if(type==="session")return token.sessionId===id;
    if(token.taskId===id)return true;
    const session=sessionRunner(token);
    return session!==undefined && Boolean(this.db.select({id:tasks.id}).from(tasks).where(and(eq(tasks.id,id),tasksOfSession(session))).get());
  }
}
