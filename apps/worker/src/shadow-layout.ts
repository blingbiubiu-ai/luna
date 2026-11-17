import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {join,sep} from "node:path";
import {ExecutionError,transaction,type SqlDatabase} from "@luna/execution-store";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";

export interface ShadowLayout extends ResourceScope {
 home:string;
 homeSource:string;
 runners:string;
 resourceRoot:string;
 credentials:string;
}

/** Worker owns physical paths; Service supplies only authenticated IDs, never a HOME path. */
export class WorkerShadowLayouts {
 private readonly root:string;
 constructor(private readonly db:SqlDatabase,workerHome:string){
  this.root=realpathSync(workerHome);
  if(this.root.includes(",") || /[\x00-\x1f]/.test(this.root))throw new ExecutionError(400,"runner_path_invalid");
  db.exec(`CREATE TABLE IF NOT EXISTS worker_shadow_layouts (
   shadow_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, home TEXT UNIQUE NOT NULL, runners TEXT UNIQUE NOT NULL);
   CREATE TABLE IF NOT EXISTS worker_shadow_context_paths (
   context_id TEXT PRIMARY KEY, shadow_id TEXT NOT NULL REFERENCES worker_shadow_layouts(shadow_id), cwd TEXT UNIQUE NOT NULL);
   CREATE TRIGGER IF NOT EXISTS worker_shadow_layout_immutable BEFORE UPDATE ON worker_shadow_layouts
   BEGIN SELECT RAISE(ABORT,'shadow_layout_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS worker_shadow_context_path_immutable BEFORE UPDATE ON worker_shadow_context_paths
   BEGIN SELECT RAISE(ABORT,'shadow_context_path_immutable'); END;`);
 }

 ensure(scope:ResourceScope):ShadowLayout {
  const resourceRoot=this.resourceRoot(scope);
  const home=join(this.root,"agents",scope.agentId,"shadows",scope.shadowId);
  const runners=join(home,"runners");
  return transaction(this.db,()=>{
   const prior=this.db.prepare("SELECT agent_id,home,runners FROM worker_shadow_layouts WHERE shadow_id=?").get(scope.shadowId) as {agent_id:string;home:string;runners:string}|undefined;
   if(prior && (prior.agent_id!==scope.agentId || prior.home!==home || prior.runners!==runners))throw new ExecutionError(409,"shadow_layout_conflict");
   if(prior && (!stat(home) || !stat(runners)))throw new ExecutionError(409,"shadow_storage_missing");
   safeDirectory(this.root,home);
   safeDirectory(this.root,resourceRoot);
   safeDirectory(this.root,join(resourceRoot,"credentials"));
   safeDirectory(this.root,runners);
   this.db.prepare("INSERT OR IGNORE INTO worker_shadow_layouts(shadow_id,agent_id,home,runners) VALUES (?,?,?,?)").run(scope.shadowId,scope.agentId,home,runners);
   return {...scope,home,homeSource:home,runners,resourceRoot,credentials:join(resourceRoot,"credentials")};
  });
 }

 /**
  * Forget a deleted Shadow: drop its layout, context and preparation records and return
  * the HOME and resource directories the caller must delete.
  */
 remove(scope:ResourceScope):string[] {
  const resourceRoot=this.resourceRoot(scope);
  const home=join(this.root,"agents",scope.agentId,"shadows",scope.shadowId);
  transaction(this.db,()=>{
   const tables=new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
   const contexts="SELECT context_id FROM worker_shadow_context_paths WHERE shadow_id=?";
   for(const table of ["worker_contexts","worker_context_projects"])
    if(tables.has(table))this.db.prepare(`DELETE FROM ${table} WHERE context_id IN (${contexts})`).run(scope.shadowId);
   if(tables.has("worker_shadow_preparations"))this.db.prepare("DELETE FROM worker_shadow_preparations WHERE shadow_id=?").run(scope.shadowId);
   this.db.prepare("DELETE FROM worker_shadow_context_paths WHERE shadow_id=?").run(scope.shadowId);
   this.db.prepare("DELETE FROM worker_shadow_layouts WHERE shadow_id=? AND agent_id=?").run(scope.shadowId,scope.agentId);
  });
  return [home,resourceRoot];
 }

 /** Executor configuration is stored outside Runner HOME. */
 executorDirectory(scope:ResourceScope,environmentId:string):string {
  validateId(environmentId);
  return join(this.resourceRoot(scope),"environments",environmentId);
 }

 private resourceRoot(scope:ResourceScope):string {
  validateScope(scope);
  return join(this.root,"agents",scope.agentId,"shadow-resources",scope.shadowId);
 }

 /** Context IDs stay bound to their original Shadow and direct-child directory across restarts. */
 context(scope:ResourceScope,contextId:string):{layout:ShadowLayout;cwd:string} {
  validateId(contextId);
  return transaction(this.db,()=>{
   if(!this.db.prepare("SELECT 1 FROM worker_shadow_layouts WHERE shadow_id=?").get(scope.shadowId))
    throw new ExecutionError(409,"shadow_layout_missing");
   const layout=this.ensure(scope);
   const cwd=join(layout.runners,contextId);
   const prior=this.db.prepare("SELECT shadow_id,cwd FROM worker_shadow_context_paths WHERE context_id=?").get(contextId) as {shadow_id:string;cwd:string}|undefined;
   if(prior && (prior.shadow_id!==scope.shadowId || prior.cwd!==cwd))throw new ExecutionError(409,"context_shadow_conflict");
   if(prior && !stat(cwd))throw new ExecutionError(409,"context_storage_missing");
   safeDirectory(layout.runners,cwd);
   this.db.prepare("INSERT OR IGNORE INTO worker_shadow_context_paths VALUES (?,?,?)").run(contextId,scope.shadowId,cwd);
   return {layout,cwd};
  });
 }
}

function validateId(value:string):void {
 if(typeof value!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new ExecutionError(400,"invalid_shadow_path_id");
}
function validateScope(scope:ResourceScope):void {validateId(scope.agentId);validateId(scope.shadowId);}
function stat(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}}
function safeDirectory(root:string,target:string):void {
 if(target!==root && !target.startsWith(root+sep))throw new ExecutionError(409,"shadow_directory_unsafe");
 let path=root;
 for(const part of target.slice(root.length).split(sep).filter(Boolean)){
  path=join(path,part);const prior=stat(path);
  if(prior && (prior.isSymbolicLink() || !prior.isDirectory()))throw new ExecutionError(409,"shadow_directory_unsafe");
  if(!prior)mkdirSync(path,{mode:0o700});
  if(realpathSync(path)!==path)throw new ExecutionError(409,"shadow_directory_unsafe");
 }
}
