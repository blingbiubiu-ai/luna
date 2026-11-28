import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, RefreshCw } from "lucide-react";

import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { LanguageToggle } from "@/components/language-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PluginDetailDashboard, PluginsDashboard } from "@/app/plugins/plugins-dashboard";
import { PlatformAccountsPage } from "@/app/platform-accounts";
import { PlatformSettingsPage } from "@/app/platform-settings";
import { LineageInvitePage } from "@/app/lineage-invite";
import {
  useDashboardAgents, useDashboardMe, useDisablePlugin, useEnablePlugin, usePlugin, usePlugins,
  useRefreshPlugins, useRollbackPlugin, useUpgradePlugin,
} from "@/lib/api";
import { ApiFetchError } from "@/lib/api/client";
import { appHistory } from "@/lib/app-history";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

/** Content beside the platform rail for pages outside any Agent: the Agents entry (opens the first Agent) and, for platform administrators, platform management. */
export function PlatformShell({ pathname }: { readonly pathname: string }) {
  const path = pathname.replace(/\/$/, "") || "/";
  const me = useDashboardMe();
  const isAdmin = me.data?.isPlatformAdmin === true;
  const detail = /^\/platform\/plugins\/([^/]+)$/.exec(path);
  const inviteMatch = /^\/invite\/([^/]+)$/.exec(path);
  let title = "Agents";
  let page: ReactNode = <AgentsLanding />;
  if (inviteMatch) {
    title = "接收传承记忆";
    page = <LineageInvitePage token={decodeURIComponent(inviteMatch[1]!)} />;
  } else if (path === "/platform/settings") {
    title = "设置";
    page = me.isPending
      ? <p role="status" className="p-6">正在加载…</p>
      : me.isError
        ? <p role="alert" className="p-6 text-sm text-muted-foreground">无法验证平台管理员权限，请刷新后重试。</p>
        : !isAdmin
          ? <p role="alert" className="p-6 text-sm text-muted-foreground">平台设置需要平台管理员权限。</p>
          : <PlatformSettingsPage />;
  } else if (path === "/platform/accounts") {
    title = "账号管理";
    page = me.isPending
      ? <p role="status" className="p-6">正在加载…</p>
      : !isAdmin
        ? <p role="alert" className="p-6 text-sm text-muted-foreground">账号管理需要平台管理员权限。</p>
        : <PlatformAccountsPage currentAccountId={me.data?.account?.id} />;
  } else if (path === "/platform/plugins" || detail) {
    title = "插件管理";
    page = me.isPending ? <p role="status" className="p-6">正在加载…</p>
      : !isAdmin ? <p role="alert" className="p-6 text-sm text-muted-foreground">插件管理需要平台管理员权限。</p>
      : detail ? <PlatformPluginDetail pluginId={decodeURIComponent(detail[1]!)} />
      : <PlatformPlugins />;
  }
  return (
    <TooltipProvider delayDuration={0}>
      <div className="luna-shell flex h-svh min-w-0 flex-1 flex-col">
        <ShellHeader title={title} />
        <div className="luna-content flex flex-1 min-h-0 flex-col">{page}</div>
      </div>
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}

function ShellHeader({ title }: { readonly title: string }) {
  const queryClient = useQueryClient();
  return (
    <header className="luna-header flex shrink-0 items-center gap-2">
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

/** First Agent to open from the Agents entry; null when the user has none. */
export function agentsLandingHref(agents: readonly DashboardAgentChoice[]): string | null {
  return agents[0] ? `/agent/${encodeURIComponent(agents[0].id)}` : null;
}

/** `/` opens the first Agent; with no Agent it offers to create one. */
function AgentsLanding() {
  const agents = useDashboardAgents();
  const target = agents.data ? agentsLandingHref(agents.data.agents) : null;
  useEffect(() => { if (target) appHistory.replace(target); }, [target]);
  if (agents.isError) return <p role="alert" className="p-6 text-sm text-destructive">无法加载 Agent。</p>;
  if (!agents.isSuccess || target) return <p role="status" className="p-6 text-sm text-muted-foreground">正在打开 Agent…</p>;
  return <NoAgents />;
}

export function NoAgents() {
  const [creating, setCreating] = useState(false);
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div className="space-y-3 rounded-xl border border-dashed bg-card p-6">
        <h1 className="text-base font-semibold">还没有 Agent</h1>
        <p className="text-sm text-muted-foreground">新建一个 Agent 后会直接进入它的工作台。</p>
        <Button onClick={() => setCreating(true)}><PlusIcon className="size-4" />新建 Agent</Button>
      </div>
      <CreateAgentDialog open={creating} onOpenChange={setCreating} />
    </main>
  );
}

function PlatformPlugins() {
  const agents=useDashboardAgents();const me=useDashboardMe();
  const modelAgent=agents.data?.agents.find(agent=>agent.ownerAccountId===me.data?.account?.id&&agent.status==="active");
  const modelConfigHref=modelAgent?`/agent/${encodeURIComponent(modelAgent.id)}/settings/agents`:undefined;
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
    return <div>{modelConfigHref?<div className="px-6 pt-6"><Button asChild variant="outline"><a href={modelConfigHref}>模型账号登录与 API</a></Button></div>:null}<PluginSourceUnconfigured /></div>;
  }
  return (
    <PluginsDashboard
      {...(modelConfigHref?{modelConfigHref}:{})}
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
      <div role="status" className="space-y-3 rounded-xl border border-dashed bg-card p-6 text-sm">
        <h1 className="text-base font-semibold">未配置插件源</h1>
        <p className="text-muted-foreground">平台还没有可拉取插件的来源，所以插件列表为空。</p>
        <p className="text-muted-foreground">
          请前往 <a href="/platform/settings" className="font-medium text-foreground underline underline-offset-4">平台设置 → 插件市场源</a> 填写插件仓库 Git 地址（及分支），保存后即可直接在这里刷新、安装插件。
        </p>
      </div>
    </main>
  );
}
