import {and,eq,exists,or,sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentShadows,taskParticipants,tasks} from "@/data/schema";
import {AgentError,AgentStore,type AgentAccessOptions} from "./agent-store";

/** Task visibility is active Agent plus ownership, creation or explicit participation. */
export class TaskAccessPolicy {
  constructor(private readonly db:DrizzleDB){}
  requireAccess(actorUserId:string,taskId:string,options:AgentAccessOptions={}){
    const task=this.db.select({id:tasks.id,agent_id:tasks.agent_id}).from(tasks).where(eq(tasks.id,taskId)).get();
    if(!task)throw new AgentError("task_not_found",404);
    const allowed=this.db.select({id:tasks.id}).from(tasks).where(and(eq(tasks.id,task.id),this.listPredicate(actorUserId,task.agent_id,options))).get();
    if(!allowed)throw new AgentError("task_access_denied",403);
    return task;
  }
  listPredicate(actorUserId:string,agentId:string,options:AgentAccessOptions={}){
    const agents=new AgentStore(this.db),agent=agents.requireAccess(actorUserId,agentId,options),owner=agents.isOwnerUser(agent.id,actorUserId);
    const participated=this.db.select({one:sql`1`}).from(taskParticipants).where(and(
      eq(taskParticipants.task_id,tasks.id),eq(taskParticipants.user_id,actorUserId)));
    const activeShadow=this.db.select({one:sql`1`}).from(agentShadows).where(and(
      eq(agentShadows.id,tasks.shadow_id),eq(agentShadows.agentId,agentId),eq(agentShadows.status,"active")));
    const shadowFilter=options.readHistory && owner ? undefined : exists(activeShadow);
    return and(shadowFilter,eq(tasks.agent_id,agentId),owner?undefined:
      or(eq(tasks.creator_user_id,actorUserId),exists(participated)));
  }
}
