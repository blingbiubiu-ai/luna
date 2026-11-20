import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client";

/** Shown on the page of a group chat's session: whether the Shadow listens to that chat without being addressed. */
export function SessionListeningSwitch({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const client = useQueryClient();
  const path = `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/listening`;
  const query = useQuery({ queryKey: [path], queryFn: ({ signal }) => apiFetch<{ listening: boolean | null }>(path, { signal }) });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A private chat, Work or Dashboard session has no group chat to listen to.
  if (query.data?.listening === null || query.data === undefined) return null;
  const set = async (enabled: boolean) => {
    setSaving(true); setError(null);
    try {
      client.setQueryData([path], await apiFetch<{ listening: boolean }>(path, { method: "PUT", body: JSON.stringify({ enabled }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSaving(false); }
  };
  return (
    <label
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={error ?? "开启后，这个群里没有 @ 分身的消息也会攒成一批交给它，它觉得该说话时才开口。"}
      data-testid="session-listening-switch"
    >
      <span className={error ? "text-destructive" : undefined}>{error ? "保存失败" : "旁听"}</span>
      <Switch aria-label="旁听这个群" checked={query.data.listening} disabled={saving} onCheckedChange={enabled => void set(enabled)} />
    </label>
  );
}
