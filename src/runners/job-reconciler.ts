import {AgentError} from "@/agents/agent-store";
import { setTimeout as delay } from "node:timers/promises";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessionCommands, sessionInbox, sessionTriggers, sessionTurns, taskRuns, tasks } from "@/data/schema";
import { GatewayError } from "@/server/gateway-error";
import { sessionDispatcherFor } from "@/sessions/session-dispatcher";
import type { ExecutionRuntime } from "@/runtime/execution-runtime";
import { ExecutionError } from "@luna/execution-store";
import { InvocationService } from "./invocation-service";
import { InvocationStore, type InvocationRecord } from "./invocation-store";
import { decodeInvocation } from "./invocation-codec";
import { taskReportForRun } from "@/tasks/task-report-store";
import { TaskRunStore } from "@/tasks/task-run-store";
import { TimelineStore } from "@/timeline/timeline-store";

/** Startup cancellation owns its original session lane until Runtime confirms termination. */
export class JobReconciler {
  private readonly authority: InvocationService;
  private readonly store: InvocationStore;
  constructor(private readonly db: DrizzleDB, private readonly runtime: ExecutionRuntime, private readonly detach: AbortSignal) {
    this.authority = new InvocationService(db); this.store = this.authority.store;
  }
  async recover(): Promise<void> {
    // Validate before normal recovery can attach any invalid invocation.
    for (const invocation of this.store.pending()) {
      if (invocation.state !== "active") continue;
      try { this.authority.requireScope(invocation.id); }
      catch (error) {
        if (!(error instanceof GatewayError) && !(error instanceof AgentError)) throw error;
        this.authority.revoke(invocation.id, error.code);
      }
    }
    const recoveries = this.store.pending().filter(item => item.state === "revoked").map(invocation => {
      const recover = () => this.cancelAndSettle(invocation);
      return invocation.sessionId && invocation.runnerKind !== "task"
        ? sessionDispatcherFor(this.db).dispatch({ kind: "session_trigger", sessionId: invocation.sessionId }, recover)
        : recover();
    });
    // Even one failed recovery must not leave other database users untracked at shutdown.
    const results = await Promise.allSettled(recoveries);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Runtime cancellation recovery remains pending");
  }
  private async cancelAndSettle(invocation: InvocationRecord): Promise<void> {
    for (const original of this.store.jobsFor(invocation.id)) {
      while (!this.detach.aborted) {
        const job = this.store.job(original.id)!;
        if (["terminal", "settled"].includes(job.state)) break;
        try {
          // Atomic registration/cancellation also works during drain and never
          // exposes an unsubmitted intent to dispatch between two HTTP calls.
          await this.runtime.cancelIntent(job.request, this.detach);
          for await (const event of this.runtime.events(job.id, job.cursor, this.detach)) this.store.consume(event, () => {});
          if (!this.detach.aborted && !["terminal", "settled"].includes(this.store.job(job.id)!.state)) throw new Error("Cancellation stream ended without a terminal event");
        } catch (error) {
          if (this.detach.aborted) return;
          if (error instanceof ExecutionError && error.status < 500 && error.status !== 429) throw error;
          await delay(1000, undefined, { signal: this.detach }).catch(() => {});
        }
      }
      if (this.detach.aborted) return;
    }
    if (this.detach.aborted) return;
    this.store.finish(invocation.id, () => this.completeCancelledBusiness(invocation));
  }
  private completeCancelledBusiness(invocation: InvocationRecord): void {
    const now = Date.now(); const reason = invocation.revokeReason ?? "Invocation cancelled";
    const snapshot = decodeInvocation(invocation.inputSnapshot);
    if (snapshot.kind === "task") {
      const run = this.db.select().from(taskRuns).where(eq(taskRuns.id, snapshot.input.taskRunId)).get();
      if (run?.status !== "running") return;
      // A submitted report finished the work: TaskRunSupervisor completes the run with it once settled.
      if (taskReportForRun(this.db, run.id)) return;
      // Same guarded terminal transition and timeline event as TaskRunSupervisor;
      // the supervisor closes the status card when it observes this cancellation.
      const cancelled = new TaskRunStore(this.db).markCancelled(run.id, { cancelReason: reason, finishedAt: now });
      new TimelineStore(this.db).append({ taskId: run.task_id, type: "runner.cancelled", summary: reason,
        data: { taskRunId: cancelled.id, runIndex: cancelled.runIndex, runReason: cancelled.reason, runnerType: cancelled.runnerType, cancelReason: reason } });
      const latest = this.db.select().from(taskRuns).where(eq(taskRuns.task_id, run.task_id)).orderBy(desc(taskRuns.run_index)).get();
      if (latest?.id === run.id) this.db.update(tasks).set({ status: "cancelled", updated_at: now, last_activity_at: now }).where(eq(tasks.id, run.task_id)).run();
      return;
    }
    const turnId = snapshot.input.turnId;
    if (turnId) {
      this.db.update(sessionTurns).set({ status: "failed", error: reason, completed_at: now, updated_at: now }).where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.status, "running"))).run();
      this.db.update(sessionInbox).set({ status: "failed", error: reason, completed_at: now, updated_at: now }).where(and(eq(sessionInbox.turn_id, turnId), eq(sessionInbox.status, "claimed"))).run();
      this.db.update(sessionCommands).set({ status: "cancelled", error: reason, claim: null, updatedAt: now }).where(and(eq(sessionCommands.id, turnId), eq(sessionCommands.kind, "session.invoke"), inArray(sessionCommands.status, ["pending", "running", "unknown"]))).run();
    }
    if (snapshot.kind === "main" && snapshot.input.input.type === "task_result") {
      this.db.update(sessionTriggers).set({ status: "cancelled", error: reason, updatedAt: now }).where(and(eq(sessionTriggers.sessionId, invocation.sessionId!), eq(sessionTriggers.kind, "task_result"),
        sql`json_extract(${sessionTriggers.payload}, '$.result.taskRunId') = ${snapshot.input.input.result.taskRunId}`,
        inArray(sessionTriggers.status, ["pending", "running", "failed"]))).run();
    }
  }
}
