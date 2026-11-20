import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  BriefcaseBusiness,
  CircleCheck,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { DashboardIdentity } from "@/components/identity-link";
import { IdentityLink, identitySearchText } from "@/components/identity-link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardCanonicalUser, DashboardTask } from "@/lib/api";
import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import { useTasks } from "@/lib/api";
import { isActiveTaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/$agentId/tasks/")({
  component: TasksPage,
});

function TasksPage() {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const selection = useShadowScope();
  const { data: tasks, error, isLoading } = useTasks(selection.scope);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const filtered = useMemo(
    () =>
      filterTasks(tasks ?? [], {
        query,
        typeFilter,
        statusFilter,
        priorityFilter,
      }),
    [tasks, priorityFilter, query, statusFilter, typeFilter],
  );
  const filterOptions = useMemo(() => buildFilterOptions(tasks ?? []), [tasks]);
  const activeCount = (tasks ?? []).filter((item) =>
    isActiveTaskStatus(item.status),
  ).length;
  const finishedCount = (tasks ?? []).filter((item) =>
    ["completed", "failed", "cancelled"].includes(item.status),
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="border-b bg-card/70 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppertask tracking-wide text-muted-foreground">
              <BriefcaseBusiness className="size-3.5" />{t("Task Queue")}</div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("Tasks")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("Durable work contexts, channel subscriptions, and runner state.")}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:min-w-[28rem]">
            <HeaderStat label={t("Total")} value={tasks?.length ?? 0} />
            <HeaderStat label={t("Running")} value={activeCount} />
            <HeaderStat label={t("Finished")} value={finishedCount} />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
        <Card className="rounded-lg py-0">
          <CardContent className="flex flex-wrap gap-3 p-3 lg:items-center">
            <ShadowPicker selection={selection} />
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search title, id, status, priority")}
                className="h-9 bg-background pl-9"
              />
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-2">
              <FilterSelect
                label={t("Type")}
                value={typeFilter}
                options={filterOptions.types}
                onChange={setTypeFilter}
              />
              <FilterSelect
                label={t("Status")}
                value={statusFilter}
                options={filterOptions.statuses}
                onChange={setStatusFilter}
              />
              <FilterSelect
                label={t("Priority")}
                value={priorityFilter}
                options={filterOptions.priorities}
                onChange={setPriorityFilter}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-0 flex-1 overflow-hidden rounded-lg py-0">
          <CardHeader className="border-b px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-sm">{t("Task inventory")}</CardTitle>
                <CardDescription>
                  {filtered.length}{t("visible of")}{tasks?.length ?? 0}
                </CardDescription>
              </div>
              <Badge variant="outline" className="gap-1.5">
                <span className="size-2 rounded-full bg-green-500" />{t("Queue idle")}</Badge>
            </div>
          </CardHeader>

          <ScrollArea className="min-h-0 flex-1">
            {error || selection.error ? (
              <DashboardErrorState title={t("Tasks failed to load")} error={error ?? selection.error} />
            ) : isLoading || selection.loading ? (
              <LoadingRows />
            ) : filtered.length === 0 ? (
              <TaskEmptyState hasQuery={query.trim().length > 0} />
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="pl-4">{t("Task")}</TableHead>
                    <TableHead>{t("Status")}</TableHead>
                    <TableHead>{t("Type")}</TableHead>
                    <TableHead>{t("Priority")}</TableHead>
                    <TableHead>{t("Participants")}</TableHead>
                    <TableHead>{t("Surfaces")}</TableHead>
                    <TableHead>{t("Last activity")}</TableHead>
                    <TableHead className="pr-4 text-right">{t("Open")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((item) => (
                    <TableRow key={item.id} className="h-14">
                      <TableCell className="max-w-[32rem] pl-4">
                        <a href={`${base}/tasks/${encodeURIComponent(item.id)}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {item.title}
                        </a>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.summary ?? item.id}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={item.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <UiText>{item.type}</UiText>
                      </TableCell>
                      <TableCell>
                        {item.priority ? (
                          <Badge variant="outline"><UiText>{item.priority}</UiText></Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-64">
                        <div className="flex flex-wrap gap-1">
                          {item.participants.slice(0, 3).map((participant) => (
                            <Badge
                              key={`${participant.userId}:${participant.role}`}
                              variant="outline"
                              className="max-w-44 rounded-md"
                            >
                              <span className="mr-1 text-muted-foreground">
                                <UiText>{participant.role}</UiText>
                              </span>
                              <IdentityLink
                                className="max-w-28 text-xs"
                                fallbackKind={
                                  participant.role === "agent" ? "bot" : "user"
                                }
                                identity={identityForCanonicalUser(participant.user)}
                                showKind={false}
                              />
                            </Badge>
                          ))}
                          {item.participants.length > 3 && (
                            <Badge variant="secondary">
                              +{item.participants.length - 3}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {item.linkedSessions?.length ??
                          item.linked_session_count}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTime(item.last_activity_at)}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <a href={`${base}/tasks/${encodeURIComponent(item.id)}`}
                          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
                        >
                          <ArrowRight className="size-4" />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}

function HeaderStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

function TaskEmptyState({ hasQuery }: { hasQuery: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[24rem] items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md border bg-background">
          <CircleCheck className="size-5 text-green-500" />
        </div>
        <h2 className="mt-4 text-base font-semibold">
          {hasQuery ? t("No matching tasks") : t("No active tasks")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasQuery ? t("Try a different filter.") : t("Queue idle.")}
        </p>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-md",
        tone === "green" && "border-green-500/30 text-green-700 dark:text-green-400",
        tone === "blue" && "border-blue-500/30 text-blue-700 dark:text-blue-400",
        tone === "amber" &&
          "border-yellow-500/40 text-yellow-700 dark:text-yellow-400",
      )}
    >
      <UiText>{status}</UiText>
    </Badge>
  );
}

function DashboardErrorState({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : t("Unknown error")}
      </p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="min-w-28 text-xs text-muted-foreground">
      <span className="sr-only">{label}</span>
      <SelectField
        aria-label={`${label} filter`}
        value={value}
        onValueChange={onChange}
        fullWidth
        options={[
          { value: "all", label },
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
  types: string[];
  statuses: string[];
  priorities: string[];
} {
  return {
    types: uniqueSorted(tasks.map((item) => item.type)),
    statuses: uniqueSorted(tasks.map((item) => item.status)),
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

function filterTasks(
  tasks: readonly DashboardTask[],
  filters: {
    query: string;
    typeFilter: string;
    statusFilter: string;
    priorityFilter: string;
  },
): DashboardTask[] {
  const { priorityFilter, query, statusFilter, typeFilter } = filters;
  const normalized = query.trim().toLowerCase();
  return tasks
    .filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) {
        return false;
      }
      if (statusFilter !== "all" && item.status !== statusFilter) {
        return false;
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
        ...(item.linkedSessions ?? item.linked_sessions).map(
          (session) => `${session.id} ${session.title ?? ""}`,
        ),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    })
    .sort((a, b) => b.last_activity_at - a.last_activity_at);
}

function identityForCanonicalUser(
  user: DashboardCanonicalUser | null | undefined,
): DashboardIdentity | null {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    channel: { type: "luna", id: "canonical" },
    externalId: user.id,
    identityKind: canonicalUserIdentityKind(user.kind),
    displayName: user.displayName,
    status: user.status,
    avatarUrl: user.avatarUrl,
    providerIds: {},
  };
}

function canonicalUserIdentityKind(kind: string): DashboardIdentity["identityKind"] {
  switch (kind) {
    case "bot":
      return "bot";
    case "system":
      return "system";
    case "human":
    case "service":
    default:
      return "user";
  }
}

function statusTone(status: string): "green" | "blue" | "amber" | "neutral" {
  if (status === "completed") {
    return "green";
  }
  if (status === "running") {
    return "blue";
  }
  if (status === "failed" || status === "cancelled") {
    return "amber";
  }
  return "neutral";
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
