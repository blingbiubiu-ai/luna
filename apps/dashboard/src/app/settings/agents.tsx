import { createFileRoute } from "@tanstack/react-router";

import { useRouteAgent } from "@/lib/agent-route";
import { useTranslation } from "@/lib/i18n";
import { AgentConfigDashboardView } from "./agent-config-dashboard";
import { WorkerModels } from "../plugins/worker-models";
import {
  useActivateAgentProfileRevision,
  useAgentConfigStatus,
  useAgentProfiles,
  useAgentTypeDescriptors,
  useCreateAgentProfile,
  useCreateAgentProfileRevision,
  useDeleteAgentProfile,
  useDashboardAuthSession,
  useTestAgentProfileRevision,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/settings/agents/")({
  component: AgentConfigurationPage,
});

function AgentConfigurationPage() {
  const { t } = useTranslation();
  const auth = useDashboardAuthSession();
  const agent = useRouteAgent();
  if (auth.data?.account?.id === agent.ownerAccountId && agent.status === "active") return <AgentProfiles agentId={agent.id} />;
  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-5 py-7 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("Model Configuration")}</h1>
      </header>
      {auth.error ? <p role="alert" className="text-destructive">无法加载 Agent。</p>
        : auth.isLoading ? <p>正在加载…</p>
        : <p className="text-sm text-muted-foreground">只有 Agent 所有者可以配置启用中的 Agent。</p>}
    </div>
  );
}

function AgentProfiles({ agentId }: { agentId: string }) {
  const status = useAgentConfigStatus(agentId);
  const types = useAgentTypeDescriptors(agentId);
  const profiles = useAgentProfiles(agentId);
  const create = useCreateAgentProfile(agentId);
  const createRevision = useCreateAgentProfileRevision(agentId);
  const testRevision = useTestAgentProfileRevision(agentId);
  const activate = useActivateAgentProfileRevision(agentId);
  const remove = useDeleteAgentProfile(agentId);


  return (
    <div>{typeof window !== "undefined" && new URLSearchParams(window.location.search).has("modelLogin") ? <section className="mx-auto max-w-7xl px-4 pt-6 md:px-7"><h2 className="mb-3 text-sm font-semibold">完成账号绑定</h2><WorkerModels agentId={agentId} view="embedded" /></section> : null}<AgentConfigDashboardView
      key={agentId}
      agentId={agentId}
      error={status.error ?? types.error ?? profiles.error}
      loading={status.isLoading || types.isLoading || profiles.isLoading}
      onActivate={(revisionId) => activate.mutateAsync(revisionId)}
      onCreate={(input) => create.mutateAsync(input)}
      onCreateRevision={(profileId, revision) =>
        createRevision.mutateAsync({ profileId, revision })}
      onDelete={(profileId) => remove.mutateAsync(profileId)}
      onTest={(revisionId) => testRevision.mutateAsync(revisionId)}
      profiles={profiles.data ?? []}
      status={status.data ?? { status: "setup_required", active: null }}
      types={types.data ?? []}
    /></div>
  );
}
