import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client";
import { useAgentBasePath } from "@/lib/agent-route";

interface RootSettings { shadowId: string; enabled: boolean }

/**
 * Shadow root switch. Saves immediately: it is separate from the editor's "save and apply",
 * because turning it on or off replaces the Shadow's container. Who is trusted is the
 * `agent.root` grant on the Users and Groups pages.
 */
export function ShadowRootAccess({ agentId, shadowId, disabled }: { agentId: string; shadowId: string; disabled?: boolean }) {
  const path = `/agents/${encodeURIComponent(agentId)}/shadows/${encodeURIComponent(shadowId)}/root`;
  const base = useAgentBasePath();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: [path], queryFn: ({ signal }) => apiFetch<RootSettings>(path, { signal }) });
  const update = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<RootSettings>(path, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: data => client.setQueryData([path], data),
  });
  const data = settings.data;
  const busy = disabled || update.isPending || !data;

  function toggle(enabled: boolean) {
    const message = enabled
      ? "开启 root 后，这个分身的任务可以在容器里使用 sudo，由 Agent 判断是否是受信用户想做或同意的操作。\n\n分身的容器会在空闲时重建：系统盘（apt 安装的软件等）会被重置，HOME 保留。确认开启？"
      : "关闭 root 后，分身的容器会在空闲时重建：系统盘（apt 安装的软件等）会被重置，HOME 保留。确认关闭？";
    if (confirm(message)) update.mutate(enabled);
  }

  return <section aria-label="Root 权限" className="space-y-2 border-t px-6 py-4">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3 className="text-sm font-medium">Root 权限</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          开启后，任务可以使用 sudo。Agent 只为受信用户想做或同意的事使用它；需求来自其他人时，会先征求受信用户同意。
        </p>
      </div>
      <Switch aria-label="开启 root" checked={data?.enabled ?? false} disabled={busy} onCheckedChange={toggle} />
    </div>
    <p className="text-xs text-muted-foreground">
      受信用户：Agent 主人，以及在<a className="underline" href={`${base}/users`}>用户</a>或<a className="underline" href={`${base}/groups`}>用户组</a>页被授予「Root 权限」（<code>agent.root</code>）的人。
    </p>
    {(settings.error || update.error) && <p role="alert" className="text-sm text-destructive">
      {update.error ? `无法保存 root 设置。${update.error.message}` : "无法加载 root 设置。"}
    </p>}
  </section>;
}
