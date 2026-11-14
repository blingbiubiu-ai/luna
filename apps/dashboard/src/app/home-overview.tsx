import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import {
  Activity,
  ArrowRight,
  BriefcaseBusiness,
  CircleCheck,
  Clock3,
  MessagesSquare,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  DashboardRuntimeStatus,
  DashboardSession,
  DashboardTask,
} from "@/lib/api";
import { useAgentBasePath } from "@/lib/agent-route";
import { isActiveTaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export function HomeOverview({
  tasks,
  scopePicker,
  scopeError,
  sessions,
  tasksLoading,
  sessionsLoading,
  runtimeStatus,
  runtimeLoading,
  runtimeError,
}: {
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
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const tone = runtimeTone(runtimeStatus, runtimeLoading, runtimeError);
  const activeTasks = tasks.filter((item) =>
    isActiveTaskStatus(item.status),
  ).length;
  const runningWork = activeTasks;
  const latestTask = [...tasks].sort(
    (a, b) => b.last_activity_at - a.last_activity_at,
  )[0];

  return (
    <div className="luna-overview flex min-h-0 flex-1 flex-col bg-background">
      {scopePicker && <div className="flex flex-wrap items-center gap-2 px-5 pt-4">{scopePicker}</div>}
      {scopeError instanceof Error && <p role="alert" className="px-5 pt-2 text-sm text-destructive">{scopeError.message}</p>}
      <div className="luna-hero">
        <div className="contents">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Activity
                className={cn(
                  "size-3.5",
                  tone === "ok"
                    ? "text-green-500"
                    : tone === "warn"
                      ? "text-amber-500"
                      : "text-red-500",
                )}
              />{t("Luna Runtime")}</div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("Operations, at a glance.")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("Your agents, conversations, and work. All in one place.")}</p>
          </div>
          <div className="luna-hero-status">
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
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("Active tasks")}
          value={tasksLoading ? "-" : String(activeTasks)}
          detail={`${tasks.length} total`}
          icon={BriefcaseBusiness}
        />
        <MetricCard
          label={t("Sessions")}
          value={sessionsLoading ? "-" : String(sessions.length)}
          detail="linked channel surfaces"
          icon={MessagesSquare}
        />
        <MetricCard
          label={t("Runner work")}
          value={tasksLoading ? "-" : String(runningWork)}
          detail="active task sessions"
          icon={Waypoints}
        />
        <MetricCard
          label={t("Queue")}
          value={runningWork > 0 ? "Busy" : "Idle"}
          detail="task-scoped serial work"
          icon={Clock3}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_0.8fr]">
        <Card className="min-h-0 rounded-lg">
          <CardHeader className="border-b pb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>{t("Task Intake")}</CardTitle>
                <CardDescription>{t("Current task load by latest run state.")}</CardDescription>
              </div>
              <DashboardLink
                href={`${base}/tasks`}

              >{t("Open tasks")}<ArrowRight className="size-4" />
              </DashboardLink>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-4 md:grid-cols-3">
            <StatusTile label={t("New")} value={countByStatus(tasks, "new")} />
            <StatusTile
              label={t("Running")}
              value={countByStatus(tasks, "running")}
              tone="blue"
            />
            <StatusTile
              label={t("Completed")}
              value={
                countByStatus(tasks, "completed")
              }
            />
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader className="border-b pb-4">
            <CardTitle>{t("Latest Activity")}</CardTitle>
            <CardDescription>{t("Most recent persisted task signal.")}</CardDescription>
          </CardHeader>
          <CardContent className="p-4">
            {latestTask ? (
              <div className="space-y-3">
                <Badge variant="secondary"><UiText>{latestTask.status}</UiText></Badge>
                <div>
                  <div className="line-clamp-2 text-sm font-medium">
                    {latestTask.title}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatTime(latestTask.last_activity_at)}
                  </div>
                </div>
                <DashboardLink
                  href={`${base}/tasks/${encodeURIComponent(latestTask.id)}`}

                >{t("View timeline")}<ArrowRight className="size-4" />
                </DashboardLink>
              </div>
            ) : (
              <div className="flex min-h-32 flex-col justify-center rounded-md border border-dashed bg-muted/20 p-4">
                <CircleCheck className="size-5 text-green-500" />
                <div className="mt-3 text-sm font-medium">{t("No active tasks")}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t("Queue idle.")}</div>
              </div>
            )}
          </CardContent>
        </Card>
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
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        tone === "ok"
          ? "border-green-500/30"
          : tone === "warn"
            ? "border-amber-500/40"
            : "border-red-500/40",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          tone === "ok"
            ? "bg-green-500"
            : tone === "warn"
              ? "bg-amber-500"
              : "bg-red-500",
        )}
      />
      <UiText>{runtimeLabel(status, loading, error)}</UiText>
    </Badge>
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
    <Badge variant="outline" className="gap-1.5">
      <Waypoints className="size-3" />
      <UiText>{channelStatusLabel(status, loading, error)}</UiText>
    </Badge>
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
    <Badge variant="outline" className="gap-1.5">
      <ShieldCheck className="size-3" />
      <UiText>{agentStatusLabel(status, loading, error)}</UiText>
    </Badge>
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
    (channel) => channel.inbound?.state === undefined ||
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
  const primaryState = primary.inbound?.state ?? "unknown";
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

function DashboardLink({ children, href }: { children: ReactNode; href: string }) {
  return <a href={href} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
    {children}
  </a>;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <Card className="luna-metric rounded-lg py-6">
      <CardContent className="flex items-center justify-between gap-4 px-4">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <UiText>{label}</UiText>
          </div>
          <div className="mt-3 text-4xl font-semibold tracking-tight">
            <UiText>{value}</UiText>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            <UiText>{detail}</UiText>
          </div>
        </div>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );
}

function StatusTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "blue" | "amber";
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium"><UiText>{label}</UiText></div>
        <span
          className={cn(
            "size-2 rounded-full",
            tone === "blue" && "bg-blue-500",
            tone === "amber" && "bg-yellow-500",
            tone === "neutral" && "bg-muted-foreground",
          )}
        />
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-tight"><UiText>{value}</UiText></div>
    </div>
  );
}

function countByStatus(
  tasks: readonly DashboardTask[],
  status: string,
): number {
  return tasks.filter((task) => task.status === status).length;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
