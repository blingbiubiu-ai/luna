import { randomId } from "@/lib/random-id";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { dashboardAgentsKey } from "@/lib/api/hooks";

type Status = "active" | "disabled" | "deleted";
type JobStatus = {status: "pending" | "completed"; lastError: string | null};

export function AgentLifecycleActions({ agentId, shadowId, name, status, entityLabel, showStatusAction = true, canDelete = true, disabled = false }: {
  agentId: string;
  shadowId?: string;
  name: string;
  status: string;
  entityLabel?: string;
  showStatusAction?: boolean;
  canDelete?: boolean;
  disabled?: boolean;
}) {
  const client = useQueryClient();
  const base = `/agents/${encodeURIComponent(agentId)}`;
  const path = `${base}${shadowId ? `/shadows/${encodeURIComponent(shadowId)}` : ""}/status`;
  const request = useRef<{ target: Status; key: string } | null>(null);
  const change = useMutation({
    mutationFn: (target: Status) => {
      const pending = request.current?.target === target ? request.current : { target, key: randomId() };
      request.current = pending;
      return apiFetch<{ job: JobStatus & {id: string} }>(path, {
        method: "PUT", headers: { "Idempotency-Key": pending.key }, body: JSON.stringify({ status: target }),
      });
    },
    onSuccess: async () => {
      request.current = null;
      await client.invalidateQueries({ queryKey: dashboardAgentsKey });
    },
  });
  const jobId = change.data?.job.status === "pending" ? change.data.job.id : undefined;
  const tracked = useQuery({
    queryKey: [...dashboardAgentsKey, agentId, "lifecycle", jobId],
    queryFn: ({ signal }) => apiFetch<{job: JobStatus}>(`${base}/lifecycle/${encodeURIComponent(jobId!)}`, {signal}),
    enabled: !!jobId,
    refetchInterval: query => query.state.data?.job.status === "completed" ? false : 1000,
  });
  const pending = !!jobId && tracked.data?.job.status !== "completed";
  const busy = disabled || change.isPending || pending;
  const next = status === "active" ? "disabled" : "active";
  const action = next === "disabled" ? "停用" : "恢复";
  const entity = entityLabel ?? (shadowId ? "分身" : "Agent");
  const statusLabel = action + entity;

  return <div className="flex flex-wrap items-center gap-2">
    {showStatusAction && <ActionDialog title={statusLabel} description={name} submitLabel={statusLabel}
      trigger={<Button variant="outline" size="sm" disabled={busy}>{statusLabel}</Button>}
      onSubmit={() => change.mutateAsync(next)} isSubmitting={change.isPending} error={change.error} children={null} />}
    {canDelete && <ActionDialog title={"删除" + entity} description={`删除 ${name} 后将保留历史记录。`} submitLabel={"删除" + entity}
      trigger={<Button variant="outline" size="sm" disabled={busy}>{"删除" + entity}</Button>}
      onSubmit={() => change.mutateAsync("deleted")} isSubmitting={change.isPending} error={change.error} children={null} />}
    {pending && <span role="status" className="text-xs text-muted-foreground">正在排空</span>}
    {(tracked.error || tracked.data?.job.lastError) && <span role="alert" className="text-xs text-destructive">
      {tracked.error?.message ?? tracked.data?.job.lastError}
    </span>}
  </div>;
}
