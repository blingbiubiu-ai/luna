import {ShadowPreparationStore} from "./shadow-preparation-store";
import {lstatSync,mkdirSync,writeFileSync,renameSync,rmSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {ExecutionError,type SqlDatabase} from "@luna/execution-store";
import {WorkerContextPreparation,WorkerPreparedContext} from "@luna/runner-protocol";
import {ensureRunnerWorkspaceInstructionFiles} from "@luna/host-runtime/runner-instructions";
import {WorkerResourceDownload} from "./resource-download";
import {WorkerShadowLayouts} from "./shadow-layout";
import {WorkerShadowMounts} from "./shadow-mounts";
import {rootHostCheck} from "./root-host";

/** Durable preparation ownership prevents concurrent requests from rewriting a pinned context. */
export class ShadowPreparation {
 readonly store:ShadowPreparationStore;
 private readonly download:WorkerResourceDownload;
 private readonly layouts:WorkerShadowLayouts;
 private readonly mounts:WorkerShadowMounts;
 private readonly busy=new Set<string>();
 constructor(private readonly db:SqlDatabase,home:string,private readonly workerId:string,
  private readonly origin:string,token:string){
  this.download=new WorkerResourceDownload(home,origin,token);
  this.layouts=new WorkerShadowLayouts(db,home);this.mounts=new WorkerShadowMounts(db,home);
  this.store=new ShadowPreparationStore(db);
 }
 async prepare(raw:unknown){
  const parsed=WorkerContextPreparation.safeParse(raw);
  if(!parsed.success)throw new ExecutionError(422,"invalid_context_preparation");
  const input=parsed.data,key=input.scope.shadowId;
  if(input.runnerId!==input.contextId)throw new ExecutionError(409,"runner_context_mismatch");
  if(this.busy.has(key))throw new ExecutionError(503,"shadow_preparation_busy");
  this.busy.add(key);
  try{
   this.store.begin(input);
   // Repeat authorization even after a lost reply; cached bytes are not an access grant.
   await this.download.sync(input.scope,input.resources);
   const prior=this.store.requireLive(input.invocationId);
   const plan=this.mounts.prepare(input.scope,input.resources),{cwd}=this.layouts.context(input.scope,input.contextId);
   if(prior.state==="prepared" && prior.reply){
    const reply=WorkerPreparedContext.parse(JSON.parse(prior.reply));
    return {...reply,env:{LUNA_SERVICE_URL:this.origin}};
   }
   for(const directory of ["workspace",".luna"]){
    const path=join(cwd,directory),info=lstatSync(path,{throwIfNoEntry:false});
    if(info && (!info.isDirectory() || info.isSymbolicLink()))throw new ExecutionError(409,"invalid_context_target");
    if(!info)mkdirSync(path,{mode:0o700});
   }
   for(const name of ["AGENTS.md","CLAUDE.md",".luna/runner-context.json"]){
    const info=lstatSync(join(cwd,name),{throwIfNoEntry:false});
    if(info && (!info.isFile() || info.isSymbolicLink() || info.nlink!==1))throw new ExecutionError(409,"invalid_context_target");
   }
   const rendered=ensureRunnerWorkspaceInstructionFiles({home:plan.layout.home,promptsRoot:join(plan.resourceSource,"prompts"),
    runnerRootPath:cwd,runnerKind:input.runnerKind,previousFingerprint:null,
    // The rules accompany the Shadow switch only where this host lets the container use sudo.
    runnerSudo:input.rootAccess===true && rootHostCheck(plan.layout.homeSource).allowed});
   const target=join(cwd,".luna/runner-context.json"),temp=join(cwd,".luna",`.context-${randomUUID()}`);
   try{writeFileSync(temp,JSON.stringify(input.context??{},null,2)+"\n",{flag:"wx",mode:0o600});renameSync(temp,target);}
   finally{rmSync(temp,{force:true});}
   const reply=WorkerPreparedContext.parse({protocolVersion:2,scope:input.scope,resources:input.resources,workerId:this.workerId,
    home:plan.layout.home,cwd,instructionFingerprint:rendered.instructionFingerprint,resourceRevision:input.resources.digest,
    env:{LUNA_SERVICE_URL:this.origin}});
   this.store.complete(input.invocationId,reply);
   return reply;
  }finally{this.busy.delete(key);}
 }
}
