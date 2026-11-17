import {createHash} from "node:crypto";
import type {ResourceFile} from "./runner-resources";

export interface ResourceScope {agentId:string;shadowId:string}
export interface ResourceSelection {
 publicRevision:string;
 agentToolsRevision:string;
 digest:string;
}
export interface ScopedResourceBundle extends ResourceScope {
 version:2;
 selection:ResourceSelection;
 files:ResourceFile[];
}
const parts=["public","agent/tools"] as const;
const selectionKeys=["publicRevision","agentToolsRevision","digest"] as const;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const compare=(a:string,b:string)=>a<b ? -1 : a>b ? 1 : 0;
function exact(value:unknown,keys:readonly string[]): asserts value is Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) throw new Error("Invalid resource fields");
}
function validateScope(scope:ResourceScope):void {
 for(const id of [scope.agentId,scope.shadowId]) if(typeof id!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid resource scope");
}
function canonicalFiles(input:unknown):ResourceFile[] {
 if(!Array.isArray(input) || input.length>20000) throw new Error("Invalid resource files");
 let bytes=0;
 const paths=new Set<string>(),directories=new Map<string,string>();
 const files:ResourceFile[]=[];
 for(const entry of input){
  exact(entry,["path","content","mode"]);
  const {path,content,mode}=entry;
  if(typeof path!=="string" || path.length>4096 || path.normalize("NFC")!==path || /[\\\x00-\x1f\x7f]/.test(path)
   || path.split("/").some(p=>!p || p==="." || p==="..") || !parts.some(part=>path.startsWith(part+"/"))
   || typeof content!=="string" || content.length>Math.ceil(128*1024*1024/3)*4 || (mode!==0o644 && mode!==0o755)) throw new Error("Invalid resource entry");
  const decoded=Buffer.from(content,"base64");
  if(decoded.toString("base64")!==content) throw new Error("Invalid resource encoding");
  bytes+=decoded.length;
  if(bytes>128*1024*1024) throw new Error("Runner resources exceed limit");
  // Workers may use case-insensitive filesystems; reject aliases on every host.
  const key=path.toLowerCase(),parents=path.split("/");parents.pop();
  if(paths.has(key) || directories.has(key)) throw new Error("Conflicting resource path");
  while(parents.length){
   const parent=parents.join("/"),folded=parent.toLowerCase();
   if(paths.has(folded) || (directories.has(folded) && directories.get(folded)!==parent)) throw new Error("Conflicting resource path");
   directories.set(folded,parent);parents.pop();
  }
  paths.add(key);files.push({path,content,mode});
 }
 return files.sort((a,b)=>compare(a.path,b.path));
}

/** Build only from explicitly selected, non-secret resources, never from a whole Service HOME. */
export function createScopedResources(scope:ResourceScope,input:ResourceFile[]):ScopedResourceBundle {
 validateScope(scope);
 const files=canonicalFiles(input);
 const revision=(part:typeof parts[number],identity:unknown)=>hash({version:2,part,scope:identity,files:files.filter(f=>f.path.startsWith(part+"/"))});
 const revisions={
  publicRevision:revision("public",null),
  agentToolsRevision:revision("agent/tools",{agentId:scope.agentId}),
 };
 const selection={...revisions,digest:hash({version:2,agentId:scope.agentId,shadowId:scope.shadowId,...revisions})};
 return {version:2,agentId:scope.agentId,shadowId:scope.shadowId,selection,files};
}

/** Both expected values come from authenticated placement/admission, not from the download itself. */
export function validateScopedResources(input:unknown,scope:ResourceScope,expected:ResourceSelection):ScopedResourceBundle {
 validateScope(scope);
 exact(input,["version","agentId","shadowId","selection","files"]);
 if(input.version!==2) throw new Error("Unsupported resource protocol");
 if(input.agentId!==scope.agentId || input.shadowId!==scope.shadowId) throw new Error("Resource scope mismatch");
 exact(input.selection,selectionKeys);exact(expected,selectionKeys);
 const result=createScopedResources(scope,input.files as ResourceFile[]);
 for(const key of selectionKeys){
  if(input.selection[key]!==result.selection[key]) throw new Error("Resource digest mismatch");
  if(expected[key]!==result.selection[key]) throw new Error("Resource selection mismatch");
 }
 return result;
}
