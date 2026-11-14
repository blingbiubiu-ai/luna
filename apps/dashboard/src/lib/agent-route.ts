import { createContext, useContext } from "react";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

export const DashboardAgentContext = createContext<DashboardAgentChoice | null>(null);

export function useRouteAgent() {
  const agent = useContext(DashboardAgentContext);
  if (!agent) throw new Error("Agent route context is missing");
  return agent;
}

export function useAgentBasePath() {
  const agent = useContext(DashboardAgentContext);
  return agent ? `/agent/${encodeURIComponent(agent.id)}` : "/agent";
}
