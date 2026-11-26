import {useQuery,useQueryClient} from "@tanstack/react-query";
import {useEffect,useState} from "react";
import {apiFetch} from "@/lib/api/client";
import {Button} from "@/components/ui/button";
import type {DashboardModelProviderReference} from "@/lib/api/hooks";

interface Catalog {providers:{pluginId:string;providerId:string;name:string;enabled:boolean;loginLabel:string|null}[];workers:{workerId:string;ready:boolean;supported:boolean;paused:boolean}[]}
interface Account {accountId:string;credentialRevision:string;releaseSha256:string;name:string;state:string;expiresAt:number|null;models:{id:string;name:string}[]}
const path=(agentId:string)=>`/model-providers`;
const scoped=(agentId:string,operation:string)=>`${path(agentId)}/${operation}?agentId=${encodeURIComponent(agentId)}`;
const key=(agentId:string)=>["luna","worker-models",agentId];

/** Mounted by Agent scope, so pending imports cannot overwrite a different Agent's draft. */
export function WorkerModels({agentId,pluginId,onSelect,selected,model,onUseModel}:{agentId:string;pluginId?:string;selected?:DashboardModelProviderReference;model?:string;onSelect?:(reference:DashboardModelProviderReference|null,model:string)=>void;onUseModel?:(reference:DashboardModelProviderReference,model:string)=>Promise<unknown>}){
 const catalog=useQuery({queryKey:[...key(agentId),"providers"],queryFn:({signal})=>apiFetch<Catalog>(scoped(agentId,"providers"),{signal})});
 const query=typeof window==="undefined"?new URLSearchParams():new URLSearchParams(window.location.search);
 const [choice,setChoice]=useState(selected ? `${selected.pluginId}/${selected.providerId}` : !onSelect&&query.has("modelPlugin")?`${query.get("modelPlugin")}/${query.get("modelProvider")}`:"");
 const [workerId,setWorker]=useState(selected?.workerId??(!onSelect?query.get("modelWorker")??"":""));
 if(catalog.isError)return <p role="alert">无法读取 Worker 模型源。</p>;
 if(!catalog.data)return <p>正在读取模型源…</p>;
 const providers=catalog.data.providers.filter(p=>(!pluginId || p.pluginId===pluginId) && (!onSelect || p.enabled));
 if(!providers.length)return onSelect ? <p>先在 Agent 插件页面启用模型源并导入账号。</p> : null;
 const provider=providers.find(p=>`${p.pluginId}/${p.providerId}`===choice)??(!choice?providers.find(p=>p.loginLabel)??providers[0]:undefined);
 const worker=catalog.data.workers.find(w=>w.workerId===workerId)??(!workerId?catalog.data.workers.find(w=>w.ready&&w.supported&&!w.paused):undefined);
 return <section aria-label="Worker 模型源" className="space-y-3 rounded-lg border p-4 text-sm">
  <h3 className="font-medium">Worker 模型源</h3>
  <label className="block">模型插件<select aria-label="模型插件" className="mt-1 block w-full rounded border bg-background p-2" value={provider?`${provider.pluginId}/${provider.providerId}`:choice} onChange={e=>{setChoice(e.target.value);onSelect?.(null,"");}}><option value="">请选择</option>{providers.map(p=><option key={`${p.pluginId}/${p.providerId}`} value={`${p.pluginId}/${p.providerId}`}>{p.name}{!p.enabled?" · 未启用":""}</option>)}</select></label>
  <label className="block">绑定 Worker<select aria-label="绑定 Worker" className="mt-1 block w-full rounded border bg-background p-2" value={worker?.workerId??workerId} onChange={e=>{setWorker(e.target.value);onSelect?.(null,"");}}><option value="">请选择</option>{catalog.data.workers.map(w=><option key={w.workerId} value={w.workerId} disabled={!w.ready||!w.supported||w.paused}>{w.workerId}{!w.supported?" · 需升级":!w.ready?" · 离线":w.paused?" · 暂停":""}</option>)}</select></label>
  {provider && worker?.ready && worker.supported && !worker.paused ? <WorkerAccount key={`${agentId}/${provider.providerId}/${worker.workerId}`} agentId={agentId} pluginId={provider.pluginId} providerId={provider.providerId} workerId={worker.workerId} enabled={provider.enabled} loginLabel={provider.loginLabel} {...(onSelect ? {onSelect} : {})} {...(onUseModel?{onUseModel}:{})} {...(model===undefined?{}:{model})} /> : <p>选择在线 Worker 后即可登录账号。</p>}
 </section>;
}
function WorkerAccount({agentId,pluginId,providerId,workerId,onSelect,model,loginLabel,enabled,onUseModel}:{agentId:string;pluginId:string;providerId:string;workerId:string;model?:string;loginLabel:string|null;enabled:boolean;onSelect?:(reference:DashboardModelProviderReference|null,model:string)=>void;onUseModel?:(reference:DashboardModelProviderReference,model:string)=>Promise<unknown>}){
 const client=useQueryClient();
 const target={pluginId,providerId,workerId};
 const queryKey=[...key(agentId),pluginId,providerId,workerId];
 const account=useQuery({queryKey,queryFn:({signal})=>apiFetch<{account:Account|null}>(scoped(agentId,"account"),{method:"POST",body:JSON.stringify(target),signal}),enabled});
 const [credential,setCredential]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 const value=account.data?.account;
 const reference=value ? {kind:"worker-plugin" as const,...target,accountId:value.accountId,credentialRevision:value.credentialRevision,releaseSha256:value.releaseSha256} : null;
 const params=typeof window==="undefined"?new URLSearchParams():new URLSearchParams(window.location.search);
 const [flowId,setFlow]=useState(!onSelect&&params.get("modelPlugin")===pluginId&&params.get("modelWorker")===workerId?params.get("modelLogin"):null);
 const [authorizationUrl,setAuthorizationUrl]=useState("");
 const flow=useQuery({queryKey:[...queryKey,"login",flowId],queryFn:({signal})=>apiFetch<{state:string;account?:Account}>(scoped(agentId,"login/poll"),{method:"POST",body:JSON.stringify({flowId}),signal}),enabled:!!flowId,refetchInterval:q=>q.state.data?.state==="ready"||q.state.error?false:2000,retry:false});
 useEffect(()=>{if(flow.data?.state==="ready"&&flow.data.account){client.setQueryData(queryKey,{account:flow.data.account});void client.invalidateQueries({queryKey:[...key(agentId),"providers"]});setFlow(null);setAuthorizationUrl("");}},[flow.data]);
 async function login(){
  const popup=window.open("about:blank","_blank");if(popup)popup.opener=null;
  setBusy(true);setError("");
  try{const result=await apiFetch<{flowId:string;authorizationUrl:string}>(scoped(agentId,"login/start"),{method:"POST",body:JSON.stringify({...target,expectedRevision:value?.credentialRevision??null})});setFlow(result.flowId);setAuthorizationUrl(result.authorizationUrl);void client.invalidateQueries({queryKey:[...key(agentId),"providers"]});if(popup)popup.location.replace(result.authorizationUrl);}
  catch{popup?.close();setError("无法启动授权，请检查 Worker 和插件版本。");}finally{setBusy(false);}
 }
 async function cancelLogin(){try{await apiFetch(scoped(agentId,"login/cancel"),{method:"POST",body:JSON.stringify({flowId})});}catch{}setFlow(null);setAuthorizationUrl("");}
 async function run(operation:"import"|"refresh"){
  setBusy(true);setError("");
  try{
   const body=operation==="import" ? {...target,requestId:crypto.randomUUID(),expectedRevision:value?.credentialRevision??null,credential:JSON.parse(credential)} : {reference};
   await apiFetch(scoped(agentId,operation),{method:"POST",body:JSON.stringify(body)});
   setCredential("");onSelect?.(null,"");await client.invalidateQueries({queryKey});
  }catch{setError(operation==="import"?"导入失败，请检查凭据、账号区域和当前修订。":"模型刷新失败。");}
  finally{setBusy(false);}
 }
 return <div className="space-y-3">
  {!onSelect&&loginLabel?<div className="space-y-2"><Button type="button" disabled={busy||!!flowId&&!flow.isError} onClick={()=>void login()}>{value?loginLabel.replace(/^登录/,"重新登录"):loginLabel}</Button>{!enabled?<p className="text-xs text-muted-foreground">登录时会在此 Agent 启用模型源。</p>:null}{flowId?<p role="status">{flow.isError?"授权失败或已过期，请重新登录。":"等待授权绑定，完成后会自动读取模型。"}<Button type="button" variant="ghost" size="sm" onClick={()=>void cancelLogin()}>取消登录</Button></p>:null}{authorizationUrl?<a className="block underline" href={authorizationUrl} target="_blank" rel="noreferrer">打开授权页面</a>:null}</div>:null}
  {account.isError?<p role="alert">无法读取账号。</p>:value ? <p>账号：{value.name} · {value.state}{value.expiresAt ? ` · 到期 ${new Date(value.expiresAt).toLocaleString()}`:""}</p>:<p>尚未导入账号。</p>}
  {onSelect ? <label className="block">插件模型<select aria-label="插件模型" required className="mt-1 block w-full rounded border bg-background p-2" value={model??""} disabled={value?.state!=="ready"} onChange={e=>onSelect(reference,e.target.value)}><option value="">请选择</option>{value?.models.map(m=><option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}</select></label> : <details><summary className="cursor-pointer text-xs text-muted-foreground">导入已有凭据</summary><div className="mt-2 space-y-2">
   <label className="block">导入凭据文件<input aria-label="导入凭据文件" type="file" accept=".json,application/json" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];if(file){if(file.size>60000){setError("凭据文件过大。");return;}setCredential(await file.text());}}}/></label>
   <p className="text-xs text-muted-foreground">{credential?"已选择文件，等待导入。":"使用本地登录助手生成的 JSON；凭据保存在绑定 Worker。"}</p>
   <Button type="button" disabled={busy||!credential||account.isPending||account.isError} onClick={()=>void run("import")}>{value?"替换账号":"导入账号"}</Button>
  </div></details>}
  <Button type="button" variant="outline" disabled={busy||!reference} onClick={()=>void run("refresh")}>刷新模型</Button>
  {!onSelect&&reference&&value?.state==="ready"?<ModelApiInfo agentId={agentId} reference={reference}/>:null}
  {!onSelect && value?.models.length ? <ul className="max-h-64 space-y-2 overflow-y-auto text-xs">{value.models.map(m=><li key={m.id} className="flex items-center justify-between gap-2"><span>{m.name} · <code>{m.id}</code></span>{onUseModel&&reference?<Button type="button" variant="outline" size="sm" disabled={busy} onClick={async()=>{setBusy(true);try{await onUseModel(reference,m.id);}catch{setError("添加模型配置失败。");}finally{setBusy(false);}}}>添加到模型配置</Button>:null}</li>)}</ul>:null}
  {error?<p role="alert" className="text-destructive">{error}</p>:null}
 </div>;
}
function ModelApiInfo({agentId,reference}:{agentId:string;reference:DashboardModelProviderReference}){
 const info=useQuery({queryKey:[...key(agentId),"info",reference],queryFn:({signal})=>apiFetch<{protocol:string;baseUrl:string;workerLocalBaseUrl:string}>(scoped(agentId,"info"),{method:"POST",body:JSON.stringify({reference}),signal})});
 if(!info.data)return null;
 return <div className="rounded border bg-muted/30 p-3 text-xs"><p>协议：{info.data.protocol}</p><p className="mt-1 break-all">Runner API：<code>{info.data.baseUrl}</code></p><p className="mt-1 break-all">Worker 本地 API：<code>{info.data.workerLocalBaseUrl}</code></p><p className="mt-2 text-muted-foreground">Luna 运行任务时会自动提供 API Key。选择下方模型添加配置后，测试连接并激活即可使用。</p></div>;
}
