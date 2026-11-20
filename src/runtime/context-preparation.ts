import {contentHash,ExecutionError,transaction,type SqlDatabase} from "@luna/execution-store";
import {ContextPreparation,PreparedContext,WorkerPreparedContext} from "@luna/runner-protocol";
import type {RuntimeScheduler} from "./scheduler";
import {retryableDelivery} from "./delivery";
import type {ShadowPlacement} from "./shadow-placements";

/** Workers that put each context in its owner's directory, shared by the owner's contexts. */
export const OWNER_WORKSPACE_CAPABILITY="owner-workspace-v1";

interface PreparationIntent {invocation_id:string;input_json:string;worker_id:string;generation:number;state:string}

/** Prepare on the context’s current Worker, with failover before execution is reserved. */
export class ContextPreparationManager {
 private busy=new Set<string>();
 constructor(private db:SqlDatabase,private scheduler:RuntimeScheduler){
  db.exec("CREATE TABLE IF NOT EXISTS runtime_preparation_intents(invocation_id TEXT PRIMARY KEY,input_json TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,error TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS runtime_prepared_contexts(context_id TEXT PRIMARY KEY,body TEXT NOT NULL,input_json TEXT NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_previous_preparations(
   invocation_id TEXT NOT NULL,input_json TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,
   PRIMARY KEY(invocation_id,worker_id))`);
 }
 isBusy(id:string):boolean{return this.busy.has(id);}
 hasActiveShadow(shadowId: string): boolean {
  return Boolean(this.db.prepare("SELECT 1 FROM runtime_preparation_intents WHERE state='active' AND json_extract(input_json,'$.scope.shadowId')=? LIMIT 1").get(shadowId));
 }
 previousWorkers(shadowId:string):string[] {
  const rows=this.db.prepare("SELECT DISTINCT worker_id FROM runtime_previous_preparations WHERE json_extract(input_json,'$.scope.shadowId')=?")
   .all(shadowId) as {worker_id:string}[];
  return rows.map(row=>row.worker_id);
 }
 /** Drop a purged Shadow's settled preparation records; active ones keep the purge pending. */
 forgetShadow(shadowId:string):void {
  transaction(this.db,()=>{
   for(const table of ["runtime_prepared_contexts","runtime_previous_preparations"])
    this.db.prepare(`DELETE FROM ${table} WHERE json_extract(input_json,'$.scope.shadowId')=?`).run(shadowId);
  });
 }
 cached(id:string):PreparedContext|undefined {
  const row=this.db.prepare("SELECT body FROM runtime_prepared_contexts WHERE context_id=?").get(id) as {body:string}|undefined;
  return row ? PreparedContext.parse(JSON.parse(row.body)) : undefined;
 }
 input(id:string):ContextPreparation|undefined {
  const row=this.db.prepare("SELECT input_json FROM runtime_prepared_contexts WHERE context_id=?").get(id) as {input_json:string}|undefined;
  return row ? ContextPreparation.parse(JSON.parse(row.input_json)) : undefined;
 }
 pendingInput(invocationId:string):ContextPreparation|undefined {
  const row=this.db.prepare("SELECT input_json FROM runtime_preparation_intents WHERE invocation_id=? AND state='active'").get(invocationId) as {input_json:string}|undefined;
  return row ? ContextPreparation.parse(JSON.parse(row.input_json)) : undefined;
 }
 async prepare(raw:ContextPreparation,signal?:AbortSignal):Promise<PreparedContext>{
  if(raw?.protocolVersion!==2)throw new ExecutionError(422,"unsupported_protocol");
  const parsed=ContextPreparation.safeParse(raw);
  if(!parsed.success)throw new ExecutionError(422,"invalid_context_preparation");
  const input=parsed.data;
  if(this.busy.has(input.contextId))throw new ExecutionError(503,"context_busy");
  if(!this.scheduler.allowedWorkers)throw new ExecutionError(409,"worker_authorization_unconfigured");
  this.busy.add(input.contextId);
  try{
   const intent=this.db.prepare("SELECT * FROM runtime_preparation_intents WHERE invocation_id=?").get(input.invocationId) as PreparationIntent|undefined;
   if(intent && (intent.state==="released" || contentHash(JSON.parse(intent.input_json))!==contentHash(input)))throw new ExecutionError(409,"invocation_preparation_conflict");
   const allowed=this.scheduler.allowedWorkers(input.scope);
   const bound=this.scheduler.placements.boundWorkerId(input.scope);
   const executing=this.scheduler.jobs.list(true).some(job=>job.job.runnerContextId===input.contextId && job.workerId && job.placementState!=="terminal");
   if(!intent && !executing) {
    const route=this.scheduler.placements.context(input.scope,input.contextId);
    const changing=route && (bound ? bound!==route.workerId : !allowed.includes(route.workerId));
    if(changing && this.scheduler.isContextFileBusy(input.contextId))throw new ExecutionError(503,"context_busy");
    this.scheduler.placements.applyRouting(input.scope,input.contextId,input.scopeKey,allowed,input.projectId);
   }
   let placement=this.scheduler.placements.bindContext(input.scope,input.contextId,input.scopeKey,allowed,input.projectId,false);
   if(intent && (intent.worker_id!==placement.workerId || intent.generation!==placement.generation))throw new ExecutionError(409,"invocation_preparation_conflict");
   const prior=this.cached(input.contextId);
   const activeJobs=this.scheduler.jobs.list(true).filter(job=>job.job.runnerContextId===input.contextId && job.placementState!=="terminal");
   if(activeJobs.some(job=>job.job.invocationId!==input.invocationId)){
    if(activeJobs.some(job=>job.workerId) && (!prior || (bound && bound!==placement.workerId) || prior.workerId!==placement.workerId || prior.scope.placementGeneration!==placement.generation))
      throw new ExecutionError(409,"context_execution_unknown");
    throw new ExecutionError(503,"context_busy");
   }
   if(activeJobs.some(job=>job.workerId)){
    if(!prior || (bound && bound!==placement.workerId) || prior.workerId!==placement.workerId || prior.scope.placementGeneration!==placement.generation
      || contentHash(this.input(input.contextId))!==contentHash(input))throw new ExecutionError(409,"context_execution_unknown");
    this.scheduler.placements.bindContext(input.scope,input.contextId,input.scopeKey,allowed,input.projectId);
    return prior;
   }
   this.db.prepare("INSERT OR IGNORE INTO runtime_preparation_intents VALUES (?,?,?,?,'active',NULL)").run(input.invocationId,JSON.stringify(input),placement.workerId,placement.generation);
   let reply:unknown;
   try{
    reply=await this.deliver(input,placement,signal);
   }catch(error){
    signal?.throwIfAborted();
    if(!(error instanceof ExecutionError) || !["worker_delivery_failed","shadow_worker_unavailable"].includes(error.code))throw error;
    const replacement=this.replace(input,placement);
    if(!replacement)throw error;
    placement=replacement;
    reply=await this.deliver(input,placement,signal);
   }
   signal?.throwIfAborted();
   const scope={...input.scope,placementGeneration:placement.generation};
   const parsedReply=WorkerPreparedContext.safeParse(reply);
   if(!parsedReply.success)throw new ExecutionError(409,"invalid_prepared_context");
   const result=parsedReply.data;
   if(result.workerId!==placement.workerId || contentHash(result.scope)!==contentHash(scope) || contentHash(result.resources)!==contentHash(input.resources))throw new ExecutionError(409,"prepared_context_scope_mismatch");
   // Recheck authorization and placement after the asynchronous Worker operation.
   this.scheduler.placements.bindContext(input.scope,input.contextId,input.scopeKey,this.scheduler.allowedWorkers(input.scope),input.projectId);
   this.scheduler.placements.require(input.scope,placement.workerId,placement.generation,input.contextId);
   // Only a change here starts a fresh provider session: another Worker or placement, whose HOME holds
   // different provider sessions. Instructions and resources (prompts, skills, tools) are left out on
   // purpose: Claude rereads CLAUDE.md and Codex resends a replaced AGENTS.md on every resumed turn, and
   // a skill body is read when it is used, so updating them must not cost conversations their context.
   const prepared:PreparedContext={...result,local:placement.workerId===this.scheduler.config.homeWorkerId,
    instructionFingerprint:contentHash({scope,workerId:placement.workerId})};
   transaction(this.db,()=>this.db.prepare("INSERT INTO runtime_prepared_contexts VALUES (?,?,?) ON CONFLICT(context_id) DO UPDATE SET body=excluded.body,input_json=excluded.input_json")
    .run(input.contextId,JSON.stringify(prepared),JSON.stringify(input)));
   return prepared;
  }finally{this.busy.delete(input.contextId);}
 }
 private async deliver(input:ContextPreparation,placement:ShadowPlacement,signal?:AbortSignal):Promise<unknown> {
  this.scheduler.placements.bindContext(input.scope,input.contextId,input.scopeKey,this.scheduler.allowedWorkers!(input.scope),input.projectId);
  // Older Workers name every context's directory after the context and refuse anything else.
  const shared=this.scheduler.workers.list().find(worker=>worker.workerId===placement.workerId)?.health?.capabilities?.includes(OWNER_WORKSPACE_CAPABILITY)===true;
  let lastError:unknown;
  for(let attempt=0;attempt<2;attempt++){
   signal?.throwIfAborted();
   try{
    return await this.scheduler.workers.client(placement.workerId).call("POST","/v2/context-prepare",{
     ...input,...(shared ? {} : {runnerId:input.contextId}),scope:{...input.scope,placementGeneration:placement.generation},
    },AbortSignal.any([AbortSignal.timeout(10000),...(signal ? [signal] : [])]));
   }catch(error){
    signal?.throwIfAborted();
    if(error instanceof ExecutionError && ["shadow_resources_pending","shadow_preparation_busy","context_busy"].includes(error.code))throw error;
    if(!retryableDelivery(error))throw error;
    lastError=error;
   }
  }
  throw new ExecutionError(502,"worker_delivery_failed",{cause:String(lastError)});
 }
 private replace(input:ContextPreparation,placement:ShadowPlacement):ShadowPlacement|undefined {
  return transaction(this.db,()=>{
   if(this.scheduler.isContextFileBusy(input.contextId) || this.scheduler.jobs.list(true).some(job=>
    job.job.runnerContextId===input.contextId && job.workerId && job.placementState!=="terminal"))return;
   const excluded=this.db.prepare("SELECT worker_id FROM runtime_previous_preparations WHERE invocation_id=?").all(input.invocationId) as {worker_id:string}[];
   const replacement=this.scheduler.placements.replace(placement,input.contextId,this.scheduler.allowedWorkers!(input.scope),input.projectId,new Set(excluded.map(row=>row.worker_id)));
   if(!replacement)return;
   this.db.prepare("INSERT INTO runtime_previous_preparations SELECT * FROM runtime_preparation_intents WHERE invocation_id=?").run(input.invocationId);
   this.db.prepare("UPDATE runtime_preparation_intents SET worker_id=?,error=NULL WHERE invocation_id=?").run(replacement.workerId,input.invocationId);
   this.db.prepare("DELETE FROM runtime_prepared_contexts WHERE context_id=?").run(input.contextId);
   return replacement;
  });
 }
 /** Service settlement authorizes release on the current Worker; a replaced prepare can be released immediately. */
 async releaseSettled():Promise<void> {
  for(const table of ["runtime_preparation_intents","runtime_previous_preparations"]){
   const intents=this.db.prepare(`SELECT * FROM ${table} WHERE state='active'`).all() as PreparationIntent[];
   for(const intent of intents){
    if(table==="runtime_preparation_intents" && (!this.scheduler.preparationSettled?.(intent.invocation_id)
      || this.scheduler.jobs.list(true).some(job=>job.job.invocationId===intent.invocation_id && job.placementState!=="terminal")))continue;
    const input=ContextPreparation.parse(JSON.parse(intent.input_json));
    if(this.isBusy(input.contextId))continue;
    try{
     await this.scheduler.workers.client(intent.worker_id).call("POST","/v2/context-preparations/release",{
      invocationId:intent.invocation_id,contextId:input.contextId,scope:{...input.scope,placementGeneration:intent.generation},resourceRevision:input.resources.digest,
     });
     this.db.prepare(`UPDATE ${table} SET state='released',error=NULL WHERE invocation_id=? AND worker_id=?`).run(intent.invocation_id,intent.worker_id);
    }catch(error){
     this.db.prepare(`UPDATE ${table} SET error=? WHERE invocation_id=? AND worker_id=?`).run(error instanceof ExecutionError ? error.code : "preparation_release_unavailable",intent.invocation_id,intent.worker_id);
    }
   }
  }
 }

}
