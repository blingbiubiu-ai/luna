import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRouteAgent } from "@/lib/agent-route";
import { apiFetch } from "@/lib/api/client";
import { dashboardAgentsKey } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";

interface ShadowChoice {
  id: string;
  name: string;
  status: string;
  avatarUrl?: string | null;
  workerRouting?: { mode: "automatic" | "bound"; workerId: string | null };
  modelSelection?: {
    mode: "inherit" | "fixed";
    revisionId: string | null;
    name: string | null;
    model: string | null;
    agentType: string | null;
    available?: boolean;
  };
}

export function useAgentShadows(agentId: string, enabled = true) {
  return useQuery({
    queryKey: [...dashboardAgentsKey, agentId, "shadows"],
    queryFn: ({ signal }) =>
      apiFetch<{ shadows: ShadowChoice[] }>(
        `/agents/${encodeURIComponent(agentId)}/shadows`,
        { signal },
      ),
    enabled,
  });
}

export function useShadowScope(defaultToBody = false, enabled = true) {
  const agent = useRouteAgent();
  const [shadowChoice, chooseShadow] = useState("");
  const shadows = useAgentShadows(agent.id, enabled);
  const availableShadows =
    shadows.data?.shadows.filter(
      (shadow) =>
        shadow.status === "active" &&
        (!defaultToBody || shadow.id !== agent.defaultShadowId),
    ) ?? [];
  const shadow = availableShadows.find((item) => item.id === shadowChoice);
  const shadowId = shadow?.id ?? (defaultToBody ? agent.defaultShadowId : undefined);
  return {
    shadow,
    availableShadows,
    defaultToBody,
    chooseShadow,
    defaultShadowId: agent.defaultShadowId,
    scope: { agentId: agent.id, ...(shadowId ? { shadowId } : {}) },
    loading: shadows.isLoading,
    error: shadows.error,
  };
}

function ShadowDot({
  name,
  avatarUrl,
}: {
  readonly name: string;
  readonly avatarUrl?: string | null | undefined;
}) {
  if (avatarUrl) {
    return (
      <img
        alt=""
        src={avatarUrl}
        className="size-4 shrink-0 rounded-full object-cover"
      />
    );
  }
  const ch = Array.from(name.trim() || "本")[0] ?? "本";
  return (
    <span className="inline-grid size-4 shrink-0 place-items-center rounded-full bg-primary/85 text-[9.5px] font-semibold text-primary-foreground">
      {ch}
    </span>
  );
}

export function ShadowPicker({
  selection,
  disabled = false,
  size = "default",
}: {
  selection: ReturnType<typeof useShadowScope>;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  const current = selection.shadow;
  const defaultLabel = selection.defaultToBody ? "本体" : "所有分身";
  const currentLabel = current
    ? current.id === selection.defaultShadowId
      ? "本体"
      : current.name
    : defaultLabel;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label="分身"
          disabled={disabled}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 border border-border bg-card font-normal text-foreground shadow-2xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
            size === "sm"
              ? "h-7 rounded-[7px] px-2 text-xs"
              : "h-9 rounded-[8px] px-3 text-[13px]",
          )}
        >
          {current ? (
            <ShadowDot name={currentLabel} avatarUrl={current.avatarUrl} />
          ) : (
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="max-w-24 truncate">{currentLabel}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[148px] rounded-[8px] border-border bg-card p-1 shadow-lg"
      >
        <DropdownMenuItem
          onSelect={() => selection.chooseShadow("")}
          className="flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-[13px]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{defaultLabel}</span>
          </span>
          {!current ? <Check className="size-3.5 shrink-0 text-foreground" /> : null}
        </DropdownMenuItem>
        {selection.availableShadows.map((item) => {
          const itemLabel = item.id === selection.defaultShadowId ? "本体" : item.name;
          const active = current?.id === item.id;
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => selection.chooseShadow(item.id)}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-[13px]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <ShadowDot name={itemLabel} avatarUrl={item.avatarUrl} />
                <span className="truncate">{itemLabel}</span>
              </span>
              {active ? <Check className="size-3.5 shrink-0 text-foreground" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
