import { randomId } from "@/lib/random-id";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { dashboardAgentsKey } from "@/lib/api/hooks";

type Status = "active" | "disabled" | "deleted";
type JobStatus = {status: "pending" | "completed"; lastError: string | null};

export type LifecycleRequest = "status" | "delete" | null;

/**
 * Status and delete actions. With `request`/`onRequestChange` the buttons are left out and the
 * dialogs open on request, so a menu elsewhere (the Shadow card's "⋯") can drive them.
 */
export function AgentLifecycleActions({ agentId, shadowId, name, status, entityLabel, showStatusAction = true, canDelete = true, disabled = false, request: openRequest, onRequestChange }: {
  agentId: string;
  shadowId?: string;
  name: string;
  status: string;
  entityLabel?: string;
  showStatusAction?: boolean;
  canDelete?: boolean;
  disabled?: boolean;
  request?: LifecycleRequest;
  onRequestChange?: (request: LifecycleRequest) => void;
}) {
  const client = useQueryClient();
  const base = `/agents/${encodeURIComponent(agentId)}`;
  const path = `${base}${shadowId ? `/shadows/${encodeURIComponent(shadowId)}` : ""}/status`;
  const request = useRef<{ target: Status; key: string } | null>(null);
  const [confirmName, setConfirmName] = useState("");
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
  const controlled = onRequestChange !== undefined;
  const dialog = (kind: Exclude<LifecycleRequest, null>, button: string) => controlled
    ? { open: openRequest === kind, onOpenChange: (open: boolean) => { if (!open) onRequestChange(null); } }
    : { trigger: <Button variant="outline" size="sm" disabled={busy}>{button}</Button> };

  return <div className="flex flex-wrap items-center gap-2">
    {showStatusAction && <ActionDialog title={statusLabel} description={name} submitLabel={statusLabel}
      {...dialog("status", statusLabel)}
      onSubmit={() => change.mutateAsync(next)} isSubmitting={change.isPending} error={change.error} children={null} />}
    {canDelete && <ActionDialog title={"删除" + entity} submitLabel={"永久删除" + entity} submitDisabled={confirmName !== name}
      {...dialog("delete", "删除" + entity)}
      onSubmit={() => change.mutateAsync("deleted")} isSubmitting={change.isPending} error={change.error}>
      <DeleteWarning name={name} entity={entity} wholeAgent={!shadowId} confirmName={confirmName} onConfirmName={setConfirmName} />
    </ActionDialog>}
    {pending && <span role="status" className="text-xs text-muted-foreground">正在排空</span>}
    {(tracked.error || tracked.data?.job.lastError) && <span role="alert" className="text-xs text-destructive">
      {tracked.error?.message ?? tracked.data?.job.lastError}
    </span>}
  </div>;
}

/** Deleting removes Worker data for good; the warning names what goes and what stays. */
export function DeleteWarning({ name, entity, wholeAgent, confirmName, onConfirmName }: {
  name: string; entity: string; wholeAgent: boolean; confirmName: string; onConfirmName: (value: string) => void;
}) {
  return <>
    <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
      <p className="font-semibold text-destructive">此操作不可恢复。</p>
      <p>
        将永久删除{wholeAgent ? "该 Agent 所有分身" : "该分身"}在 Worker 上的数据：容器、HOME 目录（登录态、git/ssh 配置、浏览器数据、文件等）、
        系统盘上安装的软件、资源快照和 /data 卷。
      </p>
      <p className="text-muted-foreground">会话、消息、任务和记忆等历史记录会保留。</p>
    </div>
    <label className="grid gap-1.5 text-sm">
      <span>输入{entity}名称 <span className="font-semibold">{name}</span> 以确认</span>
      <Input value={confirmName} onChange={event => onConfirmName(event.target.value)} autoComplete="off" aria-label={`输入${entity}名称以确认`} />
    </label>
  </>;
}
