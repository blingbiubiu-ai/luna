import { createFileRoute } from "@tanstack/react-router";

import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { useRouteAgent } from "@/lib/agent-route";
import {
  useAgentConfigStatus,
  useRuntimeStatus,
  useSessions,
  useTasks,
} from "@/lib/api";

import { HomeOverview } from "./home-overview";

export const Route = createFileRoute("/$agentId/")({ component: AgentOverview });

function AgentOverview() {
  const agent = useRouteAgent();
  const selection = useShadowScope();
  const { scope } = selection;
  const { data: tasks = [], isLoading: tasksLoading } = useTasks(scope);
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions(scope);
  const {
    data: runtimeStatus,
    isLoading: runtimeLoading,
    error: runtimeError,
  } = useRuntimeStatus(agent.id);
  const configStatus = useAgentConfigStatus(agent.id);
  const activeProfile = configStatus.data?.active;
  const activeModelLabel = activeProfile
    ? `${activeProfile.agentType} · ${activeProfile.model}`
    : undefined;

  return (
    <HomeOverview
      activeModelLabel={activeModelLabel}
      shadowCount={selection.availableShadows.length}
      scopePicker={
        selection.availableShadows.length > 1 ? (
          <ShadowPicker selection={selection} size="sm" />
        ) : null
      }
      scopeError={selection.error}
      tasks={tasks}
      sessions={sessions}
      tasksLoading={tasksLoading}
      sessionsLoading={sessionsLoading}
      runtimeStatus={runtimeStatus}
      runtimeLoading={runtimeLoading}
      runtimeError={runtimeError}
    />
  );
}
