import {
  ArrowUpRight,
  Clock,
  FileCode2,
  FileJson,
  FileText,
  MessageSquare,
  Play,
  ScrollText,
} from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";

import { avatarColorForKey } from "@/app/sessions/session-avatar";
import {
  ContextPackList,
  RunContextSummaryInline,
  RunContextSummaryList,
  SeedRecordList,
} from "@/components/context-pack-list";
import { CopyTextButton } from "@/components/copy-text-button";
import { IdentityLink } from "@/components/identity-link";
import { InspectableText } from "@/components/inspectable-text";
import { useAgentBasePath } from "@/lib/agent-route";
import type {
  DashboardCanonicalUser,
  DashboardContextPack,
  DashboardRunnerContextSeedRecord,
  DashboardTaskRunContextSummary,
} from "@/lib/api";
import { appHistory } from "@/lib/app-history";
import { UiText, useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import {
  formatRunDuration,
  formatTaskFullTime,
  identityForCanonicalUser,
  parseTaskContext,
  resolveTaskEffectiveState,
  TaskPriorityPill,
  taskStateClasses,
  TaskStateIcon,
  TaskStatusPill,
  TaskTypePill,
} from "./task-visuals";

export interface TaskDetailData {
  id: string;
  type: string;
  status: string;
  priority: string | null;
  severity: string | null;
  title: string;
  summary: string | null;
  creatorUserId: string | null;
  creatorUser?: DashboardCanonicalUser | null;
  participants: Array<{
    userId: string;
    role: string;
    user: DashboardCanonicalUser;
  }>;
  linked_session_count: number;
  linked_sessions: Array<{
    id: string;
    title: string | null;
    display_title?: string;
    displayTitle?: string;
    channel_type: string;
    channel_id: string;
    group_id: string | null;
    thread_id: string | null;
  }>;
  linkedSessions: Array<{
    id: string;
    title: string | null;
    displayTitle?: string;
    channelType: string;
  }>;
  taskContext?: unknown;
  contextPacks: DashboardContextPack[];
  seedRecords: DashboardRunnerContextSeedRecord[];
  runContextSummaries: DashboardTaskRunContextSummary[];
  sourceMessages?: TaskSourceMessageData[];
  sourceTurnMessages?: TaskSourceTurnMessageData[];
  runs: TaskRunData[];
  timeline: TaskTimelineEventData[];
  artifacts: TaskArtifactData[];
  subscriptions: Array<{
    id: string;
    task_id: string;
    session_id: string;
    channel_type: string;
    channel_id: string;
    group_id: string | null;
    thread_id: string | null;
    thread_key?: string | null;
    visibility: string;
    created_at: number;
    updated_at: number;
  }>;
  workSession?: {
    id: string;
    title: string | null;
    displayTitle?: string;
    channelType?: string;
    channel_type?: string;
  } | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

export interface TaskContextMessageData {
  id: string;
  entryId: string;
  entryKind: string;
  session_id: string;
  sessionId: string;
  channel_message_key: string | null;
  channelMessageKey: string | null;
  senderUserId: string;
  senderUser: DashboardCanonicalUser;
  role: string;
  contentKind: string;
  presentationKind: string;
  providerMessageType: string | null;
  content: unknown;
  created_at: number;
  createdAt: number;
}

export interface TaskSourceMessageData {
  sourceId: string;
  sessionId: string;
  createdAt: number;
  message: TaskContextMessageData;
}

export interface TaskSourceTurnMessageData {
  turnId: string;
  turnRole: string;
  sessionId: string;
  message: TaskContextMessageData;
}

export interface TaskRunData {
  id: string;
  task_id: string;
  taskId: string;
  run_index: number;
  runIndex: number;
  status: string;
  reason: string;
  input_snapshot: unknown;
  inputSnapshot: unknown;
  materialized_prompt?: string | null;
  materializedPrompt?: string | null;
  contextPackIds?: string[];
  contextPacks?: DashboardContextPack[];
  hasMaterializedPrompt?: boolean;
  seedRecords?: DashboardRunnerContextSeedRecord[];
  runner_type: string;
  runnerType: string;
  runner_context_id: string | null;
  runnerContextId: string | null;
  source_message_id: string | null;
  sourceMessageId: string | null;
  started_at: number;
  startedAt: number;
  finished_at: number | null;
  finishedAt: number | null;
  cancel_reason: string | null;
  cancelReason: string | null;
  error: string | null;
  final_report_artifact_id: string | null;
  finalReportArtifactId: string | null;
}

export interface TaskTimelineEventData {
  id: string;
  task_id: string;
  session_id: string | null;
  message_id: string | null;
  type: string;
  summary: string;
  data: unknown;
  taskRunId: string | null;
  runIndex: number | null;
  runReason: string | null;
  runnerType: string | null;
  visibility: string;
  actor_user_id?: string | null;
  actorUserId?: string | null;
  actorUser?: DashboardCanonicalUser | null;
  created_at: number;
}

export interface TaskArtifactData {
  id: string;
  task_id: string;
  type: string;
  name: string;
  mime_type?: string | null;
  mimeType?: string | null;
  path: string | null;
  content: string | null;
  metadata: unknown;
  status?: string;
  created_at: number;
  href: string | null;
}

export interface TaskDetailViewProps {
  taskDetail: TaskDetailData | undefined;
  runs: TaskRunData[] | undefined;
  timeline: TaskTimelineEventData[] | undefined;
  timelinePagination?: {hasMore: boolean; loading: boolean; loadMore: () => void};
  artifacts: TaskArtifactData[] | undefined;
  loading: {
    taskDetail: boolean;
    runs: boolean;
    timeline: boolean;
    artifacts: boolean;
  };
  errors?: {
    taskDetail?: unknown;
    runs?: unknown;
    timeline?: unknown;
    artifacts?: unknown;
  };
  backSlot?: ReactNode;
  actionsSlot?: ReactNode;
}

const tabs = ["Timeline", "Report", "Runs", "Artifacts", "Context"] as const;
type TaskDetailTab = (typeof tabs)[number];
const artifactGroupOrder = ["report", "patch", "log", "json", "text"] as const;
type ArtifactGroup = (typeof artifactGroupOrder)[number];

const cardSurfaceClass =
  "rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000006]";
const sageCardSurfaceClass =
  "relative overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_6px_#00000006] before:absolute before:top-0 before:left-5 before:h-[3px] before:w-6 before:rounded-xs before:bg-[#a3b69e] dark:before:bg-[#8ea487]";

function navigateClient(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  ) {
    event.preventDefault();
    appHistory.push(href);
  }
}

export function TaskDetailView({
  taskDetail,
  runs,
  timeline,
  timelinePagination,
  artifacts,
  loading,
  errors,
  backSlot,
  actionsSlot,
}: TaskDetailViewProps) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("Timeline");
  const [timelineRunFilter, setTimelineRunFilter] = useState<number | "all">("all");

  const displayRuns = runs ?? taskDetail?.runs ?? [];
  const orderedRuns = [...displayRuns].sort((a, b) => b.runIndex - a.runIndex);
  const displayTimeline = timeline ?? taskDetail?.timeline ?? [];
  const orderedTimeline = [...displayTimeline].sort(
    (a, b) => b.created_at - a.created_at,
  );
  const filteredTimeline =
    timelineRunFilter === "all"
      ? orderedTimeline
      : orderedTimeline.filter((event) => event.runIndex === timelineRunFilter);

  const displayArtifacts = artifacts ?? taskDetail?.artifacts ?? [];
  const latestRun = latestTaskRun(displayRuns);
  const latestRunDuration = latestRun
    ? formatRunDuration(latestRun.startedAt, latestRun.finishedAt)
    : null;
  const currentReportArtifactId =
    latestRun?.status === "completed" ? latestRun.finalReportArtifactId : null;
  const reportArtifacts =
    currentReportArtifactId === null
      ? []
      : displayArtifacts.filter(
          (artifact) =>
            artifact.id === currentReportArtifactId &&
            shouldInlineArtifactContent(artifact),
        );
  const groupedArtifacts = groupArtifacts(displayArtifacts);
  const operationTraces = displayTimeline.flatMap(toOperationTrace);
  const taskContext = parseTaskContext(taskDetail?.taskContext);
  const effectiveState = resolveTaskEffectiveState({
    status: taskDetail?.status ?? "new",
    taskContext: taskDetail?.taskContext,
  });
  const sourceMessages = taskDetail?.sourceMessages ?? [];
  const sourceTurnMessages = taskDetail?.sourceTurnMessages ?? [];
  const sourceSessionIds = new Set(sourceMessages.map((item) => item.sessionId));
  const notificationSessionIds = new Set(
    (taskDetail?.subscriptions ?? []).map((subscription) => subscription.session_id),
  );
  const linkedSessions =
    taskDetail?.linkedSessions ??
    taskDetail?.linked_sessions.map((session) => ({
      id: session.id,
      title: session.title,
      displayTitle: session.displayTitle ?? session.display_title,
      channelType: session.channel_type,
    })) ??
    [];
  const linkedSessionDetails =
    taskDetail?.linked_sessions ??
    linkedSessions.map((session) => ({
      id: session.id,
      title: session.title,
      displayTitle: session.displayTitle,
      channel_type: session.channelType,
      channel_id: "-",
      group_id: null,
      thread_id: null,
    }));

  if (errors?.taskDetail && !loading.taskDetail) {
    return (
      <article
        className="flex h-full flex-1 flex-col p-5 md:p-7"
        data-testid="task-detail"
      >
        {backSlot ? <div className="mb-4">{backSlot}</div> : null}
        <DashboardErrorState
          title={t("Task failed to load")}
          error={errors.taskDetail}
        />
      </article>
    );
  }

  const tabCounts: Record<TaskDetailTab, number | null> = {
    Timeline: displayTimeline.length,
    Report: reportArtifacts.length > 0 ? reportArtifacts.length : null,
    Runs: displayRuns.length,
    Artifacts: displayArtifacts.length,
    Context:
      (taskContext.hasContent ? 1 : 0) +
      sourceMessages.length +
      (taskDetail?.contextPacks.length ?? 0),
  };

  return (
    <article
      className="@container flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background @[1040px]:overflow-hidden"
      data-testid="task-detail"
    >
      {/* Unified Full-Width Identity Hero Header */}
      <header
        className="shrink-0 border-b border-border bg-card px-5 pt-4 pb-0 md:px-7"
        data-testid="task-header"
      >
        <div className="space-y-3">
          {/* Row 1: Navigation + Status Pills + Primary Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {backSlot ? (
                <>
                  {backSlot}
                  <span aria-hidden="true" className="h-4 w-px bg-border" />
                </>
              ) : null}

              <TaskStatusPill
                status={taskDetail?.status === "waiting" ? "Waiting" : (taskDetail?.status ?? "loading")}
                effectiveState={
                  effectiveState === "waiting" && taskDetail?.status !== "waiting"
                    ? "completed"
                    : effectiveState
                }
                showDot
                className="rounded-full px-2.5 py-0.5 text-xs font-semibold"
              />
              {effectiveState === "waiting" && taskDetail?.status !== "waiting" ? (
                <TaskStatusPill
                  status="Waiting"
                  effectiveState="waiting"
                  showDot
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold"
                />
              ) : null}
              <TaskTypePill
                type={taskDetail?.type ?? "type"}
                className="px-2.5 py-0.5 text-xs"
              />
              {taskDetail?.priority ? (
                <TaskPriorityPill
                  priority={taskDetail.priority}
                  alwaysShow
                  className="rounded-full px-2.5 py-0.5 text-xs"
                />
              ) : null}
              {taskDetail?.severity ? (
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                  {taskDetail.severity}
                </span>
              ) : null}
              {!actionsSlot ? (
                <span className="font-mono text-muted-foreground">
                  {taskDetail?.id ?? "task"}
                </span>
              ) : null}
            </div>

            {actionsSlot ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {actionsSlot}
              </div>
            ) : (
              <div className="text-xs tabular-nums text-muted-foreground">
                {t("Last activity")}{" "}
                {taskDetail ? formatTaskFullTime(taskDetail.last_activity_at) : "-"}
              </div>
            )}
          </div>

          {/* Row 2: Title + Compact Provenance + Right Vital Metric Tiles */}
          <div className="flex flex-col gap-3 @[960px]:flex-row @[960px]:items-center @[960px]:justify-between">
            <div className="min-w-0 flex-1 space-y-1.5">
              <h1
                className="m-0 text-[20px] leading-snug font-semibold tracking-tight break-words text-foreground md:text-[22px]"
                title={taskDetail?.title ?? "Loading task"}
              >
                {taskDetail?.title ?? t("Loading task")}
              </h1>

              {taskDetail ? (
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span>{t("Creator")}:</span>
                    <IdentityLink
                      className="text-xs"
                      identity={identityForCanonicalUser(taskDetail.creatorUser)}
                      showAvatar
                      showKind={false}
                    />
                  </span>

                  {linkedSessionDetails[0] ? (
                    <a
                      href={`${base}/sessions/${encodeURIComponent(linkedSessionDetails[0].id)}`}
                      onClick={(event) =>
                        navigateClient(
                          event,
                          `${base}/sessions/${encodeURIComponent(linkedSessionDetails[0]!.id)}`,
                        )
                      }
                      className="inline-flex max-w-64 items-center gap-1 rounded-[6px] bg-muted px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
                    >
                      <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {linkedSessionDetails[0].displayTitle ??
                          linkedSessionDetails[0].title ??
                          "Untitled session"}
                      </span>
                    </a>
                  ) : null}

                  <span className="font-mono text-[11px] opacity-75">
                    {taskDetail.id}
                  </span>
                </div>
              ) : null}
            </div>

            {/* Right Vital Summary Strip (Desktop) */}
            {taskDetail ? (
              <div className="hidden shrink-0 grid-cols-3 gap-2 @[960px]:grid">
                <button
                  type="button"
                  onClick={() => setActiveTab("Runs")}
                  className="relative min-w-[8.5rem] cursor-pointer overflow-hidden rounded-xl border border-border bg-background/65 px-3 py-2 text-left transition-colors before:absolute before:top-0 before:left-3.5 before:h-[2.5px] before:w-5 before:rounded-xs before:bg-[#a3b69e] hover:bg-accent/45 dark:before:bg-[#8ea487]"
                >
                  <div className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
                    <span>{t("Latest run")}</span>
                    <Play className="size-3 opacity-70" />
                  </div>
                  <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-foreground">
                    {latestRun
                      ? `#${latestRun.runIndex} · ${latestRun.runnerType}`
                      : "-"}
                  </div>
                  <div className="truncate text-[11px] tabular-nums text-muted-foreground">
                    {latestRunDuration ?? `${displayRuns.length} ${t("Runs")}`}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("Artifacts")}
                  className="min-w-[7rem] cursor-pointer rounded-xl border border-border bg-background/65 px-3 py-2 text-left transition-colors hover:bg-accent/45"
                >
                  <div className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
                    <span>{t("Artifacts")}</span>
                    <FileText className="size-3 text-[#5b8a72] dark:text-[#7fb096]" />
                  </div>
                  <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-foreground">
                    {displayArtifacts.length}
                  </div>
                  <div className="truncate text-[11px] tabular-nums text-muted-foreground">
                    {displayTimeline.length} {t("events")}
                  </div>
                </button>

                <div className="min-w-[9rem] rounded-xl border border-border bg-background/65 px-3 py-2 text-left">
                  <div className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
                    <span>{t("Last activity")}</span>
                    <Clock className="size-3 opacity-70" />
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] font-semibold tabular-nums text-foreground">
                    {formatTaskFullTime(taskDetail.last_activity_at)}
                  </div>
                  <div className="truncate text-[11px] tabular-nums text-muted-foreground">
                    {t("Created")} {formatTaskFullTime(taskDetail.created_at)}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Contextual Callout Banners */}
          {taskContext.pendingQuestions.length > 0 ? (
            <div
              className={cn(
                "rounded-xl border px-4 py-3 text-xs",
                taskStateClasses("waiting").calloutClass,
              )}
            >
              <div className="font-semibold">{t("Waiting for confirmation")}</div>
              <div className="mt-1 space-y-1 text-[13px] leading-relaxed">
                {taskContext.pendingQuestions.map((question, idx) => (
                  <div key={idx} className="break-words">
                    {question}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {latestRun?.status === "failed" && latestRun.error ? (
            <div
              className={cn(
                "rounded-xl border px-4 py-3 text-xs",
                taskStateClasses("failed").calloutClass,
              )}
            >
              <div className="font-semibold">{t("Latest run error")}</div>
              <div className="mt-1 font-mono leading-relaxed break-all">
                {latestRun.error}
              </div>
            </div>
          ) : null}

          {/* Operation Trace Banner */}
          {operationTraces.length > 0 ? (
            <section
              className="grid gap-2 rounded-xl border border-border bg-muted/40 p-3 text-xs"
              data-testid="task-operation-trace"
            >
              <h2 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                {t("Operation Trace")}
              </h2>
              <div className="grid gap-2 @[900px]:grid-cols-2">
                {operationTraces.map((trace) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-card px-3 py-2"
                    key={`${trace.requestId}:${trace.operation}`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-foreground break-all">
                          {trace.operation}
                        </span>
                        <span className="rounded bg-[#5b8a72]/14 px-1.5 py-0.5 text-[11px] font-medium text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]">
                          <UiText>{trace.status}</UiText>
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {trace.requestId}
                      </div>
                    </div>
                    {trace.artifactIds.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {trace.artifactIds.map((artifactId) => (
                          <a
                            className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-background px-2 py-0.5 font-mono text-foreground transition-colors hover:bg-accent hover:no-underline"
                            href={`#artifact-${artifactId}`}
                            key={artifactId}
                            onClick={() => setActiveTab("Artifacts")}
                          >
                            <FileText className="size-3 text-muted-foreground" />
                            <span>{artifactId}</span>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Flush Underline Tab Navigation */}
          <nav
            aria-label={t("Task detail sections")}
            className="flex items-center gap-1 overflow-x-auto pt-0.5"
            role="tablist"
          >
            {tabs.map((tab) => {
              const isSelected = activeTab === tab;
              const count = tabCounts[tab];
              return (
                <div
                  key={tab}
                  className={cn(
                    "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] whitespace-nowrap transition-colors",
                    isSelected
                      ? "border-[#a3b69e] text-foreground dark:border-[#8ea487]"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <button
                    aria-controls={tab.toLowerCase()}
                    aria-selected={isSelected}
                    className={cn(
                      "cursor-pointer text-left outline-none",
                      isSelected ? "font-semibold text-foreground" : "font-normal",
                    )}
                    onClick={() => setActiveTab(tab)}
                    role="tab"
                    type="button"
                  >
                    {t(tab)}
                  </button>
                  {count !== null && count > 0 ? (
                    <span
                      aria-hidden="true"
                      onClick={() => setActiveTab(tab)}
                      className="cursor-pointer rounded-full bg-muted px-1.5 py-0.5 text-[11px] leading-none font-normal tabular-nums text-muted-foreground"
                    >
                      {count}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Full-Bleed Two-Column Split Workbench */}
      <div className="grid min-h-0 flex-1 grid-cols-1 @[1040px]:grid-cols-[minmax(0,1fr)_340px] @[1400px]:grid-cols-[minmax(0,1fr)_380px]">
        {/* Left Fluid Main Stage */}
        <div className="min-w-0 px-5 py-5 md:px-7 md:py-6 @[1040px]:overflow-y-auto">
          {activeTab === "Runs" ? (
            <section
              id="runs"
              className="space-y-3.5 pb-4"
              data-testid="task-runs"
              role="tabpanel"
            >
              <h2 className="sr-only">{t("Runs")}</h2>
              {loading.runs ? (
                <p className="text-sm text-muted-foreground">{t("Loading runs")}</p>
              ) : errors?.runs ? (
                <DashboardErrorState
                  title={t("Runs failed to load")}
                  error={errors.runs}
                />
              ) : orderedRuns.length === 0 ? (
                <div className={cn(cardSurfaceClass, "p-6 text-sm text-muted-foreground")}>
                  -
                </div>
              ) : (
                orderedRuns.map((run) => {
                  const runState = resolveTaskEffectiveState({ status: run.status });
                  const duration = formatRunDuration(run.startedAt, run.finishedAt);
                  return (
                    <div
                      key={run.id}
                      className={cn(cardSurfaceClass, "space-y-3.5 p-5")}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <TaskStateIcon state={runState} />
                          <span className="text-[15px] font-semibold text-foreground">
                            #{run.runIndex}
                          </span>
                          <TaskStatusPill status={run.status} effectiveState={runState} />
                          <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs text-secondary-foreground">
                            {run.runnerType}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t("Reason")}: <UiText>{run.reason}</UiText>
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-muted-foreground">
                          <span>
                            {formatTaskFullTime(run.startedAt)}
                            {run.finishedAt
                              ? ` → ${formatTaskFullTime(run.finishedAt)}`
                              : ""}
                            {duration ? ` · ${duration}` : ""}
                          </span>
                          {runMaterializedPromptText(run) ? (
                            <CopyTextButton
                              className="h-7 rounded-[7px] px-2.5 font-sans text-xs"
                              label={`Copy LLM prompt for run #${run.runIndex}`}
                              text={runMaterializedPromptText(run) ?? ""}
                            >
                              {t("Copy LLM prompt")}
                            </CopyTextButton>
                          ) : null}
                        </div>
                      </div>

                      {run.error ? (
                        <div
                          className={cn(
                            "rounded-xl border p-3 font-mono text-xs break-all",
                            taskStateClasses("failed").calloutClass,
                          )}
                        >
                          {t("Error:")} {run.error}
                        </div>
                      ) : null}

                      {run.cancelReason ? (
                        <div className="rounded-xl border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                          {t("Cancelled:")} {run.cancelReason}
                        </div>
                      ) : null}

                      <div
                        className="space-y-2 rounded-xl border border-border bg-muted/35 p-3.5 font-mono text-xs break-words whitespace-normal"
                        data-testid={`task-run-input-${run.id}`}
                      >
                        <InspectableText
                          label={t("Input")}
                          previewLength={260}
                          previewClassName="font-mono"
                          text={formatInspectableValue(run.inputSnapshot)}
                        />
                        <div className="font-sans">
                          <RunContextSummaryInline run={run} />
                        </div>
                      </div>

                      {run.finalReportArtifactId ? (
                        <div className="flex items-center justify-end text-xs">
                          <a
                            className="inline-flex items-center gap-1 font-medium text-[#5b8a72] hover:underline dark:text-[#7fb096]"
                            href={`#artifact-${run.finalReportArtifactId}`}
                            onClick={() => setActiveTab("Artifacts")}
                          >
                            <FileText className="size-3.5" />
                            <span>{run.finalReportArtifactId}</span>
                          </a>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </section>
          ) : null}

          {activeTab === "Timeline" ? (
            <section
              id="timeline"
              className="pb-4"
              data-testid="task-timeline"
              role="tabpanel"
            >
              {loading.timeline ? (
                <p className="text-sm text-muted-foreground">{t("Loading timeline")}</p>
              ) : errors?.timeline ? (
                <DashboardErrorState
                  title={t("Timeline failed to load")}
                  error={errors.timeline}
                />
              ) : (
                <div className={cn(cardSurfaceClass, "p-5 md:p-6")}>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3.5">
                    <div className="flex items-center gap-2">
                      <h2 className="m-0 text-sm font-semibold text-foreground">
                        {t("Timeline")}
                      </h2>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                        {filteredTimeline.length}
                      </span>
                    </div>

                    {orderedRuns.length > 1 ? (
                      <div className="inline-flex flex-wrap items-center gap-0.5 rounded-[8px] bg-muted p-0.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setTimelineRunFilter("all")}
                          className={cn(
                            "cursor-pointer rounded-[6px] px-2.5 py-1 transition-colors",
                            timelineRunFilter === "all"
                              ? "bg-card font-medium text-foreground shadow-2xs"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {t("All runs")}
                        </button>
                        {orderedRuns.map((run) => (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => setTimelineRunFilter(run.runIndex)}
                            className={cn(
                              "cursor-pointer rounded-[6px] px-2 py-1 font-mono transition-colors",
                              timelineRunFilter === run.runIndex
                                ? "bg-card font-semibold text-foreground shadow-2xs"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            #{run.runIndex}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {filteredTimeline.length === 0 ? (
                    <p className="m-0 text-sm text-muted-foreground">-</p>
                  ) : (
                    <div className="relative space-y-5 pl-6">
                      <span
                        aria-hidden="true"
                        className="absolute top-2 bottom-2 left-[11px] w-px bg-border"
                      />
                      {filteredTimeline.map((event) => (
                        <div
                          key={event.id}
                          className="relative rounded-xl px-2.5 py-1.5 transition-colors hover:bg-muted/35"
                        >
                          <span
                            aria-hidden="true"
                            className="absolute top-2.5 -left-6 inline-grid size-[22px] place-items-center rounded-full bg-card ring-4 ring-card"
                          >
                            <span
                              className={cn(
                                "size-2.5 rounded-full",
                                timelineEventDotClass(event.type),
                              )}
                            />
                          </span>

                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                                {event.type}
                              </span>
                              {event.runIndex ? (
                                <button
                                  type="button"
                                  onClick={() => setActiveTab("Runs")}
                                  className="cursor-pointer rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground transition-opacity hover:opacity-80"
                                >
                                  #{event.runIndex}
                                </button>
                              ) : null}
                              {event.actorUser ? (
                                <>
                                  <IdentityLink
                                    className="max-w-52 text-xs"
                                    fallbackKind="user"
                                    identity={identityForCanonicalUser(event.actorUser)}
                                    showAvatar
                                    showKind={false}
                                  />
                                  <span className="text-muted-foreground">·</span>
                                </>
                              ) : null}
                              <span className="text-muted-foreground">
                                <UiText>{event.visibility}</UiText>
                              </span>
                            </div>
                            <span className="tabular-nums text-muted-foreground">
                              {formatTaskFullTime(event.created_at)}
                            </span>
                          </div>

                          {event.type === "runner.tool" && event.data && typeof event.data === "object" ? (
                            <div className="mt-1 text-xs text-muted-foreground" data-testid={`task-tool-status-${event.id}`}>
                              {toolProgressLabel(event.data as Record<string, unknown>)}
                            </div>
                          ) : null}

                          <div
                            className="mt-1.5 text-[13.5px] leading-relaxed break-words whitespace-normal text-foreground"
                            data-testid={`task-timeline-summary-${event.id}`}
                          >
                            <InspectableText
                              label={t("Summary")}
                              previewLength={280}
                              text={
                                event.type === "runner.step" &&
                                event.data &&
                                typeof event.data === "object" &&
                                "text" in event.data &&
                                typeof event.data.text === "string"
                                  ? event.data.text
                                  : event.summary
                              }
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {timelinePagination?.hasMore ? (
                    <button
                      type="button"
                      className="mt-4 rounded-[8px] border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                      disabled={timelinePagination.loading}
                      onClick={timelinePagination.loadMore}
                    >
                      {timelinePagination.loading ? "加载中…" : "加载更早记录"}
                    </button>
                  ) : null}
                </div>
              )}
            </section>
          ) : null}

          {activeTab === "Report" ? (
            <section
              id="report"
              className="space-y-4 pb-4"
              data-testid="task-report"
              role="tabpanel"
            >
              <div className={cn(sageCardSurfaceClass, "space-y-2 p-5 md:p-6")}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                    {t("Summary")}
                  </h2>
                  {taskDetail?.summary ? (
                    <CopyTextButton
                      className="h-7 rounded-[7px] px-2.5 text-xs"
                      label={t("Copy")}
                      text={taskDetail.summary}
                    >
                      {t("Copy")}
                    </CopyTextButton>
                  ) : null}
                </div>
                <p className="m-0 text-sm leading-6 break-words whitespace-pre-wrap text-foreground">
                  {taskDetail?.summary ?? t("No report summary is available.")}
                </p>
              </div>

              {reportArtifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className={cn(cardSurfaceClass, "overflow-hidden")}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
                    <div className="flex items-center gap-2 text-xs">
                      <FileText className="size-4 text-[#5b8a72] dark:text-[#7fb096]" />
                      <h3 className="m-0 font-mono text-sm font-medium text-foreground">
                        {artifact.name}
                      </h3>
                    </div>
                    {artifact.href ? (
                      <a
                        href={artifact.href}
                        className="inline-flex h-7 items-center gap-1 rounded-[7px] border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
                      >
                        <span>{t("Open preview")}</span>
                        <ArrowUpRight className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                  <div
                    className="max-w-full overflow-hidden p-5 text-sm leading-7 break-words whitespace-pre-wrap md:p-6"
                    data-testid="task-report-content"
                  >
                    <Streamdown className="break-words">
                      {artifact.content ?? ""}
                    </Streamdown>
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          {activeTab === "Artifacts" ? (
            <section
              id="artifacts"
              className="pb-4"
              data-testid="task-artifacts"
              role="tabpanel"
            >
              <h2 className="sr-only">{t("Artifacts")}</h2>
              {loading.artifacts ? (
                <p className="text-sm text-muted-foreground">
                  {t("Loading artifacts")}
                </p>
              ) : errors?.artifacts ? (
                <DashboardErrorState
                  title={t("Artifacts failed to load")}
                  error={errors.artifacts}
                />
              ) : displayArtifacts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-14 text-center text-sm text-muted-foreground">
                  {t("No artifacts recorded.")}
                </div>
              ) : (
                <div className="space-y-5">
                  {artifactGroupOrder.map((group) => {
                    const items = groupedArtifacts[group];
                    if (items.length === 0) {
                      return null;
                    }
                    return (
                      <section key={group} className="space-y-2.5">
                        <div className="flex items-center gap-2 px-1">
                          <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                            <UiText>{group}</UiText>
                          </h3>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {items.length}
                          </span>
                        </div>
                        <div className="grid gap-3 @[760px]:grid-cols-2">
                          {items.map((artifact) => {
                            const artifactHref = artifact.href;
                            const Icon = artifactGroupIcon(group);
                            return (
                              <div
                                id={`artifact-${artifact.id}`}
                                key={artifact.id}
                                className={cn(
                                  cardSurfaceClass,
                                  "flex items-center justify-between gap-3 p-4 transition-colors hover:bg-muted/35",
                                )}
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <span
                                    aria-hidden="true"
                                    className={cn(
                                      "inline-grid size-9 shrink-0 place-items-center rounded-xl",
                                      artifactGroupBadgeClass(group),
                                    )}
                                  >
                                    <Icon className="size-4" />
                                  </span>
                                  <div className="min-w-0">
                                    <div className="font-mono text-[13.5px] font-medium break-words whitespace-normal text-foreground">
                                      {artifactHref ? (
                                        <a
                                          className="text-foreground hover:underline"
                                          data-testid="task-artifact-link"
                                          href={artifactHref}
                                        >
                                          {artifact.name}
                                        </a>
                                      ) : (
                                        artifact.name
                                      )}
                                    </div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                      <span>{artifact.type}</span>
                                      <span>·</span>
                                      <span>
                                        <UiText>{artifact.status ?? "active"}</UiText>
                                      </span>
                                      <span>·</span>
                                      <span>
                                        {formatTaskFullTime(artifact.created_at)}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {artifactHref ? (
                                  <a
                                    href={artifactHref}
                                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[7px] border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
                                  >
                                    <span>{t("Open preview")}</span>
                                    <ArrowUpRight className="size-3.5" />
                                  </a>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {activeTab === "Context" ? (
            <section
              id="context"
              className="space-y-5 pb-4"
              data-testid="task-context"
              role="tabpanel"
            >
              <h2 className="sr-only">{t("Context")}</h2>

              {/* Task Structured Context */}
              <section className={cn(sageCardSurfaceClass, "space-y-3 p-5 md:p-6")}>
                <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                  {t("Task Context")}
                </h3>
                <div className="text-sm">
                  {taskContext.latestUserMessage ? (
                    <ContextField
                      label={t("Latest user message")}
                      value={taskContext.latestUserMessage}
                    />
                  ) : null}
                  <ContextList
                    label={t("Known facts")}
                    values={taskContext.knownFacts}
                  />
                  <ContextList
                    label={t("Assumptions")}
                    values={taskContext.assumptions}
                  />
                  <ContextList
                    label={t("Pending questions")}
                    values={taskContext.pendingQuestions}
                  />
                  {!taskContext.hasContent ? (
                    <div className="text-sm text-muted-foreground">
                      {t("No task-level context was recorded.")}
                    </div>
                  ) : null}
                </div>
              </section>

              {/* Source Messages & Turn Context Side-by-Side on Wide Screens */}
              <div className="grid items-start gap-5 @[920px]:grid-cols-2">
                <section className={cn(cardSurfaceClass, "space-y-3 p-5")}>
                  <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                    {t("Source Messages")}
                  </h3>
                  <div className="grid gap-2.5 text-sm">
                    {sourceMessages.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
                        {t("No source messages recorded.")}
                      </div>
                    ) : (
                      sourceMessages.map((source) => (
                        <TaskContextMessageRow
                          key={`${source.sourceId}:${source.message.id}`}
                          label={t("source")}
                          message={source.message}
                        />
                      ))
                    )}
                  </div>
                </section>

                <section className={cn(cardSurfaceClass, "space-y-3 p-5")}>
                  <h3 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                    {t("Source Turn Context")}
                  </h3>
                  <div className="grid gap-2.5 text-sm">
                    {sourceTurnMessages.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
                        {t("No source turn context recorded.")}
                      </div>
                    ) : (
                      sourceTurnMessages.map((item) => (
                        <TaskContextMessageRow
                          key={`${item.turnId}:${item.turnRole}:${item.message.entryId}`}
                          label={item.turnRole}
                          message={item.message}
                        />
                      ))
                    )}
                  </div>
                </section>
              </div>

              {/* Runner Context Packs & Seeds */}
              <div className={cn(cardSurfaceClass, "space-y-5 p-5 md:p-6")}>
                <ContextPackList packs={taskDetail?.contextPacks ?? []} />
                <SeedRecordList records={taskDetail?.seedRecords ?? []} />
                <RunContextSummaryList
                  summaries={taskDetail?.runContextSummaries ?? []}
                />
              </div>
            </section>
          ) : null}
        </div>

        {/* Right Persistent Inspector Rail (Visible across ALL tabs!) */}
        <aside
          className="border-t border-border bg-sidebar/60 px-5 py-5 md:px-6 md:py-6 @[1040px]:overflow-y-auto @[1040px]:border-t-0 @[1040px]:border-l"
          data-testid="task-inspector-rail"
        >
          <div className="divide-y divide-border/75">
            {/* Section 1: Task Overview Properties */}
            <section className="space-y-3 pb-5">
              <h2 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                {t("Task overview")}
              </h2>
              <dl className="m-0 space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t("Status")}</dt>
                  <dd className="m-0 flex items-center gap-1.5">
                    <TaskStatusPill
                      status={taskDetail?.status === "waiting" ? "Waiting" : (taskDetail?.status ?? "loading")}
                      effectiveState={
                        effectiveState === "waiting" && taskDetail?.status !== "waiting"
                          ? "completed"
                          : effectiveState
                      }
                      showDot
                    />
                    {effectiveState === "waiting" && taskDetail?.status !== "waiting" ? (
                      <TaskStatusPill
                        status="Waiting"
                        effectiveState="waiting"
                        showDot
                      />
                    ) : null}
                  </dd>
                </div>

                {taskDetail ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">{t("Creator")}</dt>
                      <dd className="m-0 min-w-0">
                        <IdentityLink
                          className="text-xs"
                          identity={identityForCanonicalUser(taskDetail.creatorUser)}
                          showAvatar
                          showKind={false}
                        />
                      </dd>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">{t("Type")}</dt>
                      <dd className="m-0 flex items-center gap-1.5">
                        <TaskTypePill type={taskDetail.type} />
                        {taskDetail.priority ? (
                          <TaskPriorityPill
                            priority={taskDetail.priority}
                            alwaysShow
                          />
                        ) : null}
                      </dd>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">{t("Created")}</dt>
                      <dd className="m-0 tabular-nums text-foreground">
                        {formatTaskFullTime(taskDetail.created_at)}
                      </dd>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">{t("Last activity")}</dt>
                      <dd className="m-0 tabular-nums text-foreground">
                        {formatTaskFullTime(taskDetail.last_activity_at)}
                      </dd>
                    </div>
                  </>
                ) : null}
              </dl>
            </section>

            {/* Section 2: Linked Sessions & Work Session */}
            <section className="space-y-3 py-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                  {t("Linked Sessions")}
                </h2>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {linkedSessionDetails.length}
                </span>
              </div>

              {linkedSessionDetails.length === 0 ? (
                <p className="m-0 text-xs text-muted-foreground">
                  {t("No linked sessions.")}
                </p>
              ) : (
                <div className="space-y-2">
                  {linkedSessionDetails.map((session) => {
                    const label =
                      session.displayTitle ??
                      session.title ??
                      t("Untitled session");
                    const sessionHref = `${base}/sessions/${session.id}`;
                    return (
                      <div
                        className="space-y-2 rounded-xl border border-border/80 bg-card p-3 shadow-2xs"
                        key={session.id}
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className="inline-grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                            style={{
                              backgroundColor: avatarColorForKey(
                                session.group_id ?? session.id,
                              ),
                            }}
                          >
                            {Array.from(label.trim() || "?").slice(0, 2).join("")}
                          </span>
                          <div className="min-w-0 flex-1">
                            <a
                              className="block truncate text-[13px] font-medium text-foreground hover:underline"
                              href={sessionHref}
                              onClick={(event) => navigateClient(event, sessionHref)}
                            >
                              {label}
                            </a>
                            <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                              <span>{session.channel_type}</span>
                              <span>·</span>
                              <span>{session.channel_id}</span>
                              {session.group_id ? (
                                <span>
                                  · {t("Group")} {session.group_id}
                                </span>
                              ) : null}
                              {session.thread_id ? (
                                <span>
                                  · {t("Thread")} {session.thread_id}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        {sourceSessionIds.has(session.id) ||
                        notificationSessionIds.has(session.id) ? (
                          <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2 text-[11px]">
                            {sourceSessionIds.has(session.id) ? (
                              <span className="rounded bg-secondary px-2 py-0.5 text-secondary-foreground">
                                {t("Source session")}
                              </span>
                            ) : null}
                            {notificationSessionIds.has(session.id) ? (
                              <span className="rounded bg-[#5b8a72]/14 px-2 py-0.5 font-medium text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]">
                                {t("Notification thread")}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              {taskDetail?.workSession ? (
                <WorkSessionSummary
                  base={base}
                  session={taskDetail.workSession}
                />
              ) : null}
            </section>

            {/* Section 3: Participants */}
            <section className="space-y-3 py-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                  {t("Participants")}
                </h2>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {taskDetail?.participants.length ?? 0}
                </span>
              </div>

              {(taskDetail?.participants ?? []).length === 0 ? (
                <p className="m-0 text-xs text-muted-foreground">-</p>
              ) : (
                <div className="space-y-2">
                  {(taskDetail?.participants ?? []).map((participant) => (
                    <div
                      className="flex items-center justify-between gap-2 rounded-xl border border-border/80 bg-card px-3 py-2 text-xs shadow-2xs"
                      key={`${participant.userId}:${participant.role}`}
                    >
                      <IdentityLink
                        className="min-w-0 text-xs"
                        fallbackKind={
                          participant.role === "agent" ? "bot" : "user"
                        }
                        identity={identityForCanonicalUser(participant.user)}
                        showAvatar
                        showKind={false}
                      />
                      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
                        <UiText>{participant.role}</UiText>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Section 4: Notifications */}
            <section className="space-y-3 pt-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="m-0 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                  {t("Notifications")}
                </h2>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {taskDetail?.subscriptions.length ?? 0}
                </span>
              </div>

              {(taskDetail?.subscriptions ?? []).length === 0 ? (
                <p className="m-0 text-xs text-muted-foreground">
                  {t("No notifications configured.")}
                </p>
              ) : (
                <div className="space-y-2">
                  {(taskDetail?.subscriptions ?? []).map((subscription) => (
                    <div
                      className="rounded-xl border border-border/80 bg-card px-3 py-2.5 shadow-2xs"
                      key={subscription.id}
                    >
                      <div className="text-xs font-medium text-foreground">
                        <UiText>
                          {subscription.visibility === "full"
                            ? "Full updates"
                            : subscription.visibility === "summary"
                              ? "Summary updates"
                              : `${subscription.visibility} updates`}
                        </UiText>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                        <span>{subscription.channel_type}</span>
                        <span>·</span>
                        <span>{subscription.channel_id}</span>
                        {subscription.group_id ? (
                          <span>
                            · {t("Group")} {subscription.group_id}
                          </span>
                        ) : null}
                        {subscriptionThreadKey(subscription) ? (
                          <span>
                            · {t("Thread")} {subscriptionThreadKey(subscription)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </aside>
      </div>
    </article>
  );
}

function DashboardErrorState({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        <UiText>{errorMessage(error)}</UiText>
      </p>
    </div>
  );
}

function WorkSessionSummary({
  base,
  session,
}: {
  base: string;
  session: NonNullable<TaskDetailData["workSession"]>;
}) {
  const { t } = useTranslation();
  const label = session.displayTitle ?? session.title ?? session.id;
  const sessionHref = `${base}/sessions/${encodeURIComponent(session.id)}`;
  return (
    <div className="space-y-1.5 rounded-xl border border-dashed border-border bg-card/70 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
        <span>{t("Work session")}</span>
        <CopyTextButton
          className="h-5 rounded px-1.5 font-mono text-[10px] font-normal normal-case"
          label={t("Work session")}
          text={session.id}
        >
          {session.id.length > 14 ? `${session.id.slice(0, 12)}…` : session.id}
        </CopyTextButton>
      </div>
      <a
        href={sessionHref}
        onClick={(event) => navigateClient(event, sessionHref)}
        className="block truncate text-xs font-medium text-foreground hover:underline"
      >
        {label}
      </a>
    </div>
  );
}

function ContextField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-2.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[9.5rem_1fr]">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-[13px] leading-relaxed">
        {renderMarkdownInlineText(value)}
      </div>
    </div>
  );
}

function ContextList({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-1 border-b border-border/60 py-2.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[9.5rem_1fr]">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <ul className="m-0 min-w-0 list-disc space-y-1 pl-4 text-[13px] leading-relaxed">
        {values.map((value, index) => (
          <li className="break-words" key={`${index}:${value}`}>
            {renderMarkdownInlineText(value)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskContextMessageRow({
  label,
  message,
}: {
  label: string;
  message: TaskContextMessageData;
}) {
  return (
    <div
      className="rounded-xl border border-border border-l-[3px] border-l-[#a3b69e] bg-muted/40 p-3.5 dark:border-l-[#8ea487]"
      data-testid={`task-context-message-${message.id}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-card px-1.5 py-0.5 font-medium text-foreground">
          {label}
        </span>
        <IdentityLink
          className="text-xs"
          fallbackKind={message.role === "assistant" ? "bot" : "user"}
          identity={identityForCanonicalUser(message.senderUser)}
          showKind={false}
        />
        <span>{formatTaskFullTime(message.createdAt ?? message.created_at)}</span>
        {message.entryKind !== "message" ? <span>{message.entryKind}</span> : null}
      </div>
      <div className="min-w-0 text-[13px] leading-6 break-words">
        {renderTaskContextMessageContent(message)}
      </div>
    </div>
  );
}

function renderTaskContextMessageContent(message: TaskContextMessageData) {
  const content = message.content;
  if (Array.isArray(content)) {
    const nodes = content.flatMap((part, index) =>
      renderContentBlock(part, `${message.id}:${index}`),
    );
    return nodes.length === 0 ? (
      <span className="text-muted-foreground">
        <UiText>Empty message</UiText>
      </span>
    ) : (
      nodes
    );
  }
  if (typeof content === "string") {
    return renderMarkdownInlineText(content);
  }
  return renderMarkdownInlineText(formatInspectableValue(content));
}

function renderContentBlock(part: unknown, key: string) {
  if (!isRecord(part)) {
    return [];
  }
  if (part.type === "text" && typeof part.text === "string") {
    return [
      <div className="min-w-0 break-words" key={key}>
        {renderMarkdownInlineText(part.text)}
      </div>,
    ];
  }
  if (part.type === "image") {
    const src = readString(part.url) || readString(part.fileId);
    if (!src) {
      return [];
    }
    const imageSrc = markdownImageSrc(src);
    if (imageSrc === undefined) {
      return [
        <div className="break-all text-muted-foreground" key={key}>
          {src}
        </div>,
      ];
    }
    return [
      <img
        alt={readString(part.alt) || "image"}
        className="my-2 max-h-80 max-w-full rounded-lg border border-border object-contain"
        key={key}
        loading="lazy"
        src={imageSrc}
      />,
    ];
  }
  if (part.type === "file") {
    const name = readString(part.name) || readString(part.fileId) || "file";
    return [
      <div className="text-muted-foreground" key={key}>
        {name}
      </div>,
    ];
  }
  return [];
}

export function shouldInlineArtifactContent(artifact: TaskArtifactData): boolean {
  return (
    artifact.content !== null &&
    artifactGroup(artifact) === "report" &&
    artifact.type !== "raw_runner_log" &&
    artifact.type !== "runner_log"
  );
}

function latestTaskRun(runs: readonly TaskRunData[]): TaskRunData | undefined {
  return runs.reduce<TaskRunData | undefined>(
    (latest, run) =>
      latest === undefined || run.runIndex > latest.runIndex ? run : latest,
    undefined,
  );
}

function groupArtifacts(
  artifacts: readonly TaskArtifactData[],
): Record<ArtifactGroup, TaskArtifactData[]> {
  return artifacts.reduce<Record<ArtifactGroup, TaskArtifactData[]>>(
    (groups, artifact) => {
      groups[artifactGroup(artifact)].push(artifact);
      return groups;
    },
    {
      report: [],
      patch: [],
      log: [],
      json: [],
      text: [],
    },
  );
}

function artifactGroup(artifact: TaskArtifactData): ArtifactGroup {
  const type = artifact.type.toLowerCase();
  const name = artifact.name.toLowerCase();
  const mimeType = (artifact.mimeType ?? artifact.mime_type ?? "").toLowerCase();
  if (type.includes("report") || name.endsWith(".md")) {
    return "report";
  }
  if (
    type.includes("patch") ||
    name.endsWith(".patch") ||
    name.endsWith(".diff")
  ) {
    return "patch";
  }
  if (type.includes("log") || name.endsWith(".log")) {
    return "log";
  }
  if (
    type.includes("json") ||
    mimeType.includes("json") ||
    name.endsWith(".json")
  ) {
    return "json";
  }
  return "text";
}

function artifactGroupIcon(group: ArtifactGroup) {
  switch (group) {
    case "patch":
      return FileCode2;
    case "log":
      return ScrollText;
    case "json":
      return FileJson;
    case "report":
    case "text":
    default:
      return FileText;
  }
}

function artifactGroupBadgeClass(group: ArtifactGroup): string {
  switch (group) {
    case "report":
      return "bg-[#5b8a72]/14 text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]";
    case "patch":
      return "bg-[#b07d4f]/14 text-[#b07d4f] dark:bg-[#d1a273]/16 dark:text-[#d1a273]";
    case "log":
    case "json":
      return "bg-[#5c7c99]/14 text-[#5c7c99] dark:bg-[#86a3be]/16 dark:text-[#86a3be]";
    case "text":
    default:
      return "bg-muted text-muted-foreground";
  }
}

function timelineEventDotClass(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("fail") || lower.includes("error")) {
    return "bg-[#b5544a] dark:bg-[#dc7a70]";
  }
  if (lower.includes("wait") || lower.includes("question")) {
    return "bg-[#5c7c99] dark:bg-[#86a3be]";
  }
  if (lower.includes("start") || lower.includes("progress") || lower.includes("run")) {
    return "bg-[#b07d4f] dark:bg-[#d1a273]";
  }
  return "bg-[#5b8a72] dark:bg-[#7fb096]";
}

function formatInspectableValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function runMaterializedPromptText(run: TaskRunData): string | null {
  const materializedPrompt = run.materializedPrompt ?? run.materialized_prompt;
  if (typeof materializedPrompt !== "string" || materializedPrompt.length === 0) {
    return null;
  }
  return materializedPrompt;
}

function renderMarkdownInlineText(text: string) {
  const nodes: ReactNode[] = [];
  let offset = 0;
  const tokenPattern =
    /(!\[([^\]]*)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > offset) {
      nodes.push(text.slice(offset, match.index));
    }
    if (match[1] !== undefined && match[3] !== undefined) {
      const imageSrc = markdownImageSrc(match[3]);
      nodes.push(
        imageSrc === undefined ? (
          match[0]
        ) : (
          <img
            alt={match[2] || "image"}
            className="my-2 max-h-80 max-w-full rounded-lg border border-border object-contain"
            key={`image:${match.index}`}
            loading="lazy"
            src={imageSrc}
          />
        ),
      );
    } else if (match[5] !== undefined) {
      nodes.push(<strong key={`strong:${match.index}`}>{match[5]}</strong>);
    } else if (match[7] !== undefined && match[8] !== undefined) {
      nodes.push(
        <a
          className="font-medium text-primary hover:underline"
          href={match[8]}
          key={`link:${match.index}`}
          rel="noreferrer"
          target="_blank"
        >
          {match[7]}
        </a>,
      );
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) {
    nodes.push(text.slice(offset));
  }
  return nodes.length === 0 ? text : nodes;
}

function markdownImageSrc(src: string): string | undefined {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return src;
  }
  if (src.startsWith("artifact:")) {
    return undefined;
  }
  return src;
}

function toOperationTrace(event: TaskTimelineEventData): Array<{
  operation: string;
  requestId: string;
  status: string;
  artifactIds: string[];
}> {
  const data = parseTimelineData(event.data);
  if (!isRecord(data)) {
    return [];
  }
  const operation = readString(data.operation);
  if (operation.length === 0) {
    return [];
  }
  return [
    {
      operation,
      requestId: readString(data.requestId) || event.id,
      status: readString(data.status) || event.type,
      artifactIds: readStringList(data.artifactIds),
    },
  ];
}

function parseTimelineData(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function subscriptionThreadKey(
  subscription: TaskDetailData["subscriptions"][number],
): string | null {
  return subscription.thread_id ?? subscription.thread_key ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toolProgressLabel(data: Record<string, unknown>): string {
  const status = data.status === "ended" ? "已结束" : data.status === "failed" ? "失败" : data.status === "interrupted" ? "中断，结果未确认" : "运行中";
  const started = typeof data.startedAt === "number" ? `开始 ${formatTaskFullTime(data.startedAt)}` : "开始时间未记录";
  const finished = typeof data.finishedAt === "number" ? ` · 结束 ${formatTaskFullTime(data.finishedAt)}` : "";
  return `${status} · ${started}${finished}`;
}
