import { createFileRoute } from "@tanstack/react-router";

import { AgentPluginsPage } from "@/app/plugins/agent-plugins";

/** Agent plugins: enablement, configuration and secrets. Installation is on the platform Plugins page. */
export const Route = createFileRoute("/$agentId/plugins/")({
  component: AgentPluginsPage,
});
