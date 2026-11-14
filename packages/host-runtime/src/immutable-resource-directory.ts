import {randomUUID} from "node:crypto";
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,sep} from "node:path";

export interface ImmutableResourceFile {path:string;content:Buffer;mode:0o400|0o444|0o555}
/** Shared atomic publication for downloaded bytes and derived read-only mount trees. */
export class ImmutableResourceDirectory {
 readonly root:string;
 constructor(home:string){this.root=realpathSync(home);}
 directory(relative:string):string {
  validPath(relative);let path=this.root;
  for(const part of relative.split("/")){
   path=join(path,part);const info=stat(path);
   if(info && (!info.isDirectory() || info.isSymbolicLink()))throw new Error("Unsafe resource directory");
  }
  return path;
 }
 publish(relative:string,files:readonly ImmutableResourceFile[],emptyDirectories:readonly string[]=[],rootMode=0o700):string {
  const destination=this.directory(relative);const directories=treeDirectories(files,emptyDirectories);
  if(stat(destination)){this.verify(relative,files,emptyDirectories);return destination;}
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const temp=join(dirname(destination),`.pending-${randomUUID()}`);mkdirSync(temp,{mode:rootMode});
  try{
   for(const directory of [...directories].sort())mkdirSync(join(temp,directory),{recursive:true,mode:0o755});
   for(const file of files){
    const fd=openSync(join(temp,file.path),"wx",file.mode);
    try{writeFileSync(fd,file.content);fsyncSync(fd);}finally{closeSync(fd);}
   }
   syncTree(temp);
   try{renameSync(temp,destination);}catch(error){if(!stat(destination))throw error;this.verify(relative,files,emptyDirectories);}
   for(let parent=dirname(destination);;parent=dirname(parent)){syncDirectory(parent);if(parent===this.root)break;}
   this.verify(relative,files,emptyDirectories);return destination;
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
 verify(relative:string,files:readonly ImmutableResourceFile[],emptyDirectories:readonly string[]=[]):void {
  const root=this.directory(relative),directories=treeDirectories(files,emptyDirectories),expected=new Map(files.map(file=>[file.path,file]));
  const visit=(path:string,prefix:string)=>{
   const directory=lstatSync(path);if(!directory.isDirectory() || directory.isSymbolicLink())throw new Error("Unsafe resource directory");
   for(const name of readdirSync(path)){
    const full=join(path,name),key=prefix+name,entry=lstatSync(full);
    if(entry.isSymbolicLink())throw new Error("Unsafe resource entry");
    if(entry.isDirectory()){
     if(!directories.delete(key))throw new Error("Resource snapshot integrity error");visit(full,key+"/");continue;
    }
    const file=expected.get(key);
    if(!entry.isFile() || !file || (entry.mode&0o777)!==file.mode || !readFileSync(full).equals(file.content))throw new Error("Resource snapshot integrity error");
    expected.delete(key);
   }
  };
  visit(root,"");if(expected.size || directories.size)throw new Error("Resource snapshot integrity error");
 }
 read(relative:string,path:string):Buffer {
  validPath(path);const root=this.directory(relative);
  let current=root;const parts=path.split("/");
  for(const part of parts){current=join(current,part);const info=lstatSync(current);if(info.isSymbolicLink())throw new Error("Unsafe resource entry");}
  if(!lstatSync(current).isFile())throw new Error("Unsafe resource entry");
  return readFileSync(current);
 }
}
function treeDirectories(files:readonly ImmutableResourceFile[],empty:readonly string[]):Set<string>{
 const directories=new Set<string>(),paths=new Set<string>();
 for(const file of files){validPath(file.path);if(paths.has(file.path))throw new Error("Duplicate resource path");paths.add(file.path);}
 for(const path of [...files.map(file=>file.path),...empty.map(path=>{validPath(path);return `${path}/placeholder`;})]){
  const parts=path.split("/");parts.pop();while(parts.length){const parent=parts.join("/");if(paths.has(parent))throw new Error("Conflicting resource path");directories.add(parent);parts.pop();}
 }
 return directories;
}
function validPath(path:string):void {if(!path || path.startsWith(sep) || /[\\\x00-\x1f]/.test(path) || path.split("/").some(part=>!part || part==="." || part===".."))throw new Error("Unsafe resource path");}
function stat(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}}
function syncDirectory(path:string):void {const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncTree(path:string):void {for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory())syncTree(join(path,entry.name));syncDirectory(path);}
