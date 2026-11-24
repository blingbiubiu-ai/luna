import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { correlatedRequests, taskReportCommands, taskRuns } from "@/data/schema";

export function taskReportForRun(db: DrizzleDB, taskRunId: string) {
  return db
    .select()
    .from(taskReportCommands)
    .where(eq(taskReportCommands.taskRunId, taskRunId))
    .get();
}

export interface TaskInvocation {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly runnerContextId: string;
  readonly signal?: AbortSignal;
}

const registries = new WeakMap<DrizzleDB, Map<string, TaskInvocation>>();
export function taskInvocations(db: DrizzleDB): Map<string, TaskInvocation> {
  let registry = registries.get(db);
  if (!registry) {
    registry = new Map();
    registries.set(db, registry);
  }
  return registry;
}

export type TaskRunSettlementOutcome =
  | {
      readonly kind: "completed";
      readonly finalReportArtifactId: string;
    }
  | {
      readonly kind: "waiting";
      readonly pauseReason: string;
    };

export function requireTaskReportCompletion(
  db: DrizzleDB,
  taskRunId: string,
  _terminalText?: string,
): TaskRunSettlementOutcome {
  const report = taskReportForRun(db, taskRunId);
  if (report) {
    return {
      kind: "completed",
      finalReportArtifactId: report.reportArtifactId,
    };
  }

  const runRow = db
    .select({
      taskId: taskRuns.task_id,
      pauseReason: taskRuns.pause_reason,
    })
    .from(taskRuns)
    .where(eq(taskRuns.id, taskRunId))
    .get();
  if (runRow?.pauseReason) {
    return {
      kind: "waiting",
      pauseReason: runRow.pauseReason,
    };
  }

  if (runRow) {
    const openReqs = db
      .select({ id: correlatedRequests.id, goal: correlatedRequests.instruction })
      .from(correlatedRequests)
      .where(
        and(
          eq(correlatedRequests.originTaskId, runRow.taskId),
          inArray(correlatedRequests.status, ["open", "in_progress"]),
        ),
      )
      .all();
    if (openReqs.length > 0) {
      return {
        kind: "waiting",
        pauseReason: `Waiting for response on request ${openReqs[0]!.id}: ${openReqs[0]!.goal.slice(0, 120)}`,
      };
    }
  }

  throw new Error(
    "Task completed without submitting a report command (luna tasks report) or suspending (luna tasks pause / luna ask --to main)",
  );
}
