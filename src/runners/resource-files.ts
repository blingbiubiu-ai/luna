import {lstatSync,readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import type {ResourceFile} from "@luna/host-runtime/runner-resources";

/** Explicit source trees only. Never traverses symlinks or reads a whole Service HOME. */
export class ResourceFiles {
 readonly files:ResourceFile[]=[];
 private bytes=0;
 add(path:string,content:string|Buffer,mode=0o644):void {
  const data=Buffer.isBuffer(content) ? content : Buffer.from(content);
  this.check(data.length);this.bytes+=data.length;
  this.files.push({path,content:data.toString("base64"),mode});
 }
 file(source:string,target:string,mode?:number):void {
  const stat=lstatSync(source);
  if(!stat.isFile() || stat.isSymbolicLink())throw new Error("Unsafe runner resource source");
  this.check(stat.size);
  this.add(target,readFileSync(source),mode ?? (stat.mode&0o111 ? 0o755 : 0o644));
 }
 tree(source:string,target:string):void {
  const stat=lstatSync(source);
  if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error("Unsafe runner resource source");
  for(const entry of readdirSync(source,{withFileTypes:true}).sort((a,b)=>a.name<b.name ? -1 : a.name>b.name ? 1 : 0)){
   if(entry.isSymbolicLink())throw new Error("Unsafe runner resource source");
   if(entry.isDirectory())this.tree(join(source,entry.name),`${target}/${entry.name}`);
   else this.file(join(source,entry.name),`${target}/${entry.name}`);
  }
 }
 private check(size:number):void {
  if(this.bytes+size>128*1024*1024 || this.files.length>=20000)throw new Error("Runner resources exceed limit");
 }
}
