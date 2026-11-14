import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useDashboardAgent } from "@/lib/api";
import { DashboardAgentContext } from "@/lib/agent-route";

export const Route = createFileRoute("/$agentId")({
  component: AgentLayout,
});

function AgentLayout() {
  const { agentId } = Route.useParams();
  const agent = useDashboardAgent(agentId);

  if (agent.isPending) return <p role="status" className="p-6">正在加载 Agent…</p>;
  if (!agent.data) {
    return <div className="space-y-3 p-6">
      <p role="alert">无法打开此 Agent。</p>
      <a className="underline" href="/">返回 Agent 首页</a>
    </div>;
  }

  return <DashboardAgentContext.Provider key={agentId} value={agent.data.agent}>
    <Outlet />
  </DashboardAgentContext.Provider>;
}
