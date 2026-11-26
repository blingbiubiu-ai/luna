import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BindWorkerDialog, type WorkerReleaseManifest } from "@/components/bind-worker-dialog";
import { UpgradeWorkerDialog } from "@/components/upgrade-worker-dialog";
import { useRouteAgent } from "@/lib/agent-route";
import { apiFetch } from "@/lib/api/client";

export const Route = createFileRoute("/$agentId/settings/workers/")({ component: WorkersPage });

interface WorkerUpgradeStatus {
  state: "idle" | "pulling_image" | "downloading_worker" | "restarting" | "succeeded" | "failed";
  targetVersion?: string;
  targetImage?: string;
  message?: string;
  updatedAt: number;
}

interface Worker {
  workerId: string;
  owned: boolean;
  local: boolean;
  connected: boolean;
  revoked: boolean;
  draining: boolean;
  lastHeartbeatAt: number;
  health: {
    ready?: boolean;
    capacity: number;
    occupied: number;
    projects?: string[];
    capabilities?: string[];
    imageDigest?: string;
    imageRepoDigest?: string;
    imageRef?: string;
    imageVariant?: string;
    workerVersion?: string;
    managedBinary?: boolean;
    upgrade?: WorkerUpgradeStatus;
    revision?: string;
    desiredRevision?: string;
    error?: string;
  } | null;
}

interface Assignment {
  workerId: string;
  status: "active" | "disabled";
  paused: boolean;
}

interface WorkerList {
  workers: Worker[];
  assignments: Assignment[];
  canManageWorkers: boolean;
}

const IN_PROGRESS_UPGRADE_STATES = new Set<WorkerUpgradeStatus["state"]>([
  "pulling_image",
  "downloading_worker",
  "restarting",
]);

function upgradeStateLabel(state: WorkerUpgradeStatus["state"]): string {
  switch (state) {
    case "pulling_image": return "拉取镜像中…";
    case "downloading_worker": return "下载更新中…";
    case "restarting": return "重启中…";
    case "succeeded": return "升级完成";
    case "failed": return "升级失败";
    default: return "";
  }
}

function WorkersPage() {
  const agent = useRouteAgent();
  return <AgentWorkers key={agent.id} agent={agent} />;
}

function AgentWorkers({ agent }: { agent: ReturnType<typeof useRouteAgent> }) {
  const client = useQueryClient();
  const path = `/agents/${encodeURIComponent(agent.id)}/workers`;
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => apiFetch<WorkerList>(path, { signal }),
    refetchInterval: queryState => {
      const hasActiveUpgrade = queryState.state.data?.workers.some(
        w => w.health?.upgrade && IN_PROGRESS_UPGRADE_STATES.has(w.health.upgrade.state),
      );
      return hasActiveUpgrade ? 2000 : 5000;
    },
  });
  const releaseQuery = useQuery({
    queryKey: ["/worker/release/manifest.json"],
    queryFn: ({ signal }) => apiFetch<WorkerReleaseManifest>("/worker/release/manifest.json", { signal }),
    staleTime: 30_000,
  });
  const assign = useMutation({
    mutationFn: (workerId: string) => apiFetch(`${path}/${encodeURIComponent(workerId)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "disabled" }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: [path] }),
  });
  const changeAdmission = useMutation({
    mutationFn: ({workerId, paused}: Assignment) => apiFetch(
      `${path}/${encodeURIComponent(workerId)}/${paused ? "resume" : "drain"}`,
      { method: "POST" },
    ),
    onSuccess: () => client.invalidateQueries({ queryKey: [path] }),
  });
  const assigned = query.data?.assignments.filter(row => row.status === "active") ?? [];
  const canAssign = agent.status === "active";
  const latestWorkerVersion = releaseQuery.data?.worker.version ?? null;

  function renderWorker(assignment: Assignment) {
    const {workerId, paused} = assignment;
    const worker = query.data?.workers.find(item => item.workerId === workerId);
    const health = worker?.health;
    const online = Boolean(worker?.connected && !worker.revoked);
    const canChangeAdmission = worker && !worker.revoked && (query.data?.canManageWorkers || (worker.local && worker.owned));
    const canUnassign = worker?.owned && !worker.local;
    const supportsUpgrade = Boolean(health?.capabilities?.includes("worker-upgrade-v1"));
    const canUpgrade = Boolean(worker && !worker.revoked && (worker.owned || worker.local) && online && supportsUpgrade);
    const upgradeState = health?.upgrade;
    const isUpgrading = Boolean(upgradeState && IN_PROGRESS_UPGRADE_STATES.has(upgradeState.state));
    const hasNewWorkerVersion = Boolean(
      latestWorkerVersion && health?.workerVersion && health.workerVersion !== latestWorkerVersion,
    );
    const hasWorkerActionableUpdate = hasNewWorkerVersion && health?.managedBinary !== false;
    const variantKey = health?.imageVariant === "developer" || health?.imageRef?.includes("luna-runner-developer")
      ? "developer"
      : health?.imageVariant === "general" || health?.imageRef?.includes("luna-runner")
        ? "general"
        : undefined;
    const targetImageDigest = variantKey ? releaseQuery.data?.images[variantKey]?.digest ?? null : null;
    const hasNewImageVersion = Boolean(
      targetImageDigest
      && health?.imageDigest !== targetImageDigest
      && health?.imageRepoDigest !== targetImageDigest,
    );
    const showUpgradeButton = canUpgrade && (isUpgrading || hasWorkerActionableUpdate || hasNewImageVersion);
    const isUpToDate = online && supportsUpgrade && !isUpgrading && !hasNewWorkerVersion && !hasNewImageVersion;

    return <TableRow key={workerId}>
      <TableCell className="max-w-64 px-3 py-3 whitespace-normal">
        <p className="break-all font-mono">{workerId}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {worker ? (worker.local ? "同机 Worker · 管理员专用" : worker.owned ? "我的 Worker" : "已有绑定") : ""}
          {health?.workerVersion ? ` · v:${health.workerVersion}` : ""}
        </p>
        {hasNewWorkerVersion && (
          <span className="mt-1 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            有新版本 ({latestWorkerVersion})
          </span>
        )}
        {isUpToDate && (
          <span className="mt-1 inline-block rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            已是最新
          </span>
        )}
      </TableCell>
      <TableCell className="px-3">
        <span className="worker-presence" data-online={online}>
          <span className="worker-presence-dot" aria-hidden="true" />
          {!worker ? "状态未知" : worker.revoked ? "已撤销" : online ? "在线" : "离线"}
        </span>
      </TableCell>
      <TableCell className="max-w-64 px-3 whitespace-normal">
        <p>{health ? health.ready ? "就绪" : "未就绪" : "—"}</p>
        {health?.imageRef ? (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground" title={health.imageDigest}>
            {health.imageVariant ? `[${health.imageVariant}] ` : ""}{health.imageRef}
          </p>
        ) : health?.imageDigest ? (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground" title={health.imageDigest}>
            镜像 {health.imageDigest.slice(0, 19)}
          </p>
        ) : null}
        {hasNewImageVersion && (
          <span className="mt-1 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            镜像有新版本
          </span>
        )}
        {health?.error && <p className="mt-1 break-words text-xs text-destructive">{health.error}</p>}
        {upgradeState && upgradeState.state !== "idle" && (
          <p className={`mt-1 break-words text-xs ${upgradeState.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
            {upgradeStateLabel(upgradeState.state)}{upgradeState.message ? `：${upgradeState.message}` : ""}
          </p>
        )}
        {health?.revision && <p className="text-xs text-muted-foreground">当前 {health.revision.slice(0, 10)}</p>}
        {health?.desiredRevision && <p className="text-xs text-muted-foreground">期望 {health.desiredRevision.slice(0, 10)}</p>}
      </TableCell>
      <TableCell className="px-3">{worker && !worker.revoked ? paused ? "已暂停" : worker.draining ? "节点已暂停" : "已启用" : "—"}</TableCell>
      <TableCell className="px-3 tabular-nums">{health ? `${health.occupied} / ${health.capacity}` : "—"}</TableCell>
      <TableCell className="max-w-48 px-3 break-all whitespace-normal">{health?.projects?.join("、") || "—"}</TableCell>
      <TableCell className="px-3">{worker?.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).toLocaleString() : "—"}</TableCell>
      <TableCell className="px-3">
        <div className="flex flex-wrap gap-2">
          {showUpgradeButton && worker && <UpgradeWorkerDialog
            path={path}
            worker={worker}
            release={releaseQuery.data}
            hasNewWorkerVersion={hasNewWorkerVersion}
            hasNewImageVersion={hasNewImageVersion}
            isUpgrading={isUpgrading}
            upgradingLabel={upgradeState ? upgradeStateLabel(upgradeState.state) : "升级中…"}
          />}
          {canChangeAdmission && <Button size="sm" variant="outline" disabled={changeAdmission.isPending}
            onClick={() => changeAdmission.mutate(assignment)}>
            {paused ? "恢复接单" : "暂停接单"}
          </Button>}
          {canUnassign && <Button size="sm" variant="outline" disabled={assign.isPending}
            onClick={() => {
              if (confirm("取消分配后，此 Agent 上已使用该 Worker 的分身将无法继续执行。确认取消分配？")) {
                assign.mutate(workerId);
              }
            }}>取消分配</Button>}
          {!showUpgradeButton && !canChangeAdmission && !canUnassign && "—"}
        </div>
      </TableCell>
    </TableRow>;
  }

  return <main className="mx-auto w-full min-w-0 max-w-7xl space-y-6 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Workers</h1>
        <p className="text-muted-foreground">
          {agent.name} 的执行节点
          {latestWorkerVersion ? ` · 平台 Worker 版本 ${latestWorkerVersion}` : ""}
        </p>
      </div>
      <BindWorkerDialog path={path} agentName={agent.name} disabled={!canAssign} />
    </div>

    {query.error && <p role="alert" className="text-destructive">无法加载 Worker。{query.error.message}</p>}
    {assign.error && <p role="alert" className="text-destructive">无法更新分配。{assign.error.message}</p>}
    {changeAdmission.error && <p role="alert" className="text-destructive">无法更新接单状态。{changeAdmission.error.message}</p>}
    {query.isLoading && <p>正在加载…</p>}
    {query.data && <section className="space-y-3">
      <h2 className="font-medium">已分配</h2>
      {assigned.length > 0 ? <div className="overflow-hidden rounded-lg border">
        <Table aria-label="已分配的 Worker">
          <TableHeader className="bg-muted/40">
            <TableRow>
              {["Worker", "连接", "执行环境", "接单", "负载", "项目", "最近心跳", "操作"].map(label =>
                <TableHead key={label} scope="col" className="px-3">{label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>{assigned.map(renderWorker)}</TableBody>
        </Table>
      </div> : <p className="rounded-lg border p-4 text-sm text-muted-foreground">尚未分配 Worker。接入自己的 Worker 后即可为此 Agent 执行任务。</p>}
    </section>}
  </main>;
}
