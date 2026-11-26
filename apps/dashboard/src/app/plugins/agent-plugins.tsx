import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useRouteAgent } from "@/lib/agent-route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useDashboardAuthSession } from "@/lib/api";
import { ApiFetchError, apiFetch } from "@/lib/api/client";
import {WorkerModels} from "./worker-models";

interface PluginChoice {
  id: string;
  name: string;
  version: string;
  supported: boolean;
  enabled: boolean;
}

interface PluginConfig {
  revision: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  secretKeys: string[];
}

interface SecretChange {
  key: string;
  value: string | null;
}

const pluginsKey = (agentId: string) => ["luna", "agent-plugins", agentId] as const;

export function AgentPluginsPage() {
  const auth = useDashboardAuthSession();
  const agent = useRouteAgent();
  return (
    <section className="mx-auto w-full max-w-5xl space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Agent 插件</h1>
      </header>
      {auth.error ? <p role="alert" className="text-destructive">无法加载 Agent。</p>
        : auth.isLoading ? <p>正在加载…</p>
        : auth.data?.account?.id === agent.ownerAccountId && agent.status === "active" ? <AgentPlugins agentId={agent.id} />
        : <p className="text-sm text-muted-foreground">只有 Agent 所有者可以配置启用中的 Agent。</p>}
    </section>
  );
}

function AgentPlugins({ agentId }: { agentId: string }) {
  const [selectedId, setSelectedId] = useState("");
  const path = `/agents/${encodeURIComponent(agentId)}/plugins`;
  const key = pluginsKey(agentId);
  const list = useQuery({
    queryKey: [...key, "list"],
    queryFn: ({ signal }) => apiFetch<{ plugins: PluginChoice[] }>(path, { signal }),
  });
  if (list.isPending) return <p>正在加载插件…</p>;
  if (list.isError) return <p role="alert" className="text-destructive">无法加载插件。</p>;
  const plugins = list.data.plugins;
  const selected = plugins.find(plugin => plugin.id === selectedId);
  if (!plugins.length) return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">平台尚未加载插件。</p>;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(13rem,1fr)_2fr]">
      <ul className="space-y-1 rounded-lg border bg-card p-2">
        {plugins.map(plugin => (
          <li key={plugin.id}>
            <button type="button" aria-pressed={selected?.id === plugin.id} onClick={() => setSelectedId(plugin.id)}
              className="w-full rounded-md p-3 text-left hover:bg-muted aria-pressed:bg-muted">
              <span className="block text-sm font-medium">{plugin.name}</span>
              <span className="text-xs text-muted-foreground">
                {plugin.version} · {!plugin.supported ? "待适配" : plugin.enabled ? "已启用" : "未启用"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected
        ? <div className="space-y-4"><PluginConfigPanel key={`${agentId}/${selected.id}`} agentId={agentId} plugin={selected} path={`${path}/${encodeURIComponent(selected.id)}`} /><WorkerModels key={`${agentId}/${selected.id}/${selected.enabled}`} agentId={agentId} pluginId={selected.id}/></div>
        : <p className="p-4 text-sm text-muted-foreground">请选择插件。</p>}
    </div>
  );
}

function PluginConfigPanel({ agentId, plugin, path }: { agentId: string; plugin: PluginChoice; path: string }) {
  const client = useQueryClient();
  const key = [...pluginsKey(agentId), "config", plugin.id];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiFetch<PluginConfig>(path, { signal }),
  });
  if (query.isPending) return <p>正在加载配置…</p>;
  if (query.isError) return <p role="alert" className="text-destructive">无法加载配置。</p>;
  return <PluginConfigEditor plugin={plugin} initial={query.data}
    onReload={async () => {
      const result = await query.refetch();
      if (result.isError) throw result.error;
      return result.data;
    }}
    onSave={async input => {
      const saved = await apiFetch<PluginConfig>(path, { method: "PUT", body: JSON.stringify(input) });
      client.setQueryData(key, saved);
      void client.invalidateQueries({ queryKey: [...pluginsKey(agentId), "list"], exact: true });
      return saved;
    }} />;
}

function PluginConfigEditor({ plugin, initial, onSave, onReload }: {
  plugin: PluginChoice;
  initial: PluginConfig;
  onSave: (input: { expectedRevision: string | null; enabled: boolean; config: Record<string, unknown>; secrets: Record<string, string | null> }) => Promise<PluginConfig>;
  onReload: () => Promise<PluginConfig>;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [config, setConfig] = useState(() => JSON.stringify(initial.config, null, 2));
  const [changes, setChanges] = useState<SecretChange[]>([]);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function reset(next: PluginConfig) {
    setSnapshot(next);
    setEnabled(next.enabled);
    setConfig(JSON.stringify(next.config, null, 2));
    setChanges([]);
    setError("");
    setConflict(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict) return;
    setError("");
    setSaved(false);
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(config);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("普通配置必须是 JSON 对象。");
      const keys = changes.map(change => change.key.trim());
      if (new Set(keys).size !== keys.length || keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
        changes.some(change => change.value === "")) throw new Error("密钥名称必须唯一，替换时需填写新值。");
      reset(await onSave({
        expectedRevision: snapshot.revision, enabled, config: parsed as Record<string, unknown>,
        secrets: Object.fromEntries(changes.map((change, index) => [keys[index]!, change.value])),
      }));
      setSaved(true);
    } catch (failure) {
      if (failure instanceof ApiFetchError && failure.code === "plugin_config_conflict") {
        setConflict(true);
        setError("配置已被更新。重新加载后再编辑。");
      } else {
        setError(failure instanceof Error ? failure.message : "保存失败。");
      }
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setBusy(true);
    try { reset(await onReload()); }
    catch { setError("无法重新加载配置。"); }
    finally { setBusy(false); }
  }

  return (
    <form className="space-y-4 rounded-lg border bg-card p-5" onSubmit={submit}>
      <h2 className="font-medium">{plugin.name}</h2>
      {!plugin.supported && <p className="text-sm text-muted-foreground">该版本待适配 Agent，当前不可启用。</p>}
      <fieldset className="space-y-4" disabled={busy}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} disabled={!plugin.supported && !enabled} onChange={event => setEnabled(event.target.checked)} />
          在此 Agent 启用
        </label>
        <label className="block space-y-2 text-sm">普通配置（JSON）
          <Textarea rows={5} className="font-mono" required value={config} onChange={event => setConfig(event.target.value)} />
        </label>
        <section aria-label="密钥" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">密钥</h3>
            <Button type="button" size="sm" variant="outline" onClick={() => setChanges([...changes, { key: "", value: "" }])}>添加密钥</Button>
          </div>
          {snapshot.secretKeys.length > 0 && <p className="break-all text-xs text-muted-foreground">已配置 {snapshot.secretKeys.join("、")}。填写同名密钥可替换。</p>}
          {changes.map((change, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <Input aria-label={`密钥名称 ${index + 1}`} readOnly={change.value === null} required placeholder="密钥名称" value={change.key}
                onChange={event => setChanges(changes.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} />
              {change.value === null ? <span className="text-xs text-muted-foreground">保存时移除</span>
                : <Input type="password" autoComplete="new-password" aria-label={`密钥值 ${index + 1}`} required placeholder="新值"
                  value={change.value} onChange={event => setChanges(changes.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />}
              <Button type="button" size="sm" variant="ghost" onClick={() => setChanges(changes.filter((_, i) => i !== index))}>取消</Button>
            </div>
          ))}
          {snapshot.secretKeys.filter(key => !changes.some(change => change.key === key)).map(key => (
            <Button key={key} type="button" size="sm" variant="ghost" onClick={() => setChanges([...changes, { key, value: null }])}>移除 {key}</Button>
          ))}
        </section>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p role="status" className="text-sm text-muted-foreground">配置已保存。</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || conflict || (enabled && !plugin.supported)}>保存配置</Button>
        {conflict && <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>重新加载配置</Button>}
      </div>
    </form>
  );
}
