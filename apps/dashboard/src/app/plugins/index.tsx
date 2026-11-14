import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { PluginsDashboard } from "@/app/plugins/plugins-dashboard";
import { AgentPluginsPage } from "@/app/plugins/agent-plugins";
import { Button } from "@/components/ui/button";
import { ApiFetchError } from "@/lib/api/client";
import {
  useDisablePlugin,
  useEnablePlugin,
  usePlugins,
  useRefreshPlugins,
  useRollbackPlugin,
  useUpgradePlugin,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/plugins/")({
  component: PluginsPage,
});

function PluginsPage() {
  const [platform, setPlatform] = useState(false);
  return (
    <>
      <nav aria-label="插件管理" className="flex flex-wrap gap-2 border-b px-5 py-3">
        <Button size="sm" variant={platform ? "ghost" : "secondary"} aria-pressed={!platform} onClick={() => setPlatform(false)}>Agent 插件</Button>
        <Button size="sm" variant={platform ? "secondary" : "ghost"} aria-pressed={platform} onClick={() => setPlatform(true)}>平台插件市场</Button>
      </nav>
      {platform ? <PlatformMarketplace /> : <AgentPluginsPage />}
    </>
  );
}

function PlatformMarketplace() {
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
  if (plugins.error instanceof ApiFetchError && plugins.error.status === 403) {
    return <p className="p-6 text-sm text-muted-foreground">平台插件市场由平台管理员管理。</p>;
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
      onRollbackPlugin={(pluginId, version) =>
        void runAction(pluginId, () => rollback.mutateAsync({ pluginId, version }))}
      onUpgradePlugin={(pluginId, version) =>
        void runAction(pluginId, () => upgrade.mutateAsync({ pluginId, version }))}
      plugins={plugins.data?.plugins ?? []}
    />
  );
}
