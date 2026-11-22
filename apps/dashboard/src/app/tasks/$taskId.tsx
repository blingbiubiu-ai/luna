import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, TerminalSquareIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { CopyTextButton } from "@/components/copy-text-button";
import { DeleteRecordButton } from "@/components/delete-record-button";
import { useAgentBasePath } from "@/lib/agent-route";
import {
  useTask,
  useTaskArtifacts,
  useTaskRuns,
  useTaskTimeline,
  type DashboardTaskArtifact,
} from "@/lib/api";
import { appHistory } from "@/lib/app-history";
import { useTranslation } from "@/lib/i18n";

import { TaskDetailView } from "./task-detail-view";

export const Route = createFileRoute("/$agentId/tasks/$taskId")({
  component: TaskDetailPage,
});

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

function TaskDetailPage() {
  const { t } = useTranslation();
  const { agentId, taskId } = Route.useParams();
  const base = useAgentBasePath();
  const {
    data: taskDetail,
    error: taskError,
    isError: taskIsError,
    isLoading: taskLoading,
  } = useTask(taskId, agentId);
  const {
    data: timeline,
    error: timelineError,
    isError: timelineIsError,
    isLoading: timelineLoading,
  } = useTaskTimeline(taskId, agentId);
  const {
    data: artifacts,
    error: artifactsError,
    isError: artifactsIsError,
    isLoading: artifactsLoading,
  } = useTaskArtifacts(taskId, agentId);
  const {
    data: runs,
    error: runsError,
    isError: runsIsError,
    isLoading: runsLoading,
  } = useTaskRuns(taskId, agentId);
  const displayArtifacts = artifacts?.map(formatTaskArtifactForDisplay);
  const tasksHref = `${base}/tasks`;
  const tuiHref = `${base}/terminals?taskId=${encodeURIComponent(taskId)}`;

  const backSlot = (
    <a
      href={tasksHref}
      onClick={(event) => navigateClient(event, tasksHref)}
      className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
    >
      <ArrowLeft className="size-3.5" />
      <span>{t("Back to tasks")}</span>
    </a>
  );

  const actionsSlot = taskDetail ? (
    <>
      <CopyTextButton
        className="h-7 max-w-44 truncate rounded-[7px] border border-border bg-background px-2.5 font-mono text-xs text-muted-foreground hover:text-foreground"
        label={t("Copy task ID")}
        text={taskId}
      >
        {taskId.length > 20 ? `${taskId.slice(0, 18)}…` : taskId}
      </CopyTextButton>
      <a
        href={tuiHref}
        onClick={(event) => navigateClient(event, tuiHref)}
        className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:no-underline"
      >
        <TerminalSquareIcon className="size-3.5" />
        <span>{t("Open TUI")}</span>
      </a>
      <DeleteRecordButton
        kind="tasks"
        id={taskId}
        path={`/tasks/${encodeURIComponent(taskId)}?agentId=${encodeURIComponent(agentId)}`}
        name={taskDetail.title}
        onDeleted={() => {
          appHistory.push(tasksHref);
        }}
      />
    </>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden border-t border-border bg-background">
      <TaskDetailView
        taskDetail={taskDetail}
        runs={runs}
        timeline={timeline}
        artifacts={displayArtifacts}
        backSlot={backSlot}
        actionsSlot={actionsSlot}
        loading={{
          taskDetail: taskLoading,
          runs: runsLoading,
          timeline: timelineLoading,
          artifacts: artifactsLoading,
        }}
        errors={{
          taskDetail: taskIsError ? taskError : undefined,
          runs: runsIsError ? runsError : undefined,
          timeline: timelineIsError ? timelineError : undefined,
          artifacts: artifactsIsError ? artifactsError : undefined,
        }}
      />
    </div>
  );
}

function formatTaskArtifactForDisplay(
  artifact: DashboardTaskArtifact,
): DashboardTaskArtifact {
  if (artifact.name !== "diff.patch" || artifact.type !== "diff_patch") {
    return artifact;
  }

  const metadata = artifact.metadata;
  if (!isRecord(metadata)) {
    return artifact;
  }

  const additions = formatCount(metadata.additions, "+");
  const deletions = formatCount(metadata.deletions, "-");
  const filesChanged = formatFilesChanged(metadata.filesChanged);
  const summary = [filesChanged, additions, deletions].filter(Boolean).join(", ");
  if (summary.length === 0) {
    return artifact;
  }

  return {
    ...artifact,
    name: `${artifact.name} (${summary})`,
  };
}

function formatCount(value: unknown, prefix: "+" | "-"): string | null {
  return typeof value === "number" ? `${prefix}${value}` : null;
}

function formatFilesChanged(value: unknown): string | null {
  if (typeof value !== "number") {
    return null;
  }
  return `${value} ${value === 1 ? "file" : "files"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
