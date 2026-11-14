import {TaskScopeResolver} from "@/agents/task-scope";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import {and,count,eq,isNull} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {invocationResourceSnapshots,runnerResourceSnapshots,runnerInvocations} from "@/data/schema";
import {AgentError} from "@/agents/agent-store";
import {ScopedResourceStore} from "@luna/host-runtime/scoped-resource-store";
import type {ScopedResourceBundle} from "@luna/host-runtime/scoped-runner-resources";
import {InvocationStore} from "./invocation-store";
import {resolveInvocationScope} from "./invocation-scope";
import type {AgentResourceBuilder} from "./agent-resource-builder";

/** Pins at admission; retries/recovery read only the persisted selection, never current configuration. */
export class InvocationResources {
 private readonly files:ScopedResourceStore;
 constructor(private readonly db:DrizzleDB,home:string){this.files=new ScopedResourceStore(home);}
 pin(invocationId:string,builder:AgentResourceBuilder):ScopedResourceBundle {
  return this.db.transaction(()=>{
   const invocation=new InvocationStore(this.db).require(invocationId);
   if(invocation.state!=="active" || invocation.settledAt!==null)throw new AgentError("invocation_inactive",409);
   const scope=resolveInvocationScope(this.db,invocation);
   if(this.reference(invocationId))return this.read(invocationId);
   // Existing attempts must not acquire a different resource set after restart.
   if(invocation.activeJobId)throw new AgentError("invocation_resources_missing",409);
   const bundle=builder.capture(invocation.actorUserId,scope);
   this.files.publish(bundle,scope,bundle.selection);
   this.db.insert(runnerResourceSnapshots).values({digest:bundle.selection.digest,...scope,selection:bundle.selection,createdAt:Date.now()}).onConflictDoNothing().run();
   this.db.insert(invocationResourceSnapshots).values({invocationId,digest:bundle.selection.digest,createdAt:Date.now()}).run();
   return this.read(invocationId);
  });
 }
 read(invocationId:string):ScopedResourceBundle {
  const invocation=new InvocationStore(this.db).require(invocationId),ref=this.reference(invocationId);
  if(!ref)throw new AgentError("invocation_resources_missing",409);
  const snapshot=this.db.select().from(runnerResourceSnapshots).where(eq(runnerResourceSnapshots.digest,ref.digest)).get();
  if(!snapshot || snapshot.agentId!==invocation.agentId || snapshot.shadowId!==invocation.shadowId)throw new AgentError("invocation_resource_scope_mismatch",409);
  return this.files.read(snapshot,snapshot.selection);
 }
 /** Called only after Worker placement/access authentication; unreferenced history is not downloadable. */
 download(scope:ResourceScope,digest:string):ScopedResourceBundle|undefined {
  new TaskScopeResolver(this.db).active(scope);
  const snapshot=this.db.select().from(runnerResourceSnapshots).where(eq(runnerResourceSnapshots.digest,digest)).get();
  if(!snapshot || snapshot.agentId!==scope.agentId || snapshot.shadowId!==scope.shadowId || this.retainedReferences(digest)===0)return undefined;
  return this.files.read(snapshot,snapshot.selection);
 }
 /** Revocation alone does not release bytes: unknown/running work still holds this reference. */
 retainedReferences(digest:string):number {
  return this.db.select({value:count()}).from(invocationResourceSnapshots)
   .innerJoin(runnerInvocations,eq(invocationResourceSnapshots.invocationId,runnerInvocations.id))
   .where(and(eq(invocationResourceSnapshots.digest,digest),isNull(runnerInvocations.settledAt))).get()!.value;
 }
 private reference(invocationId:string){return this.db.select().from(invocationResourceSnapshots).where(eq(invocationResourceSnapshots.invocationId,invocationId)).get();}
}
