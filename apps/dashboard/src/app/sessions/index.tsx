import { apiFetch } from "@/lib/api/client";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { useAgentBasePath } from "@/lib/agent-route";
import { appHistory } from "@/lib/app-history";
import { useSessions } from "@/lib/api";
import { SessionsList } from "./sessions-list";

export const Route = createFileRoute("/$agentId/sessions/")({
  component: SessionsPage,
});

function SessionsPage() {
  const selection = useShadowScope(true);
  const base = useAgentBasePath();
  const sessions = useSessions(selection.scope);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>("/sessions/dashboard", {
        method: "POST",
        body: JSON.stringify(selection.scope),
      });
      appHistory.push(`${base}/sessions/${encodeURIComponent(result.sessionId)}`);
    } catch (error) {
      setCreateError(error);
      setCreating(false);
    }
  }

  return (
    <SessionsList
      sessions={sessions.data ?? []}
      query={query}
      setQuery={setQuery}
      loading={sessions.isLoading || selection.loading}
      error={createError ?? sessions.error ?? selection.error}
      onCreate={() => void create()}
      creating={creating}
      createDisabled={selection.loading || Boolean(selection.error)}
      createScope={<ShadowPicker selection={selection} disabled={creating} />}
    />
  );
}
