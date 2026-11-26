import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Link2, Loader2, RefreshCw, Search, Server, ShieldCheck, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DashboardModelProviderReference } from "@/lib/api/hooks";

export interface ProviderModel { id: string; name: string; contextWindow?: number; capabilities?: { tools?: boolean; reasoning?: boolean } }
export interface ModelProvider { pluginId: string; providerId: string; name: string; enabled: boolean; loginLabel: string | null }
export interface ModelWorker { workerId: string; ready: boolean; supported: boolean; paused: boolean }
export interface ModelCatalog { providers: ModelProvider[]; workers: ModelWorker[] }
export interface ModelAccount { agentId: string; pluginId: string; providerId: string; accountId: string; credentialRevision: string; releaseSha256: string; name: string; state: string; expiresAt: number | null; models: ProviderModel[] }
export interface AccountTarget { agentId: string; pluginId: string; providerId: string; workerId: string }
export const modelKey = (agentId: string) => ["luna", "worker-models", agentId] as const;
export const accountKey = (target: AccountTarget) => [...modelKey(target.agentId), "account", target.pluginId, target.providerId, target.workerId] as const;
const endpoint = (agentId: string, operation: string) => `/model-providers/${operation}?agentId=${encodeURIComponent(agentId)}`;
const bodyTarget = ({ pluginId, providerId, workerId }: AccountTarget) => ({ pluginId, providerId, workerId });
export function accountReference(target: AccountTarget, account?: ModelAccount | null): DashboardModelProviderReference | null {
  if (!account || account.agentId !== target.agentId || account.pluginId !== target.pluginId || account.providerId !== target.providerId) return null;
  return { kind: "worker-plugin", ...bodyTarget(target), accountId: account.accountId, credentialRevision: account.credentialRevision, releaseSha256: account.releaseSha256 };
}
export function useModelCatalog(agentId: string) {
  return useQuery({ queryKey: [...modelKey(agentId), "providers"], queryFn: ({ signal }) => apiFetch<ModelCatalog>(endpoint(agentId, "providers"), { signal }) });
}
export function useModelAccount(target: AccountTarget, enabled: boolean) {
  return useQuery({ queryKey: accountKey(target), queryFn: ({ signal }) => apiFetch<{ account: ModelAccount | null }>(endpoint(target.agentId, "account"), { method: "POST", body: JSON.stringify(bodyTarget(target)), signal }), enabled });
}
export interface ProviderSource { key: string; target: AccountTarget; provider: ModelProvider; worker: ModelWorker; account?: ModelAccount | null; reference: DashboardModelProviderReference | null; ready: boolean; loading: boolean; error: boolean }
export interface ModelSelectionHint { pluginId: string; providerId: string; workerId: string; model?: string }
export function resolveModelHint(agentId: string, hint: ModelSelectionHint, sources: ProviderSource[]) {
  const source = sources.find(s => s.target.agentId === agentId && s.target.pluginId === hint.pluginId && s.target.providerId === hint.providerId && s.target.workerId === hint.workerId);
  if (!source?.ready || source.account?.state !== "ready") return null;
  const model = source.account.models.find(m => m.id === hint.model);
  const reference = accountReference(source.target, source.account);
  return model && reference ? { source, model, reference } : null;
}
export function useProviderSources(agentId: string) {
  const catalog = useModelCatalog(agentId);
  const targets = (catalog.data?.providers ?? []).filter(p => p.enabled).flatMap(provider => (catalog.data?.workers ?? []).filter(w => w.supported && w.ready && !w.paused).map(worker => ({ provider, worker, target: { agentId, pluginId: provider.pluginId, providerId: provider.providerId, workerId: worker.workerId } })));
  const accounts = useQueries({ queries: targets.map(({ target }) => ({ queryKey: accountKey(target), queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<{ account: ModelAccount | null }>(endpoint(agentId, "account"), { method: "POST", body: JSON.stringify(bodyTarget(target)), signal }) })) });
  const sources: ProviderSource[] = targets.map(({ target, provider, worker }, index) => {
    const account = accounts[index].data?.account;
    const reference = accountReference(target, account);
    return { key: `${provider.pluginId}/${provider.providerId}/${worker.workerId}`, target, provider, worker, account, reference, ready: account?.state === "ready" && !!reference, loading: accounts[index].isPending, error: accounts[index].isError };
  });
  return { catalog, sources };
}
export function ModelStatus({ good, children }: { good: boolean; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ${good ? "bg-[#edf3e8] text-[#506b3b] dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}><span className={`size-1.5 rounded-full ${good ? "bg-[#7b9568]" : "bg-muted-foreground/50"}`} />{children}</span>;
}
export function ModelMark() { return <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#e9eee1] text-[#6b7e55] dark:bg-muted dark:text-foreground"><Sparkles className="size-4" strokeWidth={1.5} /></span>; }
export function ModelSearch({ value, onChange, placeholder = "搜索名称或模型 ID…" }: { value: string; onChange(value: string): void; placeholder?: string }) {
  return <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="搜索可用模型" className="h-9 border-border bg-muted/30 pl-9 text-xs shadow-none" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /></div>;
}
export function providerDetailsHref(agentId: string, source?: ProviderSource) {
  const params = source ? new URLSearchParams({ plugin: source.provider.pluginId, modelPlugin: source.provider.pluginId, modelProvider: source.provider.providerId, modelWorker: source.worker.workerId }) : null;
  return `/agent/${encodeURIComponent(agentId)}/plugins${params ? `?${params}` : ""}`;
}
export function modelConfigurationHref(agentId: string, reference: DashboardModelProviderReference, model: string) {
  return `/agent/${encodeURIComponent(agentId)}/settings/agents?${new URLSearchParams({ addModel: model, modelPlugin: reference.pluginId, modelProvider: reference.providerId, modelWorker: reference.workerId })}`;
}

export function ModelSourcePicker({ agentId, selected, initial, model, disabled = false, onSelect }: { agentId: string; selected?: DashboardModelProviderReference; initial?: ModelSelectionHint; model: string; disabled?: boolean; onSelect(reference: DashboardModelProviderReference | null, model: string, name?: string): void }) {
  const { catalog, sources } = useProviderSources(agentId);
  const [choice, setChoice] = useState(selected ? `${selected.pluginId}/${selected.providerId}/${selected.workerId}` : initial ? `${initial.pluginId}/${initial.providerId}/${initial.workerId}` : "");
  const [query, setQuery] = useState("");
  const applied = useRef(false);
  useEffect(() => { if (!initial?.model || applied.current) return; const result = resolveModelHint(agentId, initial, sources); if (result) { applied.current = true; onSelect(result.reference, result.model.id, result.model.name); } }, [agentId, initial, sources, onSelect]);
  const source = sources.find(s => s.key === choice) ?? (!choice ? sources.find(s => s.ready && s.provider.loginLabel) ?? sources.find(s => s.ready) ?? sources[0] : undefined);
  const models = source?.account?.models.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  if (catalog.isError) return <p role="alert" className="text-sm text-destructive">无法读取模型源，请刷新后重试。</p>;
  if (catalog.isPending) return <p className="py-6 text-sm text-muted-foreground">正在读取模型源…</p>;
  return <div className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]"><label className="space-y-2 text-xs"><span className="block text-muted-foreground">模型账号</span><select aria-label="选择模型 Provider" disabled={disabled} className="h-10 w-full rounded-lg border bg-background px-3 text-xs" value={source?.key ?? choice} onChange={e => { applied.current = true; setChoice(e.target.value); setQuery(""); onSelect(null, ""); }}><option value="">选择已登录 Provider</option>{sources.map(s => <option key={s.key} value={s.key}>{s.provider.name} · {s.worker.workerId}{s.ready ? "" : " · 未连接"}</option>)}</select></label><div className="space-y-2 text-xs"><span className="block text-muted-foreground">绑定 Worker</span><div className="flex h-10 items-center gap-2 rounded-lg border bg-muted/20 px-3"><Server className="size-3.5 text-muted-foreground" /><span className="truncate">{source?.worker.workerId ?? selected?.workerId ?? "尚未绑定"}</span></div></div></div>
    {source && <div className="flex items-center gap-2 rounded-xl border bg-[#f7f9f3] px-3 py-2.5 text-xs dark:bg-muted"><ShieldCheck className="size-3.5 shrink-0 text-[#718466]" /><span className="min-w-0 flex-1 truncate">{source.account?.name ?? (source.loading ? "读取账号中…" : "尚未连接账号")}</span><ModelStatus good={source.ready}>{source.ready ? "已连接 · 自动绑定" : "等待连接"}</ModelStatus></div>}
    {selected && source?.reference && selected.credentialRevision !== source.reference.credentialRevision && <p className="text-xs text-muted-foreground">此配置绑定较早的账号版本。重新选择模型可使用当前账号版本。</p>}
    <ModelSearch value={query} onChange={setQuery} />
    <div className="grid max-h-[420px] gap-3 overflow-y-auto sm:grid-cols-2">{models.map(m => <button type="button" key={m.id} disabled={disabled || !source?.ready} aria-pressed={model === m.id} onClick={() => { applied.current = true; onSelect(source?.reference ?? null, m.id, m.name); }} className={`space-y-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${model === m.id ? "border-[#81946d] bg-[#f1f5ec] dark:bg-accent" : "hover:border-[#a3af97]"}`}><div className="flex items-center justify-between"><Sparkles className="size-4 text-muted-foreground" /><span className={`flex size-4 items-center justify-center rounded-full border ${model === m.id ? "border-[#718466] bg-[#718466] text-white" : "border-border"}`}>{model === m.id && <Check className="size-2.5" />}</span></div><span className="block truncate text-xs font-semibold">{m.name}</span><code className="block truncate text-[10px] text-muted-foreground">{m.id}</code></button>)}</div>
    {(!models.length || !source?.ready) && <div className="rounded-xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground"><p>{source?.error ? "无法读取此账号，请检查 Worker 状态。" : source?.loading ? "正在读取目录…" : query ? "没有匹配的模型。" : "先在插件详情页登录账号，再选择模型。"}</p><a className="mt-3 inline-block underline underline-offset-4" href={providerDetailsHref(agentId, source)}>管理模型账号</a></div>}
  </div>;
}

export function ModelAccountSidebar({ agentId, sources, onAdd }: { agentId: string; sources: ProviderSource[]; onAdd(source: ProviderSource): void }) {
  return <div className="rounded-2xl border p-4"><div className="mb-4 flex items-center gap-2"><Link2 className="size-3.5 text-muted-foreground" /><h3 className="text-xs font-semibold">模型账号</h3><a href={providerDetailsHref(agentId)} className="ml-auto text-[11px] text-muted-foreground">管理<ArrowUpRight className="ml-1 inline size-3" /></a></div><div className="space-y-4">{sources.map(source => <div key={source.key} className="space-y-2 rounded-xl border bg-muted/10 p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{source.provider.name}</span><span className={`size-1.5 shrink-0 rounded-full ${source.ready ? "bg-[#7b9568]" : "bg-muted-foreground/40"}`} /></div><span className="block truncate text-[11px] text-muted-foreground">{source.account?.name ?? (source.loading ? "读取账号中…" : "尚未连接账号")}</span><span className="block truncate text-[10px] text-muted-foreground">{source.worker.workerId}</span><div className="flex items-center justify-between border-t pt-2 text-[11px] text-muted-foreground"><span>{source.account?.models.length ?? 0} 个模型</span>{source.ready ? <button type="button" className="text-foreground" onClick={() => onAdd(source)}>添加模型 +</button> : <a href={providerDetailsHref(agentId, source)} className="underline">登录账号</a>}</div></div>)}</div>{!sources.length && <p className="text-xs leading-5 text-muted-foreground">暂无已启用且在线的 Provider。<a className="ml-1 underline" href={providerDetailsHref(agentId)}>管理插件与账号</a></p>}<div className="mt-4 flex gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[#718466]" /><p className="text-xs leading-5 text-muted-foreground">Provider 模型自动绑定账号与 Worker，无需重复填写 API 信息。</p></div></div>;
}
export function ProviderDirectory({ sources, onAdd }: { sources: ProviderSource[]; onAdd(source: ProviderSource, model: ProviderModel): void }) {
  const [choice, setChoice] = useState(""); const [query, setQuery] = useState("");
  const source = sources.find(s => s.key === choice) ?? sources.find(s => s.ready && s.provider.loginLabel) ?? sources[0];
  const models = source?.account?.models.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <div className="space-y-4 pt-4"><div className="flex flex-wrap gap-2">{sources.map(s => <button type="button" key={s.key} aria-pressed={s.key === source?.key} onClick={() => setChoice(s.key)} className={`rounded-full border px-3 py-1.5 text-xs ${s.key === source?.key ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{s.provider.name} · {s.worker.workerId}</button>)}</div><ModelSearch value={query} onChange={setQuery} /><div className="grid gap-3 sm:grid-cols-2">{models.map(m => <div key={m.id} className="space-y-3 rounded-xl border p-4"><ModelMark /><h3 className="truncate text-sm font-semibold">{m.name}</h3><code className="block truncate text-[10px] text-muted-foreground">{m.id}</code><div className="flex items-center justify-between border-t pt-3"><span className="text-[11px] text-muted-foreground">{source.provider.name}</span><Button size="xs" variant="ghost" disabled={!source.ready} onClick={() => onAdd(source, m)}>添加<ArrowUpRight className="size-3" /></Button></div></div>)}</div>{!models.length && <p className="py-6 text-center text-xs text-muted-foreground">{source?.loading ? "正在读取模型目录…" : query ? "没有匹配的模型。" : "连接账号后，可用模型会显示在这里。"}</p>}</div>;
}

/** Account management is shared by plugin details and the authorization return page. */
export function WorkerModels({ agentId, pluginId, onSelect, selected, model, onUseModel, view = "overview" }: { agentId: string; pluginId?: string; selected?: DashboardModelProviderReference; model?: string; onSelect?(reference: DashboardModelProviderReference | null, model: string): void; onUseModel?(reference: DashboardModelProviderReference, model: string): Promise<unknown>; view?: "overview" | "directory" | "embedded" }) {
  if (onSelect) return <ModelSourcePicker agentId={agentId} selected={selected} model={model ?? ""} onSelect={onSelect} />;
  return <AccountWorkspace key={`${agentId}/${pluginId ?? "all"}`} {...{ agentId, pluginId, onUseModel, view }} />;
}
function AccountWorkspace({ agentId, pluginId, onUseModel, view }: { agentId: string; pluginId?: string; onUseModel?: (reference: DashboardModelProviderReference, model: string) => Promise<unknown>; view: string }) {
  const catalog = useModelCatalog(agentId); const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const [choice, setChoice] = useState(params.get("modelPlugin") && params.get("modelProvider") ? `${params.get("modelPlugin")}/${params.get("modelProvider")}` : "");
  const [workerId, setWorker] = useState(params.get("modelWorker") ?? "");
  const providers = catalog.data?.providers.filter(p => !pluginId || p.pluginId === pluginId) ?? [];
  const provider = providers.find(p => `${p.pluginId}/${p.providerId}` === choice) ?? (!choice ? providers.find(p => p.loginLabel) ?? providers[0] : undefined);
  const worker = catalog.data?.workers.find(w => w.workerId === workerId) ?? (!workerId ? catalog.data?.workers.find(w => w.ready && w.supported && !w.paused) : undefined);
  if (catalog.isError) return <p role="alert" className="text-sm text-destructive">无法读取模型源。</p>;
  if (catalog.isPending) return <p className="py-4 text-sm text-muted-foreground">正在读取模型源…</p>;
  if (!providers.length) return null;
  return <div className="space-y-4">
    {(providers.length > 1 || !worker?.ready || !worker?.supported || view === "embedded") && <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-2 text-xs"><span className="block text-muted-foreground">模型 Provider</span><select aria-label="模型插件" className="h-10 w-full rounded-lg border bg-background px-3" value={provider ? `${provider.pluginId}/${provider.providerId}` : choice} onChange={e => setChoice(e.target.value)}><option value="">选择 Provider</option>{providers.map(p => <option key={`${p.pluginId}/${p.providerId}`} value={`${p.pluginId}/${p.providerId}`}>{p.name}</option>)}</select></label><label className="space-y-2 text-xs"><span className="block text-muted-foreground">绑定 Worker</span><select aria-label="绑定 Worker" className="h-10 w-full rounded-lg border bg-background px-3" value={worker?.workerId ?? workerId} onChange={e => setWorker(e.target.value)}><option value="">选择 Worker</option>{catalog.data.workers.map(w => <option key={w.workerId} value={w.workerId} disabled={!w.ready || !w.supported || w.paused}>{w.workerId}{!w.supported ? " · 需升级" : !w.ready ? " · 离线" : w.paused ? " · 暂停" : ""}</option>)}</select></label></div>}
    {provider && worker?.ready && worker.supported && !worker.paused ? <WorkerAccount key={`${agentId}/${provider.pluginId}/${provider.providerId}/${worker.workerId}`} {...{ agentId, provider, worker, onUseModel, view }} onWorkerChange={setWorker} workers={catalog.data.workers} /> : <p className="rounded-xl border border-dashed p-5 text-xs text-muted-foreground">选择在线且支持模型 Provider 的 Worker 后即可登录。</p>}
  </div>;
}
function WorkerAccount({ agentId, provider, worker, workers, onWorkerChange, onUseModel, view }: { agentId: string; provider: ModelProvider; worker: ModelWorker; workers: ModelWorker[]; onWorkerChange(value: string): void; onUseModel?: (reference: DashboardModelProviderReference, model: string) => Promise<unknown>; view: string }) {
  const client = useQueryClient(); const target = { agentId, pluginId: provider.pluginId, providerId: provider.providerId, workerId: worker.workerId };
  const account = useModelAccount(target, provider.enabled); const value = account.data?.account; const reference = accountReference(target, value);
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const [flowId, setFlow] = useState(params.get("modelPlugin") === provider.pluginId && params.get("modelProvider") === provider.providerId && params.get("modelWorker") === worker.workerId ? params.get("modelLogin") : null);
  const [authorizationUrl, setAuthorizationUrl] = useState(""); const [callbackInput, setCallbackInput] = useState(""); const [copiedUrl, setCopiedUrl] = useState(false); const [submittingCallback, setSubmittingCallback] = useState(false); const [credential, setCredential] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [query, setQuery] = useState("");
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const flow = useQuery<{ state: string; account?: ModelAccount }>({ queryKey: [...accountKey(target), "login", flowId], enabled: !!flowId, retry: false, refetchInterval: q => q.state.error || q.state.data?.state === "ready" ? false : 2000, queryFn: ({ signal }) => apiFetch<{ state: string; account?: ModelAccount }>(endpoint(agentId, "login/poll"), { method: "POST", body: JSON.stringify({ flowId }), signal }) });
  useEffect(() => { if (flow.data?.state === "ready" && flow.data.account) { client.setQueryData(accountKey(target), { account: flow.data.account }); setFlow(null); setAuthorizationUrl(""); setCallbackInput(""); void client.invalidateQueries({ queryKey: modelKey(agentId) }); void client.invalidateQueries({ queryKey: ["luna", "agent-plugins", agentId] }); } }, [flow.data]);
  useEffect(() => { if (flow.error) { setError("授权会话已结束，可刷新账号确认绑定结果。"); setFlow(null); setAuthorizationUrl(""); setCallbackInput(""); void account.refetch(); } }, [flow.error]);
  async function login() {
    const popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
    setBusy(true); setError(""); setCallbackInput(""); setCopiedUrl(false);
    try { const result = await apiFetch<{ flowId: string; authorizationUrl: string }>(endpoint(agentId, "login/start"), { method: "POST", body: JSON.stringify({ ...bodyTarget(target), expectedRevision: value?.credentialRevision ?? null }) });
      if (!alive.current) { popup?.close(); await apiFetch(endpoint(agentId, "login/cancel"), { method: "POST", body: JSON.stringify({ flowId: result.flowId }) }).catch(() => {}); return; }
      if (alive.current) { setFlow(result.flowId); setAuthorizationUrl(result.authorizationUrl); void client.invalidateQueries({ queryKey: modelKey(agentId) }); void client.invalidateQueries({ queryKey: ["luna", "agent-plugins", agentId] }); }
      if (popup) popup.location.replace(result.authorizationUrl);
    } catch { popup?.close(); if (alive.current) setError("无法启动授权，请检查 Worker 与插件状态。"); } finally { if (alive.current) setBusy(false); }
  }
  async function submitCallback() {
    if (!flowId || !callbackInput.trim()) return;
    setSubmittingCallback(true); setError("");
    try {
      await apiFetch(endpoint(agentId, "login/callback"), { method: "POST", body: JSON.stringify({ flowId, callbackUrl: callbackInput.trim() }) });
      if (alive.current) { setCallbackInput(""); void flow.refetch(); }
    } catch { if (alive.current) setError("回调地址无效或已过期，请确认复制了浏览器地址栏的完整链接。"); }
    finally { if (alive.current) setSubmittingCallback(false); }
  }
  async function cancelLogin() { try { await apiFetch(endpoint(agentId, "login/cancel"), { method: "POST", body: JSON.stringify({ flowId }) }); setFlow(null); setAuthorizationUrl(""); setCallbackInput(""); } catch { setError("无法取消授权，请稍后重试。"); } }
  async function run(operation: "import" | "refresh") {
    setBusy(true); setError("");
    try { const payload = operation === "import" ? { ...bodyTarget(target), requestId: crypto.randomUUID(), expectedRevision: value?.credentialRevision ?? null, credential: JSON.parse(credential) } : { reference };
      await apiFetch(endpoint(agentId, operation), { method: "POST", body: JSON.stringify(payload) });
      if (alive.current) { setCredential(""); await client.invalidateQueries({ queryKey: accountKey(target) }); }
    } catch { if (alive.current) setError(operation === "import" ? "导入失败，请检查凭据、账号区域与当前版本。" : "刷新失败，请检查账号和 Worker 状态。"); } finally { if (alive.current) setBusy(false); }
  }
  const models = value?.models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const connected = provider.enabled && value?.state === "ready";
  const loginFlowBanner = flowId ? <div className="space-y-3 rounded-2xl border bg-card p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-semibold">在浏览器中完成 {provider.name} 登录</p>
        <p className="mt-0.5 text-xs text-muted-foreground">已打开授权页面，登录完成后账号会自动绑定。</p>
      </div>
      <Button size="xs" variant="ghost" onClick={() => void cancelLogin()}>取消</Button>
    </div>
    {authorizationUrl && <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground" title={authorizationUrl}>{authorizationUrl}</code>
      <Button size="xs" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(authorizationUrl); setCopiedUrl(true); } catch { setCopiedUrl(false); } }}>{copiedUrl ? "已复制" : "复制"}</Button>
      <Button size="xs" variant="outline" asChild><a href={authorizationUrl} target="_blank" rel="noreferrer">重新打开</a></Button>
    </div>}
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs text-muted-foreground">如果浏览器跳转后的页面无法加载（Luna 部署在远端服务器或容器内），请复制浏览器地址栏的完整链接并粘贴到下方：</p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void submitCallback(); }}>
        <input
          aria-label="回调地址 Callback URL"
          type="url"
          value={callbackInput}
          onChange={e => setCallbackInput(e.target.value)}
          placeholder="http://127.0.0.1:51121/authorize?..."
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono text-xs"
        />
        <Button size="sm" type="submit" disabled={submittingCallback || !callbackInput.trim()}>
          {submittingCallback ? "提交中…" : "完成登录"}
        </Button>
      </form>
    </div>
  </div> : null;
  const accountPanel = <div className="space-y-4 rounded-2xl border p-4"><h3 className="flex items-center gap-2 text-xs font-semibold"><Link2 className="size-3.5 text-muted-foreground" />模型账号</h3><div className="flex items-center gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-xs font-semibold uppercase">{value?.name.slice(0, 1) ?? "?"}</div><div className="min-w-0"><p className="truncate text-xs font-medium" title={value?.name}>{value?.name ?? (!provider.enabled ? "插件尚未启用" : account.isPending ? "读取账号中…" : "尚未连接账号")}</p><p className="mt-1 text-[11px] text-muted-foreground">{value?.expiresAt ? `有效期至 ${new Date(value.expiresAt).toLocaleDateString()}` : "凭据保存在绑定 Worker"}</p></div></div><div className="flex flex-wrap items-center justify-between gap-2"><ModelStatus good={connected}>{connected ? "已连接" : value?.state === "expired" ? "需要重新登录" : value?.state === "unavailable" ? "账号暂不可用" : "待连接"}</ModelStatus>{provider.loginLabel && <Button size="sm" variant={connected ? "outline" : "default"} disabled={busy || !!flowId} onClick={() => void login()}><Link2 className="size-3.5" />{connected ? "重新授权" : provider.loginLabel}</Button>}</div>{!provider.enabled && provider.loginLabel && <p className="text-[11px] text-muted-foreground">登录时会在当前 Agent 启用模型源。</p>}{flowId && <p role="status" className="text-xs text-muted-foreground">等待授权绑定…<Button size="xs" variant="ghost" onClick={() => void cancelLogin()}>取消登录</Button></p>}{provider.enabled && account.isError && <p role="alert" className="text-xs text-destructive">无法读取账号。</p>}<details className="border-t pt-3" open={!provider.loginLabel && !connected}><summary className="cursor-pointer list-none text-[11px] text-muted-foreground">导入已有凭据<ChevronDown className="ml-1 inline size-3" /></summary><div className="mt-3 space-y-3"><input aria-label="导入凭据文件" type="file" accept=".json,application/json" disabled={busy || !provider.enabled} className="max-w-full text-[11px]" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 60000) { setError("凭据文件过大。"); return; } const contents = await file.text(); if (alive.current) setCredential(contents); }} /><p className="text-[11px] text-muted-foreground">{credential ? "已选择文件，等待导入。" : "使用登录助手生成的 JSON 文件。"}</p><Button size="sm" variant="outline" disabled={busy || !credential || !provider.enabled || account.isPending || account.isError} onClick={() => void run("import")}>{value ? "替换账号" : "导入账号"}</Button></div></details></div>;
  const directory = <div className="min-w-0 rounded-2xl border p-5"><div className="mb-4 flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-muted-foreground" />可用模型 <span className="text-xs font-normal text-muted-foreground">{value?.models.length ?? 0}</span></h3><Button size="xs" variant="ghost" disabled={busy || !reference || !connected} onClick={() => void run("refresh")}><RefreshCw className={`size-3 ${busy ? "animate-spin" : ""}`} />刷新</Button></div><ModelSearch value={query} onChange={setQuery} /><div className={`mt-2 divide-y divide-border/70 overflow-y-auto ${view === "directory" ? "max-h-[540px]" : "max-h-[330px]"}`}>{models.map(m => <div key={m.id} className="flex items-center gap-3 py-3.5"><ModelMark /><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{m.name}</p><code className="mt-1 block truncate text-[10px] text-muted-foreground">{m.id}</code></div>{reference && connected && (onUseModel ? <Button size="xs" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await onUseModel(reference, m.id); } catch { setError("添加模型配置失败。"); } finally { if (alive.current) setBusy(false); } }}>添加<ArrowUpRight className="size-3" /></Button> : <Button size="xs" variant="ghost" asChild><a href={modelConfigurationHref(agentId, reference, m.id)}>添加<ArrowUpRight className="size-3" /></a></Button>)}</div>)}</div>{!models.length && <p className="py-8 text-center text-xs text-muted-foreground">{query ? "没有匹配的模型。" : "连接账号后，模型会显示在这里。"}</p>}</div>;
  return <div className="space-y-4">{error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}{loginFlowBanner}{view === "directory" ? directory : <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_256px]"><div className="min-w-0 space-y-5"><div className="rounded-2xl border bg-[#fafbf7] p-5 dark:bg-card"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{connected ? "模型已就绪" : "连接你的模型账号"}</h3><p className="mt-1 text-xs text-muted-foreground">{connected ? `${value.models.length} 个模型可供当前 Agent 使用` : "完成授权后，自动读取可用模型。"}</p></div><ModelStatus good={connected}>{connected ? "已连接" : "待连接"}</ModelStatus></div><div className="mt-4 flex items-center gap-2 border-t pt-3 text-[11px] text-muted-foreground"><Server className="size-3.5" />{worker.workerId}<span className="ml-auto">Worker 模型源</span></div></div>{directory}</div><aside className="space-y-4">{accountPanel}{reference && connected && <ModelApiInfo agentId={agentId} reference={reference} />}<details className="rounded-xl border px-4 py-3"><summary className="cursor-pointer list-none text-xs text-muted-foreground">更换 Worker<ChevronDown className="float-right size-3.5" /></summary><select aria-label="更换 Worker" value={worker.workerId} className="mt-3 h-9 w-full rounded border bg-background px-2 text-xs" onChange={e => onWorkerChange(e.target.value)}>{workers.map(w => <option key={w.workerId} value={w.workerId} disabled={!w.ready || !w.supported || w.paused}>{w.workerId}{!w.supported ? " · 需升级" : !w.ready ? " · 离线" : w.paused ? " · 暂停" : ""}</option>)}</select></details></aside></div>}</div>;
}
function ModelApiInfo({ agentId, reference }: { agentId: string; reference: DashboardModelProviderReference }) {
  const [copied, setCopied] = useState(false);
  const info = useQuery({ queryKey: [...modelKey(agentId), "info", reference], queryFn: ({ signal }) => apiFetch<{ protocol: string; baseUrl: string; workerLocalBaseUrl: string }>(endpoint(agentId, "info"), { method: "POST", body: JSON.stringify({ reference }), signal }) });
  if (!info.data) return null;
  return <div className="space-y-4 rounded-2xl border p-4"><h3 className="text-xs font-semibold">接入信息</h3><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">调用协议</span><span className="rounded bg-muted px-2 py-1 font-mono text-[10px]">{info.data.protocol}</span></div><div><span className="text-[11px] text-muted-foreground">Runner API</span><div className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/20 px-2.5 py-2"><code className="min-w-0 flex-1 break-all text-[10px] leading-4">{info.data.baseUrl}</code><button type="button" className="text-[10px] text-muted-foreground" onClick={async () => { try { await navigator.clipboard.writeText(info.data!.baseUrl); setCopied(true); } catch { setCopied(false); } }}>{copied ? "已复制" : "复制"}</button></div></div><p className="text-xs leading-5 text-muted-foreground">Luna 自动绑定账号与调用凭据，添加模型时无需重复填写。</p><details><summary className="cursor-pointer text-[11px] text-muted-foreground">Worker 本地地址</summary><code className="mt-2 block break-all text-[10px] text-muted-foreground">{info.data.workerLocalBaseUrl}</code></details></div>;
}
