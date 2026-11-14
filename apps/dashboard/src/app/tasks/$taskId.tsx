import { useAgentBasePath } from "@/lib/agent-route";
import { DeleteRecordButton } from "@/components/delete-record-button";
import { useTranslation } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useTask,
  useTaskArtifacts,
  useTaskRuns,
  useTaskTimeline,
} from "@/lib/api";
import type { DashboardTaskArtifact } from "@/lib/api";

import { TaskDetailView } from "./task-detail-view";

export const Route = createFileRoute("/$agentId/tasks/$taskId")({
  component: TaskDetailPage,
});

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

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Button variant="ghost" size="sm" asChild>
          <a href={`${base}/tasks`}>
            <ArrowLeft className="size-4" />{t("Tasks")}</a>
        </Button>
        {taskDetail ? <DeleteRecordButton kind="tasks" id={taskId} path={`/tasks/${encodeURIComponent(taskId)}?agentId=${encodeURIComponent(agentId)}`} name={taskDetail.title} onDeleted={() => { window.location.assign(`${base}/tasks`); }} /> : null}
      </div>
      <TaskDetailView
        taskDetail={taskDetail}
        runs={runs}
        timeline={timeline}
        artifacts={displayArtifacts}
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
