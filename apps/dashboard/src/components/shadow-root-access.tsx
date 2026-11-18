import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface RootSettings { shadowId: string; enabled: boolean }

const ROOT_HINT = "开启后，受信用户触发的任务可在容器内使用 sudo，并由 Agent 判断是否为受信用户期望的操作。"
  + "受信用户是 Agent 主人，以及在用户或用户组页被授予「Root 权限」（agent.root）的人。";

/**
 * Shadow root switch on the Shadow card. Saves immediately because turning it on or off
 * replaces the Shadow's container once idle. `hostRefusal` is the Worker host's reason when
 * root cannot take effect there.
 */
export function ShadowRootSwitch({ agentId, shadowId, disabled, hostRefusal }: {
  agentId: string; shadowId: string; disabled?: boolean; hostRefusal?: string;
}) {
  const path = `/agents/${encodeURIComponent(agentId)}/shadows/${encodeURIComponent(shadowId)}/root`;
  const client = useQueryClient();
  const settings = useQuery({ queryKey: [path], queryFn: ({ signal }) => apiFetch<RootSettings>(path, { signal }) });
  const update = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<RootSettings>(path, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: data => client.setQueryData([path], data),
  });
  function toggle(enabled: boolean) {
    const message = enabled
      ? `${ROOT_HINT}\n\n请勿在面向外部非受信访客的分身上开启 root（避免提示词注入误导受信会话）。\n\n分身的容器会在空闲时重建：系统盘（apt 安装的软件等）会被重置，HOME 保留。确认开启？`
      : "关闭 root 后，分身的容器会在空闲时重建：系统盘（apt 安装的软件等）会被重置，HOME 保留。确认关闭？";
    if (confirm(message)) update.mutate(enabled);
  }
  return <ShadowRootSwitchView enabled={settings.data?.enabled ?? false} busy={disabled || update.isPending || !settings.data}
    hostRefusal={hostRefusal} error={update.error ? `无法保存：${update.error.message}` : settings.error ? "无法加载 root 设置" : undefined}
    onToggle={toggle} />;
}

export function ShadowRootSwitchView({ enabled, busy, hostRefusal, error, onToggle }: {
  enabled: boolean; busy: boolean; hostRefusal?: string; error?: string; onToggle: (enabled: boolean) => void;
}) {
  const label = error ?? (enabled && hostRefusal ? "root 未生效" : enabled ? "root 已开启 · 需受信用户同意" : "root");
  return <label title={hostRefusal ?? ROOT_HINT} className={cn("flex shrink-0 items-center gap-2 text-xs",
    error || (enabled && hostRefusal) ? "text-destructive" : enabled ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
    {label}
    <Switch aria-label="root 权限" checked={enabled} disabled={busy} onCheckedChange={onToggle} />
  </label>;
}
