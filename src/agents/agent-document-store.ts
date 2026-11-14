import {createHash,randomUUID} from "node:crypto";
import {closeSync,fsyncSync,openSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {eq} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {agentDocumentRevisions,agentShadows,lunaAgents} from "@/data/schema";
import {AgentError,AgentStore,type AgentScope} from "./agent-store";
import {TaskScopeResolver} from "./task-scope";

type Kind="memory"|"persona";
export interface DocumentSnapshot {revision:string|null; files:Readonly<Record<string,string>>; updatedAt:number|null}
export class DocumentConflictError extends AgentError {
 constructor(readonly currentRevision:string|null){super("document_revision_conflict",409);}
}

/** Scoped immutable files and compare-and-swap pointers. Never overwrites a mounted revision. */
export class AgentDocumentStore {
 constructor(private readonly db:DrizzleDB,private readonly home:string){}

 memory(actor:string,agentId:string):DocumentSnapshot {
  this.authorizeMemory(actor,agentId);
  return this.current("memory",agentId,null);
 }
 persona(actor:string,scope:AgentScope):DocumentSnapshot {
  this.authorizePersona(actor,scope);
  return this.current("persona",scope.agentId,scope.shadowId);
 }
 writeMemory(actor:string,agentId:string,input:{expectedRevision:string|null;path:string;content:string}):DocumentSnapshot {
  this.authorizeMemory(actor,agentId);
  validMemoryPath(input.path);
  return this.write(actor,"memory",agentId,null,input.expectedRevision,files=>({...files,[input.path]:input.content}));
 }
 /** Import reviewed long-term files as the Agent's first memory revision. */
 initializeMemory(actor:string,agentId:string,files:Readonly<Record<string,string>>):DocumentSnapshot {
  new AgentStore(this.db).requireOwner(actor,agentId);
  for(const path of Object.keys(files)) validMemoryPath(path);
  return this.write(actor,"memory",agentId,null,null,()=>({...files}));
 }

 writePersona(actor:string,scope:AgentScope,input:{expectedRevision:string;user:string;soul:string}):DocumentSnapshot {
  this.authorizePersona(actor,scope);
  return this.write(actor,"persona",scope.agentId,scope.shadowId,input.expectedRevision,()=>({"USER.md":input.user,"SOUL.md":input.soul}));
 }

 /** Internal execution preparation; caller has already authorized the invocation owner. */
 execution(scope:AgentScope):{memory:DocumentSnapshot;persona:DocumentSnapshot} {
  new TaskScopeResolver(this.db).active(scope);
  return {memory:this.current("memory",scope.agentId,null),persona:this.current("persona",scope.agentId,scope.shadowId)};
 }

 /** Internal resource preparation must supply its separately authorized scope and exact revision. */
 snapshot(kind:Kind,agentId:string,shadowId:string|null,revision:string):DocumentSnapshot {
  const row=this.db.select().from(agentDocumentRevisions).where(eq(agentDocumentRevisions.id,revision)).get();
  if(!row || row.agentId!==agentId || row.shadowId!==shadowId || row.kind!==kind) throw new AgentError("document_revision_not_found",404);
  const files=canonicalFiles(row.files);
  if(digest(kind,agentId,shadowId,files)!==revision) throw new AgentError("document_integrity_error",409);
  this.verify(this.directory(kind,agentId,shadowId,revision),files);
  return {revision,files,updatedAt:row.createdAt};
 }

 private current(kind:Kind,agentId:string,shadowId:string|null):DocumentSnapshot {
  const store=new AgentStore(this.db),agent=store.get(agentId);
  const shadow=shadowId===null ? null : store.shadow(shadowId);
  if(shadow && shadow.agentId!==agentId) throw new AgentError("scope_mismatch",409);
  const revision=kind==="memory" ? agent.memoryRevision : shadow!.configRevision;
  if(revision) return this.snapshot(kind,agentId,shadowId,revision);
  const files=kind==="memory" ? {} : {"USER.md":"","SOUL.md":""};
  return {revision:kind==="memory" ? null : digest(kind,agentId,shadowId,canonicalFiles(files)),files,updatedAt:null};
 }
 private write(actor:string,kind:Kind,agentId:string,shadowId:string|null,expected:string|null,change:(files:Readonly<Record<string,string>>)=>Record<string,string>):DocumentSnapshot {
  return this.db.transaction(()=>{
   if(kind==="memory") this.authorizeMemory(actor,agentId);
   else this.authorizePersona(actor,{agentId,shadowId:shadowId!});
   const current=this.current(kind,agentId,shadowId);
   if(current.revision!==expected) throw new DocumentConflictError(current.revision);
   const files=canonicalFiles(change(current.files));
   const revision=digest(kind,agentId,shadowId,files);
   if(current.revision===revision && current.updatedAt!==null) return current;
   this.publish(this.directory(kind,agentId,shadowId,revision),files);
   const now=Date.now();
   this.db.insert(agentDocumentRevisions).values({id:revision,agentId,shadowId,kind,files,authorUserId:actor,parentRevision:current.revision,createdAt:now}).onConflictDoNothing().run();
   if(kind==="memory") this.db.update(lunaAgents).set({memoryRevision:revision,updatedAt:now}).where(eq(lunaAgents.id,agentId)).run();
   else this.db.update(agentShadows).set({configRevision:revision,updatedAt:now}).where(eq(agentShadows.id,shadowId!)).run();
   return this.snapshot(kind,agentId,shadowId,revision);
  });
 }
 private authorizeMemory(actor:string,agentId:string):void {
  const agents = new AgentStore(this.db);
  agents.requireOwner(actor, agentId);
  agents.requireAccess(actor, agentId);
 }
 private authorizePersona(actor:string,scope:AgentScope):void {
  const store=new AgentStore(this.db);
  store.requireOwner(actor,scope.agentId);
  const shadow=store.shadow(scope.shadowId);
  if(shadow.agentId!==scope.agentId) throw new AgentError("scope_mismatch",409);
  if(shadow.status==="deleted") throw new AgentError("shadow_deleted",409);
 }
 private directory(kind:Kind,agentId:string,shadowId:string|null,revision:string):string {
  for(const id of [agentId,...(shadowId ? [shadowId] : []),revision]) if(!/^[A-Za-z0-9_-]+$/.test(id)) throw new AgentError("document_scope_path_invalid",400);
  const home=realpathSync(this.home);
  const parts=kind==="memory" ? ["agents",agentId,"memory",revision] : ["agents",agentId,"shadow-resources",shadowId!,"config",revision];
  let path=home;
  for(const part of parts){path=join(path,part);if(existsSync(path) || isSymlink(path)) {
   const stat=lstatSync(path);if(stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentError("document_path_unsafe",409);
  }}
  return path;
 }
 private publish(destination:string,files:Readonly<Record<string,string>>):void {
  if(existsSync(destination)){this.verify(destination,files);return;}
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const temp=join(dirname(destination),`.pending-${randomUUID()}`);
  mkdirSync(temp,{mode:0o700});
  try {
   for(const [path,content] of Object.entries(files)){
    const target=join(temp,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});
    const fd=openSync(target,"wx",0o400);
    try{writeFileSync(fd,content,"utf8");fsyncSync(fd);}finally{closeSync(fd);}
   }
   this.verify(temp,files);
   syncDirectories(temp);
   renameSync(temp,destination);
   const home=realpathSync(this.home);
   for(let parent=dirname(destination);;parent=dirname(parent)){
    syncDirectory(parent);if(parent===home) break;
    if(parent===dirname(parent)) throw new AgentError("document_path_unsafe",409);
   }
  } finally {rmSync(temp,{recursive:true,force:true});}
 }
 private verify(root:string,files:Readonly<Record<string,string>>):void {
  const found:Record<string,string>={};
  const walk=(directory:string,prefix:string)=>{
   if(lstatSync(directory).isSymbolicLink()) throw new AgentError("document_path_unsafe",409);
   for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=prefix+entry.name,full=join(directory,entry.name);
    if(entry.isSymbolicLink()) throw new AgentError("document_path_unsafe",409);
    if(entry.isDirectory()) walk(full,path+"/");
    else if(entry.isFile()) found[path]=readFileSync(full,"utf8");
    else throw new AgentError("document_path_unsafe",409);
   }
  };
  walk(root,"");
  if(JSON.stringify(canonicalFiles(found))!==JSON.stringify(files)) throw new AgentError("document_integrity_error",409);
 }
}
function isSymlink(path:string):boolean {try{return lstatSync(path).isSymbolicLink();}catch{return false;}}
function validMemoryPath(path:string):void {
 validPath(path);
 if(["USER.MD","SOUL.MD","MAIN.MD","TASK.MD","WORK.MD"].includes(path.toUpperCase())) throw new AgentError("reserved_memory_path",400);
}
function validPath(path:string):void {
 if(path.length>240 || path.split("/").some(part=>!part || part==="." || part===".." || /[\\:\x00-\x1f\x7f]/.test(part))) throw new AgentError("memory_path_invalid",400);
}
function canonicalFiles(files:Readonly<Record<string,string>>):Record<string,string> {
 const entries=Object.entries(files).sort(([a],[b])=>a<b ? -1 : a>b ? 1 : 0);let size=0;
 if(entries.length>256) throw new AgentError("document_too_large",400);
 for(const [path,content] of entries){validPath(path);
  if(entries.some(([other])=>other!==path && path.startsWith(other+"/"))) throw new AgentError("memory_path_conflict",400);if(typeof content!=="string") throw new AgentError("document_content_invalid",400);size+=Buffer.byteLength(content);}
 if(size>8*1024*1024) throw new AgentError("document_too_large",400);
 return Object.fromEntries(entries);
}
function digest(kind:Kind,agentId:string,shadowId:string|null,files:Readonly<Record<string,string>>):string {
 return createHash("sha256").update(JSON.stringify({kind,agentId,shadowId,files})).digest("hex");
}

function syncDirectory(path:string):void {const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectories(path:string):void {
 for(const entry of readdirSync(path,{withFileTypes:true})) if(entry.isDirectory()) syncDirectories(join(path,entry.name));
 syncDirectory(path);
}
