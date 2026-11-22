import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  BellOff,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitPullRequestArrow,
  HeartPulse,
  HelpCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentBasePath, useRouteAgent } from "@/lib/agent-route";
import {
  useCancelProactivityRequest,
  useProactivityOverview,
  useTriggerShadowHeartbeat,
  type DashboardCorrelatedRequestItem,
  type DashboardShadowHeartbeatItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/$agentId/proactivity/")({
  component: ProactivityPage,
});

type RequestFilter = "all" | "pending" | "ask" | "handoff";

function formatDateTime(ms: number | null | undefined, timezone?: string): string {
  if (!ms || ms <= 0) return "尚未运行";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      ...(timezone ? { timeZone: timezone } : {}),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
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

  const [requestFilter, setRequestFilter] = useState<RequestFilter>("all");
  const [triggerBanner, setTriggerBanner] = useState<{
    shadowName: string;
    sessionId: string;
    alreadyRunning: boolean;
  } | null>(null);

  const data = overviewQuery.data;
  const now = data?.now ?? Date.now();

  const filteredRequests = useMemo(() => {
    const list = data?.requests ?? [];
    return list.filter(item => {
      if (requestFilter === "pending") return item.status === "pending";
      if (requestFilter === "ask") return item.kind === "ask";
      if (requestFilter === "handoff") return item.kind === "handoff";
      return true;
    });
  }, [data?.requests, requestFilter]);

  const wakeShadows = (data?.heartbeats ?? []).filter(
    hb => hb.pendingActivity.hasWakeActivity,
  ).length;
  const openRequestsCount = (data?.requests ?? []).filter(
    r => r.status === "pending",
  ).length;
  const enabledDutiesCount = (data?.duties ?? []).filter(d => d.enabled).length;
  const failedDutiesCount = (data?.duties ?? []).filter(
    d => d.lastFailure !== null,
  ).length;
  const deferredCount = data?.governance.deferredQueue.length ?? 0;

  async function handleTriggerHeartbeat(hb: DashboardShadowHeartbeatItem) {
    const res = await triggerHeartbeat.mutateAsync(hb.shadowId);
    setTriggerBanner({
      shadowName: hb.shadowName,
      sessionId: res.sessionId,
      alreadyRunning: res.alreadyRunning,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <HeartPulse className="size-3.5 text-primary" />
              <span>自我层 · 主动沟通 · 外发调控</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">主动中心</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              实时查看数字分身的心跳巡检状态、向用户发起的追问确认（Ask）、跨会话协同委派（Handoff）、值班职责及免打扰外发调控。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selection.availableShadows.length > 1 && (
              <ShadowPicker selection={selection} />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={overviewQuery.isFetching}
              onClick={() => void overviewQuery.refetch()}
            >
              <RefreshCw
                className={cn(
                  "mr-1.5 size-3.5",
                  overviewQuery.isFetching && "animate-spin",
                )}
              />
              刷新
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`${base}/settings/general`}>
                <SlidersHorizontal className="mr-1.5 size-3.5" />
                主动策略设置
              </a>
            </Button>
          </div>
        </header>

        {/* Active Policy Bar */}
        {data && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/25 px-4 py-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">当前生效策略：</span>
            <Badge variant="outline">
              心跳间隔{" "}
              {data.settings.heartbeatIntervalMs > 0
                ? `${Math.round(data.settings.heartbeatIntervalMs / 60_000)} 分钟`
                : "已关闭"}
            </Badge>
            <Badge variant="outline">
              单会话上限{" "}
              {data.settings.outboundPerSessionPerHour > 0
                ? `${data.settings.outboundPerSessionPerHour} 条/小时`
                : "不限"}
            </Badge>
            <Badge variant="outline">
              单接收人上限{" "}
              {data.settings.outboundPerRecipientPerDay > 0
                ? `${data.settings.outboundPerRecipientPerDay} 条/天`
                : "不限"}
            </Badge>
            <Badge variant="outline">
              去重窗口{" "}
              {data.settings.outboundDedupWindowMs > 0
                ? `${Math.round(data.settings.outboundDedupWindowMs / 3_600_000)} 小时`
                : "关闭"}
            </Badge>
            {data.settings.quietHours ? (
              <Badge
                variant={data.settings.inQuietHours ? "default" : "secondary"}
                className={cn(
                  data.settings.inQuietHours &&
                    "bg-indigo-600 text-white hover:bg-indigo-600",
                )}
              >
                <BellOff className="mr-1 size-3" />
                免打扰 {data.settings.quietHours.start}–
                {data.settings.quietHours.end}
                {data.settings.inQuietHours ? "（生效中）" : "（未到时段）"}
              </Badge>
            ) : (
              <Badge variant="outline">免打扰：未开启</Badge>
            )}
          </div>
        )}

        {/* Manual Trigger Banner */}
        {triggerBanner && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-950 dark:text-emerald-200">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                {triggerBanner.alreadyRunning
                  ? `分身「${triggerBanner.shadowName}」已有心跳任务正在队列或执行中。`
                  : `已唤醒分身「${triggerBanner.shadowName}」执行即时心跳巡检。`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={`${base}/sessions/${encodeURIComponent(triggerBanner.sessionId)}`}
                className="inline-flex items-center gap-1 font-medium underline"
              >
                进入心跳会话查看
                <ArrowRight className="size-3.5" />
              </a>
              <button
                type="button"
                onClick={() => setTriggerBanner(null)}
                className="text-xs opacity-70 hover:opacity-100"
              >
                关闭
              </button>
            </div>
          </div>
        )}

        {/* Error / Loading */}
        {overviewQuery.error instanceof Error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            加载主动中心数据失败：{overviewQuery.error.message}
          </div>
        )}

        {overviewQuery.isLoading && !data ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl" />
            ))}
          </div>
        ) : data ? (
          <>
            {/* 4 Metric Cards */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryTile
                title="分身心跳实况"
                value={`${data.heartbeats.length} 个分身`}
                subtitle={
                  wakeShadows > 0
                    ? `${wakeShadows} 个分身有新动态待巡检`
                    : "全部游标已同步，安静守候"
                }
                icon={HeartPulse}
                tone={wakeShadows > 0 ? "amber" : "neutral"}
              />
              <SummaryTile
                title="待响应追问 / 协同"
                value={String(openRequestsCount)}
                subtitle={`累计记录 ${data.requests.length} 条关联请求`}
                icon={HelpCircle}
                tone={openRequestsCount > 0 ? "blue" : "neutral"}
              />
              <SummaryTile
                title="值班巡检职责 (task.run)"
                value={String(enabledDutiesCount)}
                subtitle={
                  failedDutiesCount > 0
                    ? `${failedDutiesCount} 个巡检最近执行失败`
                    : `共 ${data.duties.length} 个直连巡检任务`
                }
                icon={CalendarClock}
                tone={failedDutiesCount > 0 ? "red" : "neutral"}
              />
              <SummaryTile
                title="近 24h 主动外发"
                value={`${data.governance.sentLast24h} 条`}
                subtitle={
                  deferredCount > 0
                    ? `${deferredCount} 条消息因免打扰顺延待发`
                    : "当前无顺延积压消息"
                }
                icon={BellOff}
                tone={deferredCount > 0 ? "indigo" : "neutral"}
              />
            </div>

            {/* Section 1: Shadow Heartbeats */}
            <Card className="rounded-xl">
              <CardHeader className="border-b pb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <HeartPulse className="size-4 text-primary" />
                      分身心跳实况（Shadow Heartbeat）
                    </CardTitle>
                    <CardDescription className="mt-1">
                      每个分身独立维护专属「心跳」会话与游标；仅在游标后出现新人类消息、结案任务或请求回执时才唤醒模型，零动态时零 Token 消耗。
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 p-5 md:grid-cols-2">
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
              </CardContent>
            </Card>

            {/* Section 2: Correlated Requests (Asks & Handoffs) */}
            <Card className="rounded-xl">
              <CardHeader className="border-b pb-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <GitPullRequestArrow className="size-4 text-primary" />
                      主动追问与跨会话协同账本（Asks & Handoffs）
                    </CardTitle>
                    <CardDescription className="mt-1">
                      追踪 Agent 通过 `luna asks` 向用户发起的选项/文本确认，以及通过 `luna handoff` 委派给目标会话跟进的闭环状态。
                    </CardDescription>
                  </div>
                  <div
                    role="group"
                    aria-label="请求筛选"
                    className="flex gap-0.5 rounded-lg bg-muted p-1 text-xs"
                  >
                    {(
                      [
                        ["all", `全部 (${data.requests.length})`],
                        ["pending", `等待中 (${openRequestsCount})`],
                        [
                          "ask",
                          `提问 (${data.requests.filter(r => r.kind === "ask").length})`,
                        ],
                        [
                          "handoff",
                          `委派 (${data.requests.filter(r => r.kind === "handoff").length})`,
                        ],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={requestFilter === key}
                        onClick={() => setRequestFilter(key)}
                        className={cn(
                          "rounded-md px-2.5 py-1 transition-colors",
                          requestFilter === key
                            ? "bg-card font-medium text-foreground shadow-2xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5">
                {filteredRequests.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                    {requestFilter === "all"
                      ? "暂无主动追问或跨会话委派记录。当 Agent 主动发起 `luna asks` 或 `luna handoff` 时将在此实时追踪。"
                      : "当前筛选条件下没有记录。"}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredRequests.map(req => (
                      <CorrelatedRequestRow
                        key={req.id}
                        item={req}
                        base={base}
                        now={now}
                        timezone={data.settings.timezone}
                        cancelling={
                          cancelRequest.isPending &&
                          cancelRequest.variables === req.id
                        }
                        onCancel={() => cancelRequest.mutate(req.id)}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Section 3: Duties & Outbound Governance */}
            <div className="grid gap-5 lg:grid-cols-2">
              {/* Left: Scheduled task.run Duties */}
              <Card className="rounded-xl">
                <CardHeader className="border-b pb-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <CalendarClock className="size-4 text-primary" />
                        值班巡检职责（直连 `task.run`）
                      </CardTitle>
                      <CardDescription className="mt-1">
                        到点直接以静默模式唤醒后台 Task Runner 执行巡检，不占用会话协调者。
                      </CardDescription>
                    </div>
                    <a
                      href={`${base}/schedules`}
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      管理定时任务
                      <ArrowRight className="size-3.5" />
                    </a>
                  </div>
                </CardHeader>
                <CardContent className="p-5">
                  {data.duties.length === 0 ? (
                    <div className="rounded-lg border border-dashed bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                      暂无直连后台任务的巡检计划。可在「定时任务」页面新建 `直连后台任务巡检（task.run）`，或让 Agent 按 `luna-duties` 规范自行建立。
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data.duties.map(duty => (
                        <div
                          key={duty.id}
                          className="rounded-lg border bg-card p-3.5 text-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{duty.title}</span>
                            <div className="flex items-center gap-1.5">
                              {duty.lastFailure && (
                                <Badge variant="destructive" className="text-[10px]">
                                  最近失败
                                </Badge>
                              )}
                              <Badge
                                variant={duty.enabled ? "secondary" : "outline"}
                                className="text-[10px]"
                              >
                                {duty.enabled ? "启用中" : "已暂停"}
                              </Badge>
                            </div>
                          </div>
                          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                            {duty.instruction}
                          </p>
                          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              后台任务：
                              <a
                                href={`${base}/tasks/${encodeURIComponent(duty.taskId)}`}
                                className="text-primary hover:underline"
                              >
                                {duty.taskTitle}
                              </a>
                            </span>
                            <span>
                              汇报会话：
                              <a
                                href={`${base}/sessions/${encodeURIComponent(duty.targetSessionId)}`}
                                className="text-primary hover:underline"
                              >
                                {duty.targetSessionTitle}
                              </a>
                            </span>
                            <span>
                              下次运行：{formatDateTime(duty.nextAt, duty.timezone)}
                            </span>
                          </div>
                          {duty.lastFailure && (
                            <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                              失败原因：{duty.lastFailure.reason}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Right: Outbound Governance & Deferred Queue */}
              <Card className="rounded-xl">
                <CardHeader className="border-b pb-4">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldAlert className="size-4 text-primary" />
                    免打扰顺延队列与外发调控记录
                  </CardTitle>
                  <CardDescription className="mt-1">
                    被动答复不受限制；主动通知受配额、去重窗口和免打扰时段保护。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 p-5">
                  <div>
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      免打扰待发队列（{data.governance.deferredQueue.length}）
                    </h3>
                    {data.governance.deferredQueue.length === 0 ? (
                      <p className="rounded-lg border border-dashed bg-muted/15 px-3.5 py-4 text-xs text-muted-foreground">
                        当前没有因免打扰暂存的主动消息。
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {data.governance.deferredQueue.map(cmd => (
                          <div
                            key={cmd.id}
                            className="rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-3 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <a
                                href={`${base}/sessions/${encodeURIComponent(cmd.sessionId)}`}
                                className="font-medium text-primary hover:underline"
                              >
                                {cmd.sessionTitle}
                              </a>
                              <Badge variant="outline" className="text-[10px]">
                                预计发送：
                                {formatDateTime(
                                  cmd.availableAt,
                                  data.settings.timezone,
                                )}
                              </Badge>
                            </div>
                            <p className="mt-1.5 line-clamp-2 text-muted-foreground">
                              {cmd.contentPreview}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      近期外发调控事件（{data.governance.recentEvents.length}）
                    </h3>
                    {data.governance.recentEvents.length === 0 ? (
                      <p className="rounded-lg border border-dashed bg-muted/15 px-3.5 py-4 text-xs text-muted-foreground">
                        近期未触发外发限流、重复拦截或免打扰顺延。
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {data.governance.recentEvents.slice(0, 10).map(ev => (
                          <div
                            key={ev.id}
                            className="rounded-lg border bg-muted/15 px-3 py-2.5 text-xs"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                <Badge
                                  variant={
                                    ev.controlKind === "outbound_throttled"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                  className="text-[10px]"
                                >
                                  {ev.controlKind === "outbound_throttled"
                                    ? "外发限流拦截"
                                    : "免打扰顺延"}
                                </Badge>
                                <a
                                  href={`${base}/sessions/${encodeURIComponent(ev.sessionId)}`}
                                  className="font-medium text-primary hover:underline"
                                >
                                  {ev.sessionTitle}
                                </a>
                              </div>
                              <span className="text-muted-foreground">
                                {formatDateTime(ev.createdAt, data.settings.timezone)}
                              </span>
                            </div>
                            <p className="mt-1 text-muted-foreground">
                              {ev.summary}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SummaryTile({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
}: {
  readonly title: string;
  readonly value: string;
  readonly subtitle: string;
  readonly icon: typeof HeartPulse;
  readonly tone: "neutral" | "amber" | "blue" | "red" | "indigo";
}) {
  return (
    <Card className="rounded-xl py-4">
      <CardContent className="flex items-start justify-between gap-3 px-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{title}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            tone === "amber" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
            tone === "blue" && "bg-blue-500/15 text-blue-600 dark:text-blue-400",
            tone === "red" && "bg-destructive/15 text-destructive",
            tone === "indigo" && "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
            tone === "neutral" && "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </div>
      </CardContent>
    </Card>
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

  const activityChips: string[] = [];
  if (act.messageCount > 0) {
    activityChips.push(`${act.messageSessions} 个会话共 ${act.messageCount} 条新消息`);
  }
  if (act.taskRunCount > 0) {
    activityChips.push(`${act.taskRunCount} 个后台任务已结案`);
  }
  if (act.scheduleOccurrenceCount > 0) {
    activityChips.push(`${act.scheduleOccurrenceCount} 次定时执行`);
  }
  if (act.correlatedRequestCount > 0) {
    activityChips.push(`${act.correlatedRequestCount} 条请求回执`);
  }

  return (
    <div className="flex flex-col justify-between rounded-xl border bg-card p-4 shadow-2xs">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{hb.shadowName}</span>
            {hb.isDefault && (
              <Badge variant="outline" className="text-[10px]">
                默认分身
              </Badge>
            )}
          </div>
          {isRunning ? (
            <Badge className="bg-blue-600 text-white hover:bg-blue-600">
              心跳执行中
            </Badge>
          ) : isFailed ? (
            <Badge variant="destructive">上次心跳异常</Badge>
          ) : act.hasWakeActivity ? (
            <Badge className="bg-amber-500/20 text-amber-800 hover:bg-amber-500/20 dark:text-amber-300">
              有新动态待巡检
            </Badge>
          ) : (
            <Badge variant="secondary">空闲守候</Badge>
          )}
        </div>

        {/* Pending Activity Digest */}
        <div className="rounded-lg bg-muted/35 px-3 py-2 text-xs">
          <span className="font-medium text-foreground">游标后待巡检动态：</span>
          {activityChips.length > 0 ? (
            <span className="ml-1 text-foreground">{activityChips.join(" · ")}</span>
          ) : (
            <span className="ml-1 text-muted-foreground">
              暂无新消息或任务变动（到点将跳过模型调用）
            </span>
          )}
        </div>

        {/* Timestamps */}
        <div className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex items-center gap-1.5">
            <Clock3 className="size-3.5 shrink-0" />
            <span>
              上次心跳：{formatDateTime(hb.lastQueuedAt, timezone)}（
              {formatRelative(hb.lastQueuedAt, now)}）
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5 shrink-0" />
            <span>
              下次窗口：
              {!hb.nextEligibleAt
                ? "已关闭周期唤醒"
                : hb.nextEligibleAt <= now
                  ? act.hasWakeActivity
                    ? "下一轮扫描即唤醒"
                    : "随时就绪（有新动态即唤醒）"
                  : `${formatDateTime(hb.nextEligibleAt, timezone)}（${formatRelative(hb.nextEligibleAt, now)}）`}
            </span>
          </div>
        </div>

        {isFailed && hb.latestCommand?.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-2 break-all">{hb.latestCommand.error}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {hb.sessionId ? (
          <a
            href={`${base}/sessions/${encodeURIComponent(hb.sessionId)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            打开「心跳」专属会话
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            尚未生成心跳会话（首次唤醒时创建）
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant={act.hasWakeActivity ? "default" : "outline"}
          disabled={triggering || isRunning}
          onClick={onTrigger}
        >
          <Play className="mr-1.5 size-3.5" />
          {triggering
            ? "唤醒中…"
            : isRunning
              ? "正在执行心跳"
              : "立即唤醒心跳"}
        </Button>
      </div>
    </div>
  );
}

const STATUS_META: Record<
  DashboardCorrelatedRequestItem["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
  pending: {
    label: "等待响应",
    variant: "default",
    className: "bg-blue-600 text-white hover:bg-blue-600",
  },
  answered: {
    label: "已回答",
    variant: "secondary",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  done: {
    label: "已完成",
    variant: "secondary",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  declined: { label: "已婉拒", variant: "destructive" },
  expired: { label: "已过期", variant: "outline" },
  failed: { label: "执行失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
};

function CorrelatedRequestRow({
  item,
  base,
  now,
  timezone,
  cancelling,
  onCancel,
}: {
  readonly item: DashboardCorrelatedRequestItem;
  readonly base: string;
  readonly now: number;
  readonly timezone: string;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}) {
  const statusMeta = STATUS_META[item.status] ?? {
    label: item.status,
    variant: "outline" as const,
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
    <div className="rounded-xl border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {item.kind === "ask" ? "主动提问 (Ask)" : "跨会话委派 (Handoff)"}
          </Badge>
          <Badge variant={statusMeta.variant} className={statusMeta.className}>
            {statusMeta.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            分身：{item.shadowName}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {item.id}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>发起于 {formatDateTime(item.createdAt, timezone)}</span>
          {item.status === "pending" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cancelling}
              onClick={onCancel}
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            >
              <XCircle className="mr-1 size-3.5" />
              {cancelling ? "取消中…" : "取消"}
            </Button>
          )}
        </div>
      </div>

      {/* Session Flow */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>发起会话：</span>
        <a
          href={`${base}/sessions/${encodeURIComponent(item.originSessionId)}`}
          className="font-medium text-primary hover:underline"
        >
          {item.originSessionTitle}
        </a>
        <ArrowRight className="size-3" />
        <span>目标：</span>
        <a
          href={`${base}/sessions/${encodeURIComponent(item.targetSessionId)}`}
          className="font-medium text-primary hover:underline"
        >
          {item.targetSessionTitle}
        </a>
        {item.targetUserName && (
          <Badge variant="outline" className="ml-1 text-[10px]">
            指定对象：{item.targetUserName}
          </Badge>
        )}
        {item.status === "pending" && item.expiresAt && (
          <span className="ml-auto text-xs text-muted-foreground">
            过期时间：{formatDateTime(item.expiresAt, timezone)}（
            {formatRelative(item.expiresAt, now)}）
          </span>
        )}
      </div>

      {/* Question / Instruction */}
      <p className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-muted/30 px-3 py-2 text-sm">
        {item.instruction}
      </p>

      {/* Ask Options */}
      {item.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">快捷选项：</span>
          {item.options.map(opt => {
            const chosen = selectedOption === opt;
            return (
              <Badge
                key={opt}
                variant={chosen ? "default" : "outline"}
                className={cn(
                  "text-xs",
                  chosen && "bg-emerald-600 text-white hover:bg-emerald-600",
                )}
              >
                {chosen ? `✓ ${opt}` : opt}
              </Badge>
            );
          })}
        </div>
      )}

      {/* Resolution */}
      {answerOrSummary && (
        <div className="mt-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
            <span className="font-medium text-foreground">
              回执结果
              {item.resolvedByUserName ? `（由 ${item.resolvedByUserName} 响应）` : ""}
            </span>
            <span>{formatDateTime(item.updatedAt, timezone)}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
            {answerOrSummary}
          </p>
        </div>
      )}
    </div>
  );
}
