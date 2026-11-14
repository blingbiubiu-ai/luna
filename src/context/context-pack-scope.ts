import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {contextPackItems,contextPacks,managedArtifacts,messages,runnerContexts,sessionTimelineEntries} from "@/data/schema";
import {AgentError,type AgentScope} from "@/agents/agent-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import type {CreateContextPackInput,CreateContextPackItemInput,RecordRunnerSeedInput} from "./context-pack-store";

/** Resolves each referenced entity; caller-supplied provenance cannot override its owner. */
export class ContextPackScope {
  private readonly scopes:TaskScopeResolver;
  constructor(private readonly db:DrizzleDB){this.scopes=new TaskScopeResolver(db);}

  owner(type:string,id:string):AgentScope {
    if(type==="session")return this.scopes.session(id);
    if(type==="task")return this.scopes.task(id);
    throw new AgentError("context_owner_type_invalid",400);
  }

  create(input:CreateContextPackInput):void {
    const scope=this.owner(input.ownerType,input.ownerId);
    if(input.triggerMessageId)this.message(scope,input.triggerMessageId);
    if(input.triggerEntryId){
      const entry=this.entry(scope,input.triggerEntryId);
      if(input.triggerMessageId&&entry.messageId!==input.triggerMessageId)throw new AgentError("context_provenance_mismatch",409);
    }
  }

  items(packId:string,items:readonly CreateContextPackItemInput[]):void {
    const pack=this.db.select().from(contextPacks).where(eq(contextPacks.id,packId)).get();
    if(!pack)throw new AgentError("context_pack_not_found",404);
    const scope=this.owner(pack.ownerType,pack.ownerId);
    for(const item of items){
      if(item.sourceSessionId)this.scopes.assertSame(scope,this.scopes.session(item.sourceSessionId));
      if(item.sourceMessageId)this.message(scope,item.sourceMessageId);
      const sourceEntry = item.sourceEntryId ? this.entry(scope, item.sourceEntryId) : undefined;
      if(sourceEntry){
        if(item.sourceSessionId&&sourceEntry.sessionId!==item.sourceSessionId)throw new AgentError("context_provenance_mismatch",409);
        if(item.sourceMessageId&&sourceEntry.messageId!==item.sourceMessageId)throw new AgentError("context_provenance_mismatch",409);
      }
      if(item.itemKind==="message"){
        this.message(scope,item.itemId);
        if(sourceEntry&&sourceEntry.messageId!==item.itemId)throw new AgentError("context_provenance_mismatch",409);
        if(item.sourceMessageId&&item.sourceMessageId!==item.itemId)throw new AgentError("context_provenance_mismatch",409);
      }else if(item.itemKind==="timeline_entry"){
        const entry=this.entry(scope,item.itemId);
        if(item.sourceMessageId&&entry.messageId!==item.sourceMessageId)throw new AgentError("context_provenance_mismatch",409);
        if(sourceEntry&&entry.messageId!==sourceEntry.messageId)throw new AgentError("context_provenance_mismatch",409);
        // A thread launch can project an original timeline entry into its own session.
        const threadProjection = sourceEntry && pack.kind === "thread_launch"
          && pack.ownerType === "session" && entry.sessionId === pack.ownerId;
        if(item.sourceSessionId&&entry.sessionId!==item.sourceSessionId&&!threadProjection)throw new AgentError("context_provenance_mismatch",409);
      }else if(item.itemKind==="artifact"){
        const artifact=this.db.select().from(managedArtifacts).where(eq(managedArtifacts.id,item.itemId)).get();
        if(!artifact||artifact.status!=="active")throw new AgentError("context_artifact_unavailable",409);
        this.scopes.assertSame(scope,this.owner(artifact.scope_type,artifact.scope_id));
      }else if(item.itemKind==="fact"){
        // A manual task restart carries its own text and has no external provenance.
        if(pack.ownerType!=="task" || pack.kind!=="task_update" || item.sourceSessionId || item.sourceEntryId || item.sourceMessageId || item.sourceIdentityId)
          throw new AgentError("context_provenance_mismatch",409);
      }else throw new AgentError("context_item_kind_invalid",400);
    }
  }

  move(sourceId:string,targetId:string):void {
    this.scopes.assertSame(this.scopes.session(sourceId),this.scopes.session(targetId));
  }

  seed(input:RecordRunnerSeedInput):void {
    const scope=this.owner(input.ownerType,input.ownerId);
    const runner=this.db.select().from(runnerContexts).where(eq(runnerContexts.id,input.runnerContextId)).get();
    const pack=this.db.select().from(contextPacks).where(eq(contextPacks.id,input.seedContextPackId)).get();
    if(!runner||!pack)throw new AgentError("context_seed_owner_missing",409);
    if(runner.owner_type!==input.ownerType||runner.owner_id!==input.ownerId)throw new AgentError("context_seed_owner_mismatch",409);
    this.scopes.assertSame(scope,this.owner(pack.ownerType,pack.ownerId));
    for(const id of input.seedEntryIdsJson)this.entry(scope,id);
    for(const id of input.seedContextItemIdsJson){
      const item=this.db.select().from(contextPackItems).where(eq(contextPackItems.id,id)).get();
      if(!item||item.contextPackId!==pack.id)throw new AgentError("context_seed_item_mismatch",409);
      this.items(pack.id,[item]);
    }
  }

  private message(scope:AgentScope,id:string){
    const message=this.db.select().from(messages).where(eq(messages.id,id)).get();
    if(!message||message.deletedAt!==null)throw new AgentError("context_message_unavailable",409);
    this.scopes.assertSame(scope,{agentId:message.agentId,shadowId:message.shadowId});
    return message;
  }

  private entry(scope:AgentScope,id:string){
    const entry=this.db.select().from(sessionTimelineEntries).where(eq(sessionTimelineEntries.id,id)).get();
    if(!entry)throw new AgentError("context_entry_unavailable",409);
    this.scopes.assertSame(scope,this.scopes.session(entry.sessionId));
    this.message(scope,entry.messageId);
    return entry;
  }
}
