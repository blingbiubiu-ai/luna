import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Layers3, Puzzle, Settings2, Sparkles } from "lucide-react";
import { useRouteAgent } from "@/lib/agent-route";
import { appHistory } from "@/lib/app-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useDashboardAuthSession } from "@/lib/api";
import { ApiFetchError, apiFetch } from "@/lib/api/client";
import { modelKey, useModelCatalog, WorkerModels } from "./worker-models";

interface PluginChoice { id: string; name: string; version: string; supported: boolean; enabled: boolean }
interface PluginConfig { revision: string | null; enabled: boolean; config: Record<string, unknown>; secretKeys: string[] }
interface SecretChange { key: string; value: string | null }
const pluginsKey = (agentId: string) => ["luna", "agent-plugins", agentId] as const;

export function AgentPluginsPage() {
  const auth = useDashboardAuthSession(); const agent = useRouteAgent();
  return <section className="mx-auto w-full max-w-7xl p-4 pb-8 md:p-7"><header className="mb-6 flex items-end justify-between"><div><p className="mb-1 text-[11px] text-muted-foreground">工作空间 / 插件</p><h1 className="text-2xl font-semibold tracking-tight">Agent 插件</h1></div></header>{auth.error ? <p role="alert" className="text-destructive">无法加载 Agent。</p> : auth.isLoading ? <p>正在加载…</p> : auth.data?.account?.id === agent.ownerAccountId && agent.status === "active" ? <AgentPlugins key={agent.id} agentId={agent.id} /> : <p className="text-sm text-muted-foreground">只有 Agent 所有者可以配置启用中的 Agent。</p>}</section>;
}
function AgentPlugins({ agentId }: { agentId: string }) {
  const search = useSyncExternalStore(appHistory.subscribe, () => appHistory.location.search, () => "");
  const params = new URLSearchParams(search); const [selectedId, setSelectedId] = useState("");
  const path = `/agents/${encodeURIComponent(agentId)}/plugins`; const key = pluginsKey(agentId);
  const list = useQuery({ queryKey: [...key, "list"], queryFn: ({ signal }) => apiFetch<{ plugins: PluginChoice[] }>(path, { signal }) });
  const catalog = useModelCatalog(agentId);
  if (list.isPending) return <p className="py-6 text-sm text-muted-foreground">正在加载插件…</p>;
  if (list.isError) return <p role="alert" className="text-destructive">无法加载插件。</p>;
  const plugins = list.data.plugins;
  if (!plugins.length) return <div className="rounded-2xl border border-dashed p-8 text-sm text-muted-foreground">平台尚未加载插件，请联系平台管理员安装。</div>;
  const selected = plugins.find(p => p.id === (params.get("plugin") ?? selectedId)) ?? plugins.find(p => catalog.data?.providers.some(provider => provider.pluginId === p.id && provider.loginLabel)) ?? plugins[0];
  function choose(id: string) { setSelectedId(id); const url = new URL(window.location.href); url.searchParams.set("plugin", id); for (const key of ["modelLogin", "modelPlugin", "modelProvider", "modelWorker"]) url.searchParams.delete(key); appHistory.replace(url.pathname + url.search); }
  return <div className="grid items-start gap-6 lg:grid-cols-[204px_minmax(0,1fr)]"><aside className="rounded-2xl border bg-[#fafbf8] p-2 dark:bg-card"><p className="px-3 py-3 text-[10px] font-medium tracking-wider text-muted-foreground">已安装插件 · {plugins.length}</p><div className="flex gap-1 overflow-x-auto lg:flex-col">{plugins.map(plugin => <button type="button" key={plugin.id} aria-pressed={selected.id === plugin.id} onClick={() => choose(plugin.id)} className={`flex min-w-40 items-center gap-2.5 rounded-xl px-3 py-3 text-left transition-colors lg:w-full ${selected.id === plugin.id ? "bg-[#e9eee1] dark:bg-accent" : "hover:bg-muted"}`}><Puzzle className="size-4 shrink-0 text-[#657752] dark:text-muted-foreground" /><div className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{plugin.name}</span><span className="mt-1 block text-[10px] text-muted-foreground">v{plugin.version}{!plugin.supported ? " · 待适配" : ""}</span></div><span className={`size-1.5 shrink-0 rounded-full ${plugin.enabled ? "bg-[#7b9568]" : "bg-muted-foreground/40"}`} /></button>)}</div><p className="mt-3 border-t px-3 py-3 text-xs leading-5 text-muted-foreground">这里控制插件在当前 Agent 中的使用。</p></aside><PluginDetail key={`${agentId}/${selected.id}`} agentId={agentId} plugin={selected} path={`${path}/${encodeURIComponent(selected.id)}`} hasModels={selected.supported && !!catalog.data?.providers.some(p => p.pluginId === selected.id)} /></div>;
}
function PluginDetail({ agentId, plugin, path, hasModels }: { agentId: string; plugin: PluginChoice; path: string; hasModels: boolean }) {
  const client = useQueryClient(); const key = [...pluginsKey(agentId), "config", plugin.id];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => apiFetch<PluginConfig>(path, { signal }) });
  const [tab, setTab] = useState("overview"); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function save(input: { expectedRevision: string | null; enabled: boolean; config: Record<string, unknown>; secrets: Record<string, string | null> }) {
    const result = await apiFetch<PluginConfig>(path, { method: "PUT", body: JSON.stringify(input) });
    client.setQueryData(key, result); await Promise.all([client.invalidateQueries({ queryKey: [...pluginsKey(agentId), "list"] }), client.invalidateQueries({ queryKey: modelKey(agentId) })]); setNotice("配置已保存。"); return result;
  }
  async function toggle(enabled: boolean) {
    if (!query.data || busy || dirty) return; setBusy(true); setError(""); setNotice("");
    try { await save({ expectedRevision: query.data.revision, enabled, config: query.data.config, secrets: {} }); }
    catch (cause) { setError(cause instanceof ApiFetchError && cause.code === "plugin_config_conflict" ? "配置已被更新，请刷新后重试。" : "无法更新启用状态，请重试。"); await query.refetch(); }
    finally { setBusy(false); }
  }
  if (query.isPending) return <p className="p-5 text-sm text-muted-foreground">正在读取插件配置…</p>;
  if (query.isError) return <p role="alert" className="text-destructive">无法加载配置。</p>;
  const currentTab = hasModels ? tab : "config";
  return <div className="min-w-0"><header className="flex flex-wrap items-center gap-4"><div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-[#e9eee1] text-[#667654] dark:bg-muted dark:text-foreground"><Puzzle className="size-6" strokeWidth={1.5} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold tracking-tight">{plugin.name}</h2><span className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">v{plugin.version}</span></div><p className="mt-2 text-xs text-muted-foreground">{hasModels ? "连接模型账号，为 Agent 提供可用模型。" : "管理插件参数与额外凭据。"}</p></div><label className="flex items-center gap-3 rounded-lg border px-3 py-2 text-xs text-muted-foreground" title={dirty ? "请先保存或重新加载配置更改" : undefined}><span>{busy ? "保存中…" : query.data.enabled ? "已启用" : "未启用"}</span><Switch aria-label="在此 Agent 启用插件" checked={query.data.enabled} onCheckedChange={enabled => void toggle(enabled)} disabled={busy || dirty || (!plugin.supported && !query.data.enabled)} /></label></header>
    {!plugin.supported && <p className="mt-4 text-xs text-muted-foreground">该版本待适配 Agent，当前不可启用。</p>}
    <nav aria-label="插件详情分区" className="mb-6 mt-6 flex gap-6 border-b">{(hasModels ? [{ key: "overview", label: "概览", icon: <Layers3 className="size-3.5" /> }, { key: "models", label: "模型目录", icon: <Sparkles className="size-3.5" /> }, { key: "config", label: "配置", icon: <Settings2 className="size-3.5" /> }] : [{ key: "config", label: "配置", icon: <Settings2 className="size-3.5" /> }]).map(item => <button type="button" key={item.key} aria-pressed={currentTab === item.key} onClick={() => setTab(item.key)} className={`flex items-center gap-2 border-b-2 pb-3 text-xs ${currentTab === item.key ? "border-[#748960] font-medium" : "border-transparent text-muted-foreground"}`}>{item.icon}{item.label}</button>)}</nav>
    {error && <p role="alert" className="mb-4 text-xs text-destructive">{error}</p>}{notice && <p role="status" className="mb-4 text-xs text-[#617d4c] dark:text-emerald-300">{notice}</p>}
    {hasModels && <div hidden={currentTab === "config"}><WorkerModels agentId={agentId} pluginId={plugin.id} view={currentTab === "models" ? "directory" : "overview"} /></div>}
    <div hidden={currentTab !== "config"}><PluginConfigEditor plugin={plugin} initial={query.data} onDirtyChange={setDirty} onSave={save} onReload={async () => { const result = await query.refetch(); if (result.isError || !result.data) throw new Error("无法加载配置"); return result.data; }} /></div>
  </div>;
}
function PluginConfigEditor({ plugin, initial, onDirtyChange, onSave, onReload }: { plugin: PluginChoice; initial: PluginConfig; onDirtyChange(value: boolean): void; onSave(input: { expectedRevision: string | null; enabled: boolean; config: Record<string, unknown>; secrets: Record<string, string | null> }): Promise<PluginConfig>; onReload(): Promise<PluginConfig> }) {
  const [snapshot, setSnapshot] = useState(initial); const [config, setConfig] = useState(JSON.stringify(initial.config, null, 2)); const [changes, setChanges] = useState<SecretChange[]>([]); const [error, setError] = useState(""); const [conflict, setConflict] = useState(false); const [busy, setBusy] = useState(false);
  const dirty = config !== JSON.stringify(snapshot.config, null, 2) || changes.length > 0;
  useEffect(() => onDirtyChange(dirty), [dirty]);
  useEffect(() => { if (!dirty && initial.revision !== snapshot.revision) reset(initial); }, [initial.revision, dirty]);
  function reset(next: PluginConfig) { setSnapshot(next); setConfig(JSON.stringify(next.config, null, 2)); setChanges([]); setError(""); setConflict(false); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || conflict) return; setBusy(true); setError("");
    try { const parsed: unknown = JSON.parse(config); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("普通配置必须是 JSON 对象。"); const keys = changes.map(change => change.key.trim()); if (new Set(keys).size !== keys.length || keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || changes.some(change => change.value === "")) throw new Error("密钥名称必须唯一，替换时需填写新值。"); reset(await onSave({ expectedRevision: snapshot.revision, enabled: initial.enabled, config: parsed as Record<string, unknown>, secrets: Object.fromEntries(changes.map((change, index) => [keys[index], change.value])) })); }
    catch (cause) { if (cause instanceof ApiFetchError && cause.code === "plugin_config_conflict") { setConflict(true); setError("配置已被更新。重新加载后再编辑。"); } else setError(cause instanceof Error ? cause.message : "保存失败。"); }
    finally { setBusy(false); }
  }
  async function reload() { setBusy(true); try { reset(await onReload()); } catch { setError("无法重新加载配置。"); } finally { setBusy(false); } }
  return <form className="space-y-6" onSubmit={submit}><div className="flex items-start justify-between"><div><h3 className="text-sm font-semibold">插件配置</h3><p className="mt-1 text-xs text-muted-foreground">管理插件参数与额外凭据。</p></div><Button size="sm" type="submit" disabled={busy || conflict}>{busy ? "保存中…" : "保存更改"}</Button></div><fieldset disabled={busy} className="space-y-6"><label className="block space-y-3 text-xs"><span className="font-medium">普通配置</span><Textarea aria-label="普通配置 JSON" rows={7} className="bg-muted/20 font-mono text-xs leading-6" required value={config} onChange={e => setConfig(e.target.value)} /><span className="block text-muted-foreground">按插件说明填写配置项。</span></label><section aria-label="密钥" className="space-y-3 rounded-2xl border p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold">密钥</h3><Button type="button" size="xs" variant="outline" onClick={() => setChanges(previous => [...previous, { key: "", value: "" }])}>添加密钥</Button></div>{!snapshot.secretKeys.length && !changes.length && <p className="text-xs text-muted-foreground">此插件未配置额外密钥。</p>}{snapshot.secretKeys.length > 0 && <p className="break-all text-xs text-muted-foreground">已配置 {snapshot.secretKeys.join("、")}。填写同名密钥可替换。</p>}{changes.map((change, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><Input aria-label={`密钥名称 ${index + 1}`} className="text-xs" readOnly={change.value === null} required placeholder="密钥名称" value={change.key} onChange={e => setChanges(previous => previous.map((item, i) => i === index ? { ...item, key: e.target.value } : item))} />{change.value === null ? <span className="text-xs text-muted-foreground">保存时移除</span> : <Input aria-label={`密钥值 ${index + 1}`} className="text-xs" type="password" autoComplete="new-password" required placeholder="新值" value={change.value} onChange={e => setChanges(previous => previous.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} />}<Button type="button" size="sm" variant="ghost" onClick={() => setChanges(previous => previous.filter((_, i) => i !== index))}>取消</Button></div>)}{snapshot.secretKeys.filter(key => !changes.some(change => change.key === key)).map(key => <Button type="button" size="xs" variant="ghost" key={key} onClick={() => setChanges(previous => [...previous, { key, value: null }])}>移除 {key}</Button>)}</section></fieldset>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}{(dirty || conflict) && <div className="flex items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>重新加载配置</Button>{dirty && <p className="text-xs text-muted-foreground">有尚未保存的更改。</p>}</div>}</form>;
}
