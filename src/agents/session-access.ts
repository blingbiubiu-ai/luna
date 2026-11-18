import {and,eq,exists,ne,or,sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentShadows,messages,sessions} from "@/data/schema";
import {AgentError,AgentStore,type AgentAccessOptions} from "./agent-store";

/** Human access is active Agent plus ownership or participation in this conversation. */
export class SessionAccessPolicy {
  constructor(private readonly db:DrizzleDB) {}

  requireAccess(actorUserId:string,sessionId:string,options:AgentAccessOptions={}) {
    const session=this.db.select().from(sessions).where(eq(sessions.id,sessionId)).get();
    if(!session||session.status==="deleted")throw new AgentError("session_not_found",404);
    const predicate=this.listPredicate(actorUserId,session.agent_id,options);
    const allowed=this.db.select({id:sessions.id}).from(sessions).where(and(eq(sessions.id,session.id),predicate)).get();
    if(!allowed)throw new AgentError("session_access_denied",403);
    return session;
  }

  listPredicate(actorUserId:string,agentId:string,options:AgentAccessOptions={}){
    const agents=new AgentStore(this.db),agent=agents.requireAccess(actorUserId,agentId,options),owner=agents.isOwnerUser(agent.id,actorUserId);
    const participated=this.db.select({one:sql`1`}).from(messages).where(and(
      eq(messages.ownerSessionId,sessions.id),eq(messages.senderUserId,actorUserId),eq(messages.role,"user")));
    const activeShadow=this.db.select({one:sql`1`}).from(agentShadows).where(and(
      eq(agentShadows.id,sessions.shadow_id),eq(agentShadows.agentId,agentId),eq(agentShadows.status,"active")));
    const shadowFilter=options.readHistory && owner ? undefined : exists(activeShadow);
    return and(shadowFilter,eq(sessions.agent_id,agentId),ne(sessions.status,"deleted"),owner?undefined:
      or(eq(sessions.created_by_user_id,actorUserId),exists(participated)));
  }
}
