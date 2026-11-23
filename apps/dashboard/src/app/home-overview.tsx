import {
  Activity,
  BriefcaseBusiness,
  CircleCheck,
  MessagesSquare,
  Radio,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { resolveSessionKindCategory } from "@/app/sessions/session-avatar";
import { resolveTaskEffectiveState } from "@/app/tasks/task-visuals";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  DashboardRuntimeStatus,
  DashboardSession,
  DashboardTask,
} from "@/lib/api";
import { UiText, useTranslation } from "@/lib/i18n";
import { isActiveTaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const cardSurfaceClass =
  "rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000005]";
const sageCardSurfaceClass =
  "relative overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000005] before:absolute before:top-0 before:left-6 before:h-[3px] before:w-7 before:rounded-xs before:bg-[#a3b69e] dark:before:bg-[#8ea487]";

export function HomeOverview({
  activeModelLabel,
  shadowCount,
  scopePicker,
  scopeError,
  tasks,
  sessions,
  tasksLoading,
  sessionsLoading,
  runtimeStatus,
  runtimeLoading,
  runtimeError,
}: {
  readonly activeModelLabel?: string;
  readonly shadowCount?: number;
  readonly scopePicker?: ReactNode;
  readonly scopeError?: unknown;
  readonly tasks: readonly DashboardTask[];
  readonly sessions: readonly DashboardSession[];
  readonly tasksLoading: boolean;
  readonly sessionsLoading: boolean;
  readonly runtimeStatus: DashboardRuntimeStatus | undefined;
  readonly runtimeLoading: boolean;
  readonly runtimeError: unknown;
}) {
  const { locale, t } = useTranslation();
  const tone = runtimeTone(runtimeStatus, runtimeLoading, runtimeError);

  const taskStats = useMemo(() => {
    let running = 0;
    let waiting = 0;
    let completed = 0;
    let attention = 0;
    for (const item of tasks) {
      if (isActiveTaskStatus(item.status)) {
        running += 1;
        continue;
      }
      const eff = resolveTaskEffectiveState(item);
      if (eff === "waiting" || eff === "new") {
        waiting += 1;
      } else if (eff === "failed" || eff === "cancelled") {
        attention += 1;
      } else {
        completed += 1;
      }
    }
    return {
      total: tasks.length,
      running,
      waiting,
      openCount: running + waiting,
      completed,
      attention,
    };
  }, [tasks]);

  const activeSessions = useMemo(
    () => sessions.filter((s) => s.bindingStatus !== "retired"),
    [sessions],
  );

  const sessionStats = useMemo(() => {
    let groups = 0;
    let direct = 0;
    let local = 0;
    let listening = 0;
    for (const session of activeSessions) {
      if (session.parentSessionId ?? session.parent_session_id) {
        continue;
      }
      const kind = resolveSessionKindCategory(session);
      if (kind === "group") groups += 1;
      else if (kind === "direct") direct += 1;
      else local += 1;
      if (session.listening === true) {
        listening += 1;
      }
    }
    return {
      total: activeSessions.length,
      surfaceTotal: groups + direct + local,
      groups,
      direct,
      local,
      listening,
    };
  }, [activeSessions]);

  const channels = runtimeStatus?.channels ?? [];
  const connectedChannels = channels.filter(
    (ch) => ch.inbound?.state === undefined || ch.inbound.state === "connected",
  ).length;

  const metaItems: string[] = [];
  if (runtimeStatus?.uptime !== undefined) {
    metaItems.push(`${t("Uptime")} ${formatUptime(runtimeStatus.uptime)}`);
  }
  if (activeModelLabel) {
    metaItems.push(activeModelLabel);
  }
  if (shadowCount !== undefined && shadowCount > 0) {
    metaItems.push(
      locale === "zh-CN"
        ? `${shadowCount} 个分身`
        : `${shadowCount} ${shadowCount === 1 ? "shadow" : "shadows"}`,
    );
  }

  return (
    <div
      className="@container flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background"
      data-testid="agent-overview"
    >
      <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-7 sm:px-8">
        {/* Clean Page Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="m-0 text-[22px] leading-snug font-semibold tracking-tight text-foreground">
              {t("Operations, at a glance.")}
            </h1>
            <p className="m-0 mt-1 text-sm text-muted-foreground">
              {t(
                "Real-time runtime health, channel connectivity, and workload summary.",
              )}
            </p>
          </div>
          {scopePicker ? (
            <div className="flex shrink-0 items-center gap-2">{scopePicker}</div>
          ) : null}
        </header>

        {scopeError instanceof Error ? (
          <p
            role="alert"
            className="m-0 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
          >
            {scopeError.message}
          </p>
        ) : null}

        {/* Unified Runtime Health Banner */}
        <section
          className={cn(
            sageCardSurfaceClass,
            "flex flex-col gap-4 px-6 py-5 @[840px]:flex-row @[840px]:items-center @[840px]:justify-between",
          )}
        >
          <div className="flex min-w-0 items-center gap-3.5">
            <div
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-xl",
                tone === "ok"
                  ? "bg-[#5b8a72]/12 text-[#5b8a72] dark:bg-[#7fb096]/15 dark:text-[#7fb096]"
                  : tone === "warn"
                    ? "bg-[#b07d4f]/14 text-[#b07d4f] dark:bg-[#d1a273]/16 dark:text-[#d1a273]"
                    : "bg-[#b5544a]/14 text-[#b5544a] dark:bg-[#dc7a70]/16 dark:text-[#dc7a70]",
              )}
            >
              <Activity className="size-4.5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-foreground">
                  {tone === "ok"
                    ? t("System healthy")
                    : tone === "warn"
                      ? runtimeLoading
                        ? t("Checking runtime status…")
                        : t("Channel attention needed")
                      : t("Runtime unavailable")}
                </span>
              </div>
              {metaItems.length > 0 ? (
                <p className="m-0 mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {metaItems.join("  ·  ")}
                </p>
              ) : (
                <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                  {t("Luna Runtime")}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <RuntimeStatusBadge
              error={runtimeError}
              loading={runtimeLoading}
              status={runtimeStatus}
            />
            <ChannelStatusBadge
              error={runtimeError}
              loading={runtimeLoading}
              status={runtimeStatus}
            />
            <AgentStatusBadge
              error={runtimeError}
              loading={runtimeLoading}
              status={runtimeStatus}
            />
          </div>
        </section>

        {/* 4 Pure Summary KPI Cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricSummaryCard
            label={t("Active tasks")}
            icon={BriefcaseBusiness}
            iconTone="ochre"
            value={tasksLoading ? "–" : String(taskStats.openCount)}
            caption={
              tasksLoading ? (
                t("Loading")
              ) : taskStats.openCount > 0 ? (
                locale === "zh-CN" ? (
                  `${taskStats.running} 运行中 · ${taskStats.waiting} 待反馈`
                ) : (
                  `${taskStats.running} running · ${taskStats.waiting} waiting`
                )
              ) : (
                t("Queue idle")
              )
            }
          />

          <MetricSummaryCard
            label={t("Completed")}
            icon={CircleCheck}
            iconTone="sage"
            value={tasksLoading ? "–" : String(taskStats.completed)}
            caption={
              tasksLoading ? (
                t("Loading")
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <UiText>{`${taskStats.total} total`}</UiText>
                  {taskStats.attention > 0 ? (
                    <>
                      <span>·</span>
                      <span className="font-medium text-[#b5544a] dark:text-[#dc7a70]">
                        {locale === "zh-CN"
                          ? `${taskStats.attention} 异常`
                          : `${taskStats.attention} failed`}
                      </span>
                    </>
                  ) : null}
                </span>
              )
            }
          />

          <MetricSummaryCard
            label={t("Sessions")}
            icon={MessagesSquare}
            iconTone="slate"
            value={sessionsLoading ? "–" : String(sessionStats.total)}
            caption={
              sessionsLoading
                ? t("Loading")
                : locale === "zh-CN"
                  ? `${sessionStats.groups} 群聊 · ${sessionStats.direct} 私聊 · ${sessionStats.local} 本地`
                  : `${sessionStats.groups} groups · ${sessionStats.direct} direct · ${sessionStats.local} local`
            }
          />

          <MetricSummaryCard
            label={t("Channels")}
            icon={Radio}
            iconTone="neutral"
            value={
              runtimeLoading
                ? "–"
                : channels.length > 0
                  ? `${connectedChannels} / ${channels.length}`
                  : "0"
            }
            caption={
              runtimeLoading
                ? t("Loading")
                : channels.length === 0
                  ? t("Local conversation only")
                  : connectedChannels === channels.length
                    ? t("All channels connected")
                    : `${connectedChannels} ${t("channels connected")}`
            }
          />
        </div>

        {/* 2 Calm Aggregate Breakdown Panels (No Subpage Lists or Action Buttons) */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Task Status Distribution */}
          <section className={cn(cardSurfaceClass, "p-6")}>
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <h2 className="m-0 text-sm font-semibold text-foreground">
                  {t("Task Status Breakdown")}
                </h2>
                <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                  {t("Current task load by latest run state.")}
                </p>
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">
                <UiText>{`${taskStats.total} total`}</UiText>
              </span>
            </div>

            {tasksLoading ? (
              <div className="mt-5 space-y-3">
                <Skeleton className="h-2.5 w-full rounded-full" />
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <Skeleton className="h-14 rounded-xl" />
                  <Skeleton className="h-14 rounded-xl" />
                  <Skeleton className="h-14 rounded-xl" />
                  <Skeleton className="h-14 rounded-xl" />
                </div>
              </div>
            ) : (
              <>
                <div className="mt-5 flex h-2 w-full overflow-hidden rounded-full bg-secondary">
                  {taskStats.total > 0 ? (
                    <>
                      {taskStats.running > 0 ? (
                        <div
                          className="bg-[#b07d4f] transition-all dark:bg-[#d1a273]"
                          style={{
                            width: `${(taskStats.running / taskStats.total) * 100}%`,
                          }}
                        />
                      ) : null}
                      {taskStats.waiting > 0 ? (
                        <div
                          className="bg-[#5c7c99] transition-all dark:bg-[#86a3be]"
                          style={{
                            width: `${(taskStats.waiting / taskStats.total) * 100}%`,
                          }}
                        />
                      ) : null}
                      {taskStats.completed > 0 ? (
                        <div
                          className="bg-[#5b8a72] transition-all dark:bg-[#7fb096]"
                          style={{
                            width: `${(taskStats.completed / taskStats.total) * 100}%`,
                          }}
                        />
                      ) : null}
                      {taskStats.attention > 0 ? (
                        <div
                          className="bg-[#b5544a] transition-all dark:bg-[#dc7a70]"
                          style={{
                            width: `${(taskStats.attention / taskStats.total) * 100}%`,
                          }}
                        />
                      ) : null}
                    </>
                  ) : null}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <DistributionStatTile
                    dotClass="bg-[#b07d4f] dark:bg-[#d1a273]"
                    label={t("Running")}
                    count={taskStats.running}
                    total={taskStats.total}
                  />
                  <DistributionStatTile
                    dotClass="bg-[#5c7c99] dark:bg-[#86a3be]"
                    label={t("Waiting")}
                    count={taskStats.waiting}
                    total={taskStats.total}
                  />
                  <DistributionStatTile
                    dotClass="bg-[#5b8a72] dark:bg-[#7fb096]"
                    label={t("Completed")}
                    count={taskStats.completed}
                    total={taskStats.total}
                  />
                  <DistributionStatTile
                    dotClass="bg-[#b5544a] dark:bg-[#dc7a70]"
                    label={t("Failed / Cancelled")}
                    count={taskStats.attention}
                    total={taskStats.total}
                  />
                </div>
              </>
            )}
          </section>

          {/* Surface & Channel Health Summary */}
          <section className={cn(cardSurfaceClass, "flex flex-col justify-between p-6")}>
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <div>
                  <h2 className="m-0 text-sm font-semibold text-foreground">
                    {t("Channel & Surface Summary")}
                  </h2>
                  <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                    {t("Active conversation surfaces and inbound channel health.")}
                  </p>
                </div>
                {sessionStats.listening > 0 ? (
                  <span className="rounded-full bg-[#5b8a72]/12 px-2.5 py-0.5 text-[11px] font-medium text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]">
                    {sessionStats.listening} {t("Listening")}
                  </span>
                ) : null}
              </div>

              {sessionsLoading ? (
                <div className="mt-5 space-y-3">
                  <Skeleton className="h-2.5 w-full rounded-full" />
                  <Skeleton className="h-14 w-full rounded-xl" />
                </div>
              ) : (
                <>
                  <div className="mt-5 flex h-2 w-full overflow-hidden rounded-full bg-secondary">
                    {sessionStats.surfaceTotal > 0 ? (
                      <>
                        {sessionStats.groups > 0 ? (
                          <div
                            className="bg-[#5c7c99] dark:bg-[#86a3be]"
                            style={{
                              width: `${(sessionStats.groups / sessionStats.surfaceTotal) * 100}%`,
                            }}
                          />
                        ) : null}
                        {sessionStats.direct > 0 ? (
                          <div
                            className="bg-[#5b8a72] dark:bg-[#7fb096]"
                            style={{
                              width: `${(sessionStats.direct / sessionStats.surfaceTotal) * 100}%`,
                            }}
                          />
                        ) : null}
                        {sessionStats.local > 0 ? (
                          <div
                            className="bg-[#a39e93] dark:bg-[#78746c]"
                            style={{
                              width: `${(sessionStats.local / sessionStats.surfaceTotal) * 100}%`,
                            }}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2.5">
                    <SurfaceMiniStat
                      dotClass="bg-[#5c7c99] dark:bg-[#86a3be]"
                      label={t("Group chat")}
                      count={sessionStats.groups}
                    />
                    <SurfaceMiniStat
                      dotClass="bg-[#5b8a72] dark:bg-[#7fb096]"
                      label={t("Direct chat")}
                      count={sessionStats.direct}
                    />
                    <SurfaceMiniStat
                      dotClass="bg-[#a39e93] dark:bg-[#78746c]"
                      label={t("Local chat")}
                      count={sessionStats.local}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="mt-4 border-t border-border/70 pt-3.5">
              {runtimeLoading ? (
                <Skeleton className="h-8 w-full rounded-lg" />
              ) : channels.length === 0 ? (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t("Inbound channels")}</span>
                  <span>{t("No external channels configured")}</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {channels.map((channel) => {
                    const state = channel.inbound?.state ?? "connected";
                    const isConnected = state === "connected";
                    return (
                      <div
                        key={channel.id}
                        className="inline-flex items-center gap-2 rounded-lg border border-border/80 bg-background/60 px-2.5 py-1.5 text-xs"
                      >
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            isConnected
                              ? "bg-[#5b8a72] dark:bg-[#7fb096]"
                              : "bg-[#b07d4f] dark:bg-[#d1a273]",
                          )}
                        />
                        <span className="font-medium text-foreground">
                          <UiText>{formatChannelType(channel.type)}</UiText>
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {channel.id}
                        </span>
                        <span
                          className={cn(
                            "text-[11px] font-medium",
                            isConnected
                              ? "text-[#5b8a72] dark:text-[#7fb096]"
                              : "text-[#b07d4f] dark:text-[#d1a273]",
                          )}
                        >
                          <UiText>{state}</UiText>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function HomeOverviewForTest({
  tasks,
  sessions,
  runtimeStatus,
  runtimeLoading,
  runtimeError,
}: {
  readonly tasks: readonly DashboardTask[];
  readonly sessions: readonly DashboardSession[];
  readonly runtimeStatus: DashboardRuntimeStatus | undefined;
  readonly runtimeLoading: boolean;
  readonly runtimeError: unknown;
}) {
  return (
    <HomeOverview
      tasks={tasks}
      sessions={sessions}
      tasksLoading={false}
      sessionsLoading={false}
      runtimeStatus={runtimeStatus}
      runtimeLoading={runtimeLoading}
      runtimeError={runtimeError}
    />
  );
}

function MetricSummaryCard({
  label,
  value,
  caption,
  icon: Icon,
  iconTone,
}: {
  readonly label: string;
  readonly value: string;
  readonly caption: ReactNode;
  readonly icon: typeof Activity;
  readonly iconTone: "ochre" | "sage" | "slate" | "neutral";
}) {
  return (
    <div className={cn(cardSurfaceClass, "flex flex-col justify-between p-5")}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{label}</span>
        <span
          className={cn(
            "inline-grid size-7 place-items-center rounded-lg",
            iconTone === "ochre" &&
              "bg-[#b07d4f]/12 text-[#b07d4f] dark:bg-[#d1a273]/15 dark:text-[#d1a273]",
            iconTone === "sage" &&
              "bg-[#5b8a72]/12 text-[#5b8a72] dark:bg-[#7fb096]/15 dark:text-[#7fb096]",
            iconTone === "slate" &&
              "bg-[#5c7c99]/12 text-[#5c7c99] dark:bg-[#86a3be]/15 dark:text-[#86a3be]",
            iconTone === "neutral" && "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="mt-3 text-[28px] leading-none font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-2.5 truncate text-xs text-muted-foreground">
        {caption}
      </div>
    </div>
  );
}

function DistributionStatTile({
  dotClass,
  label,
  count,
  total,
}: {
  readonly dotClass: string;
  readonly label: string;
  readonly count: number;
  readonly total: number;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/50 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
        <span className="text-sm font-semibold text-foreground">{count}</span>
        {total > 0 ? (
          <span className="text-[11px] text-muted-foreground">{pct}%</span>
        ) : null}
      </div>
    </div>
  );
}

function SurfaceMiniStat({
  dotClass,
  label,
  count,
}: {
  readonly dotClass: string;
  readonly label: string;
  readonly count: number;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 text-base font-semibold tabular-nums text-foreground">
        {count}
      </div>
    </div>
  );
}

function RuntimeStatusBadge({
  status,
  loading,
  error,
}: {
  readonly status: DashboardRuntimeStatus | undefined;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  const tone = runtimeTone(status, loading, error);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "ok"
          ? "bg-[#5b8a72]/13 text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]"
          : tone === "warn"
            ? "bg-[#b07d4f]/14 text-[#b07d4f] dark:bg-[#d1a273]/16 dark:text-[#d1a273]"
            : "bg-[#b5544a]/14 text-[#b5544a] dark:bg-[#dc7a70]/16 dark:text-[#dc7a70]",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "ok"
            ? "bg-[#5b8a72] dark:bg-[#7fb096]"
            : tone === "warn"
              ? "bg-[#b07d4f] dark:bg-[#d1a273]"
              : "bg-[#b5544a] dark:bg-[#dc7a70]",
        )}
      />
      <UiText>{runtimeLabel(status, loading, error)}</UiText>
    </span>
  );
}

function ChannelStatusBadge({
  status,
  loading,
  error,
}: {
  readonly status: DashboardRuntimeStatus | undefined;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground">
      <Waypoints className="size-3 text-muted-foreground" />
      <UiText>{channelStatusLabel(status, loading, error)}</UiText>
    </span>
  );
}

function AgentStatusBadge({
  status,
  loading,
  error,
}: {
  readonly status: DashboardRuntimeStatus | undefined;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">
      <ShieldCheck className="size-3" />
      <UiText>{agentStatusLabel(status, loading, error)}</UiText>
    </span>
  );
}

function runtimeTone(
  status: DashboardRuntimeStatus | undefined,
  loading: boolean,
  error: unknown,
): "ok" | "warn" | "error" {
  if (error !== null && error !== undefined) {
    return "error";
  }
  if (loading || status === undefined) {
    return "warn";
  }
  return status.channels.every(
    (channel) =>
      channel.inbound?.state === undefined ||
      channel.inbound.state === "connected",
  )
    ? "ok"
    : "warn";
}

function runtimeLabel(
  status: DashboardRuntimeStatus | undefined,
  loading: boolean,
  error: unknown,
): string {
  if (error !== null && error !== undefined) {
    return "Runtime unavailable";
  }
  if (loading || status === undefined) {
    return "Runtime loading";
  }
  return `Runtime ${status.status}`;
}

function channelStatusLabel(
  status: DashboardRuntimeStatus | undefined,
  loading: boolean,
  error: unknown,
): string {
  if (error !== null && error !== undefined) {
    return "Channels unavailable";
  }
  if (loading || status === undefined) {
    return "Channels loading";
  }
  const primary = status.channels[0];
  if (primary === undefined) {
    return "No channels";
  }
  const primaryState = primary.inbound?.state ?? "connected";
  const channelCount =
    status.channels.length === 1
      ? "1 channel"
      : `${status.channels.length} channels`;
  return `${formatChannelType(primary.type)} ${primaryState} · ${channelCount}`;
}

function agentStatusLabel(
  status: DashboardRuntimeStatus | undefined,
  loading: boolean,
  error: unknown,
): string {
  if (error !== null && error !== undefined) {
    return "Agent unavailable";
  }
  if (loading || status === undefined) {
    return "Agent loading";
  }
  return "Service running";
}

function formatChannelType(type: string): string {
  return type.length === 0
    ? "Channel"
    : `${type.slice(0, 1).toUpperCase()}${type.slice(1)}`;
}

function formatUptime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const mins = Math.floor(safe / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
