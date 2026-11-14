import { createFileRoute } from "@tanstack/react-router";

import { PluginDetailDashboard } from "@/app/plugins/plugins-dashboard";
import {
  useDisablePlugin,
  useEnablePlugin,
  usePlugin,
  useRollbackPlugin,
  useUpgradePlugin,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/plugins/$pluginId")({
  component: PluginDetailPage,
});

function PluginDetailPage() {
  const { pluginId } = Route.useParams();
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
      onRollbackPlugin={(id, version) =>
        rollback.mutate({ pluginId: id, version })}
      onUpgradePlugin={(id, version) =>
        upgrade.mutate({ pluginId: id, version })}
    />
  );
}
