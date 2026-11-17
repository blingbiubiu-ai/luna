import {lstatSync,mkdirSync,readdirSync,readlinkSync,realpathSync,renameSync,rmdirSync,rmSync,symlinkSync} from "node:fs";
import {basename,dirname,join,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {ExecutionError,type SqlDatabase} from "@luna/execution-store";
import {runnerResourcesPath} from "@luna/runner-protocol/runner-assets";
import {materializeShadowMountSources} from "@luna/host-runtime/shadow-resource-mounts";
import type {ResourceScope,ResourceSelection} from "@luna/host-runtime/scoped-runner-resources";
import {WorkerShadowLayouts,type ShadowLayout} from "./shadow-layout";

/** All published snapshot versions of one Shadow, mounted read-only for the container's lifetime. */
export const RESOURCE_VERSIONS_DIR=".luna-resource-versions";

export interface ShadowBindMount {source:string;destination:string;readonly:boolean}
export interface ShadowMountPlan {layout:ShadowLayout;mounts:ShadowBindMount[];resourceSource:string}

/**
 * Resolve only one Shadow's writable storage and its verified snapshots.
 * The version directory is mounted once, so a new snapshot never replaces the container;
 * `$HOME/.luna-resources` is a link that `activate` points at the selected version.
 */
export class WorkerShadowMounts {
 private readonly layouts:WorkerShadowLayouts;
 constructor(db:SqlDatabase,private readonly workerHome:string){this.layouts=new WorkerShadowLayouts(db,workerHome);}
 prepare(scope:ResourceScope,selection:ResourceSelection):ShadowMountPlan {
  // Fail before creating HOME when bytes/scope are absent, substituted or corrupt.
  const resourceSource=materializeShadowMountSources(this.workerHome,scope,selection);
  const layout=this.layouts.ensure(scope);
  const versionsSource=dirname(resourceSource);
  if(!realpathSync(versionsSource).startsWith(realpathSync(layout.resourceRoot)+sep+"mounts"+sep))throw new ExecutionError(409,"shadow_mount_target_invalid");
  const versions=join(layout.home,RESOURCE_VERSIONS_DIR);
  directoryTarget(layout.homeSource,versions);
  return {layout,resourceSource,mounts:[
   {source:layout.homeSource,destination:layout.home,readonly:false},
   {source:versionsSource,destination:versions,readonly:true},
  ]};
 }

 /**
  * Point `$HOME/.luna-resources` at the plan's snapshot. Callers switch versions only while
  * the Shadow has no running Job; re-asserting the same version also repairs a Runner edit.
  */
 activate(plan:ShadowMountPlan):void {
  const home=plan.layout.homeSource,link=runnerResourcesPath(home);
  const target=join(RESOURCE_VERSIONS_DIR,basename(plan.resourceSource));
  const info=lstatSync(link,{throwIfNoEntry:false});
  if(info?.isSymbolicLink() && readlinkSync(link)===target)return;
  // The former per-version mount point is an empty directory on the host.
  if(info?.isDirectory()){
   if(readdirSync(link).length)throw new ExecutionError(409,"shadow_mount_target_invalid");
   rmdirSync(link);
  }else if(info && !info.isSymbolicLink())throw new ExecutionError(409,"shadow_mount_target_invalid");
  const temporary=join(home,`.luna-resources.${randomUUID()}`);
  try{symlinkSync(target,temporary);renameSync(temporary,link);}
  finally{rmSync(temporary,{force:true});}
 }
}

/** Never follow a Runner-created symlink when preparing a nested mount target. */
function directoryTarget(home:string,target:string):void {
 if(!target.startsWith(home+sep))throw new ExecutionError(409,"shadow_mount_target_invalid");
 let path=home;
 for(const part of target.slice(home.length+1).split(sep)){
  path=join(path,part);const info=lstatSync(path,{throwIfNoEntry:false});
  if(info && (!info.isDirectory() || info.isSymbolicLink()))throw new ExecutionError(409,"shadow_mount_target_invalid");
  if(!info)mkdirSync(path,{mode:0o755});
  if(realpathSync(path)!==path)throw new ExecutionError(409,"shadow_mount_target_invalid");
 }
}
