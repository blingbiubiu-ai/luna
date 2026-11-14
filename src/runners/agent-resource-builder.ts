import {dirname,resolve} from "node:path";
import type {DrizzleDB} from "@/data";
import {AgentDocumentStore} from "@/agents/agent-document-store";
import {AgentStore,type AgentScope} from "@/agents/agent-store";
import {AgentPluginStore} from "@/plugins/agent-plugin-store";
import type {PluginRegistry} from "@/plugins/registry";
import {resolveBundledSkillsRoot} from "./runner-root-layout";
import {resolvePromptAssetsRoot} from "./runner-prompts";
import {ResourceFiles} from "./resource-files";
import {createScopedResources,type ScopedResourceBundle} from "@luna/host-runtime/scoped-runner-resources";

export interface AgentResourceSources {
 /** Platform-controlled, non-secret distribution assets; no generated global resource directory. */
 bundledSkillsDirectory:string;
 promptAssetsDirectory:string;
 repoRoot:string;
}
/** Captures documents and enabled plugin contributions together; secrets/config remain in Service. */
export class AgentResourceBuilder {
 constructor(private readonly db:DrizzleDB,private readonly home:string,private readonly registry:PluginRegistry,
  private readonly sources:AgentResourceSources={bundledSkillsDirectory:resolveBundledSkillsRoot(),promptAssetsDirectory:resolvePromptAssetsRoot(),repoRoot:process.cwd()}){}

 capture(actorUserId:string,scope:AgentScope):ScopedResourceBundle {
  return this.db.transaction(()=>{
   new AgentStore(this.db).requireScope(actorUserId,scope);
   const documents=new AgentDocumentStore(this.db,this.home).execution(scope);
   const plugins=new AgentPluginStore(this.db,this.registry).enabledResources(scope.agentId);
   const files=new ResourceFiles();
   files.tree(this.sources.bundledSkillsDirectory,"public/skills");
   files.tree(this.sources.promptAssetsDirectory,"public/prompts");
   for(const [path,content] of Object.entries(documents.memory.files))files.add(`agent/memory/${path}`,content);
   for(const [path,content] of Object.entries(documents.persona.files))files.add(`shadow/config/${path}`,content);
   const catalog=plugins.map(({manifest,configRevision})=>{
    for(const skill of manifest.skills??[]){
     const id=directoryName(skill.id);
     if(files.files.some(file=>file.path.toLowerCase().startsWith(`public/skills/${id.toLowerCase()}/`)))throw new Error("Duplicate bundled/plugin skill");
     if(skill.path!==undefined){
      const source=resolve(this.sources.repoRoot,skill.path);
      files.tree(dirname(source),`agent/tools/skills/${id}`);
      // A contribution may name a nonstandard markdown file; mount it as SKILL.md.
      if(!source.endsWith("/SKILL.md"))files.file(source,`agent/tools/skills/${id}/SKILL.md`);
     }else if(skill.description!==undefined){
      files.add(`agent/tools/skills/${id}/SKILL.md`,["---",`name: ${JSON.stringify(skill.title??skill.id)}`,`description: ${JSON.stringify(skill.description)}`,"---",""] .join("\n"));
     }
    }
    for(const command of manifest.containerCommands??[]){
     const binary=directoryName(command.binary);
     files.file(resolve(this.sources.repoRoot,command.shimScript),`agent/tools/commands/${binary}`,0o755);
     if(command.runtimeDirectory!==undefined) files.tree(resolve(this.sources.repoRoot,command.runtimeDirectory),`agent/tools/commands/.runtime/${binary}`);
    }
    // Whitelist metadata: neither installation config nor Agent secrets/config are serialized.
    return {id:manifest.id,version:manifest.version,configRevision,tools:manifest.tools??[],commands:manifest.commands??[],
     skills:(manifest.skills??[]).map(skill=>({id:skill.id,title:skill.title,description:skill.description})),
     binaries:(manifest.containerCommands??[]).map(command=>command.binary)};
   });
   files.add("agent/tools/catalog.json",canonicalJson(catalog));
   return createScopedResources(scope,files.files);
  });
 }
}
function directoryName(value:string):string {
 if(!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value))throw new Error("Unsafe runner contribution name");
 return value;
}
function canonicalJson(value:unknown):string {
 return JSON.stringify(value,(_key,item)=>item && typeof item==="object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b ? -1 : a>b ? 1 : 0)) : item);
}
