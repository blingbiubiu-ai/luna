import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useRouteAgent } from "@/lib/agent-route";
import { apiFetch } from "@/lib/api/client";

export const Route = createFileRoute("/$agentId/settings/general/")({ component: AgentSettingsPage });

export type ProgressCardStyle = "card" | "native";
export interface AgentSettings {
  work: { progressCard: { show: boolean; style: ProgressCardStyle } };
  main: { taskProgressCard: { send: boolean; style: ProgressCardStyle } };
}

function AgentSettingsPage() {
  const agent = useRouteAgent();
  return <AgentSettingsLoader key={agent.id} agentId={agent.id} agentName={agent.name} />;
}

function AgentSettingsLoader({ agentId, agentName }: { agentId: string; agentName: string }) {
  const client = useQueryClient();
  const path = `/agents/${encodeURIComponent(agentId)}/settings`;
  const query = useQuery({ queryKey: [path], queryFn: ({ signal }) => apiFetch<{ settings: AgentSettings }>(path, { signal }) });
  const save = useMutation({
    mutationFn: (settings: AgentSettings) => apiFetch<{ settings: AgentSettings }>(path, { method: "PUT", body: JSON.stringify(settings) }),
    onSuccess: data => client.setQueryData([path], data),
  });
  return <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-6">
    <div>
      <h1 className="text-2xl font-semibold">Agent 设置</h1>
      <p className="text-muted-foreground">{agentName} 的通用设置，对它的所有分身生效。</p>
    </div>
    {query.error && <p role="alert" className="text-destructive">无法加载设置。{query.error.message}</p>}
    {query.isLoading && <p role="status">正在加载…</p>}
    {query.data && <AgentSettingsForm key={JSON.stringify(query.data.settings)} settings={query.data.settings}
      saving={save.isPending} error={save.error} saved={save.isSuccess} onSave={value => save.mutate(value)} />}
  </main>;
}

export function AgentSettingsForm({ settings, saving, error, saved, onSave }: {
  readonly settings: AgentSettings; readonly saving: boolean; readonly error: Error | null;
  readonly saved: boolean; readonly onSave: (value: AgentSettings) => void;
}) {
  const [value, setValue] = useState(settings);
  const [touched, setTouched] = useState(false);
  const update = (next: AgentSettings) => { setValue(next); setTouched(true); };
  const work = value.work.progressCard, main = value.main.taskProgressCard;
  return <div className="space-y-4">
    <section className="space-y-4 rounded-lg border p-4" aria-labelledby="work-progress-title">
      <div>
        <h2 id="work-progress-title" className="font-medium">Work 会话进度卡</h2>
        <p className="text-sm text-muted-foreground">`#work` 会话执行时，在话题里展示并实时更新的进度。</p>
      </div>
      <Row label="展示进度卡" hint="关闭后执行中和完成时都不发进度卡；执行出错或被取消仍会提示。">
        <Switch aria-label="展示 Work 进度卡" checked={work.show} disabled={saving}
          onCheckedChange={show => update({ ...value, work: { progressCard: { ...work, show } } })} />
      </Row>
      <Row label="进度卡样式">
        <StyleChoice name="work-style" value={work.style} disabled={saving || !work.show}
          onChange={style => update({ ...value, work: { progressCard: { ...work, style } } })} />
      </Row>
    </section>
    <section className="space-y-4 rounded-lg border p-4" aria-labelledby="main-progress-title">
      <div>
        <h2 id="main-progress-title" className="font-medium">Main 启动任务的进度卡</h2>
        <p className="text-sm text-muted-foreground">主会话启动任务时默认怎么发进度卡。用户或 Agent 对某个任务另有要求时，以那次的要求为准。</p>
      </div>
      <Row label="发送进度卡">
        <Switch aria-label="Main 启动任务时发送进度卡" checked={main.send} disabled={saving}
          onCheckedChange={send => update({ ...value, main: { taskProgressCard: { ...main, send } } })} />
      </Row>
      <Row label="默认样式">
        <StyleChoice name="main-style" value={main.style} disabled={saving || !main.send}
          onChange={style => update({ ...value, main: { taskProgressCard: { ...main, style } } })} />
      </Row>
    </section>
    {error && <p role="alert" className="text-sm text-destructive">保存失败。{error.message}</p>}
    {saved && !touched && <p role="status" className="text-sm text-muted-foreground">已保存。</p>}
    <Button disabled={saving || !touched} onClick={() => { onSave(value); setTouched(false); }}>{saving ? "正在保存…" : "保存"}</Button>
  </div>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="space-y-0.5">
      <p className="text-sm font-medium">{label}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
    {children}
  </div>;
}

const STYLES: { value: ProgressCardStyle; label: string; hint: string }[] = [
  { value: "card", label: "卡片", hint: "带标题和步骤列表的交互卡片" },
  { value: "native", label: "飞书原生进度", hint: "飞书自带的执行过程消息，样式更轻" },
];

function StyleChoice({ name, value, disabled, onChange }: {
  name: string; value: ProgressCardStyle; disabled: boolean; onChange: (style: ProgressCardStyle) => void;
}) {
  return <div role="radiogroup" aria-label={name === "work-style" ? "Work 进度卡样式" : "Main 进度卡默认样式"} className="flex gap-2">
    {STYLES.map(style => <label key={style.value} title={style.hint}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${value === style.value ? "border-primary bg-primary/5" : ""} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
      <input type="radio" name={name} value={style.value} checked={value === style.value} disabled={disabled}
        onChange={() => onChange(style.value)} />
      {style.label}
    </label>)}
  </div>;
}
