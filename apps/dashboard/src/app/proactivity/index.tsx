import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  BellOff,
  Check,
  CheckCircle2,
  GitPullRequestArrow,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { IdentityAvatar } from "@/components/identity-link";
import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentBasePath, useRouteAgent } from "@/lib/agent-route";
import {
  useCancelProactivityRequest,
  useProactivityOverview,
  useTriggerShadowHeartbeat,
  type DashboardCorrelatedRequestItem,
  type DashboardProactivityOverview,
  type DashboardShadowHeartbeatItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/$agentId/proactivity/")({
  component: ProactivityPage,
});

type LedgerTab = "requests" | "governance";
type RequestFilter = "all" | "pending" | "ask" | "handoff";

function formatHeartbeatError(raw: string): string {
  if (
    raw.includes("no_scoped_worker_available") ||
    raw.includes("shadow_worker_unavailable")
  ) {
    return "暂无可用执行 Worker（请确认绑定的 Worker 与容器服务在线）";
  }
  if (raw.includes("AgentNotConfiguredError")) {
    return "尚未启用模型配置（请先在「模型配置」中激活可用模型）";
  }
  return raw;
}

function formatShortTime(ms: number | null | undefined, timezone?: string): string {
  if (!ms || ms <= 0) return "尚未运行";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      ...(timezone ? { timeZone: timezone } : {}),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function formatRelative(ms: number | null | undefined, now: number): string {
  if (!ms || ms <= 0) return "从未";
  const diff = ms - now;
  const absMin = Math.round(Math.abs(diff) / 60_000);
  if (Math.abs(diff) < 45_000) return diff >= 0 ? "即将到期" : "刚刚";
  if (absMin < 60) return diff > 0 ? `${absMin} 分钟后` : `${absMin} 分钟前`;
  const absHr = Math.round(absMin / 60);
  if (absHr < 48) return diff > 0 ? `${absHr} 小时后` : `${absHr} 小时前`;
  const absDays = Math.round(absHr / 24);
  return diff > 0 ? `${absDays} 天后` : `${absDays} 天前`;
}

function ProactivityPage() {
  const agent = useRouteAgent();
  const base = useAgentBasePath();
  const selection = useShadowScope(false);
  const overviewQuery = useProactivityOverview(selection.scope);
  const triggerHeartbeat = useTriggerShadowHeartbeat(agent.id);
  const cancelRequest = useCancelProactivityRequest(agent.id);

  const [ledgerTab, setLedgerTab] = useState<LedgerTab>("requests");
  const [requestFilter, setRequestFilter] = useState<RequestFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [triggerBanner, setTriggerBanner] = useState<{
    shadowName: string;
    sessionId: string;
    alreadyRunning: boolean;
  } | null>(null);

  const data = overviewQuery.data;
  const now = data?.now ?? Date.now();

  const runningShadows = (data?.heartbeats ?? []).filter(
    hb =>
      hb.latestCommand?.status === "pending" ||
      hb.latestCommand?.status === "running",
  ).length;
  const wakeShadows = (data?.heartbeats ?? []).filter(
    hb => hb.pendingActivity.hasWakeActivity,
  ).length;
  const openRequestsCount = (data?.requests ?? []).filter(
    r => r.status === "pending",
  ).length;
  const deferredCount = data?.governance.deferredQueue.length ?? 0;
  const throttledCount = (data?.governance.recentEvents ?? []).filter(
    e => e.controlKind === "outbound_throttled",
  ).length;
  const governanceTotal =
    deferredCount + (data?.governance.recentEvents.length ?? 0);

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredRequests = useMemo(() => {
    const list = data?.requests ?? [];
    return list.filter(item => {
      if (requestFilter === "pending" && item.status !== "pending") return false;
      if (requestFilter === "ask" && item.kind !== "ask") return false;
      if (requestFilter === "handoff" && item.kind !== "handoff") return false;
      if (!normalizedSearch) return true;
      return [
        item.id,
        item.instruction,
        item.originSessionTitle,
        item.targetSessionTitle,
        item.targetUserName ?? "",
        item.shadowName,
      ].some(v => v.toLowerCase().includes(normalizedSearch));
    });
  }, [data?.requests, requestFilter, normalizedSearch]);

  async function handleTriggerHeartbeat(hb: DashboardShadowHeartbeatItem) {
    const res = await triggerHeartbeat.mutateAsync(hb.shadowId);
    setTriggerBanner({
      shadowName: hb.shadowName,
      sessionId: res.sessionId,
      alreadyRunning: res.alreadyRunning,
    });
  }

  const policySummary = data
    ? [
        data.settings.heartbeatIntervalMs > 0
          ? `心跳每 ${Math.round(data.settings.heartbeatIntervalMs / 60_000)} 分钟`
          : "周期心跳已关闭",
        data.settings.outboundPerSessionPerHour > 0
          ? `单会话 ${data.settings.outboundPerSessionPerHour} 条/时`
          : "单会话不限",
        data.settings.outboundPerRecipientPerDay > 0
          ? `单人 ${data.settings.outboundPerRecipientPerDay} 条/天`
          : "单人不限",
        data.settings.outboundDedupWindowMs > 0
          ? `${Math.round(data.settings.outboundDedupWindowMs / 3_600_000)}h 去重`
          : "不去重",
      ].join(" · ")
    : "";

  return (
    <div
      className="flex h-full min-h-0 flex-1 overflow-hidden border-t border-border bg-background"
      data-testid="proactivity-workspace"
    >
      <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
        <div className="mx-auto max-w-[1180px] space-y-6 pb-8">
          {/* Header + Inline Policy + KPI Strip */}
          <div className="flex flex-col gap-4 @[880px]:flex-row @[880px]:items-start @[880px]:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="m-0 text-[22px] font-semibold tracking-tight text-foreground">
                  主动中心
                </h1>
                {data && (
                  <LivePulsePill
                    runningCount={runningShadows}
                    wakeCount={wakeShadows}
                    totalShadows={data.heartbeats.length}
                  />
                )}
                {data?.settings.quietHours && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      data.settings.inQuietHours
                        ? "border-[#7d6b91]/30 bg-[#7d6b91]/14 text-[#7d6b91] dark:border-[#b2a1c7]/30 dark:bg-[#b2a1c7]/16 dark:text-[#b2a1c7]"
                        : "border-border bg-muted/60 text-muted-foreground",
                    )}
                  >
                    <BellOff className="size-3" />
                    免打扰 {data.settings.quietHours.start}–
                    {data.settings.quietHours.end}
                    {data.settings.inQuietHours ? " · 生效中" : ""}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                <span>
                  {policySummary || "管理数字分身的周期心跳自检、主动追问协同与免打扰调控"}
                </span>
                <a
                  href={`${base}/settings/general`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-foreground/80 underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground/50"
                >
                  <SlidersHorizontal className="size-3" />
                  调整策略
                </a>
                <button
                  type="button"
                  disabled={overviewQuery.isFetching}
                  onClick={() => void overviewQuery.refetch()}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn(
                      "size-3",
                      overviewQuery.isFetching && "animate-spin",
                    )}
                  />
                  刷新
                </button>
              </div>
            </div>

            {/* 4 Compact Interactive KPI Tiles (matching TasksWorkspaceView) */}
            <div className="grid grid-cols-2 gap-2 @[520px]:grid-cols-4 @[880px]:min-w-[27rem] @[880px]:shrink-0">
              <KpiTile
                label="待巡检分身"
                value={data ? wakeShadows : "-"}
                sub={data ? `共 ${data.heartbeats.length} 个分身` : ""}
                tone={wakeShadows > 0 ? "ochre" : "neutral"}
                withSageBar={wakeShadows > 0}
              />
              <KpiTile
                label="待响应请求"
                value={data ? openRequestsCount : "-"}
                sub={data ? `共 ${data.requests.length} 条记录` : ""}
                tone={openRequestsCount > 0 ? "slate" : "neutral"}
                active={ledgerTab === "requests" && requestFilter === "pending"}
                withSageBar={
                  openRequestsCount > 0 ||
                  (ledgerTab === "requests" && requestFilter === "pending")
                }
                onClick={() => {
                  setLedgerTab("requests");
                  setRequestFilter(prev =>
                    prev === "pending" ? "all" : "pending",
                  );
                }}
              />
              <KpiTile
                label="顺延待发"
                value={data ? deferredCount : "-"}
                sub={
                  throttledCount > 0
                    ? `近期 ${throttledCount} 次限流拦截`
                    : "免打扰暂存队列"
                }
                tone={
                  throttledCount > 0
                    ? "ochre"
                    : deferredCount > 0
                      ? "plum"
                      : "neutral"
                }
                active={ledgerTab === "governance"}
                withSageBar={ledgerTab === "governance" || deferredCount > 0}
                onClick={() => setLedgerTab("governance")}
              />
              <KpiTile
                label="24h 主动发言"
                value={data ? data.governance.sentLast24h : "-"}
                sub="被动回复不计入配额"
                tone="neutral"
              />
            </div>
          </div>

          {/* Manual Wake Toast Banner */}
          {triggerBanner && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[#5b8a72]/30 bg-[#5b8a72]/10 px-3.5 py-2.5 text-[13px] text-foreground">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 shrink-0 text-[#5b8a72] dark:text-[#7fb096]" />
                <span>
                  {triggerBanner.alreadyRunning
                    ? `分身「${triggerBanner.shadowName}」已有心跳任务正在执行或排队中。`
                    : `已唤醒分身「${triggerBanner.shadowName}」执行即时心跳自检。`}
                </span>
                <a
                  href={`${base}/sessions/${encodeURIComponent(triggerBanner.sessionId)}`}
                  className="inline-flex items-center gap-1 font-medium text-[#5b8a72] underline underline-offset-4 hover:opacity-85 dark:text-[#7fb096]"
                >
                  查看心跳会话
                  <ArrowRight className="size-3.5" />
                </a>
              </div>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setTriggerBanner(null)}
                className="rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {overviewQuery.error instanceof Error && (
            <div
              role="alert"
              className="rounded-[12px] border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              加载失败：{overviewQuery.error.message}
            </div>
          )}

          {overviewQuery.isLoading && !data ? (
            <div className="space-y-5">
              <div className="grid gap-3 @[680px]:grid-cols-2 @[1020px]:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-36 w-full rounded-[14px]" />
                ))}
              </div>
              <Skeleton className="h-64 w-full rounded-[14px]" />
            </div>
          ) : data ? (
            <>
              {/* Section 1: Per-Shadow Heartbeat Matrix */}
              <section aria-labelledby="heartbeats-heading" className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2.5">
                    <h2
                      id="heartbeats-heading"
                      className="m-0 text-[13px] font-semibold tracking-tight text-foreground"
                    >
                      数字分身心跳
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      仅在游标后有新消息、任务结案或协同回执时唤醒，空闲时零开销
                    </span>
                  </div>
                  {selection.availableShadows.length > 1 && (
                    <ShadowPicker selection={selection} size="sm" />
                  )}
                </div>

                <div className="grid gap-3 @[680px]:grid-cols-2 @[1020px]:grid-cols-3">
                  {data.heartbeats.map(hb => (
                    <ShadowHeartbeatCard
                      key={hb.shadowId}
                      hb={hb}
                      base={base}
                      now={now}
                      timezone={data.settings.timezone}
                      triggering={
                        triggerHeartbeat.isPending &&
                        triggerHeartbeat.variables === hb.shadowId
                      }
                      onTrigger={() => void handleTriggerHeartbeat(hb)}
                    />
                  ))}
                </div>
              </section>

              {/* Section 2: Unified Tabbed Activity & Governance Workspace */}
              <section aria-label="主动协同与外发调控明细" className="space-y-3">
                {/* Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      role="tablist"
                      aria-label="主动账本视图"
                      className="inline-flex items-center gap-0.5 rounded-[8px] bg-muted p-0.5 text-xs"
                    >
                      {(
                        [
                          {
                            key: "requests",
                            label: "追问与协同",
                            count: data.requests.length,
                            dot:
                              openRequestsCount > 0
                                ? "bg-[#5c7c99] dark:bg-[#86a3be]"
                                : null,
                          },
                          {
                            key: "governance",
                            label: "外发调控",
                            count: governanceTotal,
                            dot:
                              deferredCount > 0
                                ? "bg-[#7d6b91] dark:bg-[#b2a1c7]"
                                : null,
                          },
                        ] as const
                      ).map(tab => {
                        const isCurrent = ledgerTab === tab.key;
                        return (
                          <button
                            key={tab.key}
                            type="button"
                            role="tab"
                            aria-selected={isCurrent}
                            onClick={() => setLedgerTab(tab.key)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 transition-colors",
                              isCurrent
                                ? "bg-card font-semibold text-foreground shadow-xs"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {tab.dot && (
                              <span
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  tab.dot,
                                )}
                              />
                            )}
                            <span>{tab.label}</span>
                            <span className="tabular-nums opacity-65">
                              {tab.count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {ledgerTab === "requests" && (
                      <div
                        role="group"
                        aria-label="请求状态筛选"
                        className="inline-flex items-center gap-0.5 rounded-[8px] bg-muted/65 p-0.5 text-xs"
                      >
                        {(
                          [
                            ["all", "全部"],
                            ["pending", "等待响应"],
                            ["ask", "提问"],
                            ["handoff", "委派"],
                          ] as const
                        ).map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={requestFilter === key}
                            onClick={() => setRequestFilter(key)}
                            className={cn(
                              "rounded-[6px] px-2 py-1 transition-colors",
                              requestFilter === key
                                ? "bg-card font-medium text-foreground shadow-2xs"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {ledgerTab === "requests" && (
                    <label className="flex h-8 w-56 items-center gap-2 rounded-[8px] border border-border bg-card px-2.5 text-muted-foreground focus-within:border-ring">
                      <Search className="size-3.5 shrink-0" />
                      <input
                        type="search"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="搜索提问、会话或对象…"
                        className="min-w-0 flex-1 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                      />
                    </label>
                  )}
                </div>

                {/* Tab Panel Surface */}
                <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-[0_2px_5px_#00000003]">
                  {ledgerTab === "requests" ? (
                    <RequestsLedgerPanel
                      items={filteredRequests}
                      hasFilter={
                        requestFilter !== "all" || normalizedSearch.length > 0
                      }
                      base={base}
                      now={now}
                      timezone={data.settings.timezone}
                      cancellingId={
                        cancelRequest.isPending
                          ? (cancelRequest.variables ?? null)
                          : null
                      }
                      onCancel={id => cancelRequest.mutate(id)}
                    />
                  ) : (
                    <GovernanceLedgerPanel
                      governance={data.governance}
                      timezone={data.settings.timezone}
                      base={base}
                    />
                  )}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LivePulsePill({
  runningCount,
  wakeCount,
  totalShadows,
}: {
  readonly runningCount: number;
  readonly wakeCount: number;
  readonly totalShadows: number;
}) {
  if (runningCount > 0) {
    return (
      <span className="worker-presence" data-online="true">
        <span className="worker-presence-dot" aria-hidden="true" />
        {runningCount} 个分身心跳运行中
      </span>
    );
  }
  if (wakeCount > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#b07d4f]/30 bg-[#b07d4f]/12 px-2.5 py-0.5 text-xs font-medium text-[#b07d4f] dark:border-[#d1a273]/30 dark:bg-[#d1a273]/15 dark:text-[#d1a273]">
        <span className="size-1.5 rounded-full bg-[#b07d4f] dark:bg-[#d1a273]" />
        {wakeCount} 个分身有新动态待巡检
      </span>
    );
  }
  return (
    <span className="worker-presence">
      <span className="size-1.5 rounded-full bg-[#5b8a72] dark:bg-[#7fb096]" />
      {totalShadows} 个分身安静守候
    </span>
  );
}

function KpiTile({
  label,
  value,
  sub,
  tone,
  active = false,
  withSageBar = false,
  onClick,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly sub: string;
  readonly tone: "neutral" | "ochre" | "slate" | "sage" | "terra" | "plum";
  readonly active?: boolean;
  readonly withSageBar?: boolean;
  readonly onClick?: () => void;
}) {
  const valueTone =
    tone === "ochre"
      ? "text-[#b07d4f] dark:text-[#d1a273]"
      : tone === "slate"
        ? "text-[#5c7c99] dark:text-[#86a3be]"
        : tone === "sage"
          ? "text-[#5b8a72] dark:text-[#7fb096]"
          : tone === "terra"
            ? "text-[#b5544a] dark:text-[#dc7a70]"
            : tone === "plum"
              ? "text-[#7d6b91] dark:text-[#b2a1c7]"
              : "text-foreground";

  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "relative flex flex-col justify-between overflow-hidden rounded-[12px] border border-border bg-card px-3 py-2.5 text-left transition-colors",
        onClick && "cursor-pointer hover:border-foreground/20",
        active && "border-foreground/25 bg-accent/40",
        withSageBar &&
          "before:absolute before:top-0 before:left-3 before:h-[2.5px] before:w-5 before:rounded-xs before:bg-[#a3b69e] dark:before:bg-[#8ea487]",
      )}
    >
      <span className="truncate text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "mt-1 text-[20px] leading-tight font-semibold tracking-tight tabular-nums",
          valueTone,
        )}
      >
        {value}
      </span>
      <span className="mt-0.5 truncate text-[11px] text-muted-foreground/85">
        {sub}
      </span>
    </Comp>
  );
}

function ShadowHeartbeatCard({
  hb,
  base,
  now,
  timezone,
  triggering,
  onTrigger,
}: {
  readonly hb: DashboardShadowHeartbeatItem;
  readonly base: string;
  readonly now: number;
  readonly timezone: string;
  readonly triggering: boolean;
  readonly onTrigger: () => void;
}) {
  const cmdStatus = hb.latestCommand?.status;
  const isRunning = cmdStatus === "pending" || cmdStatus === "running";
  const isFailed = cmdStatus === "failed";
  const act = hb.pendingActivity;

  const activityParts: string[] = [];
  if (act.messageCount > 0) {
    activityParts.push(`${act.messageCount} 条新消息`);
  }
  if (act.taskRunCount > 0) {
    activityParts.push(`${act.taskRunCount} 个任务结案`);
  }
  if (act.scheduleOccurrenceCount > 0) {
    activityParts.push(`${act.scheduleOccurrenceCount} 次定时触发`);
  }
  if (act.correlatedRequestCount > 0) {
    activityParts.push(`${act.correlatedRequestCount} 条请求回执`);
  }

  const nextWindowText = !hb.nextEligibleAt
    ? "周期唤醒已关闭"
    : hb.nextEligibleAt <= now
      ? act.hasWakeActivity
        ? "下一轮扫描即唤醒"
        : "有新动态即唤醒"
      : `${formatRelative(hb.nextEligibleAt, now)}（${formatShortTime(hb.nextEligibleAt, timezone)}）`;

  return (
    <article
      aria-label={hb.shadowName}
      className={cn(
        "flex flex-col justify-between rounded-[14px] border bg-card p-3.5 transition-colors hover:border-foreground/15",
        act.hasWakeActivity && "border-[#b07d4f]/30 dark:border-[#d1a273]/30",
      )}
    >
      <div>
        {/* Card Header with Shadow Avatar */}
        <div className="flex items-center gap-2.5">
          <IdentityAvatar
            className="size-8 shrink-0"
            size="sm"
            identity={{
              id: hb.shadowId,
              channel: { type: "user", id: "" },
              externalId: hb.shadowId,
              identityKind: "shadow",
              displayName: hb.shadowName,
              status: "active",
              avatarUrl: null,
              providerIds: {},
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className="m-0 truncate text-[14.5px] font-semibold text-foreground">
                {hb.shadowName}
              </h3>
              {hb.isDefault && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.2 text-[10.5px] text-muted-foreground">
                  本体
                </span>
              )}
            </div>
          </div>

          {/* Subtle Presence Indicator */}
          {isRunning ? (
            <span className="worker-presence shrink-0" data-online="true">
              <span className="worker-presence-dot" aria-hidden="true" />
              巡检中
            </span>
          ) : isFailed ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#b5544a]/12 px-2.5 py-0.5 text-[11.5px] font-medium text-[#b5544a] dark:bg-[#dc7a70]/15 dark:text-[#dc7a70]">
              <span className="size-1.5 rounded-full bg-current" />
              上次异常
            </span>
          ) : act.hasWakeActivity ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#b07d4f]/13 px-2.5 py-0.5 text-[11.5px] font-medium text-[#b07d4f] dark:bg-[#d1a273]/16 dark:text-[#d1a273]">
              <span className="size-1.5 rounded-full bg-current" />
              待巡检
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-[#5b8a72]/75 dark:bg-[#7fb096]/75" />
              守候中
            </span>
          )}
        </div>

        {/* Inset Status Tray (ShadowCard idiom) */}
        <div className="mt-3 grid gap-1.5 rounded-[10px] bg-muted/75 px-3 py-2.5">
          <div className="truncate text-[12.5px]">
            {activityParts.length > 0 ? (
              <span className="font-medium text-[#b07d4f] dark:text-[#d1a273]">
                {activityParts.join(" · ")}
              </span>
            ) : (
              <span className="text-muted-foreground">
                游标后无新消息或任务变动
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
            <span>
              上次：
              {hb.lastQueuedAt && hb.lastQueuedAt > 0
                ? formatRelative(hb.lastQueuedAt, now)
                : "从未"}
            </span>
            <span aria-hidden="true" className="opacity-45">
              ·
            </span>
            <span>窗口：{nextWindowText}</span>
          </div>
          {!isFailed && hb.latestCommand?.summary && (
            <p
              title={hb.latestCommand.summary}
              className="mt-0.5 line-clamp-1 border-t border-dashed border-border/80 pt-1.5 text-[11.5px] text-foreground/80"
            >
              最近结论：{hb.latestCommand.summary}
            </p>
          )}
          {isFailed && hb.latestCommand?.error && (
            <p
              title={hb.latestCommand.error}
              className="mt-0.5 line-clamp-2 border-t border-dashed border-destructive/25 pt-1.5 text-[11.5px] text-[#b5544a] dark:text-[#dc7a70]"
            >
              {formatHeartbeatError(hb.latestCommand.error)}
            </p>
          )}
        </div>
      </div>

      {/* Compact Action Footer */}
      <div className="mt-2.5 flex items-center justify-between gap-2 px-0.5">
        {hb.sessionId ? (
          <a
            href={`${base}/sessions/${encodeURIComponent(hb.sessionId)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground/80 transition-colors hover:text-foreground"
          >
            查看心跳记录
            <ArrowRight className="size-3 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-[11.5px] text-muted-foreground/80">
            首次唤醒时自动建档
          </span>
        )}
        <Button
          type="button"
          size="xs"
          variant={act.hasWakeActivity ? "default" : "outline"}
          disabled={triggering || isRunning}
          onClick={onTrigger}
        >
          <Play className="mr-1 size-3" />
          {triggering ? "唤醒中…" : isRunning ? "巡检中" : "唤醒巡检"}
        </Button>
      </div>
    </article>
  );
}

const REQUEST_STATUS_STYLE: Record<
  DashboardCorrelatedRequestItem["status"],
  { label: string; dot: string; pill: string }
> = {
  pending: {
    label: "等待响应",
    dot: "bg-[#5c7c99] dark:bg-[#86a3be]",
    pill: "bg-[#5c7c99]/14 text-[#5c7c99] border-[#5c7c99]/28 dark:bg-[#86a3be]/16 dark:text-[#86a3be] dark:border-[#86a3be]/30",
  },
  answered: {
    label: "已回答",
    dot: "bg-[#5b8a72] dark:bg-[#7fb096]",
    pill: "bg-[#5b8a72]/14 text-[#5b8a72] border-[#5b8a72]/28 dark:bg-[#7fb096]/16 dark:text-[#7fb096] dark:border-[#7fb096]/30",
  },
  done: {
    label: "已完成",
    dot: "bg-[#5b8a72] dark:bg-[#7fb096]",
    pill: "bg-[#5b8a72]/14 text-[#5b8a72] border-[#5b8a72]/28 dark:bg-[#7fb096]/16 dark:text-[#7fb096] dark:border-[#7fb096]/30",
  },
  declined: {
    label: "已婉拒",
    dot: "bg-[#b07d4f] dark:bg-[#d1a273]",
    pill: "bg-[#b07d4f]/14 text-[#b07d4f] border-[#b07d4f]/28 dark:bg-[#d1a273]/16 dark:text-[#d1a273] dark:border-[#d1a273]/30",
  },
  expired: {
    label: "已过期",
    dot: "bg-muted-foreground",
    pill: "bg-muted text-muted-foreground border-border",
  },
  failed: {
    label: "异常",
    dot: "bg-[#b5544a] dark:bg-[#dc7a70]",
    pill: "bg-[#b5544a]/13 text-[#b5544a] border-[#b5544a]/28 dark:bg-[#dc7a70]/16 dark:text-[#dc7a70] dark:border-[#dc7a70]/30",
  },
  cancelled: {
    label: "已取消",
    dot: "bg-muted-foreground",
    pill: "bg-muted text-muted-foreground border-border",
  },
};

function RequestsLedgerPanel({
  items,
  hasFilter,
  base,
  now,
  timezone,
  cancellingId,
  onCancel,
}: {
  readonly items: readonly DashboardCorrelatedRequestItem[];
  readonly hasFilter: boolean;
  readonly base: string;
  readonly now: number;
  readonly timezone: string;
  readonly cancellingId: string | null;
  readonly onCancel: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <LedgerEmptyState
        icon={GitPullRequestArrow}
        title={hasFilter ? "没有匹配的请求记录" : "暂无追问或跨会话协同"}
        description={
          hasFilter
            ? "尝试切换筛选标签或清空搜索词。"
            : "当分身主动向用户发起确认提问，或将待跟进事项委派给目标会话时，处理进度与回执会在此实时闭环。"
        }
      />
    );
  }

  return (
    <div className="divide-y divide-border">
      {items.map(item => {
        const meta = REQUEST_STATUS_STYLE[item.status] ?? {
          label: item.status,
          dot: "bg-muted-foreground",
          pill: "bg-muted text-muted-foreground border-border",
        };
        const selectedOption =
          item.result && typeof item.result.selectedOption === "string"
            ? item.result.selectedOption
            : undefined;
        const answerOrSummary =
          item.result && typeof item.result.answer === "string"
            ? item.result.answer
            : item.result && typeof item.result.summary === "string"
              ? item.result.summary
              : item.result && typeof item.result.reason === "string"
                ? item.result.reason
                : undefined;

        return (
          <div
            key={item.id}
            className="group px-4 py-3.5 transition-colors hover:bg-muted/30"
          >
            {/* Row Top: Status + Kind + Route + Timestamp / Cancel */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    meta.pill,
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", meta.dot)} />
                  {meta.label}
                </span>

                <span className="rounded-[5px] bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
                  {item.kind === "ask" ? "主动提问" : "跨会话委派"}
                </span>

                <span className="text-muted-foreground">{item.shadowName}</span>
                <span aria-hidden="true" className="text-muted-foreground/40">
                  ·
                </span>

                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <a
                    href={`${base}/sessions/${encodeURIComponent(item.originSessionId)}`}
                    className="max-w-44 truncate font-medium text-foreground/85 hover:underline"
                  >
                    {item.originSessionTitle}
                  </a>
                  <ArrowRight className="size-3 shrink-0 opacity-60" />
                  <a
                    href={`${base}/sessions/${encodeURIComponent(item.targetSessionId)}`}
                    className="max-w-44 truncate font-medium text-foreground/85 hover:underline"
                  >
                    {item.targetSessionTitle}
                  </a>
                  {item.targetUserName && (
                    <span className="rounded bg-muted px-1.5 py-0.2 text-[11px]">
                      @{item.targetUserName}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                {item.status === "pending" && item.expiresAt && (
                  <span>{formatRelative(item.expiresAt, now)}过期</span>
                )}
                <span className="tabular-nums">
                  {formatShortTime(item.createdAt, timezone)}
                </span>
                {item.status === "pending" && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={cancellingId === item.id}
                    onClick={() => onCancel(item.id)}
                    className="h-6 px-2 text-xs text-[#b5544a] hover:bg-[#b5544a]/10 hover:text-[#b5544a] dark:text-[#dc7a70]"
                  >
                    {cancellingId === item.id ? "取消中…" : "取消"}
                  </Button>
                )}
              </div>
            </div>

            {/* Instruction / Question Text */}
            <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-foreground">
              {item.instruction}
            </p>

            {/* Options Chips */}
            {item.options.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {item.options.map(opt => {
                  const chosen = selectedOption === opt;
                  return (
                    <span
                      key={opt}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
                        chosen
                          ? "border-[#5b8a72]/35 bg-[#5b8a72]/14 font-medium text-[#5b8a72] dark:border-[#7fb096]/35 dark:bg-[#7fb096]/16 dark:text-[#7fb096]"
                          : "border-border bg-muted/45 text-muted-foreground",
                      )}
                    >
                      {chosen && <Check className="size-3" />}
                      {opt}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Resolution Callout */}
            {answerOrSummary && (
              <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[9px] bg-muted/65 px-3 py-2 text-[12.5px]">
                <span className="font-medium text-[#5b8a72] dark:text-[#7fb096]">
                  {item.resolvedByUserName
                    ? `${item.resolvedByUserName} 响应：`
                    : "回执结果："}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
                  {answerOrSummary}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GovernanceLedgerPanel({
  governance,
  timezone,
  base,
}: {
  readonly governance: DashboardProactivityOverview["governance"];
  readonly timezone: string;
  readonly base: string;
}) {
  const { deferredQueue, recentEvents } = governance;
  if (deferredQueue.length === 0 && recentEvents.length === 0) {
    return (
      <LedgerEmptyState
        icon={BellOff}
        title="外发秩序良好，暂无顺延或限流记录"
        description="被动回复不受配额与免打扰限制；当主动消息命中免打扰时段或频率上限时，顺延队列与拦截明细会在此显示。"
      />
    );
  }

  return (
    <div className="divide-y divide-border">
      {deferredQueue.map(cmd => (
        <div
          key={cmd.id}
          className="px-4 py-3.5 transition-colors hover:bg-muted/30"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#7d6b91]/30 bg-[#7d6b91]/14 px-2 py-0.5 text-[11px] font-medium text-[#7d6b91] dark:border-[#b2a1c7]/30 dark:bg-[#b2a1c7]/16 dark:text-[#b2a1c7]">
                <span className="size-1.5 rounded-full bg-current" />
                免打扰顺延待发
              </span>
              <a
                href={`${base}/sessions/${encodeURIComponent(cmd.sessionId)}`}
                className="font-medium text-foreground/85 hover:underline"
              >
                {cmd.sessionTitle}
              </a>
            </div>
            <span className="tabular-nums text-muted-foreground">
              预计发送：{formatShortTime(cmd.availableAt, timezone)}
            </span>
          </div>
          <p className="mt-1.5 line-clamp-2 text-[13px] text-foreground/90">
            {cmd.contentPreview}
          </p>
        </div>
      ))}

      {recentEvents.map(ev => {
        const isThrottled = ev.controlKind === "outbound_throttled";
        return (
          <div
            key={ev.id}
            className="px-4 py-3 transition-colors hover:bg-muted/30"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    isThrottled
                      ? "border-[#b07d4f]/30 bg-[#b07d4f]/13 text-[#b07d4f] dark:border-[#d1a273]/30 dark:bg-[#d1a273]/16 dark:text-[#d1a273]"
                      : "border-[#7d6b91]/30 bg-[#7d6b91]/13 text-[#7d6b91] dark:border-[#b2a1c7]/30 dark:bg-[#b2a1c7]/16 dark:text-[#b2a1c7]",
                  )}
                >
                  {isThrottled ? "配额 / 去重拦截" : "免打扰顺延"}
                </span>
                <a
                  href={`${base}/sessions/${encodeURIComponent(ev.sessionId)}`}
                  className="font-medium text-foreground/85 hover:underline"
                >
                  {ev.sessionTitle}
                </a>
              </div>
              <span className="tabular-nums text-muted-foreground">
                {formatShortTime(ev.createdAt, timezone)}
              </span>
            </div>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              {ev.summary}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function LedgerEmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  readonly icon: typeof GitPullRequestArrow;
  readonly title: string;
  readonly description: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <p className="mt-3 text-[14px] font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-3.5">{action}</div>}
    </div>
  );
}
