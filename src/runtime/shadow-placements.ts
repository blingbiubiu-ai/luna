import {ExecutionError,transaction,type SqlDatabase} from "@luna/execution-store";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";
import type {WorkerRegistry,WorkerRecord} from "./worker-registry";

export interface ShadowPlacement extends ResourceScope {workerId:string;generation:number;status:"active"|"disabled"}
export type BoundWorkerResolver = (scope: ResourceScope) => string | undefined;
/** Place each context on a Worker, preferring Workers already used by its Shadow. */
export class ShadowPlacements {
 constructor(private readonly db:SqlDatabase,private readonly workers:WorkerRegistry,private readonly boundWorker?: BoundWorkerResolver){
  db.exec(`CREATE TABLE IF NOT EXISTS shadow_placements (
   shadow_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,worker_id TEXT NOT NULL REFERENCES runtime_workers(worker_id),
   generation INTEGER NOT NULL CHECK(generation>=1 AND typeof(generation)='integer'),status TEXT NOT NULL CHECK(status IN ('active','disabled')));
   CREATE TABLE IF NOT EXISTS shadow_context_routes (
   context_id TEXT PRIMARY KEY,shadow_id TEXT NOT NULL REFERENCES shadow_placements(shadow_id),
   scope_key TEXT NOT NULL,project_id TEXT,worker_id TEXT NOT NULL REFERENCES runtime_workers(worker_id));
   CREATE TRIGGER IF NOT EXISTS shadow_placement_identity BEFORE UPDATE OF shadow_id,agent_id,worker_id ON shadow_placements
   WHEN OLD.shadow_id IS NOT NEW.shadow_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.worker_id IS NOT NEW.worker_id
   BEGIN SELECT RAISE(ABORT,'shadow_placement_immutable'); END;`);
  transaction(db,()=>{
   if (!(db.prepare("PRAGMA table_info(shadow_context_routes)").all() as {name:string}[]).some(column=>column.name==="worker_id")) {
    db.exec(`DROP TRIGGER IF EXISTS shadow_context_identity;
     ALTER TABLE shadow_context_routes ADD COLUMN worker_id TEXT REFERENCES runtime_workers(worker_id);
     UPDATE shadow_context_routes SET worker_id=(SELECT worker_id FROM shadow_placements WHERE shadow_placements.shadow_id=shadow_context_routes.shadow_id);`);
   }
   db.exec(`CREATE TRIGGER IF NOT EXISTS shadow_context_identity BEFORE UPDATE OF context_id,shadow_id,scope_key,project_id ON shadow_context_routes
    BEGIN SELECT RAISE(ABORT,'shadow_context_immutable'); END;
    CREATE INDEX IF NOT EXISTS shadow_context_workers ON shadow_context_routes(shadow_id,worker_id);`);
  });
 }
 find(scope:ResourceScope):ShadowPlacement|undefined {
  valid(scope.agentId);valid(scope.shadowId);
  const row=this.db.prepare("SELECT agent_id AS agentId,shadow_id AS shadowId,worker_id AS workerId,generation,status FROM shadow_placements WHERE shadow_id=?").get(scope.shadowId) as ShadowPlacement|undefined;
  if(row && row.agentId!==scope.agentId)throw new ExecutionError(409,"shadow_placement_scope_mismatch");
  return row??undefined;
 }
 /** allowedWorkers is resolved by trusted Service Agent-worker admission, never by a client body. */
 route(scope:ResourceScope,allowedWorkers:readonly string[],projectId?:string):ShadowPlacement {
  if(projectId!==undefined)valid(projectId);
  return transaction(this.db,()=>{
   const prior=this.find(scope);
   if(prior){
    if(prior.status!=="active")throw new ExecutionError(409,"shadow_placement_disabled");
    if(!allowedWorkers.includes(prior.workerId))throw new ExecutionError(403,"agent_worker_access_denied");
    this.available(prior,projectId);return prior;
   }
   if(!allowedWorkers.length)throw new ExecutionError(409,"agent_workers_not_configured");
   const chosen=this.choose(scope,allowedWorkers,projectId);
   if(!chosen)throw new ExecutionError(503,"no_scoped_worker_available");
   this.db.prepare("INSERT INTO shadow_placements VALUES (?,?,?,1,'active')").run(scope.shadowId,scope.agentId,chosen.workerId);
   return this.find(scope)!;
  });
 }
 context(scope:ResourceScope,contextId:string):ShadowPlacement|undefined {
  const row=this.contextRoute(contextId);
  if(!row)return;
  if(row.shadow_id!==scope.shadowId)throw new ExecutionError(409,"context_placement_conflict");
  const placement=this.find(scope)!;
  return {...placement,workerId:row.worker_id};
 }
 /** Preparation calls this only before reserving execution, never for an active invocation. */
 boundWorkerId(scope:ResourceScope):string|undefined { return this.boundWorker?.(scope); }
 applyRouting(scope:ResourceScope,contextId:string,scopeKey:string,allowedWorkers:readonly string[],projectId?:string):void {
  const bound=this.boundWorker?.(scope), prior=this.context(scope,contextId);
  if(!prior || (bound ? prior.workerId===bound : allowedWorkers.includes(prior.workerId)))return;
  if(prior.status!=="active")throw new ExecutionError(409,"shadow_placement_disabled");
  const identity=this.contextRoute(contextId)!;
  if(identity.scope_key!==scopeKey || identity.project_id!==(projectId??null))throw new ExecutionError(409,"context_placement_conflict");
  if(bound && !allowedWorkers.includes(bound))throw new ExecutionError(403,"bound_worker_access_denied");
  const worker=this.choose(scope,allowedWorkers,projectId);
  if(!worker)throw new ExecutionError(503,"no_scoped_worker_available");
  transaction(this.db,()=>{
   this.db.prepare("UPDATE shadow_context_routes SET worker_id=? WHERE context_id=?").run(worker.workerId,contextId);
   this.db.prepare("DELETE FROM runtime_prepared_contexts WHERE context_id=?").run(contextId);
  });
 }
 bindContext(scope:ResourceScope,contextId:string,scopeKey:string,allowedWorkers:readonly string[],projectId?:string,requireReady=true):ShadowPlacement {
  valid(contextId);
  if(projectId!==undefined)valid(projectId);
  if(!scopeKey || scopeKey.length>512)throw new ExecutionError(400,"invalid_context_scope_key");
  return transaction(this.db,()=>{
   const old=this.contextRoute(contextId);
   if(old && (old.shadow_id!==scope.shadowId || old.scope_key!==scopeKey || old.project_id!==(projectId??null)))throw new ExecutionError(409,"context_placement_conflict");
   const shadow=this.find(scope)??this.route(scope,allowedWorkers,projectId);
   const workerId=old?.worker_id??this.choose(scope,allowedWorkers,projectId)?.workerId;
   if(!workerId)throw new ExecutionError(503,"no_scoped_worker_available");
   const placement={...shadow,workerId};
   this.authorize(placement,allowedWorkers);
   if(requireReady)this.available(placement,projectId);
   if(!old)this.db.prepare("INSERT INTO shadow_context_routes VALUES (?,?,?,?,?)").run(contextId,scope.shadowId,scopeKey,projectId??null,workerId);
   return placement;
  });
 }
 /** Caller checks that this context has no outstanding execution before rebinding. */
 replace(prior:ShadowPlacement,contextId:string,allowedWorkers:readonly string[],projectId:string|undefined,excluded:ReadonlySet<string>):ShadowPlacement|undefined {
  if(this.boundWorker?.(prior))return;
  this.require(prior,prior.workerId,prior.generation,contextId);
  this.authorize(prior,allowedWorkers);
  if(this.workers.hasRecentHeartbeat(prior.workerId))return;
  const chosen=this.choose(prior,allowedWorkers.filter(id=>id!==prior.workerId && !excluded.has(id)),projectId);
  if(!chosen)return;
  this.db.prepare("UPDATE shadow_context_routes SET worker_id=? WHERE context_id=?").run(chosen.workerId,contextId);
  return {...prior,workerId:chosen.workerId};
 }
 workerIds(scope:ResourceScope):string[] {
  const shadow=this.find(scope);
  if(!shadow)return [];
  const rows=this.db.prepare("SELECT DISTINCT worker_id FROM shadow_context_routes WHERE shadow_id=?").all(scope.shadowId) as {worker_id:string}[];
  return rows.length ? rows.map(row=>row.worker_id) : [shadow.workerId];
 }
 /** Assignment/download fencing checks the persisted identity even if the Worker is temporarily offline. */
 require(scope:ResourceScope,workerId:string,generation:number,contextId?:string):ShadowPlacement {
  const placement=contextId===undefined ? this.find(scope) : this.context(scope,contextId);
  if(!placement || placement.generation!==generation || placement.status!=="active"
    || (contextId===undefined ? !this.workerIds(scope).includes(workerId) : placement.workerId!==workerId))throw new ExecutionError(409,"shadow_placement_mismatch");
  return {...placement,workerId};
 }
 private contextRoute(contextId:string) {
  return this.db.prepare("SELECT shadow_id,scope_key,project_id,worker_id FROM shadow_context_routes WHERE context_id=?").get(contextId) as
   {shadow_id:string;scope_key:string;project_id:string|null;worker_id:string}|undefined;
 }
 private authorize(placement:ShadowPlacement,allowedWorkers:readonly string[]):void {
  if(placement.status!=="active")throw new ExecutionError(409,"shadow_placement_disabled");
  if(!allowedWorkers.includes(placement.workerId))throw new ExecutionError(403,"agent_worker_access_denied");
 }
 private choose(scope:ResourceScope,allowedWorkers:readonly string[],projectId?:string):WorkerRecord|undefined {
  const bound=this.boundWorker?.(scope);
  if(bound && !allowedWorkers.includes(bound))throw new ExecutionError(403,"bound_worker_access_denied");
  if(bound && !this.workers.list().some(worker=>worker.workerId===bound && this.ready(worker,projectId)))throw new ExecutionError(503,"bound_worker_unavailable");
  const affinity=new Set(this.workerIds(scope));
  return this.workers.list().filter(worker=>(!bound || worker.workerId===bound) && allowedWorkers.includes(worker.workerId) && this.ready(worker,projectId))
   .map(worker=>({worker,load:this.occupied(worker)}))
   .sort((a,b)=>Number(a.load>=a.worker.health!.capacity)-Number(b.load>=b.worker.health!.capacity)
    || Number(affinity.has(b.worker.workerId))-Number(affinity.has(a.worker.workerId))
    || a.load-b.load || (a.worker.workerId < b.worker.workerId ? -1 : a.worker.workerId > b.worker.workerId ? 1 : 0))[0]?.worker;
 }
 private ready(worker:WorkerRecord,projectId?:string):boolean {
  return !worker.draining && worker.lastSeen>Date.now()-30000 && worker.health?.ready===true
   && worker.health.capabilities?.includes("shadow-scope-v2")===true
   && (!projectId || worker.health.projects?.includes(projectId)===true);
 }
 private available(placement:ShadowPlacement,projectId?:string):void {
  const worker=this.workers.require(placement.workerId);
  if(!this.ready(worker,projectId))throw new ExecutionError(503,"shadow_worker_unavailable");
 }
 private occupied(worker:WorkerRecord):number {
  const jobs=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_jobs'").get();
  if(!jobs)return worker.health?.occupied??0;
  const assigned=this.db.prepare(`SELECT count(*) AS count FROM scheduled_jobs
   WHERE pending=1 AND json_extract(record_json,'$.workerId')=? AND json_extract(record_json,'$.placementState')!='terminal'`).get(worker.workerId) as {count:number};
  const intents=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_preparation_intents'").get();
  if(!intents)return Math.max(worker.health?.occupied??0,assigned.count);
  // Count contexts preparing on this Worker before they appear in its reservation load.
  const preparing=this.db.prepare(`SELECT count(DISTINCT json_extract(i.input_json,'$.contextId')) AS count
   FROM runtime_preparation_intents i JOIN shadow_context_routes r ON r.context_id=json_extract(i.input_json,'$.contextId')
   WHERE i.state='active' AND i.worker_id=? AND i.worker_id=r.worker_id AND NOT EXISTS (
    SELECT 1 FROM scheduled_jobs j WHERE j.pending=1 AND json_extract(j.record_json,'$.job.invocationId')=i.invocation_id
    AND json_extract(j.record_json,'$.workerId') IS NOT NULL)
  `).get(worker.workerId) as {count:number};
  return Math.max(worker.health?.occupied??0,assigned.count)+preparing.count;
 }
}
function valid(value:string):void {if(typeof value!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new ExecutionError(400,"invalid_placement_id");}
