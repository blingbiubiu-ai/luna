import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {dirname,join,relative,sep} from "node:path";
import {ExecutionError,transaction,type SqlDatabase} from "@luna/execution-store";
import type {ResourceScope} from "@luna/host-runtime/scoped-runner-resources";

/** Every container sees its Shadow's HOME here; each container belongs to one Shadow. */
export const CONTAINER_HOME="/home/luna";

/** `home` and `runners` are the paths inside the container; the `Source` ones are on this host. */
export interface ShadowLayout extends ResourceScope {
 home:string;
 homeSource:string;
 runners:string;
 runnersSource:string;
 resourceRoot:string;
 credentials:string;
}

/** Worker owns physical paths; Service supplies only authenticated IDs, never a HOME path. */
export class WorkerShadowLayouts {
 private readonly root:string;
 constructor(private readonly db:SqlDatabase,workerHome:string){
  this.root=realpathSync(workerHome);
  if(this.root.includes(",") || /[\x00-\x1f]/.test(this.root))throw new ExecutionError(400,"runner_path_invalid");
  // Contexts of one owner (a session or a task) share its directory, so cwd is no longer unique.
  const legacy=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_shadow_context_paths'").get() as {sql:string}|undefined;
  const shared=legacy?.sql.includes("cwd TEXT UNIQUE")===true;
  if(shared)db.exec(`BEGIN; DROP TRIGGER IF EXISTS worker_shadow_context_path_immutable;
   ALTER TABLE worker_shadow_context_paths RENAME TO worker_shadow_context_paths_v1;`);
  db.exec(`CREATE TABLE IF NOT EXISTS worker_shadow_layouts (
   shadow_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, home TEXT UNIQUE NOT NULL, runners TEXT UNIQUE NOT NULL);
   CREATE TABLE IF NOT EXISTS worker_shadow_context_paths (
   context_id TEXT PRIMARY KEY, shadow_id TEXT NOT NULL REFERENCES worker_shadow_layouts(shadow_id), cwd TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS worker_shadow_layout_immutable BEFORE UPDATE ON worker_shadow_layouts
   BEGIN SELECT RAISE(ABORT,'shadow_layout_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS worker_shadow_context_path_immutable BEFORE UPDATE ON worker_shadow_context_paths
   BEGIN SELECT RAISE(ABORT,'shadow_context_path_immutable'); END;`);
  if(shared)db.exec(`INSERT INTO worker_shadow_context_paths SELECT context_id,shadow_id,cwd FROM worker_shadow_context_paths_v1;
   DROP TABLE worker_shadow_context_paths_v1; COMMIT;`);
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
   return {...scope,home:CONTAINER_HOME,homeSource:home,runners:join(CONTAINER_HOME,"runners"),runnersSource:runners,resourceRoot,credentials:join(resourceRoot,"credentials")};
  });
 }

 /**
  * Forget a deleted Shadow: drop its layout, context and preparation records and return
  * the HOME and resource directories the caller must delete.
  */
 remove(scope:ResourceScope):string[] {
  const directories=this.directories(scope);
  transaction(this.db,()=>{
   const tables=new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
   const contexts="SELECT context_id FROM worker_shadow_context_paths WHERE shadow_id=?";
   for(const table of ["worker_contexts","worker_context_projects"])
    if(tables.has(table))this.db.prepare(`DELETE FROM ${table} WHERE context_id IN (${contexts})`).run(scope.shadowId);
   if(tables.has("worker_shadow_preparations"))this.db.prepare("DELETE FROM worker_shadow_preparations WHERE shadow_id=?").run(scope.shadowId);
   this.db.prepare("DELETE FROM worker_shadow_context_paths WHERE shadow_id=?").run(scope.shadowId);
   this.db.prepare("DELETE FROM worker_shadow_layouts WHERE shadow_id=? AND agent_id=?").run(scope.shadowId,scope.agentId);
  });
  return directories;
 }

 /** A Shadow's HOME and resource directories on this Worker. */
 directories(scope:ResourceScope):string[] {
  return [join(this.root,"agents",scope.agentId,"shadows",scope.shadowId),this.resourceRoot(scope)];
 }

 /** Shadows with a HOME layout here, whether or not an environment still exists. */
 scopes():ResourceScope[] {
  return this.db.prepare("SELECT agent_id AS agentId,shadow_id AS shadowId FROM worker_shadow_layouts").all() as ResourceScope[];
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

 /**
  * Context IDs stay bound to their original Shadow and directory across restarts. A new
  * context gets `runners/<directory>`: its owner's directory (`session-<id>`, `task-<id>`),
  * shared with the owner's other contexts, e.g. after a switch from Codex to Claude.
  * Without one it is named after the context, as contexts created before were.
  */
 context(scope:ResourceScope,contextId:string,directory=contextId):{layout:ShadowLayout;cwd:string;containerCwd:string} {
  validateId(contextId);validateId(directory);
  return transaction(this.db,()=>{
   if(!this.db.prepare("SELECT 1 FROM worker_shadow_layouts WHERE shadow_id=?").get(scope.shadowId))
    throw new ExecutionError(409,"shadow_layout_missing");
   const layout=this.ensure(scope);
   const prior=this.db.prepare("SELECT shadow_id,cwd FROM worker_shadow_context_paths WHERE context_id=?").get(contextId) as {shadow_id:string;cwd:string}|undefined;
   if(prior && (prior.shadow_id!==scope.shadowId || dirname(prior.cwd)!==layout.runnersSource))throw new ExecutionError(409,"context_shadow_conflict");
   const cwd=prior?.cwd ?? join(layout.runnersSource,directory);
   if(prior && !stat(cwd))throw new ExecutionError(409,"context_storage_missing");
   safeDirectory(layout.runnersSource,cwd);
   this.db.prepare("INSERT OR IGNORE INTO worker_shadow_context_paths VALUES (?,?,?)").run(contextId,scope.shadowId,cwd);
   return {layout,cwd,containerCwd:containerPath(layout,cwd)};
  });
 }
}

/** Where the container sees a path under the Shadow's HOME on this host. */
export function containerPath(layout:Pick<ShadowLayout,"home"|"homeSource">,hostPath:string):string {
 const rel=relative(layout.homeSource,hostPath);
 if(rel==="..")throw new ExecutionError(409,"shadow_directory_unsafe");
 if(rel.startsWith(".."+sep) || rel.startsWith("/"))throw new ExecutionError(409,"shadow_directory_unsafe");
 return rel ? join(layout.home,rel) : layout.home;
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
