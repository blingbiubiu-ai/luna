import { useMatch } from "@tanstack/react-router";
import { useDashboardAgent } from "@/lib/api";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb";

export function AppBreadcrumb() {
  const detail = useMatch({ from: "/$agentId", shouldThrow: false });
  const agent = useDashboardAgent(detail?.params.agentId);
  if (!detail) return null;

  return <Breadcrumb aria-label="当前 Agent" className="min-w-0">
    <BreadcrumbList>
      <BreadcrumbItem className="min-w-0">
        <BreadcrumbPage className="truncate font-semibold">
          {agent.data?.agent.name ?? "Agent"}
        </BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>;
}
