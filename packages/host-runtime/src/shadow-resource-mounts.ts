import {ScopedResourceStore} from "./scoped-resource-store";
import {ImmutableResourceDirectory,type ImmutableResourceFile} from "./immutable-resource-directory";
import type {ResourceScope,ResourceSelection} from "./scoped-runner-resources";

const roots=["skills/skills","commands","prompts","tools"] as const;
/** Deterministic union of approved public and Agent tools, outside writable HOME. */
export function materializeShadowMountSources(workerHome:string,scope:ResourceScope,selection:ResourceSelection):string {
 const bundle=new ScopedResourceStore(workerHome).read(scope,selection),files:ImmutableResourceFile[]=[];
 const paths=new Map<string,string>(),filePaths=new Set<string>();
 for(const file of bundle.files){
  let target:string|undefined;
  if(file.path==="agent/tools/catalog.json")target="tools/catalog.json";
  else for(const [source,destination] of [["public/skills/","skills/skills/"],["agent/tools/skills/","skills/skills/"],["public/commands/","commands/"],
   ["agent/tools/commands/","commands/"],["public/prompts/","prompts/"]]){
   if(file.path.startsWith(source!)){target=destination!+file.path.slice(source!.length);break;}
  }
  if(!target)throw new Error("Unsupported resource mount path");
  const key=target.toLowerCase(),parts=target.split("/");
  // Both exact file collisions and differently-cased directory aliases are invalid.
  for(let index=1;index<=parts.length;index++){
   const prefix=parts.slice(0,index).join("/"),folded=prefix.toLowerCase(),prior=paths.get(folded);
   if(prior && (prior!==prefix || index===parts.length || filePaths.has(folded)))throw new Error("Conflicting resource mount path");
   paths.set(folded,prefix);
  }
  filePaths.add(key);
  files.push({path:target,content:Buffer.from(file.content,"base64"),mode:file.mode===0o755 ? 0o555 : 0o444});
 }
 const plugin={name:"luna-skills",version:"0.0.0-"+selection.digest,description:"Skills provided by Luna"};
 for(const [path,manifest] of [
  ["skills/.claude-plugin/plugin.json",plugin],
  ["skills/.codex-plugin/plugin.json",{...plugin,skills:"./skills/"}],
  [".agents/plugins/marketplace.json",{name:"luna-platform",plugins:[{name:plugin.name,source:{source:"local",path:"./skills"}}]}],
 ] as const){
  files.push({path,content:Buffer.from(JSON.stringify(manifest)),mode:0o444});
 }
 // Version the derived layout independently: changing this mapping must not replace old mounts.
 const tree=new ImmutableResourceDirectory(workerHome);
 return tree.publish(`agents/${scope.agentId}/shadow-resources/${scope.shadowId}/mounts/v4/${selection.digest}`,files,roots,0o755);
}
