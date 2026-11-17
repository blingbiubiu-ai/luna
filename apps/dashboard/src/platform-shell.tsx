import { useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, BlocksIcon, Bot, PlusIcon, RefreshCw } from "lucide-react";

import { AppSidebar } from "@/components/app-sidebar";
import { CreateNameForm } from "@/components/create-name-form";
import { LanguageToggle } from "@/components/language-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarInset, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { PluginDetailDashboard, PluginsDashboard } from "@/app/plugins/plugins-dashboard";
import {
  useDashboardAgents, useDashboardMe, useDisablePlugin, useEnablePlugin, usePlugin, usePlugins,
  useRefreshPlugins, useRollbackPlugin, useUpgradePlugin,
} from "@/lib/api";
import { ApiFetchError, apiFetch } from "@/lib/api/client";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

/** Pages outside any Agent: the Agent list and, for platform administrators, platform management. */
export function PlatformShell({ pathname }: { readonly pathname: string }) {
  const path = pathname.replace(/\/$/, "") || "/";
  const me = useDashboardMe();
  const isAdmin = me.data?.isPlatformAdmin === true;
  const detail = /^\/platform\/plugins\/([^/]+)$/.exec(path);
  let title = "我的 Agent";
  let page: ReactNode = <AgentList />;
  if (path === "/platform/plugins" || detail) {
    title = "插件管理";
    page = me.isPending ? <p role="status" className="p-6">正在加载…</p>
      : !isAdmin ? <p role="alert" className="p-6 text-sm text-muted-foreground">插件管理需要平台管理员权限。</p>
      : detail ? <PlatformPluginDetail pluginId={decodeURIComponent(detail[1]!)} />
      : <PlatformPlugins />;
  }
  return (
    <SidebarProvider style={{ "--sidebar-width": "14rem" } as CSSProperties}>
      <AppSidebar nav={<PlatformNav path={path} isAdmin={isAdmin} />} />
      <SidebarInset className="luna-shell h-svh min-w-0">
        <ShellHeader title={title} />
        <div className="luna-content flex flex-1 min-h-0 flex-col">{page}</div>
      </SidebarInset>
      <Toaster position="top-center" />
    </SidebarProvider>
  );
}

function ShellHeader({ title }: { readonly title: string }) {
  const queryClient = useQueryClient();
  return (
    <header className="luna-header flex shrink-0 items-center gap-2">
      <SidebarTrigger className="-ml-1" />
      <span className="truncate font-semibold">{title}</span>
      <div className="luna-header-actions ml-auto">
        <Button variant="ghost" size="icon" aria-label="刷新页面" onClick={() => void queryClient.invalidateQueries()}>
          <RefreshCw className="size-4" />
        </Button>
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}

export function PlatformNav({ path, isAdmin }: { readonly path: string; readonly isAdmin: boolean }) {
  const groups = [
    { title: "工作台", items: [{ title: "我的 Agent", href: "/", icon: Bot, active: path === "/" }] },
    ...(isAdmin ? [{ title: "平台管理", items: [
      { title: "插件管理", href: "/platform/plugins", icon: BlocksIcon, active: path.startsWith("/platform/plugins") },
    ] }] : []),
  ];
  return <>
    {groups.map(group => (
      <SidebarGroup key={group.title}>
        <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {group.items.map(item => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={item.active} tooltip={item.title}>
                  <a href={item.href}><item.icon /><span>{item.title}</span></a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    ))}
  </>;
}

export function AgentList() {
  const agents = useDashboardAgents();
  const items = agents.data?.agents ?? [];
  async function createAgent(name: string, key: string) {
    const { agent } = await apiFetch<{ agent: DashboardAgentChoice }>("/agents", {
      method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ name }),
    });
    window.location.assign(`/agent/${encodeURIComponent(agent.id)}`);
  }
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">我的 Agent</h1>
          <p className="text-sm text-muted-foreground">打开你拥有的 Agent 工作台。</p>
        </div>
        <Dialog>
          <DialogTrigger asChild><Button><PlusIcon className="size-4" />新建 Agent</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>新建 Agent</DialogTitle></DialogHeader>
            <CreateNameForm label="Agent 名称" action="创建 Agent" onCreate={createAgent} />
          </DialogContent>
        </Dialog>
      </div>
      {agents.isLoading && <p role="status" className="text-sm text-muted-foreground">正在加载…</p>}
      {agents.isError && <p role="alert" className="rounded-xl border bg-card p-5 text-sm text-destructive">无法加载 Agent。</p>}
      {agents.isSuccess && items.length === 0 && (
        <p className="rounded-xl border border-dashed bg-card p-6 text-sm text-muted-foreground">暂无 Agent，点击右上角新建。</p>
      )}
      {items.length > 0 && (
        <ul aria-label="我的 Agent" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map(agent => (
            <li key={agent.id}>
              <a className="group block h-full rounded-xl outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                href={`/agent/${encodeURIComponent(agent.id)}`}>
                <Card className="luna-metric h-full gap-0 py-0 transition-colors group-hover:border-primary/45 group-hover:bg-muted/30">
                  <CardContent className="flex min-h-24 items-center gap-4 p-5">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                      <Bot className="size-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words font-semibold">{agent.name}</h3>
                      {agent.status === "disabled" && <Badge className="mt-2" variant="secondary">已停用</Badge>}
                    </div>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                  </CardContent>
                </Card>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function PlatformPlugins() {
  const plugins = usePlugins();
  const refresh = useRefreshPlugins();
  const enable = useEnablePlugin();
  const disable = useDisablePlugin();
  const upgrade = useUpgradePlugin();
  const rollback = useRollbackPlugin();
  const [actionError, setActionError] = useState<unknown>();
  const [pendingPluginId, setPendingPluginId] = useState<string>();
  async function runAction(pluginId: string, action: () => Promise<unknown>) {
    setActionError(undefined);
    setPendingPluginId(pluginId);
    try { await action(); await plugins.refetch(); }
    catch (error) { setActionError(error); }
    finally { setPendingPluginId(undefined); }
  }
  async function refreshList() {
    setActionError(undefined);
    try { await refresh.mutateAsync(); }
    catch (error) { setActionError(error); }
  }
  if (plugins.error instanceof ApiFetchError && plugins.error.code === "plugin_marketplace_unconfigured") {
    return <PluginSourceUnconfigured />;
  }
  return (
    <PluginsDashboard
      error={plugins.error}
      actionError={actionError}
      pendingPluginId={pendingPluginId}
      isRefreshing={refresh.isPending}
      isLoading={plugins.isLoading}
      onDisablePlugin={(pluginId) => void runAction(pluginId, () => disable.mutateAsync(pluginId))}
      onEnablePlugin={(pluginId, version) => void runAction(pluginId, () => enable.mutateAsync({ pluginId, version }))}
      onRefreshMarketplace={() => void refreshList()}
      onRollbackPlugin={(pluginId, version) => void runAction(pluginId, () => rollback.mutateAsync({ pluginId, version }))}
      onUpgradePlugin={(pluginId, version) => void runAction(pluginId, () => upgrade.mutateAsync({ pluginId, version }))}
      plugins={plugins.data?.plugins ?? []}
    />
  );
}

function PlatformPluginDetail({ pluginId }: { readonly pluginId: string }) {
  const plugin = usePlugin(pluginId);
  const enable = useEnablePlugin();
  const disable = useDisablePlugin();
  const upgrade = useUpgradePlugin();
  const rollback = useRollbackPlugin();
  return (
    <PluginDetailDashboard
      plugin={plugin.data}
      onDisablePlugin={(id) => disable.mutate(id)}
      onEnablePlugin={(id, version) => enable.mutate({ pluginId: id, version })}
      onRollbackPlugin={(id, version) => rollback.mutate({ pluginId: id, version })}
      onUpgradePlugin={(id, version) => upgrade.mutate({ pluginId: id, version })}
    />
  );
}

export function PluginSourceUnconfigured() {
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div role="status" className="space-y-2 rounded-xl border border-dashed bg-card p-6 text-sm">
        <h1 className="text-base font-semibold">未配置插件源</h1>
        <p className="text-muted-foreground">平台还没有可拉取插件的来源，所以插件列表为空。</p>
        <p className="text-muted-foreground">
          在 Service 的 <code>config.yaml</code> 中设置 <code>plugins.marketplace.gitUrl</code>（可选 <code>branch</code>），重启 Service 后即可在这里刷新、安装插件。
        </p>
      </div>
    </main>
  );
}
