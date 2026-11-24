import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { scanArtifactRefs } from "@luna/service-client/artifact-ref";
import { ArtifactRegistry } from "@/artifacts/artifact-registry";
import type { DrizzleDB } from "@/data";
import {
  accessTokens,
  taskReportCommands,
  taskRuns,
  tasks,
  taskSubscriptions,
} from "@/data/schema";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import { CorrelatedRequestService } from "@/messaging/correlated-request-service";
import { InvocationService } from "@/runners/invocation-service";
import { createArtifactAccessPolicy } from "@/server/artifact-access-policy";
import {
  runnerActorUserId,
  type LunaAccessTokenClaims,
} from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import { createLogger } from "@/shared";
import { ArtifactStore } from "@/timeline/artifact-store";
import { TimelineStore } from "@/timeline/timeline-store";
import { TaskInboxStore, type TaskInboxEventRow } from "./task-inbox-store";
import { taskReportForRun } from "./task-report-store";
import { enqueueTaskResult } from "./task-result-outbox";
import { WAITING_FOR_INPUT } from "./types";

const logger = createLogger("task-report-service");

export function formatTaskInboxEventsBlock(
  events: readonly TaskInboxEventRow[],
): string {
  return events
    .map(ev => {
      const header = `[${ev.kind}] from ${ev.source}${ev.correlationId ? ` (correlationId: ${ev.correlationId})` : ""}`;
      return `${header}\n${ev.content}`;
    })
    .join("\n\n---\n\n");
}

export class TaskReportService {
  constructor(
    private readonly db: DrizzleDB,
    private readonly publish: (result: TaskResultForMainRunner) => Promise<void>,
  ) {}

  private active(claims: LunaAccessTokenClaims | undefined) {
    if (
      claims?.source !== "runner" ||
      claims.role !== "runner" ||
      claims.runnerKind !== "task"
    ) {
      throw new GatewayError(
        "task_runner_required",
        "Only a Task Runner can perform this operation",
        403,
      );
    }
    const { invocation, snapshot } = new InvocationService(
      this.db,
    ).requireActive(claims, "task");
    if (snapshot.kind !== "task") {
      throw new GatewayError(
        "task_runner_required",
        "Only a Task Runner can perform this operation",
        403,
      );
    }
    const run = this.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.id, invocation.taskRunId!))
      .get();
    if (!run) {
      throw new GatewayError(
        "run_inactive",
        "Task run is no longer current",
        409,
      );
    }
    const token = this.db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.id, claims.tokenId))
      .get()!;
    return { run, token, claims };
  }

  private consumeUnreadOrThrow(run: typeof taskRuns.$inferSelect): void {
    const contextId = run.runner_context_id ?? run.id;
    const unread = new TaskInboxStore(this.db).consumePending({
      taskId: run.task_id,
      runnerContextId: contextId,
      runId: run.id,
    });
    if (unread.length > 0) {
      throw new GatewayError(
        "unread_updates_pending",
        `New messages arrived from Main while this Task was running. Review and address them before finishing:\n\n${formatTaskInboxEventsBlock(unread)}`,
        409,
      );
    }
  }

  submit(
    claims: LunaAccessTokenClaims | undefined,
    requestId: string,
    content: string,
  ) {
    const scope = this.active(claims);
    if (
      !/^[\w.-]{1,128}$/.test(requestId) ||
      !content.trim() ||
      content.length > 100000
    ) {
      throw new GatewayError(
        "invalid_report",
        "A valid request ID and nonempty report up to 100000 characters are required",
        400,
      );
    }
    const task = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, scope.run.task_id))
      .get();
    if (!task) {
      throw new GatewayError("task_not_found", "Task no longer exists", 404);
    }
    const existing = taskReportForRun(this.db, scope.run.id);
    if (existing) {
      if (
        existing.requestId !== requestId ||
        existing.content !== content ||
        existing.actorUserId !== runnerActorUserId(scope.claims)
      ) {
        throw new GatewayError(
          "report_conflict",
          "This run already has a final report; retry with the same request ID and content",
          409,
        );
      }
      return this.receipt(existing);
    }

    // Deliver any mid-run notes or settled request updates before letting the Task close out.
    this.consumeUnreadOrThrow(scope.run);

    const registry = new ArtifactRegistry(this.db);
    const metadata = scope.token.metadataJson;
    const allowlist = Array.isArray(metadata?.artifactIds)
      ? metadata.artifactIds.filter((id): id is string => typeof id === "string")
      : [];
    const policy = createArtifactAccessPolicy({
      db: this.db,
      accessTokenClaims: scope.claims,
      runArtifactAllowlist: allowlist,
    });
    for (const id of scanArtifactRefs(content)) {
      const artifact = registry.getActive(id);
      if (!artifact || !policy.canReadMetadata(artifact)) {
        throw new GatewayError(
          "artifact_unavailable",
          "Report references an unavailable artifact",
          403,
        );
      }
    }

    const accepted = this.db.transaction(tx => {
      const db = tx as unknown as DrizzleDB;
      const managed = new ArtifactRegistry(db).registerContent({
        scopeType: "task",
        scopeId: task.id,
        relatedUserId: runnerActorUserId(scope.claims),
        producer: "task_runner",
        kind: "report",
        name: "final-report.md",
        mimeType: "text/markdown",
        content: new TextEncoder().encode(content),
      });
      const artifact = new ArtifactStore(db).create({
        taskId: task.id,
        type: "report",
        name: "final-report.md",
        mimeType: "text/markdown",
        content,
        metadata: { managedArtifactId: managed.id, taskRunId: scope.run.id },
      });
      const row = {
        id: randomUUID(),
        taskId: task.id,
        taskRunId: scope.run.id,
        requestId,
        actorUserId: runnerActorUserId(scope.claims),
        content,
        reportArtifactId: artifact.id,
        createdAt: Date.now(),
      };
      db.insert(taskReportCommands).values(row).run();
      db.update(taskRuns)
        .set({ final_report_artifact_id: artifact.id, pause_reason: null })
        .where(eq(taskRuns.id, scope.run.id))
        .run();
      db.update(tasks)
        .set({ block_reason: null, wake_at: null, wake_reason: null })
        .where(eq(tasks.id, task.id))
        .run();
      const result: TaskResultForMainRunner = {
        taskId: task.id,
        taskRunId: scope.run.id,
        runIndex: scope.run.run_index,
        status: "completed",
        title: task.title,
        summary: task.summary ?? "",
        userVisibleReport: content,
        evidenceSummary: [],
        artifactIds: [artifact.id],
        nextActions: [],
      };
      for (const subscription of db
        .select()
        .from(taskSubscriptions)
        .where(eq(taskSubscriptions.task_id, task.id))
        .all()) {
        enqueueTaskResult(db, result, subscription);
      }
      new TimelineStore(db).append({
        taskId: task.id,
        type: "runner.report_submitted",
        summary: "Task submitted its final report to Main",
        data: {
          taskRunId: scope.run.id,
          commandId: row.id,
          finalReportArtifactId: artifact.id,
        },
      });
      return { row, result };
    });

    void this.publish(accepted.result).catch(error =>
      logger.warn(
        { err: error, commandId: accepted.row.id },
        "Task report delivery pending recovery",
      ),
    );
    return this.receipt(accepted.row);
  }

  pause(
    claims: LunaAccessTokenClaims | undefined,
    input: {
      readonly reason: string;
      readonly wakeInMs?: number | undefined;
    },
  ) {
    const scope = this.active(claims);
    const reason = input.reason.trim();
    if (!reason) {
      throw new GatewayError("invalid_pause", "Pause reason is required", 400);
    }
    if (taskReportForRun(this.db, scope.run.id)) {
      throw new GatewayError(
        "report_already_submitted",
        "Cannot pause a run that has already submitted its final report",
        409,
      );
    }
    this.consumeUnreadOrThrow(scope.run);

    const now = Date.now();
    const wakeAt =
      input.wakeInMs && input.wakeInMs > 0 ? now + input.wakeInMs : null;
    this.db.transaction(tx => {
      const db = tx as unknown as DrizzleDB;
      db.update(taskRuns)
        .set({ pause_reason: reason })
        .where(eq(taskRuns.id, scope.run.id))
        .run();
      db.update(tasks)
        .set({
          block_reason: wakeAt ? "waiting_external" : WAITING_FOR_INPUT,
          wake_at: wakeAt,
          wake_reason: reason,
          updated_at: now,
          last_activity_at: now,
        })
        .where(eq(tasks.id, scope.run.task_id))
        .run();
      new TimelineStore(db).append({
        taskId: scope.run.task_id,
        type: "runner.paused",
        summary: reason,
        data: {
          taskRunId: scope.run.id,
          reason,
          ...(wakeAt ? { wakeAt } : {}),
        },
      });
    });

    return {
      commandId: `pause_${scope.run.id}`,
      kind: "task.pause" as const,
      status: "accepted" as const,
      taskId: scope.run.task_id,
      taskRunId: scope.run.id,
      wakeAt,
      result: {
        taskId: scope.run.task_id,
        taskRunId: scope.run.id,
        reason,
        wakeAt,
      },
      error: null,
    };
  }

  hookCheck(
    claims: LunaAccessTokenClaims | undefined,
    phase: "post_tool" | "stop",
  ):
    | { readonly action: "allow" }
    | { readonly action: "inject"; readonly additionalContext: string }
    | { readonly action: "block"; readonly reason: string } {
    const scope = this.active(claims);
    const contextId = scope.run.runner_context_id ?? scope.run.id;
    const unread = new TaskInboxStore(this.db).consumePending({
      taskId: scope.run.task_id,
      runnerContextId: contextId,
      runId: scope.run.id,
    });
    if (unread.length > 0) {
      const formatted = formatTaskInboxEventsBlock(unread);
      if (phase === "post_tool") {
        return {
          action: "inject",
          additionalContext: `<task_events>\n${formatted}\n</task_events>`,
        };
      }
      return {
        action: "block",
        reason: `New messages arrived from Main while you were finishing:\n\n${formatted}\n\nPlease address them before ending this run.`,
      };
    }

    if (phase === "stop") {
      if (taskReportForRun(this.db, scope.run.id)) {
        return { action: "allow" };
      }
      if (scope.run.pause_reason) {
        return { action: "allow" };
      }
      const openReqs = new CorrelatedRequestService(
        this.db,
        () => undefined,
      ).openRequestsFromTask(scope.run.task_id);
      if (openReqs.length > 0) {
        return { action: "allow" };
      }
      return {
        action: "block",
        reason:
          "Before ending this Task Run, either submit your final report via `luna tasks report --stdin` (when the task is complete) or suspend cleanly via `luna tasks pause [--wake-in <duration>] --reason '...'` / `luna ask --to main --text '...'` (when waiting on answers or external work).",
      };
    }

    return { action: "allow" };
  }

  get(claims: LunaAccessTokenClaims | undefined, id: string) {
    const scope = this.active(claims);
    const report = taskReportForRun(this.db, scope.run.id);
    if (
      !report ||
      report.id !== id ||
      report.actorUserId !== runnerActorUserId(scope.claims)
    ) {
      throw new GatewayError("report_not_found", "Report not found", 404);
    }
    return this.receipt(report);
  }

  private receipt(row: typeof taskReportCommands.$inferSelect) {
    return {
      commandId: row.id,
      kind: "task.report" as const,
      status: "accepted" as const,
      result: {
        taskId: row.taskId,
        taskRunId: row.taskRunId,
        reportArtifactId: row.reportArtifactId,
      },
      taskId: row.taskId,
      taskRunId: row.taskRunId,
      reportArtifactId: row.reportArtifactId,
      error: null,
    };
  }
}
