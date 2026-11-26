import { readFileSync } from "node:fs";
import { join } from "node:path";
import {randomUUID} from "node:crypto";
import { ModelAccountSummary, ModelProviderReference, WORKER_MODEL_PROVIDER_CAPABILITY, type WorkerModelRelease } from "@luna/runner-protocol";
import { ExecutionError } from "@luna/execution-store";
import type { DrizzleDB } from "@/data";
import { AgentStore, AgentError } from "@/agents/agent-store";
import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { AgentPluginStore,agentPluginWrite } from "@/plugins/agent-plugin-store";
import type { PluginRegistry } from "@/plugins/registry";
import type { Runtime } from "@/runtime/runtime";

export class ModelProviderService {
  private readonly plugins: AgentPluginStore;
  private readonly access: AgentWorkerAccessStore;
  private logins=new Map<string,{actor:string;agentId:string;workerId:string;pluginId:string;providerId:string;configRevision:string;callbackPath:string;expiresAt:number}>();
  constructor(private db: DrizzleDB, private registry: PluginRegistry, private runtime: () => Runtime | undefined) {
    this.plugins = new AgentPluginStore(db, registry);
    this.access = new AgentWorkerAccessStore(db,()=>this.runtime()?.config?.homeWorkerId);
  }
  callbackPaths():string[]{
    return [...new Set(["/api/model-providers/login/callback",...this.registry.listPlugins().flatMap(plugin=>
      (plugin.manifest.workerModelProviders??[]).flatMap(provider=>provider.login?.callbackPath?[provider.login.callbackPath]:[]))])];
  }
  providers(actor: string, agentId: string) {
    new AgentStore(this.db).requireOwner(actor, agentId);
    const enabled = new Map(this.plugins.list(actor, agentId).map(p => [p.id, p.enabled]));
    return this.registry.listPlugins().flatMap(plugin => (plugin.manifest.workerModelProviders ?? []).map(provider => ({
      pluginId: plugin.manifest.id, providerId: provider.id, name: provider.displayName,
      enabled: enabled.get(plugin.manifest.id) ?? false,
      loginLabel:provider.login?.label??null,protocols:provider.protocols,
    })));
  }
  workers(actor: string, agentId: string) {
    const workers = this.runtime()?.gateway?.scheduler.workers.list() ?? [];
    return this.access.list(actor, agentId).filter(row => row.status === "active")
      .map(row => { const worker = workers.find(w => w.workerId === row.workerId);
        return { workerId: row.workerId, supported: !!worker?.health?.capabilities?.includes(WORKER_MODEL_PROVIDER_CAPABILITY),
          ready: !!worker?.health?.ready && Date.now() - worker.lastSeen < 30000 && !worker.draining, paused: row.paused }; });
  }
  private context(actor: string, agentId: string, workerId: string, pluginId: string, providerId: string) {
    new AgentStore(this.db).requireOwner(actor, agentId);
    this.access.requireWorkerAccess(actor,workerId);
    if (!this.access.allowed(agentId).includes(workerId)) throw new AgentError("agent_worker_access_denied", 403);
    const config = this.plugins.requireEnabled(agentId, pluginId);
    const plugin = this.registry.getPlugin(pluginId);
    const provider = plugin?.manifest.workerModelProviders?.find(p => p.id === providerId);
    if (!plugin || !provider || !plugin.installedRelease) throw new AgentError("model_provider_not_installed", 409);
    const workers = this.runtime()?.gateway?.scheduler.workers;
    if (!workers) throw new ExecutionError(503,"worker_runtime_unavailable");
    const worker = workers.require(workerId);
    if (!worker.health?.capabilities?.includes(WORKER_MODEL_PROVIDER_CAPABILITY)) throw new AgentError("worker_model_provider_unsupported", 409);
    if (!worker.health.ready || worker.draining || Date.now() - worker.lastSeen > 30000) throw new ExecutionError(503,"worker_model_provider_unavailable");
    return { client: workers.client(workerId), plugin, provider, configRevision: config.revision };
  }
  private async install(context: ReturnType<ModelProviderService["context"]>): Promise<void> {
    const release = context.plugin.installedRelease!;
    const checksums = readFileSync(join(release.path, "checksums.json"), "utf8");
    const files = (JSON.parse(checksums) as { files: { path: string }[] }).files.map(file => ({
      path: file.path, content: readFileSync(join(release.path, file.path)).toString("base64"),
    }));
    const body: WorkerModelRelease = { pluginId: context.plugin.manifest.id, providerId: context.provider.id,
      releaseSha256: release.sha256, entrypoint: context.provider.entrypoint, checksums, files };
    await context.client.call("POST", "/v1/model-providers/install", body, AbortSignal.timeout(30000));
  }
  async account(actor: string, agentId: string, workerId: string, pluginId: string, providerId: string) {
    const context = this.context(actor, agentId, workerId, pluginId, providerId);
    const result = await context.client.call("POST", "/v1/model-providers/account", { agentId, pluginId, providerId });
    this.context(actor, agentId, workerId, pluginId, providerId);
    return result ? ModelAccountSummary.parse(result) : null;
  }
  async importAccount(actor: string, agentId: string, input: { workerId: string; pluginId: string; providerId: string;
    requestId: string; expectedRevision: string | null; credential: unknown }) {
    const context = this.context(actor, agentId, input.workerId, input.pluginId, input.providerId);
    await this.install(context);
    const summary = ModelAccountSummary.parse(await context.client.call("POST", "/v1/model-providers/import", {
      agentId, pluginId: input.pluginId, providerId: input.providerId, requestId: input.requestId,
      expectedRevision: input.expectedRevision, credential: input.credential, releaseSha256: context.plugin.installedRelease!.sha256,
    }, AbortSignal.timeout(35000)));
    try{
      const current = this.context(actor, agentId, input.workerId, input.pluginId, input.providerId);
      if(current.configRevision!==context.configRevision)throw new AgentError("plugin_config_conflict",409);
    }catch(error){
      await context.client.call("POST", "/v1/model-providers/disable", { agentId, pluginId: input.pluginId }).catch(()=>{});
      throw error;
    }
    if (summary.agentId !== agentId || summary.pluginId !== input.pluginId || summary.providerId !== input.providerId
      || summary.releaseSha256 !== context.plugin.installedRelease!.sha256) throw new AgentError("model_account_scope_mismatch", 409);
    this.remember(input.workerId, summary);
    return summary;
  }
  private remember(workerId: string, summary: ModelAccountSummary): void {
    this.db.$client.prepare(`INSERT INTO agent_model_provider_accounts VALUES (?,?,?,?,?,?)
      ON CONFLICT(agent_id,worker_id,plugin_id,provider_id,revision) DO UPDATE SET summary_json=excluded.summary_json`)
      .run(summary.agentId, workerId, summary.pluginId, summary.providerId, summary.credentialRevision, JSON.stringify(summary));
  }
  async validateReference(actor: string, agentId: string, raw: unknown, model: string): Promise<ModelProviderReference> {
    const reference = ModelProviderReference.parse(raw);
    const context = this.context(actor, agentId, reference.workerId, reference.pluginId, reference.providerId);
    const row = this.db.$client.prepare("SELECT summary_json FROM agent_model_provider_accounts WHERE agent_id=? AND worker_id=? AND plugin_id=? AND provider_id=? AND revision=?")
      .get(agentId, reference.workerId, reference.pluginId, reference.providerId, reference.credentialRevision) as { summary_json: string } | null;
    if (!row) throw new AgentError("model_account_revision_missing", 409);
    const account = ModelAccountSummary.parse(JSON.parse(row.summary_json));
    if (account.accountId !== reference.accountId || account.releaseSha256 !== reference.releaseSha256) throw new AgentError("model_account_scope_mismatch", 403);
    await context.client.call("POST", "/v1/model-providers/check", { agentId, reference, model });
    this.context(actor, agentId, reference.workerId, reference.pluginId, reference.providerId);
    return reference;
  }
  async refresh(actor: string, agentId: string, reference: ModelProviderReference) {
    const context = this.context(actor, agentId, reference.workerId, reference.pluginId, reference.providerId);
    const result = await context.client.call("POST", "/v1/model-providers/refresh", { agentId, reference });
    this.context(actor, agentId, reference.workerId, reference.pluginId, reference.providerId);
    return result;
  }
  async startLogin(actor:string,agentId:string,input:{workerId:string;pluginId:string;providerId:string;expectedRevision:string|null},origin:string){
    new AgentStore(this.db).requireOwner(actor,agentId);
    const provider=this.registry.getPlugin(input.pluginId)?.manifest.workerModelProviders?.find(p=>p.id===input.providerId);
    if(!provider?.login)throw new AgentError("model_login_unsupported",409);
    this.access.requireWorkerAccess(actor,input.workerId);
    if(!this.access.allowed(agentId).includes(input.workerId))throw new AgentError("agent_worker_access_denied",403);
    const current=this.plugins.get(actor,agentId,input.pluginId);
    if(!current.enabled)this.plugins.put(actor,agentId,input.pluginId,agentPluginWrite.parse({expectedRevision:current.revision,enabled:true,config:current.config,secrets:{}}));
    const context=this.context(actor,agentId,input.workerId,input.pluginId,input.providerId);await this.install(context);
    for(const [id,record] of this.logins){if(record.expiresAt<Date.now())this.logins.delete(id);}
    if(this.logins.size>=128)throw new ExecutionError(429,"model_login_busy");
    const callbackPath=provider.login.callbackPath??"/api/model-providers/login/callback";
    const parsedOrigin=new URL(origin);
    const isLoopback=["127.0.0.1","localhost"].includes(parsedOrigin.hostname);
    const callbackOrigin=isLoopback?parsedOrigin.origin:"http://127.0.0.1:51121";
    const flowId=randomUUID();const callback=new URL(callbackPath,callbackOrigin);
    if(isLoopback)callback.searchParams.set("flowId",flowId);
    this.logins.set(flowId,{actor,agentId,...input,configRevision:context.configRevision,callbackPath,expiresAt:Date.now()+600000});
    try{
      const started=await context.client.call<Record<string,unknown>>("POST","/v1/model-providers/login/start",{agentId,pluginId:input.pluginId,providerId:input.providerId,expectedRevision:input.expectedRevision,flowId,callbackUrl:callback.href,releaseSha256:context.plugin.installedRelease!.sha256},AbortSignal.timeout(30000));
      return {...started,manualCallbackRecommended:!isLoopback};
    }catch(error){this.logins.delete(flowId);throw error;}
  }
  private loginContext(actor:string,agentId:string,flowId:string){
    const flow=this.logins.get(flowId);if(!flow || flow.actor!==actor || flow.agentId!==agentId || flow.expiresAt<Date.now())throw new AgentError("model_login_inactive",409);
    const context=this.context(actor,agentId,flow.workerId,flow.pluginId,flow.providerId);
    if(context.configRevision!==flow.configRevision)throw new AgentError("plugin_config_conflict",409);
    return {flow,context};
  }
  async loginCallback(actor:string,flowId:string,params:Record<string,string>,callbackPath:string){
    const flow=this.logins.get(flowId);if(!flow)throw new AgentError("model_login_inactive",409);
    if(flow.callbackPath!==callbackPath)throw new AgentError("model_login_callback_mismatch",409);
    const {context}=this.loginContext(actor,flow.agentId,flowId);
    await context.client.call("POST","/v1/model-providers/login/callback",{agentId:flow.agentId,flowId,params},AbortSignal.timeout(10000));
    this.loginContext(actor,flow.agentId,flowId);return {agentId:flow.agentId,workerId:flow.workerId,pluginId:flow.pluginId,providerId:flow.providerId};
  }
  async submitCallbackUrl(actor:string,agentId:string,flowId:string,rawCallbackUrl:string){
    const {flow}=this.loginContext(actor,agentId,flowId);
    let url:URL;
    try{url=new URL(rawCallbackUrl.trim());}catch{throw new AgentError("model_callback_invalid",400);}
    if(!["http:","https:"].includes(url.protocol) || url.search.length>65536)throw new AgentError("model_callback_invalid",400);
    if(url.pathname!==flow.callbackPath)throw new AgentError("model_login_callback_mismatch",409);
    const flowIds=url.searchParams.getAll("flowId");
    if(flowIds.length>1 || (flowIds.length===1 && flowIds[0]!==flowId))throw new AgentError("model_login_callback_mismatch",409);
    const params:Record<string,string>={};
    for(const [key,value] of url.searchParams){
      if(key==="flowId")continue;
      if(Object.hasOwn(params,key))throw new AgentError("model_callback_invalid",400);
      params[key]=value;
    }
    await this.loginCallback(actor,flowId,params,url.pathname);
    return {accepted:true};
  }
  async pollLogin(actor:string,agentId:string,flowId:string){
    const {flow,context}=this.loginContext(actor,agentId,flowId);
    const result=await context.client.call<any>("POST","/v1/model-providers/login/poll",{agentId,flowId},AbortSignal.timeout(35000));
    try{this.loginContext(actor,agentId,flowId);}catch(error){await context.client.call("POST","/v1/model-providers/disable",{agentId,pluginId:flow.pluginId}).catch(()=>{});throw error;}
    if(result.state==="ready"){
      const account=ModelAccountSummary.parse(result.account);
      if(account.agentId!==agentId || account.pluginId!==flow.pluginId || account.providerId!==flow.providerId)throw new AgentError("model_account_scope_mismatch",403);
      this.remember(flow.workerId,account);return {state:"ready",account};
    }
    return {state:"pending"};
  }
  async cancelLogin(actor:string,agentId:string,flowId:string){const {flow,context}=this.loginContext(actor,agentId,flowId);this.logins.delete(flowId);await context.client.call("POST","/v1/model-providers/login/cancel",{agentId,flowId});return {cancelled:true};}
  async info(actor:string,agentId:string,reference:ModelProviderReference){
    const context=this.context(actor,agentId,reference.workerId,reference.pluginId,reference.providerId);
    return context.client.call("POST","/v1/model-providers/info",{agentId,reference});
  }
  async test(actor: string, agentId: string, reference: ModelProviderReference, model: string, env: Readonly<Record<string, string>>, executionDriver: string) {
    await this.validateReference(actor, agentId, reference, model);
    const context = this.context(actor, agentId, reference.workerId, reference.pluginId, reference.providerId);
    const result = await context.client.call("POST", "/v1/model-providers/test", { agentId, reference, model, env, executionDriver }, AbortSignal.timeout(65000));
    this.context(actor, agentId, reference.workerId, reference.pluginId, reference.providerId);
    return result as { success: boolean; message: string };
  }
  async disable(actor: string, agentId: string, pluginId: string): Promise<void> {
    new AgentStore(this.db).requireOwner(actor, agentId);
    const workers = this.access.allowed(agentId, { includePaused: true });
    await Promise.allSettled(workers.map(workerId => this.runtime()?.gateway?.scheduler.workers.client(workerId)
      .call("POST", "/v1/model-providers/disable", { agentId, pluginId }, AbortSignal.timeout(3000))));
  }
}
