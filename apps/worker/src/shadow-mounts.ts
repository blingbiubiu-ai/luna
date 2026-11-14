import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {join,sep} from "node:path";
import {ExecutionError,type SqlDatabase} from "@luna/execution-store";
import {runnerResourcesPath} from "@luna/runner-protocol/runner-assets";
import {materializeShadowMountSources} from "@luna/host-runtime/shadow-resource-mounts";
import type {ResourceScope,ResourceSelection} from "@luna/host-runtime/scoped-runner-resources";
import {WorkerShadowLayouts,type ShadowLayout} from "./shadow-layout";

export interface ShadowBindMount {source:string;destination:string;readonly:boolean}
export interface ShadowMountPlan {layout:ShadowLayout;mounts:ShadowBindMount[];resourceSource:string}

/** Resolve only one Shadow's writable storage and its verified, fixed resource snapshot. */
export class WorkerShadowMounts {
 private readonly layouts:WorkerShadowLayouts;
 constructor(db:SqlDatabase,private readonly workerHome:string){this.layouts=new WorkerShadowLayouts(db,workerHome);}
 prepare(scope:ResourceScope,selection:ResourceSelection):ShadowMountPlan {
  // Fail before creating HOME when bytes/scope are absent, substituted or corrupt.
  const resourceSource=materializeShadowMountSources(this.workerHome,scope,selection);
  const layout=this.layouts.ensure(scope);
  const mounts:ShadowBindMount[]=[{source:layout.homeSource,destination:layout.home,readonly:false}];
  const resources=runnerResourcesPath(layout.home);
  directoryTarget(layout.homeSource,resources);
  mounts.push({source:resourceSource,destination:resources,readonly:true});
  return {layout,mounts,resourceSource};
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
