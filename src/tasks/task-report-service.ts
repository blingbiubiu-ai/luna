import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { accessTokens, taskReportCommands, taskRuns, tasks, taskSubscriptions } from "@/data/schema";
import { ArtifactRegistry } from "@/artifacts/artifact-registry";
import { scanArtifactRefs } from "@luna/service-client/artifact-ref";
import { ArtifactStore } from "@/timeline/artifact-store";
import { TimelineStore } from "@/timeline/timeline-store";
import { createArtifactAccessPolicy } from "@/server/artifact-access-policy";
import { runnerActorUserId, type LunaAccessTokenClaims } from "@/server/auth/access-token-service";
import { GatewayError } from "@/server/gateway-error";
import type { TaskResultForMainRunner } from "@/main-runner/types";
import { createLogger } from "@/shared";
import { InvocationService } from "@/runners/invocation-service";
import { taskReportForRun } from "./task-report-store";
import { enqueueTaskResult } from "./task-result-outbox";

const logger = createLogger("task-report-service");
export class TaskReportService {
  constructor(private readonly db: DrizzleDB, private readonly publish: (result: TaskResultForMainRunner) => Promise<void>) {}

  private active(claims: LunaAccessTokenClaims | undefined) {
    if (claims?.source !== "runner" || claims.role !== "runner" || claims.runnerKind !== "task")
      throw new GatewayError("task_runner_required", "Only a Task Runner can report", 403);
    // requireActive is the single authority check: token liveness, invocation
    // scope, current running Task Run with matching context, and active actor.
    const { invocation, snapshot } = new InvocationService(this.db).requireActive(claims, "task");
    if (snapshot.kind !== "task") throw new GatewayError("task_runner_required", "Only a Task Runner can report", 403);
    const run = this.db.select().from(taskRuns).where(eq(taskRuns.id, invocation.taskRunId!)).get();
    if (!run) throw new GatewayError("run_inactive", "Task run is no longer current", 409);
    const token = this.db.select().from(accessTokens).where(eq(accessTokens.id, claims.tokenId)).get()!;
    return {run, token, claims};
  }

  submit(claims: LunaAccessTokenClaims | undefined, requestId: string, content: string) {
    const scope = this.active(claims);
    if (!/^[\w.-]{1,128}$/.test(requestId) || !content.trim() || content.length > 100000)
      throw new GatewayError("invalid_report", "A valid request ID and nonempty report up to 100000 characters are required", 400);
    const existing = taskReportForRun(this.db, scope.run.id);
    if (existing) {
      if (existing.requestId !== requestId || existing.content !== content || existing.actorUserId !== runnerActorUserId(scope.claims))
        throw new GatewayError("report_conflict", "This run already has a final report; retry with the same request ID and content", 409);
      return this.receipt(existing);
    }
    const task = this.db.select().from(tasks).where(eq(tasks.id, scope.run.task_id)).get();
    if (!task) throw new GatewayError("task_not_found", "Task no longer exists", 404);
    const registry = new ArtifactRegistry(this.db);
    const metadata = scope.token.metadataJson;
    const allowlist = Array.isArray(metadata?.artifactIds) ? metadata.artifactIds.filter((id): id is string => typeof id === "string") : [];
    const policy = createArtifactAccessPolicy({db:this.db,accessTokenClaims: scope.claims, runArtifactAllowlist: allowlist});
    for (const id of scanArtifactRefs(content)) {
      const artifact = registry.getActive(id);
      if (!artifact || !policy.canReadMetadata(artifact)) throw new GatewayError("artifact_unavailable", "Report references an unavailable artifact", 403);
    }
    const accepted = this.db.transaction(tx => {
      const db = tx as unknown as DrizzleDB;
      const managed = new ArtifactRegistry(db).registerContent({scopeType: "task", scopeId: task.id,
        relatedUserId: runnerActorUserId(scope.claims), producer: "task_runner", kind: "report", name: "final-report.md",
        mimeType: "text/markdown", content: new TextEncoder().encode(content)});
      const artifact = new ArtifactStore(db).create({taskId: task.id, type: "report", name: "final-report.md",
        mimeType: "text/markdown", content, metadata: {managedArtifactId: managed.id, taskRunId: scope.run.id}});
      const row = {id: randomUUID(), taskId: task.id, taskRunId: scope.run.id, requestId,
        actorUserId: runnerActorUserId(scope.claims), content, reportArtifactId: artifact.id, createdAt: Date.now()};
      db.insert(taskReportCommands).values(row).run();
      db.update(taskRuns).set({final_report_artifact_id: artifact.id}).where(eq(taskRuns.id, scope.run.id)).run();
      const result: TaskResultForMainRunner = {taskId: task.id, taskRunId: scope.run.id, runIndex: scope.run.run_index,
        status: "completed", title: task.title, summary: task.summary ?? "", userVisibleReport: content,
        evidenceSummary: [], artifactIds: [artifact.id], nextActions: []};
      for (const subscription of db.select().from(taskSubscriptions).where(eq(taskSubscriptions.task_id, task.id)).all())
        enqueueTaskResult(db, result, subscription);
      new TimelineStore(db).append({taskId: task.id, type: "runner.report_submitted", summary: "Task submitted its final report to Main",
        data: {taskRunId: scope.run.id, commandId: row.id, finalReportArtifactId: artifact.id}});
      return {row, result};
    });
    // The outbox is committed before acknowledgement. Main may run while Task is
    // still returning its sentinel. Failure leaves durable triggers for recovery.
    void this.publish(accepted.result).catch(error => logger.warn({err: error, commandId: accepted.row.id}, "Task report delivery pending recovery"));
    return this.receipt(accepted.row);
  }

  get(claims: LunaAccessTokenClaims | undefined, id: string) {
    const scope = this.active(claims);
    const report = taskReportForRun(this.db, scope.run.id);
    if (!report || report.id !== id || report.actorUserId !== runnerActorUserId(scope.claims))
      throw new GatewayError("report_not_found", "Report not found", 404);
    return this.receipt(report);
  }

  private receipt(row: typeof taskReportCommands.$inferSelect) {
    return {commandId: row.id, status: "accepted", taskId: row.taskId, taskRunId: row.taskRunId, reportArtifactId: row.reportArtifactId};
  }
}
