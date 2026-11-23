import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { taskReportCommands } from "@/data/schema";

export function taskReportForRun(db: DrizzleDB, taskRunId: string) {
  return db.select().from(taskReportCommands).where(eq(taskReportCommands.taskRunId, taskRunId)).get();
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
  if (!registry) { registry = new Map(); registries.set(db, registry); }
  return registry;
}

export function requireTaskReportCompletion(db: DrizzleDB, taskRunId: string, _terminalText?: string) {
  const report = taskReportForRun(db, taskRunId);
  if (!report) throw new Error("Task completed without submitting a report command (luna tasks report)");
  return {finalReportArtifactId: report.reportArtifactId};
}
