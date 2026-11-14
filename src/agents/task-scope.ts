import {BotBindingStore} from "./bot-binding-store";
import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {sessions,tasks} from "@/data/schema";
import {AgentError,AgentStore,type AgentScope} from "./agent-store";

/** Resolves persisted task/session ownership without defaults or cross-Shadow fallback. */
export class TaskScopeResolver {
  constructor(private readonly db:DrizzleDB) {}

  owner(type: string, id: string): AgentScope {
    if (type === "session") return this.session(id);
    if (type === "task") return this.task(id);
    throw new AgentError("owner_type_invalid", 400);
  }

  session(sessionId:string):AgentScope {
    const session=this.db.select().from(sessions).where(eq(sessions.id,sessionId)).get();
    if(!session||session.status!=="active")throw new AgentError("session_not_found",404);
    return this.active({agentId:session.agent_id,shadowId:session.shadow_id});
  }

  task(taskId:string):AgentScope {
    const task=this.db.select().from(tasks).where(eq(tasks.id,taskId)).get();
    if(!task)throw new AgentError("task_not_found",404);
    const scope=this.active({agentId:task.agent_id,shadowId:task.shadow_id});
    if(task.primary_session_id){
      const session=this.db.select().from(sessions).where(eq(sessions.id,task.primary_session_id)).get();
      if(!session||session.status!=="active")throw new AgentError("task_session_unavailable",409);
      this.assertSame(scope,{agentId:session.agent_id,shadowId:session.shadow_id});
      if(session.binding_id){
        const binding=new BotBindingStore(this.db).requireActive(session.channel_id);
        if(binding.id!==session.binding_id)throw new AgentError("task_binding_retired",409);
      }
    }
    return scope;
  }

  active(scope:AgentScope):AgentScope {
    const agents=new AgentStore(this.db),shadow=agents.shadow(scope.shadowId);
    if(shadow.agentId!==scope.agentId)throw new AgentError("scope_mismatch",409);
    if(shadow.status!=="active"||agents.get(scope.agentId).status!=="active")throw new AgentError("shadow_disabled",409);
    return scope;
  }

  assertSame(expected:AgentScope,actual:AgentScope):void {
    if(expected.agentId!==actual.agentId||expected.shadowId!==actual.shadowId)throw new AgentError("task_scope_mismatch",409);
  }
}
