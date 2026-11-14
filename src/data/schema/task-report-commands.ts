import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tasks } from "./tasks";
import { taskRuns } from "./task-runs";

/** One immutable final report per run, accepted independently of runner termination. */
export const taskReportCommands = sqliteTable("task_report_commands", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, {onDelete: "cascade"}),
  taskRunId: text("task_run_id").notNull().references(() => taskRuns.id, {onDelete: "cascade"}),
  requestId: text("request_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  content: text("content").notNull(),
  reportArtifactId: text("report_artifact_id").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [uniqueIndex("task_report_commands_run_unique").on(table.taskRunId)]);
