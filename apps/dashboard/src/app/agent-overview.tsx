import { createFileRoute } from "@tanstack/react-router";
import { useRuntimeStatus, useSessions, useTasks } from "@/lib/api";
import { useAgentBasePath } from "@/lib/agent-route";
import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { HomeOverview } from "./home-overview";

export const Route = createFileRoute("/$agentId/")({ component: AgentOverview });

function AgentOverview() {
  const base = useAgentBasePath();
  const selection = useShadowScope();
  const { scope } = selection;
  const { data: tasks = [], isLoading: tasksLoading } = useTasks(scope);
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions(scope);
  const { data: runtimeStatus, isLoading: runtimeLoading, error: runtimeError } = useRuntimeStatus();

  return (
    <HomeOverview
      scopePicker={<>
        <a className="text-sm underline" href="/">返回 Agent 首页</a>
        {selection.availableShadows.length > 1 && <ShadowPicker selection={selection} />}
        <a className="text-sm underline" href={`${base}/settings/channels`}>数字分身</a>
      </>}
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
