import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { agentProfiles, agentProfileRevisions, shadowModelSelections } from "@/data/schema";
import { AgentError, AgentStore, type AgentScope } from "./agent-store";

export type ModelSelection = {mode:"inherit";profileId:null;revisionId:null} | {mode:"fixed";profileId:string;revisionId:string};

/** A Shadow selects an immutable validated profile revision; credentials stay in the profile store. */
export class ShadowModelSelectionStore {
  constructor(private readonly db: DrizzleDB) {}

  get(scope: AgentScope): ModelSelection {
    const row=this.db.select().from(shadowModelSelections).where(and(
      eq(shadowModelSelections.agentId,scope.agentId),eq(shadowModelSelections.shadowId,scope.shadowId),
    )).get();
    return row?.mode==="fixed" ? {mode:"fixed",profileId:row.profileId!,revisionId:row.revisionId!} : {mode:"inherit",profileId:null,revisionId:null};
  }

  view(scope: AgentScope) {
    const selection=this.get(scope);
    if(selection.mode==="inherit")return {...selection,name:null,model:null,agentType:null,available:true};
    const profile=this.db.select().from(agentProfiles).where(eq(agentProfiles.id,selection.profileId)).get();
    const revision=this.db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id,selection.revisionId)).get();
    return {...selection,name:profile?.name??null,model:revision?.model??null,agentType:profile?.agent_type??null,
      available:!!profile && profile.deleted_at===null && revision?.validation_state==="validated"};
  }

  read(actor:string,scope:AgentScope) {this.authorize(actor,scope);return this.view(scope);}

  save(actor:string,scope:AgentScope,input:{mode:"inherit"}|{mode:"fixed";revisionId:string}) {
    return this.db.transaction(()=>{
      this.authorize(actor,scope);
      const agents=new AgentStore(this.db);agents.requireAccess(agents.ownerUserId(scope.agentId),scope.agentId);
      let selection:ModelSelection={mode:"inherit",profileId:null,revisionId:null};
      if(input.mode==="fixed") {
        const revision=this.db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id,input.revisionId)).get();
        const profile=revision ? this.db.select().from(agentProfiles).where(eq(agentProfiles.id,revision.profile_id)).get() : undefined;
        if(!profile || !revision || profile.agent_id!==scope.agentId || profile.deleted_at!==null)throw new AgentError("shadow_model_unavailable",409);
        if(revision.validation_state!=="validated")throw new AgentError("shadow_model_not_validated",409);
        selection={mode:"fixed",profileId:profile.id,revisionId:revision.id};
      }
      const values={...scope,...selection,updatedByAccountId:actor,updatedAt:Date.now()};
      this.db.insert(shadowModelSelections).values(values).onConflictDoUpdate({target:shadowModelSelections.shadowId,set:values}).run();
      return this.view(scope);
    });
  }

  private authorize(actor:string,scope:AgentScope):void {
    const agents=new AgentStore(this.db);agents.requireOwner(actor,scope.agentId);
    const shadow=agents.shadow(scope.shadowId);
    if(shadow.agentId!==scope.agentId)throw new AgentError("scope_mismatch",409);
    if(shadow.status==="deleted")throw new AgentError("shadow_deleted",409);
  }
}
