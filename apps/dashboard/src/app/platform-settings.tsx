import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client";

export interface OrphanCleanup { enabled: boolean; intervalMinutes: number; retentionDays: number; }
interface PlatformSettings { orphanCleanup: OrphanCleanup; canEdit: boolean; }

const PATH = "/platform-settings";

/** Platform-wide settings; every account sees them, platform administrators change them. */
export function PlatformSettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: [PATH], queryFn: ({ signal }) => apiFetch<PlatformSettings>(PATH, { signal }) });
  const save = useMutation({
    mutationFn: (value: OrphanCleanup) => apiFetch<{ orphanCleanup: OrphanCleanup }>(`${PATH}/orphan-cleanup`, { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: () => client.invalidateQueries({ queryKey: [PATH] }),
  });
  return <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-6">
    <div>
      <h1 className="text-2xl font-semibold">设置</h1>
      <p className="text-muted-foreground">对整个平台生效。</p>
    </div>
    {query.error && <p role="alert" className="text-destructive">无法加载设置。{query.error.message}</p>}
    {query.isLoading && <p role="status">正在加载…</p>}
    {query.data && <OrphanCleanupForm key={JSON.stringify(query.data.orphanCleanup)} settings={query.data.orphanCleanup}
      canEdit={query.data.canEdit} saving={save.isPending} error={save.error} saved={save.isSuccess}
      onSave={value => save.mutate(value)} />}
  </main>;
}

export function OrphanCleanupForm({ settings, canEdit, saving, error, saved, onSave }: {
  readonly settings: OrphanCleanup; readonly canEdit: boolean; readonly saving: boolean;
  readonly error: Error | null; readonly saved: boolean; readonly onSave: (value: OrphanCleanup) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [interval, setIntervalText] = useState(String(settings.intervalMinutes));
  const [retention, setRetention] = useState(String(settings.retentionDays));
  const [touched, setTouched] = useState(false);
  const minutes = Number(interval), days = Number(retention);
  const intervalValid = Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440;
  const retentionValid = Number.isInteger(days) && days >= 1 && days <= 365;
  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setTouched(true); };
  return <section className="space-y-4 rounded-lg border p-4" aria-labelledby="orphan-cleanup-title">
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h2 id="orphan-cleanup-title" className="font-medium">自动清理孤儿数据</h2>
        <p className="text-sm text-muted-foreground">
          Service 定期询问每台 Worker 上有哪些分身。分身或其 Agent 已删除、或 Service 不认识的，先删除容器；
          保留期满仍不认识时，再删除它的 /data 卷和 HOME。期间 Service 重新认出它，就保留不删。
        </p>
      </div>
      <Switch aria-label="自动清理孤儿数据" checked={enabled} disabled={disabled} onCheckedChange={edit(setEnabled)} />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">
        <span className="font-medium">对账周期（分钟）</span>
        <Input type="number" inputMode="numeric" min={5} max={1440} value={interval} disabled={disabled || !enabled}
          aria-invalid={!intervalValid} onChange={event => edit(setIntervalText)(event.target.value)} />
        <span className="block text-xs text-muted-foreground">5 到 1440 分钟，默认 60。</span>
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium">数据保留期（天）</span>
        <Input type="number" inputMode="numeric" min={1} max={365} value={retention} disabled={disabled || !enabled}
          aria-invalid={!retentionValid} onChange={event => edit(setRetention)(event.target.value)} />
        <span className="block text-xs text-muted-foreground">1 到 365 天，默认 7。</span>
      </label>
    </div>
    {!enabled && <p className="text-sm text-muted-foreground">已关闭：Service 不再对账，Worker 上的数据都不会被自动删除。</p>}
    {!canEdit && <p className="text-sm text-muted-foreground">只有平台管理员可以修改。</p>}
    {error && <p role="alert" className="text-sm text-destructive">保存失败。{error.message}</p>}
    {saved && !touched && <p role="status" className="text-sm text-muted-foreground">已保存。</p>}
    {canEdit && <Button disabled={saving || !touched || !intervalValid || !retentionValid}
      onClick={() => onSave({ enabled, intervalMinutes: minutes, retentionDays: days })}>{saving ? "正在保存…" : "保存"}</Button>}
  </section>;
}
