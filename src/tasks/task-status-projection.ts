import { desc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { taskRuns, tasks } from "@/data/schema";

/**
 * Projects the display Task status from the latest Task Run when one exists.
 */
export function taskWithLatestRunStatus(
  db: DrizzleDB,
  task: typeof tasks.$inferSelect,
): typeof tasks.$inferSelect {
  const latestRun = db
    .select({ status: taskRuns.status })
    .from(taskRuns)
    .where(eq(taskRuns.task_id, task.id))
    .orderBy(desc(taskRuns.run_index))
    .limit(1)
    .get();
  if (latestRun === undefined || latestRun.status === task.status) {
    return task;
  }
  return {
    ...task,
    status: latestRun.status,
  };
}
