import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client";

/** Shown on the page of a group chat's session: whether the Shadow listens to that chat without being addressed. */
export function SessionListeningSwitch({
  agentId,
  sessionId,
  isTopic = false,
  groupName,
}: {
  agentId: string;
  sessionId: string;
  isTopic?: boolean;
  groupName?: string | null;
}) {
  const client = useQueryClient();
  const path = `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/listening`;
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => apiFetch<{ listening: boolean | null }>(path, { signal }),
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A private chat, Work or Dashboard session has no group chat to listen to.
  if (query.data?.listening === null || query.data === undefined) return null;
  const set = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<{ listening: boolean }>(path, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      client.setQueryData([path], updated);
      void client.invalidateQueries({ queryKey: ["luna", "sessions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const label = isTopic ? "旁听整个群" : "旁听";
  return (
    <label
      className="flex shrink-0 cursor-pointer items-center gap-2 rounded-[7px] border border-border bg-card py-1 pr-1.5 pl-2.5 text-[13px] text-foreground"
      title={
        error ??
        (query.data.listening
          ? "没有 @ 分身的消息也会攒成一批交给它，它觉得该说话时才开口"
          : "只回应 @ 和对它的回复")
      }
      data-testid="session-listening-switch"
    >
      <span className={error ? "text-destructive" : undefined}>
        {error ? "保存失败" : label}
      </span>
      <Switch
        aria-label={groupName ? `旁听 ${groupName}` : "旁听这个群"}
        checked={query.data.listening}
        disabled={saving}
        onCheckedChange={(enabled) => void set(enabled)}
      />
    </label>
  );
}
