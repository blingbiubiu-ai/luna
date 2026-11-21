import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowUpRight,
  CircleCheck,
  FileText,
  MessageSquare,
  Play,
  Search,
  TerminalSquareIcon,
  User,
  X,
} from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";

import { avatarColorForKey } from "@/app/sessions/session-avatar";
import { CopyTextButton } from "@/components/copy-text-button";
import { IdentityLink, identitySearchText } from "@/components/identity-link";
import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { SelectField } from "@/components/ui/select-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentBasePath } from "@/lib/agent-route";
import { useTasks, type DashboardTask, type DashboardTaskRun, type DashboardTaskSession } from "@/lib/api";
import { appHistory } from "@/lib/app-history";
import { UiText, useTranslation } from "@/lib/i18n";
import { isActiveTaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

import {
  formatRunDuration,
  formatTaskFullTime,
  formatTaskRelativeTime,
  identityForCanonicalUser,
  MiniUserBadgeAvatar,
  parseTaskContext,
  resolveTaskEffectiveState,
  TaskPriorityPill,
  taskStateClasses,
  TaskStateIcon,
  TaskStatusPill,
  TaskTypePill,
  type TaskEffectiveState,
} from "./task-visuals";

export const Route = createFileRoute("/$agentId/tasks/")({
  component: TasksPage,
});

export type TaskStatusTab = "all" | "running" | "waiting" | "completed" | "attention";
export type TaskLayoutMode = "grouped" | "stream";

function shouldInterceptNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function navigateClient(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (!shouldInterceptNavigation(event)) {
    return;
  }
  event.preventDefault();
  appHistory.push(href);
}

function TasksPage() {
  const selection = useShadowScope();
  const { data: tasks, error, isLoading } = useTasks(selection.scope);

  return (
    <TasksWorkspaceView
      tasks={tasks ?? []}
      loading={isLoading || selection.loading}
      error={error ?? selection.error}
      shadowControl={
        selection.availableShadows.length > 1 ? (
          <ShadowPicker selection={selection} />
        ) : null
      }
    />
  );
}

export function TasksWorkspaceView({
  tasks,
  loading,
  error,
  shadowControl,
}: {
  readonly tasks: readonly DashboardTask[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly shadowControl?: React.ReactNode;
}) {
  const base = useAgentBasePath();
  const { locale, t } = useTranslation();
  const [layoutMode, setLayoutMode] = useState<TaskLayoutMode>("grouped");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<TaskStatusTab>("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const counts = useMemo(() => {
    let running = 0;
    let waiting = 0;
    let completed = 0;
    let attention = 0;
    for (const item of tasks) {
      const eff = resolveTaskEffectiveState(item);
      if (eff === "running") {
        running += 1;
      } else if (eff === "waiting" || eff === "new") {
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
      completed,
      attention,
    };
  }, [tasks]);

  const filterOptions = useMemo(() => buildFilterOptions(tasks), [tasks]);
  const filtered = useMemo(
    () =>
      filterTasks(tasks, {
        query,
        typeFilter,
        statusFilter,
        priorityFilter,
      }),
    [tasks, priorityFilter, query, statusFilter, typeFilter],
  );

  const focusTasks = useMemo(
    () =>
      filtered.filter((item) => {
        const eff = resolveTaskEffectiveState(item);
        return eff === "running" || eff === "waiting" || eff === "new" || eff === "failed";
      }),
    [filtered],
  );

  const archiveTasks = useMemo(
    () =>
      filtered.filter((item) => {
        const eff = resolveTaskEffectiveState(item);
        return eff === "completed" || eff === "cancelled";
      }),
    [filtered],
  );

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((item) => item.id === selectedTaskId) ?? null : null),
    [selectedTaskId, tasks],
  );

  const hasActiveFilters =
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    priorityFilter !== "all" ||
    query.trim().length > 0;

  const resetFilters = () => {
    setStatusFilter("all");
    setTypeFilter("all");
    setPriorityFilter("all");
    setQuery("");
  };

  return (
    <div
      className="flex h-full min-h-0 flex-1 overflow-hidden border-t border-border bg-background"
      data-testid="tasks-workspace"
    >
      <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
        <div className="mx-auto max-w-[1400px] space-y-4 pb-6">
          {/* Page Header + Live Queue Pulse + Metric Cards */}
          <div className="flex flex-col gap-3.5 @[860px]:flex-row @[860px]:items-start @[860px]:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="m-0 text-[22px] font-semibold tracking-tight text-foreground">
                  {t("Tasks")}
                </h1>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                  <UiText>{`${counts.total} ${counts.total === 1 ? "task" : "tasks"}`}</UiText>
                </span>
                <LiveQueuePulse
                  runningCount={counts.running}
                  waitingCount={counts.waiting}
                  onSelectRunning={() =>
                    setStatusFilter((prev) => (prev === "running" ? "all" : "running"))
                  }
                  onSelectWaiting={() =>
                    setStatusFilter((prev) => (prev === "waiting" ? "all" : "waiting"))
                  }
                />
              </div>
              <p className="m-0 max-w-2xl text-[13px] text-muted-foreground">
                {t("Durable work contexts, channel subscriptions, and runner state.")}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 @[520px]:grid-cols-4 @[860px]:min-w-[26rem] @[860px]:shrink-0">
              <MetricTile
                label={t("Running")}
                value={counts.running}
                tone="ochre"
                withSageBar={counts.running > 0 || statusFilter === "running"}
                active={statusFilter === "running"}
                onClick={() =>
                  setStatusFilter((prev) => (prev === "running" ? "all" : "running"))
                }
              />
              <MetricTile
                label={t("Waiting")}
                value={counts.waiting}
                tone="slate"
                withSageBar={statusFilter === "waiting"}
                active={statusFilter === "waiting"}
                onClick={() =>
                  setStatusFilter((prev) => (prev === "waiting" ? "all" : "waiting"))
                }
              />
              <MetricTile
                label={t("Completed")}
                value={counts.completed}
                tone="sage"
                withSageBar={statusFilter === "completed"}
                active={statusFilter === "completed"}
                onClick={() =>
                  setStatusFilter((prev) => (prev === "completed" ? "all" : "completed"))
                }
              />
              <MetricTile
                label={t("Failed / Cancelled")}
                value={counts.attention}
                tone="terra"
                withSageBar={statusFilter === "attention"}
                active={statusFilter === "attention"}
                onClick={() =>
                  setStatusFilter((prev) => (prev === "attention" ? "all" : "attention"))
                }
              />
            </div>
          </div>

          {/* Two-Row Clean Toolbar: Row 1 = Status Tabs + View Mode, Row 2 = Search + Scope/Type/Priority */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="tablist"
                aria-label={t("Status")}
                className="inline-flex flex-wrap items-center gap-0.5 rounded-[8px] bg-muted p-0.5 text-xs"
              >
                {(
                  [
                    { key: "all", label: t("All"), count: counts.total, dot: null },
                    {
                      key: "running",
                      label: t("Running"),
                      count: counts.running,
                      dot: "bg-[#b07d4f] dark:bg-[#d1a273]",
                    },
                    {
                      key: "waiting",
                      label: t("Waiting"),
                      count: counts.waiting,
                      dot: "bg-[#5c7c99] dark:bg-[#86a3be]",
                    },
                    {
                      key: "completed",
                      label: t("Completed"),
                      count: counts.completed,
                      dot: null,
                    },
                    {
                      key: "attention",
                      label: t("Failed / Cancelled"),
                      count: counts.attention,
                      dot: counts.attention > 0 ? "bg-[#b5544a] dark:bg-[#dc7a70]" : null,
                    },
                  ] as const
                ).map((tab) => {
                  const isCurrent = statusFilter === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={isCurrent}
                      onClick={() => setStatusFilter(tab.key)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 transition-colors",
                        isCurrent
                          ? "bg-card font-semibold text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.dot ? (
                        <span className={cn("size-1.5 shrink-0 rounded-full", tab.dot)} />
                      ) : null}
                      <span>{tab.label}</span>
                      <span className="tabular-nums opacity-65">{tab.count}</span>
                    </button>
                  );
                })}
              </div>

              {statusFilter === "all" ? (
                <div
                  role="group"
                  aria-label={t("Task inventory")}
                  className="inline-flex items-center gap-0.5 rounded-[8px] bg-muted p-0.5 text-xs"
                >
                  <button
                    type="button"
                    aria-pressed={layoutMode === "grouped"}
                    onClick={() => setLayoutMode("grouped")}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1.5 transition-colors",
                      layoutMode === "grouped"
                        ? "bg-card font-medium text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t("Grouped view")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={layoutMode === "stream"}
                    onClick={() => setLayoutMode("stream")}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1.5 transition-colors",
                      layoutMode === "stream"
                        ? "bg-card font-medium text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t("Stream view")}
                  </button>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {shadowControl}

              <label className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[8px] border border-border bg-card px-2.5 text-muted-foreground focus-within:border-ring">
                <Search className="size-3.5 shrink-0" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("Search title, id, status, priority")}
                  aria-label={t("Search title, id, status, priority")}
                  className="min-w-0 flex-1 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
              </label>

              {filterOptions.types.length > 0 ? (
                <FilterSelect
                  label={t("Type")}
                  allLabel={t("All types")}
                  value={typeFilter}
                  options={filterOptions.types}
                  onChange={setTypeFilter}
                />
              ) : null}

              {filterOptions.priorities.length > 0 ? (
                <FilterSelect
                  label={t("Priority")}
                  allLabel={t("All priorities")}
                  value={priorityFilter}
                  options={filterOptions.priorities}
                  onChange={setPriorityFilter}
                />
              ) : null}

              {hasActiveFilters ? (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="h-8 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                  {t("Reset filters")}
                </button>
              ) : null}
            </div>
          </div>

          {/* Task List Body */}
          {error ? (
            <DashboardErrorState title={t("Tasks failed to load")} error={error} />
          ) : loading ? (
            <LoadingRows />
          ) : filtered.length === 0 ? (
            <TaskEmptyState
              hasFilters={hasActiveFilters}
              onReset={hasActiveFilters ? resetFilters : undefined}
            />
          ) : layoutMode === "grouped" && statusFilter === "all" ? (
            <div className="space-y-5">
              {focusTasks.length > 0 ? (
                <section className="space-y-2" data-testid="tasks-group-focus">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <span className="size-2 rounded-full bg-[#b07d4f] dark:bg-[#d1a273]" />
                      <span>{t("Active & needs attention")}</span>
                      <span className="font-normal tabular-nums text-muted-foreground">
                        {focusTasks.length}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t("Running, waiting for input, and failed tasks appear first")}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000006]">
                    {focusTasks.map((item) => (
                      <TaskRowItem
                        key={item.id}
                        base={base}
                        locale={locale}
                        task={item}
                        selected={selectedTask?.id === item.id}
                        onToggleSelect={() =>
                          setSelectedTaskId((prev) => (prev === item.id ? null : item.id))
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {archiveTasks.length > 0 ? (
                <section className="space-y-2" data-testid="tasks-group-archive">
                  <div className="flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
                    <span>{t("Recently finished")}</span>
                    <span className="font-normal tabular-nums">{archiveTasks.length}</span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000006]">
                    {archiveTasks.map((item) => (
                      <TaskRowItem
                        key={item.id}
                        base={base}
                        locale={locale}
                        task={item}
                        selected={selectedTask?.id === item.id}
                        onToggleSelect={() =>
                          setSelectedTaskId((prev) => (prev === item.id ? null : item.id))
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : (
            <div
              className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000006]"
              data-testid="tasks-stream-list"
            >
              {filtered.map((item) => (
                <TaskRowItem
                  key={item.id}
                  base={base}
                  locale={locale}
                  task={item}
                  selected={selectedTask?.id === item.id}
                  onToggleSelect={() =>
                    setSelectedTaskId((prev) => (prev === item.id ? null : item.id))
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Quick-Peek Inspector Drawer */}
      {selectedTask ? (
        <TaskQuickPeekDrawer
          base={base}
          locale={locale}
          task={selectedTask}
          onClose={() => setSelectedTaskId(null)}
        />
      ) : null}
    </div>
  );
}

function LiveQueuePulse({
  runningCount,
  waitingCount,
  onSelectRunning,
  onSelectWaiting,
}: {
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly onSelectRunning: () => void;
  readonly onSelectWaiting: () => void;
}) {
  const { locale, t } = useTranslation();

  if (runningCount > 0) {
    const label =
      locale === "zh-CN"
        ? `${runningCount} 个运行中${waitingCount > 0 ? ` · ${waitingCount} 个待反馈` : ""}`
        : `${runningCount} running${waitingCount > 0 ? ` · ${waitingCount} waiting` : ""}`;
    return (
      <button
        type="button"
        onClick={onSelectRunning}
        className="inline-flex items-center gap-2 rounded-full bg-[#b07d4f]/14 px-2.5 py-0.5 text-xs font-medium text-[#b07d4f] transition-opacity hover:opacity-85 dark:bg-[#d1a273]/16 dark:text-[#d1a273]"
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#b07d4f] opacity-60 dark:bg-[#d1a273]" />
          <span className="relative inline-flex size-2 rounded-full bg-[#b07d4f] dark:bg-[#d1a273]" />
        </span>
        <span>{label}</span>
      </button>
    );
  }

  if (waitingCount > 0) {
    const label =
      locale === "zh-CN" ? `${waitingCount} 个待反馈` : `${waitingCount} waiting`;
    return (
      <button
        type="button"
        onClick={onSelectWaiting}
        className="inline-flex items-center gap-1.5 rounded-full bg-[#5c7c99]/14 px-2.5 py-0.5 text-xs font-medium text-[#5c7c99] transition-opacity hover:opacity-85 dark:bg-[#86a3be]/16 dark:text-[#86a3be]"
      >
        <span className="size-2 rounded-full bg-[#5c7c99] dark:bg-[#86a3be]" />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#5b8a72]/13 px-2.5 py-0.5 text-xs font-medium text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]">
      <span className="size-2 rounded-full bg-[#5b8a72] dark:bg-[#7fb096]" />
      <span>{t("Queue idle")}</span>
    </span>
  );
}

function MetricTile({
  label,
  value,
  tone,
  withSageBar = false,
  active = false,
  onClick,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: "ochre" | "slate" | "sage" | "terra";
  readonly withSageBar?: boolean;
  readonly active?: boolean;
  readonly onClick?: () => void;
}) {
  const dotClass =
    tone === "ochre"
      ? "bg-[#b07d4f] dark:bg-[#d1a273]"
      : tone === "slate"
        ? "bg-[#5c7c99] dark:bg-[#86a3be]"
        : tone === "terra"
          ? "bg-[#b5544a] dark:bg-[#dc7a70]"
          : "bg-[#5b8a72] dark:bg-[#7fb096]";
  const valueClass =
    value === 0
      ? "text-foreground"
      : tone === "ochre"
        ? "text-[#b07d4f] dark:text-[#d1a273]"
        : tone === "slate"
          ? "text-[#5c7c99] dark:text-[#86a3be]"
          : tone === "terra"
            ? "text-[#b5544a] dark:text-[#dc7a70]"
            : "text-foreground";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card px-3 py-2 text-left shadow-[0_2px_5px_#00000004] transition-colors hover:bg-accent/40",
        active ? "border-ring ring-1 ring-ring/40" : "border-border",
        withSageBar &&
          "before:absolute before:top-0 before:left-4 before:h-[3px] before:w-6 before:rounded-xs before:bg-[#a3b69e] dark:before:bg-[#8ea487]",
      )}
    >
      <div className="flex items-center justify-between gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      </div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", valueClass)}>
        {value}
      </div>
    </button>
  );
}

function TaskRowItem({
  base,
  locale,
  task,
  selected,
  onToggleSelect,
}: {
  readonly base: string;
  readonly locale: "en" | "zh-CN";
  readonly task: DashboardTask;
  readonly selected: boolean;
  readonly onToggleSelect: () => void;
}) {
  const { t } = useTranslation();
  const detailHref = `${base}/tasks/${encodeURIComponent(task.id)}`;
  const tuiHref = `${base}/terminals?taskId=${encodeURIComponent(task.id)}`;
  const effectiveState = resolveTaskEffectiveState(task);
  const parsedContext = parseTaskContext(task.taskContext);
  const latestRun = latestTaskRun(task.runs ?? []);
  const latestEvent = (task.timeline ?? []).at(-1);
  const sessions = resolveTaskSessions(task);
  const primarySession = sessions[0];
  const extraSessions = Math.max(0, sessions.length - 1);
  const runDuration = latestRun
    ? formatRunDuration(latestRun.startedAt ?? latestRun.started_at, latestRun.finishedAt ?? latestRun.finished_at)
    : null;
  const artifactCount = task.artifacts?.length ?? 0;
  const humanParticipants = task.participants.filter(
    (p) => p.role !== "agent" && p.user?.kind !== "bot" && p.user?.kind !== "system",
  );
  const botParticipant = task.participants.find(
    (p) => p.role === "agent" || p.user?.kind === "bot" || p.user?.kind === "system",
  );

  return (
    <div
      data-testid={`task-row-${task.id}`}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("a,button")) {
          return;
        }
        onToggleSelect();
      }}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("a,button")) {
          return;
        }
        appHistory.push(detailHref);
      }}
      className={cn(
        "group relative grid cursor-pointer grid-cols-[26px_minmax(0,1fr)_auto] items-start gap-3.5 border-b border-border/60 px-4 py-3.5 transition-colors last:border-b-0",
        selected ? "bg-accent/55" : "hover:bg-muted/45",
      )}
    >
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r bg-[#a3b69e] dark:bg-[#8ea487]"
        />
      ) : null}

      <div className="pt-0.5">
        <TaskStateIcon state={effectiveState} />
      </div>

      <div className="min-w-0 space-y-1.5">
        {/* Line 1: Title + Semantic Pills */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <a
            href={detailHref}
            onClick={(event) => navigateClient(event, detailHref)}
            className="max-w-full truncate text-[14px] leading-snug font-semibold text-foreground hover:underline"
          >
            {task.title}
          </a>
          <TaskStatusPill status={task.status} effectiveState={effectiveState} />
          <TaskPriorityPill priority={task.priority} />
          <TaskTypePill type={task.type} />
        </div>

        {/* Line 2: Contextual Signal (Error / Waiting Question / Active Step / Summary) */}
        <TaskRowSecondaryLine
          task={task}
          effectiveState={effectiveState}
          latestRun={latestRun}
          latestEventSummary={latestEvent?.summary}
          waitingQuestion={parsedContext.pendingQuestions[0]}
        />

        {/* Line 3: Provenance Chips */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground">
          {primarySession ? (
            <a
              href={`${base}/sessions/${encodeURIComponent(primarySession.id)}`}
              onClick={(event) =>
                navigateClient(event, `${base}/sessions/${encodeURIComponent(primarySession.id)}`)
              }
              className="inline-flex max-w-[18rem] min-w-0 items-center gap-1 text-sidebar-foreground hover:text-foreground hover:underline"
            >
              {primarySession.channel_type === "p2p" ? (
                <User className="size-3 shrink-0 opacity-75" />
              ) : (
                <MessageSquare className="size-3 shrink-0 opacity-75" />
              )}
              <span className="truncate">{formatSessionChipLabel(primarySession)}</span>
              {extraSessions > 0 ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[11px] text-muted-foreground">
                  +{extraSessions}
                </span>
              ) : null}
            </a>
          ) : null}

          {latestRun ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Play className="size-3 shrink-0 opacity-70" />
              <span>
                #{latestRun.runIndex ?? latestRun.run_index} · {latestRun.runnerType || latestRun.runner_type}
              </span>
              {runDuration ? <span className="opacity-65">({runDuration})</span> : null}
            </span>
          ) : null}

          {artifactCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-[#5b8a72] dark:text-[#7fb096]">
              <FileText className="size-3 shrink-0" />
              <span>
                {locale === "zh-CN"
                  ? `${artifactCount} 个产物`
                  : `${artifactCount} ${artifactCount === 1 ? "artifact" : "artifacts"}`}
              </span>
            </span>
          ) : null}

          <span className="hidden font-mono text-[11px] opacity-60 md:inline">
            {shortTaskId(task.id)}
          </span>
        </div>
      </div>

      {/* Right Column: Avatars + Time + Quick Hover Actions */}
      <div className="flex shrink-0 flex-col items-end justify-between gap-2 self-stretch">
        <div className="flex items-center gap-2.5">
          {task.participants.length > 0 ? (
            <div
              className="hidden items-center -space-x-1.5 sm:flex"
              title={task.participants
                .map((p) => p.user?.displayName || p.userId)
                .join(", ")}
            >
              {humanParticipants.slice(0, 2).map((participant) => (
                <MiniUserBadgeAvatar
                  key={`${participant.userId}:${participant.role}`}
                  name={participant.user?.displayName || participant.userId}
                  avatarUrl={participant.user?.avatarUrl}
                  kind={participant.user?.kind}
                  colorKey={participant.userId}
                />
              ))}
              {humanParticipants.length > 2 ? (
                <span className="inline-grid size-6 place-items-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-card">
                  +{humanParticipants.length - 2}
                </span>
              ) : null}
              {botParticipant ? (
                <MiniUserBadgeAvatar
                  name={botParticipant.user?.displayName || "Agent"}
                  avatarUrl={botParticipant.user?.avatarUrl}
                  kind="bot"
                  colorKey={botParticipant.userId}
                />
              ) : null}
            </div>
          ) : null}

          <time
            dateTime={new Date(task.last_activity_at).toISOString()}
            title={formatTaskFullTime(task.last_activity_at)}
            className="min-w-[3.25rem] text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground"
          >
            {formatTaskRelativeTime(task.last_activity_at, locale)}
          </time>
        </div>

        <div className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <a
            href={tuiHref}
            onClick={(event) => navigateClient(event, tuiHref)}
            className="inline-flex h-6 items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
            title={t("Open TUI")}
          >
            <TerminalSquareIcon className="size-3" />
            <span>TUI</span>
          </a>
          <a
            href={detailHref}
            onClick={(event) => navigateClient(event, detailHref)}
            className="inline-flex h-6 items-center gap-0.5 rounded-[6px] bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 hover:no-underline"
          >
            <span>{t("Full details")}</span>
            <ArrowRight className="size-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

function TaskRowSecondaryLine({
  task,
  effectiveState,
  latestRun,
  latestEventSummary,
  waitingQuestion,
}: {
  readonly task: DashboardTask;
  readonly effectiveState: TaskEffectiveState;
  readonly latestRun: DashboardTaskRun | undefined;
  readonly latestEventSummary: string | undefined;
  readonly waitingQuestion: string | undefined;
}) {
  const { t } = useTranslation();

  if (effectiveState === "failed" && latestRun?.error) {
    const styles = taskStateClasses("failed");
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 truncate rounded-md border px-2 py-1 font-mono text-xs",
          styles.calloutClass,
        )}
      >
        <span className="truncate">{latestRun.error}</span>
      </div>
    );
  }

  if (effectiveState === "waiting" && waitingQuestion) {
    const styles = taskStateClasses("waiting");
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 truncate rounded-md border px-2 py-1 text-xs",
          styles.calloutClass,
        )}
      >
        <span className="shrink-0 font-medium">{t("Waiting for confirmation")}:</span>
        <span className="truncate">{waitingQuestion}</span>
      </div>
    );
  }

  if (effectiveState === "running" && latestEventSummary) {
    return (
      <div className="flex items-center gap-1.5 truncate text-[12.5px] text-[#b07d4f] dark:text-[#d1a273]">
        <span className="truncate">{latestEventSummary}</span>
        {task.summary && task.summary !== latestEventSummary ? (
          <span className="truncate text-muted-foreground">· {task.summary}</span>
        ) : null}
      </div>
    );
  }

  return (
    <p className="m-0 truncate text-[12.5px] text-muted-foreground">
      {task.summary || latestEventSummary || task.id}
    </p>
  );
}

function TaskQuickPeekDrawer({
  base,
  locale,
  task,
  onClose,
}: {
  readonly base: string;
  readonly locale: "en" | "zh-CN";
  readonly task: DashboardTask;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const detailHref = `${base}/tasks/${encodeURIComponent(task.id)}`;
  const tuiHref = `${base}/terminals?taskId=${encodeURIComponent(task.id)}`;
  const effectiveState = resolveTaskEffectiveState(task);
  const parsedContext = parseTaskContext(task.taskContext);
  const latestRun = latestTaskRun(task.runs ?? []);
  const runDuration = latestRun
    ? formatRunDuration(latestRun.startedAt ?? latestRun.started_at, latestRun.finishedAt ?? latestRun.finished_at)
    : null;
  const sessions = resolveTaskSessions(task);
  const artifacts = task.artifacts ?? [];

  return (
    <aside
      aria-label={task.title}
      data-testid="task-quick-peek"
      className="hidden w-[380px] shrink-0 flex-col overflow-hidden border-l border-border bg-card lg:flex xl:w-[420px]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <TaskStatusPill status={task.status} effectiveState={effectiveState} showDot />
          <CopyTextButton
            className="h-6 max-w-36 truncate px-2 font-mono text-xs text-muted-foreground"
            label={t("Copy task ID")}
            text={task.id}
          >
            {shortTaskId(task.id)}
          </CopyTextButton>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <a
            href={detailHref}
            onClick={(event) => navigateClient(event, detailHref)}
            className="inline-flex h-7 items-center gap-1 rounded-[7px] bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 hover:no-underline"
          >
            <span>{t("Full details")}</span>
            <ArrowUpRight className="size-3.5" />
          </a>
          <button
            type="button"
            aria-label={t("Close preview")}
            onClick={onClose}
            className="inline-grid size-7 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-2">
          <h2 className="m-0 text-base leading-snug font-semibold break-words text-foreground">
            {task.title}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <TaskTypePill type={task.type} />
            <TaskPriorityPill priority={task.priority} alwaysShow />
            <span>· {formatTaskRelativeTime(task.last_activity_at, locale)}</span>
          </div>
        </div>

        {parsedContext.pendingQuestions.length > 0 ? (
          <div
            className={cn(
              "space-y-1 rounded-xl border p-3 text-xs",
              taskStateClasses("waiting").calloutClass,
            )}
          >
            <div className="font-semibold">{t("Waiting for confirmation")}</div>
            {parsedContext.pendingQuestions.map((question, idx) => (
              <div key={idx} className="leading-relaxed break-words">
                {question}
              </div>
            ))}
          </div>
        ) : null}

        {latestRun?.error ? (
          <div
            className={cn(
              "space-y-1 rounded-xl border p-3 text-xs",
              taskStateClasses("failed").calloutClass,
            )}
          >
            <div className="font-semibold">{t("Latest run error")}</div>
            <div className="font-mono leading-relaxed break-all">{latestRun.error}</div>
          </div>
        ) : null}

        <div className="space-y-1.5 rounded-xl border border-border bg-muted/45 p-3.5">
          <div className="text-xs font-medium text-muted-foreground">
            {t("Progress & summary")}
          </div>
          <p className="m-0 text-[13px] leading-relaxed break-words text-foreground">
            {task.summary || t("No report summary is available.")}
          </p>
        </div>

        {latestRun ? (
          <section className="space-y-2">
            <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
              {t("Runner state")}
            </h3>
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border p-3 text-xs">
              <div className="min-w-0 space-y-0.5">
                <div className="font-semibold text-foreground">
                  Run #{latestRun.runIndex ?? latestRun.run_index} ·{" "}
                  {latestRun.runnerType || latestRun.runner_type}
                </div>
                <div className="text-muted-foreground">
                  <UiText>{latestRun.status}</UiText>
                  {runDuration ? ` · ${runDuration}` : ""}
                </div>
              </div>
              <a
                href={tuiHref}
                onClick={(event) => navigateClient(event, tuiHref)}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
              >
                <TerminalSquareIcon className="size-3.5" />
                <span>{t("Open TUI")}</span>
              </a>
            </div>
          </section>
        ) : null}

        {sessions.length > 0 ? (
          <section className="space-y-2">
            <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
              {t("Linked Sessions")} ({sessions.length})
            </h3>
            <div className="grid gap-1.5">
              {sessions.map((session) => {
                const label = session.displayTitle || session.title || session.id;
                const sessionHref = `${base}/sessions/${encodeURIComponent(session.id)}`;
                return (
                  <a
                    key={session.id}
                    href={sessionHref}
                    onClick={(event) => navigateClient(event, sessionHref)}
                    className="flex items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-xs transition-colors hover:bg-muted/50 hover:no-underline"
                  >
                    <span
                      className="inline-grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                      style={{ backgroundColor: avatarColorForKey(session.group_id ?? session.id) }}
                    >
                      {Array.from(label.trim() || "?").slice(0, 2).join("")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">{label}</div>
                      <div className="mt-0.5 truncate text-muted-foreground">
                        {session.thread_id
                          ? `${session.channel_type} · # ${session.thread_id}`
                          : session.channel_type}
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
            {t("Artifacts")} ({artifacts.length})
          </h3>
          {artifacts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
              {t("No artifacts recorded.")}
            </div>
          ) : (
            <div className="grid gap-1.5">
              {artifacts.slice(0, 5).map((artifact) => (
                <div
                  key={artifact.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-xs"
                >
                  {artifact.href ? (
                    <a
                      href={artifact.href}
                      className="min-w-0 flex-1 truncate font-mono text-foreground hover:underline"
                    >
                      {artifact.name}
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {artifact.name}
                    </span>
                  )}
                  <span className="shrink-0 rounded bg-[#5b8a72]/14 px-1.5 py-0.5 text-[11px] font-medium text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]">
                    {artifact.type}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {task.participants.length > 0 ? (
          <section className="space-y-2">
            <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
              {t("Participants")}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {task.participants.map((participant) => (
                <span
                  key={`${participant.userId}:${participant.role}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
                >
                  <IdentityLink
                    className="max-w-32 text-xs"
                    fallbackKind={participant.role === "agent" ? "bot" : "user"}
                    identity={identityForCanonicalUser(participant.user)}
                    showAvatar
                    showKind={false}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    <UiText>{participant.role}</UiText>
                  </span>
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

function TaskEmptyState({
  hasFilters,
  onReset,
}: {
  readonly hasFilters: boolean;
  readonly onReset?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[20rem] items-center justify-center rounded-2xl border border-dashed border-border bg-card/60 p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto inline-grid size-11 place-items-center rounded-xl bg-[#5b8a72]/14 text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]">
          <CircleCheck className="size-5" />
        </div>
        <h2 className="mt-3.5 text-sm font-semibold text-foreground">
          {hasFilters ? t("No matching tasks") : t("No active tasks")}
        </h2>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {hasFilters ? t("Try a different filter.") : t("Queue idle.")}
        </p>
        {hasFilters && onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="mt-4 inline-flex h-7 items-center rounded-[7px] border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t("Reset filters")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DashboardErrorState({
  title,
  error,
}: {
  readonly title: string;
  readonly error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {error instanceof Error ? error.message : t("Unknown error")}
      </p>
    </div>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="min-w-28 text-xs text-muted-foreground">
      <span className="sr-only">{label}</span>
      <SelectField
        aria-label={`${label} filter`}
        value={value}
        onValueChange={onChange}
        size="sm"
        fullWidth
        options={[
          { value: "all", label: allLabel },
          ...options.map((option) => ({
            value: option,
            label: t(option),
          })),
        ]}
      />
    </label>
  );
}

function buildFilterOptions(tasks: readonly DashboardTask[]): {
  readonly types: string[];
  readonly priorities: string[];
} {
  return {
    types: uniqueSorted(tasks.map((item) => item.type)),
    priorities: uniqueSorted(
      tasks
        .map((item) => item.priority)
        .filter((item): item is string => !!item),
    ),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function filterTasks(
  tasks: readonly DashboardTask[],
  filters: {
    readonly query: string;
    readonly typeFilter: string;
    readonly statusFilter: TaskStatusTab | string;
    readonly priorityFilter: string;
  },
): DashboardTask[] {
  const { priorityFilter, query, statusFilter, typeFilter } = filters;
  const normalized = query.trim().toLowerCase();
  return tasks
    .filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) {
        return false;
      }
      if (statusFilter !== "all") {
        const eff = resolveTaskEffectiveState(item);
        if (statusFilter === "running" && !isActiveTaskStatus(item.status)) {
          return false;
        }
        if (statusFilter === "waiting" && eff !== "waiting" && eff !== "new") {
          return false;
        }
        if (statusFilter === "completed" && eff !== "completed") {
          return false;
        }
        if (statusFilter === "attention" && eff !== "failed" && eff !== "cancelled") {
          return false;
        }
        if (
          !["running", "waiting", "completed", "attention"].includes(statusFilter) &&
          item.status !== statusFilter
        ) {
          return false;
        }
      }
      if (priorityFilter !== "all" && item.priority !== priorityFilter) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      const haystack = [
        item.id,
        item.title,
        item.summary ?? "",
        item.type,
        item.status,
        item.priority ?? "",
        item.creatorUserId ?? "",
        identitySearchText(identityForCanonicalUser(item.creatorUser)),
        ...item.participants.map(
          (participant) =>
            `${participant.role} ${participant.userId} ${identitySearchText(
              identityForCanonicalUser(participant.user),
            )}`,
        ),
        ...resolveTaskSessions(item).map(
          (session) =>
            `${session.id} ${session.displayTitle ?? ""} ${session.title ?? ""}`,
        ),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    })
    .sort((a, b) => b.last_activity_at - a.last_activity_at);
}

function resolveTaskSessions(task: DashboardTask): DashboardTaskSession[] {
  if (task.linked_sessions && task.linked_sessions.length > 0) {
    return [...task.linked_sessions];
  }
  if (task.linkedSessions && task.linkedSessions.length > 0) {
    return task.linkedSessions.map((session) => ({
      id: session.id,
      title: session.title,
      display_title: session.displayTitle,
      displayTitle: session.displayTitle,
      channel_type: session.channelType,
      channelType: session.channelType,
      channel_id: "",
      group_id: null,
      thread_id: null,
    }));
  }
  return [];
}

function formatSessionChipLabel(session: DashboardTaskSession): string {
  const baseTitle = session.displayTitle || session.display_title || session.title || session.id;
  if (session.title && session.displayTitle && session.title !== session.displayTitle) {
    return `${session.displayTitle} · # ${session.title}`;
  }
  return baseTitle;
}

function latestTaskRun(runs: readonly DashboardTaskRun[]): DashboardTaskRun | undefined {
  return runs.reduce<DashboardTaskRun | undefined>(
    (latest, run) =>
      latest === undefined || (run.runIndex ?? run.run_index) > (latest.runIndex ?? latest.run_index)
        ? run
        : latest,
    undefined,
  );
}

function shortTaskId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 14)}…` : id;
}
