import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useRouteAgent } from "@/lib/agent-route";
import { apiFetch } from "@/lib/api/client";
import { dashboardAgentsKey } from "@/lib/api/hooks";

interface ShadowChoice {
  id: string;
  name: string;
  status: string;
  workerRouting?: { mode: "automatic" | "bound"; workerId: string | null };
  modelSelection?: {mode:"inherit"|"fixed";revisionId:string|null;name:string|null;model:string|null;agentType:string|null;available?:boolean};
}

export function useAgentShadows(agentId: string, enabled = true) {
  return useQuery({
    queryKey: [...dashboardAgentsKey, agentId, "shadows"],
    queryFn: ({ signal }) => apiFetch<{ shadows: ShadowChoice[] }>(`/agents/${encodeURIComponent(agentId)}/shadows`, { signal }),
    enabled,
  });
}

export function useShadowScope(defaultToBody = false, enabled = true) {
  const agent = useRouteAgent();
  const [shadowChoice, chooseShadow] = useState("");
  const shadows = useAgentShadows(agent.id, enabled);
  const availableShadows = shadows.data?.shadows.filter(shadow =>
    shadow.status === "active" && (!defaultToBody || shadow.id !== agent.defaultShadowId),
  ) ?? [];
  const shadow = availableShadows.find(item => item.id === shadowChoice);
  const shadowId = shadow?.id ?? (defaultToBody ? agent.defaultShadowId : undefined);
  return {
    shadow, availableShadows, defaultToBody, chooseShadow, defaultShadowId: agent.defaultShadowId,
    scope: { agentId: agent.id, ...(shadowId ? { shadowId } : {}) },
    loading: shadows.isLoading, error: shadows.error,
  };
}

export function ShadowPicker({ selection, disabled = false }: {
  selection: ReturnType<typeof useShadowScope>;
  disabled?: boolean;
}) {
  return (
    <select aria-label="分身" className="h-9 rounded-md border bg-background px-2 text-sm"
      value={selection.shadow?.id ?? ""} disabled={disabled}
      onChange={event => selection.chooseShadow(event.target.value)}>
      <option value="">{selection.defaultToBody ? "本体" : "所有分身"}</option>
      {selection.availableShadows.map(item => (
        <option key={item.id} value={item.id}>{item.id === selection.defaultShadowId ? "本体" : item.name}</option>
      ))}
    </select>
  );
}
