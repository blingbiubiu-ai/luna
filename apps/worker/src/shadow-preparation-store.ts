import {contentHash,ExecutionError,transaction,type SqlDatabase} from "@luna/execution-store";
import {ContextPreparationRelease,WorkerContextPreparation,type PrepareRequest} from "@luna/runner-protocol";
export interface ShadowPreparationRecord {invocation_id:string;context_id:string;agent_id:string;shadow_id:string;generation:number;digest:string;input_hash:string;state:string;reply:string|null}
/** Preparation ownership survives lost replies; release requires no unsettled Job reservation. */
export class ShadowPreparationStore {
 constructor(private readonly db:SqlDatabase){
  db.exec(`CREATE TABLE IF NOT EXISTS worker_shadow_preparations (
   invocation_id TEXT PRIMARY KEY,context_id TEXT NOT NULL,agent_id TEXT NOT NULL,shadow_id TEXT NOT NULL,generation INTEGER NOT NULL,
   digest TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,reply TEXT);
   CREATE INDEX IF NOT EXISTS worker_shadow_preparation_context ON worker_shadow_preparations(context_id,state);`);
 }
 get(id:string):ShadowPreparationRecord|undefined{return this.db.prepare("SELECT * FROM worker_shadow_preparations WHERE invocation_id=?").get(id) as ShadowPreparationRecord|undefined;}
 begin(input:WorkerContextPreparation):void {
  transaction(this.db,()=>{
   const prior=this.get(input.invocationId),hash=contentHash(input);
   if(prior?.state==="released")throw new ExecutionError(409,"context_preparation_released");
   if(prior && prior.input_hash!==hash)throw new ExecutionError(409,"context_preparation_conflict");
   if(this.db.prepare("SELECT 1 FROM worker_shadow_preparations WHERE context_id=? AND invocation_id<>? AND state<>'released'").get(input.contextId,input.invocationId))throw new ExecutionError(503,"context_busy");
   // A new resource version does not wait for older preparations: the Shadow switches to it and
   // running Jobs read it from their next file access. Only another placement must drain first.
   if(this.db.prepare("SELECT 1 FROM worker_shadow_preparations WHERE shadow_id=? AND state<>'released' AND (agent_id<>? OR generation<>?)")
    .get(input.scope.shadowId,input.scope.agentId,input.scope.placementGeneration))throw new ExecutionError(503,"shadow_resources_pending");
   this.db.prepare("INSERT OR IGNORE INTO worker_shadow_preparations VALUES (?,?,?,?,?,?,?,'preparing',NULL)")
    .run(input.invocationId,input.contextId,input.scope.agentId,input.scope.shadowId,input.scope.placementGeneration,input.resources.digest,hash);
  });
 }
 /**
  * Whether `candidate` was first prepared for this Shadow after `current`, so switching to it moves
  * forward. A version this Worker never prepared (e.g. one a console provisioned) counts as oldest.
  */
 newer(scope:{agentId:string;shadowId:string;placementGeneration:number},candidate:string,current:string):boolean {
  const first=(digest:string)=>(this.db.prepare("SELECT min(rowid) AS n FROM worker_shadow_preparations WHERE agent_id=? AND shadow_id=? AND generation=? AND digest=? AND input_hash<>''")
   .get(scope.agentId,scope.shadowId,scope.placementGeneration,digest) as {n:number|null}).n;
  const a=first(candidate),b=first(current);
  return a!==null && (b===null || a>b);
 }
 complete(id:string,reply:unknown):void {
  this.requireLive(id);
  this.db.prepare("UPDATE worker_shadow_preparations SET state='prepared',reply=? WHERE invocation_id=?").run(JSON.stringify(reply),id);
 }
 requireLive(id:string):ShadowPreparationRecord {
  const row=this.get(id);if(!row || row.state==="released")throw new ExecutionError(409,"context_preparation_released");return row;
 }
 requireJob(request:PrepareRequest):void {
  if(request.occupant.kind!=="job")return;
  const row=this.requireLive(request.occupant.invocationId),scope=request.spec.scope;
  if(row.state!=="prepared" || row.context_id!==request.occupant.contextId || row.agent_id!==scope.agentId || row.shadow_id!==scope.shadowId
   || row.generation!==scope.placementGeneration || row.digest!==request.spec.resourceSelection.digest)throw new ExecutionError(409,"job_preparation_mismatch");
 }
 release(raw:unknown):void {
  const input=ContextPreparationRelease.parse(raw);
  transaction(this.db,()=>{
   const row=this.get(input.invocationId),scope=input.scope;
   if(row && (row.context_id!==input.contextId || row.agent_id!==scope.agentId || row.shadow_id!==scope.shadowId || row.generation!==scope.placementGeneration || row.digest!==input.resourceRevision))throw new ExecutionError(409,"context_preparation_conflict");
   const reservations=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_reservations'").get();
   if(reservations && this.db.prepare("SELECT 1 FROM worker_reservations WHERE json_extract(record_json,'$.occupant.invocationId')=? AND json_extract(record_json,'$.state') IN ('preparing','ready','cancelling') LIMIT 1").get(input.invocationId))throw new ExecutionError(409,"preparation_still_reserved");
   // Unknown preparation may still be in flight: a durable tombstone fences its late arrival.
   this.db.prepare("INSERT INTO worker_shadow_preparations VALUES (?,?,?,?,?,?,'','released',NULL) ON CONFLICT(invocation_id) DO UPDATE SET state='released'")
    .run(input.invocationId,input.contextId,scope.agentId,scope.shadowId,scope.placementGeneration,input.resourceRevision);
  });
 }
}
