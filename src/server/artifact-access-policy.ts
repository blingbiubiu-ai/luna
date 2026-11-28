import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {sessions,tasks} from "@/data/schema";
import type {ManagedArtifactRow} from "@/artifacts/artifact-registry";
import {AgentError,AgentStore} from "@/agents/agent-store";
import {SessionAccessPolicy} from "@/agents/session-access";
import {TaskAccessPolicy} from "@/agents/task-access";
import type {LunaAccessTokenClaims} from "./auth/access-token-service";

export interface ArtifactAccessPolicyInput {
  readonly db:DrizzleDB;
  readonly readHistory?: boolean;
  /** The signed-in account (Dashboard or personal token); a runner token reads as `accessTokenClaims.actorUserId`. */
  readonly requesterAccountId?:string|undefined;
  readonly accessTokenClaims?:LunaAccessTokenClaims|undefined;
  readonly runArtifactAllowlist?:readonly string[];
}

/** A task-result invocation still runs Main in its session. */
export function runnerArtifactScope(claims: LunaAccessTokenClaims): {scopeType: "task" | "session"; scopeId: string} | undefined {
  if (claims.runnerKind === "task" && claims.taskId) return {scopeType: "task", scopeId: claims.taskId};
  if (claims.runnerKind === "main" && claims.sessionId) return {scopeType: "session", scopeId: claims.sessionId};
}

/** Signed sharing remains explicit; authenticated reads resolve the artifact's real owner. */
export function createArtifactAccessPolicy(input:ArtifactAccessPolicyInput){
  const allowlist=new Set(input.runArtifactAllowlist??[]),claims=input.accessTokenClaims;
  const owner=(type:string,id:string)=>{
    const table = type === "session" ? sessions : type === "task" ? tasks : undefined;
    if (!table) return undefined;
    return input.db.select({agent_id:table.agent_id,shadow_id:table.shadow_id})
      .from(table).where(eq(table.id,id)).get();
  };
  const canRead=(artifact:ManagedArtifactRow,readHistory=false):boolean=>{
    const account=input.requesterAccountId,runnerUser=claims?.source==="runner"?claims.actorUserId:undefined;
    if((!account&&!runnerUser)||artifact.status!=="active"||artifact.deleted_at!==null)return false;
    try{
      const resource=owner(artifact.scope_type,artifact.scope_id);
      if(!resource || resource.agent_id !== artifact.agent_id || resource.shadow_id !== artifact.shadow_id)return false;
      const agents = new AgentStore(input.db);
      const options = {readHistory: readHistory && input.readHistory === true && claims === undefined};
      if(claims?.source==="runner"){
        const actor=claims.actorUserId;
        if(claims.role!=="runner"||!actor)return false;
        const scope = runnerArtifactScope(claims);
        if (!scope) return false;
        const runner=owner(scope.scopeType,scope.scopeId);
        if(!runner||runner.agent_id!==resource.agent_id||runner.shadow_id!==resource.shadow_id)return false;
        agents.requireScope(actor,{agentId:runner.agent_id,shadowId:runner.shadow_id});
        return allowlist.has(artifact.id)||(artifact.scope_type===scope.scopeType&&artifact.scope_id===scope.scopeId);
      }
      if(!account)return false;
      agents.requireOwner(account, resource.agent_id, {includeDeleted: options.readHistory});
      const actor=agents.ownerUserId(resource.agent_id);
      agents.requireScope(actor,{agentId:resource.agent_id,shadowId:resource.shadow_id},options);
      if(artifact.scope_type==="session")new SessionAccessPolicy(input.db).requireAccess(actor,artifact.scope_id,options);
      else new TaskAccessPolicy(input.db).requireAccess(actor,artifact.scope_id,options);
      return true;
    }catch(error){if(error instanceof AgentError)return false;throw error;}
  };
  const canManage=(artifact:ManagedArtifactRow)=>{
    return claims?.source!=="runner" && canRead(artifact);
  };
  return {
    canReadMetadata:(artifact:ManagedArtifactRow)=>canRead(artifact,true),
    canReadContent:(artifact:ManagedArtifactRow,options:{readonly hasValidSignature:boolean})=>options.hasValidSignature||canRead(artifact,true),
    canCreateSignedUrl:(artifact:ManagedArtifactRow)=>claims?.source!=="runner"&&canRead(artifact),
    canDelete:canManage,
  };
}
