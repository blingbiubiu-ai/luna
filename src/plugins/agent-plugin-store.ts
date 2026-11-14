import {randomUUID} from "node:crypto";
import {and,eq} from "drizzle-orm";
import {z} from "zod";
import type {DrizzleDB} from "@/data";
import {agentPluginConfigs} from "@/data/schema";
import {AgentError,AgentStore} from "@/agents/agent-store";
import {AgentSecretCipher,type EncryptedSecret} from "@/agent-config/secret-cipher";
import type {PluginRegistry} from "./registry";

export const agentPluginWrite=z.object({expectedRevision:z.string().nullable(),enabled:z.boolean(),config:z.record(z.string(),z.json()),
 secrets:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),z.string().min(1).nullable()).default({})}).strict();
export class PluginConfigConflictError extends AgentError {
 constructor(readonly currentRevision:string|null){super("plugin_config_conflict",409);}
}

/** No fallback to installation config or process environment secrets for Agent execution. */
export class AgentPluginStore {
 constructor(private readonly db:DrizzleDB,private readonly registry:PluginRegistry,private readonly cipher=AgentSecretCipher.tryFromEnvironment()){}
 list(actor: string, agentId: string) {
  new AgentStore(this.db).requireOwner(actor, agentId);
  const enabled = new Set(this.db.select({ id: agentPluginConfigs.pluginId }).from(agentPluginConfigs)
   .where(and(eq(agentPluginConfigs.agentId, agentId), eq(agentPluginConfigs.enabled, true))).all().map(row => row.id));
  return this.registry.listPlugins().map(({ manifest }) => ({
   id: manifest.id, name: manifest.displayName, version: manifest.version,
   supported: manifest.agentScopeVersion === 2, enabled: enabled.has(manifest.id),
  })).sort((a, b) => a.name.localeCompare(b.name));
 }
 get(actor:string,agentId:string,pluginId:string){
  new AgentStore(this.db).requireOwner(actor,agentId);
  const row=this.row(agentId,pluginId);
  return row ? {agentId,pluginId,revision:row.revision,enabled:row.enabled,config:row.config,secretKeys:Object.keys(row.secrets).sort(),updatedAt:row.updatedAt} :
    {agentId,pluginId,revision:null,enabled:false,config:{},secretKeys:[],updatedAt:null};
 }
 put(actor:string,agentId:string,pluginId:string,raw:z.input<typeof agentPluginWrite>){
  const input=agentPluginWrite.parse(raw);
  return this.db.transaction(()=>{
   new AgentStore(this.db).requireOwner(actor,agentId);
   const plugin=this.registry.getPlugin(pluginId);
   if(!plugin) throw new AgentError("plugin_not_installed",404);
   if(input.enabled && plugin.manifest.agentScopeVersion!==2) throw new AgentError("plugin_scope_unsupported",409);
   const previous=this.row(agentId,pluginId);
   if((previous?.revision??null)!==input.expectedRevision)throw new PluginConfigConflictError(previous?.revision??null);
   const revision=randomUUID(),secrets:Record<string,EncryptedSecret & {revision:string}>=Object.create(null);
   const keys=new Set([...Object.keys(previous?.secrets??{}),...Object.keys(input.secrets)]);
   for(const key of keys){
    if(input.secrets[key]===null)continue;
    const replacement=input.secrets[key];
    if(replacement===undefined){if(previous?.secrets[key])secrets[key]=previous.secrets[key]!;continue;}
    if(!this.cipher)throw new AgentError("plugin_secret_key_unavailable",409);
    secrets[key]={...this.cipher.encrypt({...this.binding(agentId,pluginId,revision,key),plaintext:replacement}),revision};
   }
   const values={agentId,pluginId,revision,enabled:input.enabled,config:input.config,secrets:{...secrets},updatedBy:actor,updatedAt:Date.now()};
   this.db.insert(agentPluginConfigs).values(values).onConflictDoUpdate({target:[agentPluginConfigs.agentId,agentPluginConfigs.pluginId],set:values}).run();
   return this.get(actor,agentId,pluginId);
  });
 }
 requireEnabled(agentId:string,pluginId:string){
  if(new AgentStore(this.db).get(agentId).status!=="active")throw new AgentError("agent_disabled",409);
  if(this.registry.getPlugin(pluginId)?.manifest.agentScopeVersion!==2)throw new AgentError("plugin_scope_unsupported",409);
  const row=this.row(agentId,pluginId);
  if(!row?.enabled)throw new AgentError("agent_plugin_disabled",403);
  return row;
 }
 /** Resource publication includes only audited, enabled plugins and opaque config revisions. */
 enabledResources(agentId:string){
  if(new AgentStore(this.db).get(agentId).status!=="active")throw new AgentError("agent_disabled",409);
  return this.db.select({pluginId:agentPluginConfigs.pluginId,revision:agentPluginConfigs.revision})
   .from(agentPluginConfigs).where(and(eq(agentPluginConfigs.agentId,agentId),eq(agentPluginConfigs.enabled,true))).all()
   .sort((a,b)=>a.pluginId<b.pluginId ? -1 : a.pluginId>b.pluginId ? 1 : 0)
   .map(row=>{
    const plugin=this.registry.getPlugin(row.pluginId);
    if(!plugin)throw new AgentError("plugin_not_installed",409);
    if(plugin.manifest.agentScopeVersion!==2)throw new AgentError("plugin_scope_unsupported",409);
    return {manifest:plugin.manifest,configRevision:row.revision};
   });
 }
 secret(agentId:string,pluginId:string,revision:string,key:string):string|undefined {
  const row=this.requireEnabled(agentId,pluginId);
  if(row.revision!==revision)throw new AgentError("plugin_config_changed",409);
  const encrypted=Object.hasOwn(row.secrets,key) ? row.secrets[key] : undefined;if(!encrypted)return undefined;
  if(!this.cipher)throw new AgentError("plugin_secret_key_unavailable",409);
  return this.cipher.decrypt({...encrypted,...this.binding(agentId,pluginId,encrypted.revision,key)});
 }
 private row(agentId:string,pluginId:string){return this.db.select().from(agentPluginConfigs).where(and(eq(agentPluginConfigs.agentId,agentId),eq(agentPluginConfigs.pluginId,pluginId))).get();}
 private binding(agentId:string,pluginId:string,revision:string,key:string){return {profileId:`plugin:${agentId}:${pluginId}`,revisionId:revision,key};}
}
