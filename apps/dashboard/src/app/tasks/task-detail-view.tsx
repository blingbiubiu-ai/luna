import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { CircleDot } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";

import {
  ContextPackList,
  RunContextSummaryInline,
  RunContextSummaryList,
  SeedRecordList,
} from "@/components/context-pack-list";
import { CopyTextButton } from "@/components/copy-text-button";
import { IdentityLink } from "@/components/identity-link";
import type { DashboardIdentity } from "@/components/identity-link";
import { InspectableText } from "@/components/inspectable-text";
import type { DashboardCanonicalUser, DashboardContextPack, DashboardRunnerContextSeedRecord, DashboardTaskRunContextSummary } from "@/lib/api";

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
}

const tabs = ["Runs", "Timeline", "Report", "Artifacts", "Context"] as const;
type TaskDetailTab = (typeof tabs)[number];
const artifactGroupOrder = ["report", "patch", "log", "json", "text"] as const;
type ArtifactGroup = (typeof artifactGroupOrder)[number];

export function TaskDetailView({
  taskDetail,
  runs,
  timeline,
  artifacts,
  loading,
  errors,
}: TaskDetailViewProps) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("Timeline");
  const displayRuns = runs ?? taskDetail?.runs ?? [];
  const displayTimeline = timeline ?? taskDetail?.timeline ?? [];
  const displayArtifacts = artifacts ?? taskDetail?.artifacts ?? [];
  const latestRun = latestTaskRun(displayRuns);
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
  const taskContext = taskContextView(taskDetail?.taskContext);
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
        className="flex h-full flex-1 flex-col"
        data-testid="task-detail"
      >
        <DashboardErrorState
          title={t("Task failed to load")}
          error={errors.taskDetail}
        />
      </article>
    );
  }

  return (
    <article className="flex h-full flex-1 flex-col" data-testid="task-detail">
      <header className="border-b px-4 py-3" data-testid="task-header">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1
              className="truncate text-sm font-semibold"
              title={taskDetail?.title ?? "Loading task"}
            >
              {taskDetail?.title ?? "Loading task"}
            </h1>
            <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
              <span>{taskDetail?.id ?? "task"}</span>
              <span>{taskDetail?.status ?? "loading"}</span>
              <span>{taskDetail?.type ?? "type"}</span>
              {taskDetail?.priority ? <span><UiText>{taskDetail.priority}</UiText></span> : null}
              {taskDetail?.severity ? <span>{taskDetail.severity}</span> : null}
            </div>
            {taskDetail ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">{t("Creator")}{" "}
                  <IdentityLink
                    className="text-xs"
                    identity={identityForCanonicalUser(taskDetail.creatorUser)}
                    showKind={false}
                  />
                </span>
                <span className="inline-flex flex-wrap items-center gap-1">{t("Participants")}{taskDetail.participants.length === 0 ? (
                    <span>-</span>
                  ) : (
                    taskDetail.participants.map((participant) => (
                      <span
                        className="inline-flex items-center gap-1"
                        key={`${participant.userId}:${participant.role}`}
                      >
                        <span><UiText>{participant.role}</UiText></span>
                        <IdentityLink
                          className="text-xs"
                          fallbackKind={
                            participant.role === "agent" ? "bot" : "user"
                          }
                          identity={identityForCanonicalUser(participant.user)}
                          showKind={false}
                        />
                      </span>
                    ))
                  )}
                </span>
              </div>
            ) : null}
            {operationTraces.length > 0 ? (
              <section
                className="mt-3 grid gap-2 rounded-md border bg-muted/20 p-3 text-xs"
                data-testid="task-operation-trace"
              >
                <h2 className="text-sm font-medium">{t("Operation Trace")}</h2>
                {operationTraces.map((trace) => (
                  <div
                    className="grid gap-1 sm:grid-cols-[14rem_1fr]"
                    key={`${trace.requestId}:${trace.operation}`}
                  >
                    <div className="font-mono text-muted-foreground">
                      {trace.requestId}
                    </div>
                    <div className="min-w-0">
                      <div className="break-all font-mono">
                        {trace.operation}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-muted-foreground">
                        <span><UiText>{trace.status}</UiText></span>
                        {trace.artifactIds.map((artifactId) => (
                          <a
                            className="text-primary hover:underline"
                            href={`#artifact-${artifactId}`}
                            key={artifactId}
                          >
                            {artifactId}
                          </a>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
          </div>
          <div className="text-right text-xs text-muted-foreground">{t("Last activity")}{" "}
            {taskDetail ? formatTime(taskDetail.last_activity_at) : "-"}
          </div>
        </div>
      </header>

      <nav
        aria-label={t("Task detail sections")}
        className="flex gap-2 border-b px-4 py-2 text-sm"
        role="tablist"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            aria-controls={tab.toLowerCase()}
            aria-selected={activeTab === tab}
            className="rounded-md px-2 py-1 text-left hover:bg-accent aria-selected:bg-accent aria-selected:text-accent-foreground"
            onClick={() => setActiveTab(tab)}
            role="tab"
            type="button"
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {activeTab === "Runs" ? (
          <section
            id="runs"
            className="mb-6"
            data-testid="task-runs"
            role="tabpanel"
          >
            <h2 className="mb-2 text-sm font-semibold">{t("Runs")}</h2>
            {loading.runs ? (
              <p>{t("Loading runs")}</p>
            ) : errors?.runs ? (
              <DashboardErrorState
                title={t("Runs failed to load")}
                error={errors.runs}
              />
            ) : (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr>
                    <th className="w-16 text-left">{t("Run")}</th>
                    <th className="w-28 text-left">{t("Status")}</th>
                    <th className="w-28 text-left">{t("Reason")}</th>
                    <th className="w-36 text-left">{t("Runner")}</th>
                    <th className="w-36 text-left">{t("Started")}</th>
                    <th className="w-36 text-left">{t("Finished")}</th>
                    <th className="text-left">{t("Input")}</th>
                    <th className="w-40 text-left">{t("Report")}</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRuns.map((run) => (
                    <tr key={run.id}>
                      <td className="align-top">#{run.runIndex}</td>
                      <td className="align-top"><UiText>{run.status}</UiText></td>
                      <td className="align-top">{run.reason}</td>
                      <td className="align-top">{run.runnerType}</td>
                      <td className="align-top text-xs text-muted-foreground">
                        {formatTime(run.startedAt)}
                      </td>
                      <td className="align-top text-xs text-muted-foreground">
                        {run.finishedAt ? formatTime(run.finishedAt) : "-"}
                      </td>
                      <td
                        className="whitespace-normal break-words align-top font-mono text-xs"
                        data-testid={`task-run-input-${run.id}`}
                      >
                        {runMaterializedPromptText(run) ? (
                          <div className="mb-2 font-sans">
                            <CopyTextButton
                              className="h-6 px-2 text-xs"
                              label={`Copy LLM prompt for run #${run.runIndex}`}
                              text={runMaterializedPromptText(run) ?? ""}
                            >{t("Copy LLM prompt")}</CopyTextButton>
                          </div>
                        ) : null}
                        <InspectableText
                          label={t("Input")}
                          previewLength={180}
                          previewClassName="font-mono"
                          text={formatInspectableValue(run.inputSnapshot)}
                        />
                        <RunContextSummaryInline run={run} />
                        {run.cancelReason ? (
                          <div className="mt-1 text-muted-foreground">{t("Cancelled:")}{" "}{run.cancelReason}
                          </div>
                        ) : null}
                        {run.error ? (
                          <div className="mt-1 text-destructive">{t("Error:")}{" "}{run.error}
                          </div>
                        ) : null}
                      </td>
                      <td className="align-top">
                        {run.finalReportArtifactId ? (
                          <a
                            className="text-primary hover:underline"
                            href={`#artifact-${run.finalReportArtifactId}`}
                          >
                            {run.finalReportArtifactId}
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ) : null}

        {activeTab === "Timeline" ? (
          <section
            id="timeline"
            className="mb-6"
            data-testid="task-timeline"
            role="tabpanel"
          >
            <h2 className="mb-2 text-sm font-semibold">{t("Timeline")}</h2>
            {loading.timeline ? (
              <p>{t("Loading timeline")}</p>
            ) : errors?.timeline ? (
              <DashboardErrorState
                title={t("Timeline failed to load")}
                error={errors.timeline}
              />
            ) : (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr>
                    <th className="w-10 text-left">{t("Icon")}</th>
                    <th className="w-36 text-left">{t("Time")}</th>
                    <th className="w-40 text-left">{t("Type")}</th>
                    <th className="w-20 text-left">{t("Run")}</th>
                    <th className="text-left">{t("Summary")}</th>
                    <th className="w-40 text-left">{t("Actor")}</th>
                    <th className="w-24 text-left">{t("Visibility")}</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTimeline.map((event) => (
                    <tr key={event.id}>
                      <td className="align-top text-muted-foreground">
                        <CircleDot className="size-4" aria-hidden="true" />
                      </td>
                      <td className="align-top text-xs text-muted-foreground">
                        {formatTime(event.created_at)}
                      </td>
                      <td className="align-top">{event.type}</td>
                      <td className="align-top">
                        {event.runIndex ? `#${event.runIndex}` : "-"}
                      </td>
                      <td
                        className="whitespace-normal break-words align-top"
                        data-testid={`task-timeline-summary-${event.id}`}
                      >
                        <InspectableText
                          label={t("Summary")}
                          previewLength={180}
                          text={event.summary}
                        />
                      </td>
                      <td className="align-top text-xs text-muted-foreground">
                        <IdentityLink
                          className="max-w-36 text-xs"
                          fallbackKind="user"
                          identity={identityForCanonicalUser(event.actorUser)}
                        />
                      </td>
                      <td className="align-top">{event.visibility}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ) : null}

        {activeTab === "Report" ? (
          <section
            id="report"
            className="mb-6"
            data-testid="task-report"
            role="tabpanel"
          >
            <h2 className="mb-2 text-sm font-semibold">{t("Report")}</h2>
            <p className="mb-4 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
              {taskDetail?.summary ?? "No report summary is available."}
            </p>
            {reportArtifacts.map((artifact) => (
              <div key={artifact.id} className="space-y-2">
                <h3 className="text-sm font-medium">{artifact.name}</h3>
                <div
                  className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm leading-6"
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
            className="mb-6"
            data-testid="task-artifacts"
            role="tabpanel"
          >
            <h2 className="mb-2 text-sm font-semibold">{t("Artifacts")}</h2>
            {loading.artifacts ? (
              <p>{t("Loading artifacts")}</p>
            ) : errors?.artifacts ? (
              <DashboardErrorState
                title={t("Artifacts failed to load")}
                error={errors.artifacts}
              />
            ) : (
              <div className="space-y-5">
                {artifactGroupOrder.map((group) => {
                  const groupArtifacts = groupedArtifacts[group];
                  if (groupArtifacts.length === 0) {
                    return null;
                  }
                  return (
                    <section key={group}>
                      <h3 className="mb-2 text-xs font-semibold uppertask text-muted-foreground">
                        {group}
                      </h3>
                      <table className="w-full table-fixed text-sm">
                        <thead>
                          <tr>
                            <th className="text-left">{t("Name")}</th>
                            <th className="w-40 text-left">{t("Type")}</th>
                            <th className="w-36 text-left">{t("Status")}</th>
                            <th className="w-48 text-left">{t("Link")}</th>
                            <th className="w-36 text-left">{t("Created")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupArtifacts.map((artifact) => {
                            const artifactHref = artifact.href;
                            return (
                              <tr key={artifact.id}>
                                <td className="whitespace-normal break-words">
                                  {artifact.name}
                                </td>
                                <td>{artifact.type}</td>
                                <td>{artifact.status ?? "active"}</td>
                                <td>
                                  {artifactHref ? (
                                    <a
                                      className="text-primary hover:underline"
                                      data-testid="task-artifact-link"
                                      href={artifactHref}
                                    >
                                      {artifact.name}
                                    </a>
                                  ) : (
                                    "-"
                                  )}
                                </td>
                                <td className="text-xs text-muted-foreground">
                                  {formatTime(artifact.created_at)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
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
            className="space-y-6"
            data-testid="task-context"
            role="tabpanel"
          >
            <h2 className="text-sm font-semibold">{t("Context")}</h2>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Participants")}</h3>
              <div className="grid gap-2 text-sm">
                {(taskDetail?.participants ?? []).map((participant) => (
                  <div
                    className="grid gap-1 rounded-md border bg-muted/20 p-3 sm:grid-cols-[8rem_1fr]"
                    key={`${participant.userId}:${participant.role}`}
                  >
                    <div className="text-muted-foreground">
                      <UiText>{participant.role}</UiText>
                    </div>
                    <IdentityLink
                      fallbackKind={
                        participant.role === "agent" ? "bot" : "user"
                      }
                      identity={identityForCanonicalUser(participant.user)}
                      showKind
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Linked Sessions")}</h3>
              <div className="grid gap-2 text-sm">
                {linkedSessionDetails.map((session) => (
                  <div
                    className="rounded-md border bg-muted/20 p-3"
                    key={session.id}
                  >
                    <a
                      className="font-medium text-primary hover:underline"
                      href={`${base}/sessions/${session.id}`}
                    >
                      {session.displayTitle ??
                        session.title ??
                        "Untitled session"}
                    </a>
                    <div className="mt-2 flex flex-wrap gap-1 text-xs">
                      {sourceSessionIds.has(session.id) ? (
                        <span className="rounded-[4px] border bg-background px-1.5 py-0.5 text-muted-foreground">{t("Source session")}</span>
                      ) : null}
                      {notificationSessionIds.has(session.id) ? (
                        <span className="rounded-[4px] border bg-background px-1.5 py-0.5 text-muted-foreground">{t("Notification thread")}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{session.channel_type}</span>
                      <span>{session.channel_id}</span>
                      {session.group_id ? (
                        <span>{t("Group")}{" "}{session.group_id}</span>
                      ) : null}
                      {session.thread_id ? (
                        <span>{t("Thread")}{" "}{session.thread_id}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Task Context")}</h3>
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                {taskContext.latestUserMessage ? (
                  <ContextField
                    label={t("Latest user message")}
                    value={taskContext.latestUserMessage}
                  />
                ) : null}
                <ContextList label={t("Known facts")} values={taskContext.knownFacts} />
                <ContextList label={t("Assumptions")} values={taskContext.assumptions} />
                <ContextList
                  label={t("Pending questions")}
                  values={taskContext.pendingQuestions}
                />
                {!taskContext.hasContent ? (
                  <div className="text-sm text-muted-foreground">{t("No task-level context was recorded.")}</div>
                ) : null}
              </div>
            </section>

            <ContextPackList packs={taskDetail?.contextPacks ?? []} />

            <SeedRecordList records={taskDetail?.seedRecords ?? []} />

            <RunContextSummaryList
              summaries={taskDetail?.runContextSummaries ?? []}
            />

            {taskDetail ? <WorkSessionSummary task={taskDetail} /> : null}

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Source Messages")}</h3>
              <div className="grid gap-2 text-sm">
                {sourceMessages.length === 0 ? (
                  <div className="rounded-md border bg-muted/20 p-3 text-muted-foreground">{t("No source messages recorded.")}</div>
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

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Source Turn Context")}</h3>
              <div className="grid gap-2 text-sm">
                {sourceTurnMessages.length === 0 ? (
                  <div className="rounded-md border bg-muted/20 p-3 text-muted-foreground">{t("No source turn context recorded.")}</div>
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

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Notifications")}</h3>
              <div className="grid gap-2 text-sm">
                {(taskDetail?.subscriptions ?? []).map((subscription) => (
                  <div
                    className="rounded-md border bg-muted/20 p-3"
                    key={subscription.id}
                  >
                    <div className="font-medium">
                      {subscription.visibility}{t("updates")}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{subscription.channel_type}</span>
                      <span>{subscription.channel_id}</span>
                      {subscription.group_id ? (
                        <span>{t("Group")}{" "}{subscription.group_id}</span>
                      ) : null}
                      {subscriptionThreadKey(subscription) ? (
                        <span>{t("Thread")}{" "}{subscriptionThreadKey(subscription)}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

          </section>
        ) : null}
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
    <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        <UiText>{errorMessage(error)}</UiText>
      </p>
    </div>
  );
}

function WorkSessionSummary({ task }: { task: TaskDetailData }) {
  const { t } = useTranslation();
  const session = task.workSession;
  if (!session) return null;
  return <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Work session")}</h3>
    <div className="rounded-md border bg-muted/20 p-3 text-sm">
      <ContextField label={t("Work session")} value={`${session.displayTitle ?? session.title ?? session.id} (${session.id})`} />
    </div>
  </section>;
}

function ContextField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid gap-1 border-b py-2 last:border-b-0 sm:grid-cols-[10rem_1fr]">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 break-words">{renderMarkdownInlineText(value)}</div>
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
    <div className="grid gap-1 border-b py-2 last:border-b-0 sm:grid-cols-[10rem_1fr]">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <ul className="min-w-0 space-y-1">
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
      className="rounded-md border bg-muted/20 p-3"
      data-testid={`task-context-message-${message.id}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-[4px] border bg-background px-1.5 py-0.5">
          {label}
        </span>
        <IdentityLink
          className="text-xs"
          fallbackKind={message.role === "assistant" ? "bot" : "user"}
          identity={identityForCanonicalUser(message.senderUser)}
          showKind={false}
        />
        <span>{formatTime(message.createdAt ?? message.created_at)}</span>
        {message.entryKind !== "message" ? <span>{message.entryKind}</span> : null}
      </div>
      <div className="min-w-0 break-words leading-6">
        {renderTaskContextMessageContent(message)}
      </div>
    </div>
  );
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

function renderTaskContextMessageContent(message: TaskContextMessageData) {
  const content = message.content;
  if (Array.isArray(content)) {
    const nodes = content.flatMap((part, index) =>
      renderContentBlock(part, `${message.id}:${index}`),
    );
    return nodes.length === 0 ? (
      <span className="text-muted-foreground"><UiText>Empty message</UiText></span>
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
        className="my-2 max-h-80 max-w-full rounded-[4px] border border-border object-contain"
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

function taskContextView(value: unknown): {
  latestUserMessage: string;
  knownFacts: string[];
  assumptions: string[];
  pendingQuestions: string[];
  hasContent: boolean;
} {
  const record = isRecord(value) ? value : {};
  const latestUserMessage = readString(record.latestUserMessage);
  const knownFacts = readStringList(record.knownFacts);
  const assumptions = readStringList(record.assumptions);
  const pendingQuestions = readStringList(record.pendingQuestions);
  return {
    latestUserMessage,
    knownFacts,
    assumptions,
    pendingQuestions,
    hasContent:
      latestUserMessage.length > 0 ||
      knownFacts.length > 0 ||
      assumptions.length > 0 ||
      pendingQuestions.length > 0,
  };
}

function renderMarkdownInlineText(text: string) {
  const nodes: ReactNode[] = [];
  let offset = 0;
  const tokenPattern = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
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
        imageSrc === undefined
          ? match[0]
          : (
              <img
                alt={match[2] || "image"}
                className="my-2 max-h-80 max-w-full rounded-[4px] border border-border object-contain"
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

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subscriptionThreadKey(
  subscription: TaskDetailData["subscriptions"][number],
): string | null {
  return subscription.thread_id ?? subscription.thread_key ?? null;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
