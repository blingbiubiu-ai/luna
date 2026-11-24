import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle table definition for explicit Task Run execution attempts.
 */
export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id").notNull(),
    run_index: integer("run_index").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    input_snapshot: text("input_snapshot", { mode: "json" }).notNull(),
    materialized_prompt: text("materialized_prompt"),
    runner_type: text("runner_type").notNull(),
    runner_context_id: text("runner_context_id"),
    source_message_id: text("source_message_id"),
    started_at: integer("started_at").notNull(),
    finished_at: integer("finished_at"),
    pause_reason: text("pause_reason"),
    cancel_reason: text("cancel_reason"),
    error: text("error"),
    final_report_artifact_id: text("final_report_artifact_id"),
  },
  (table) => [
    uniqueIndex("task_runs_task_run_index_unique").on(
      table.task_id,
      table.run_index,
    ),
    uniqueIndex("task_runs_task_source_reason_unique").on(
      table.task_id,
      table.source_message_id,
      table.reason,
    ),
    uniqueIndex("task_runs_one_running_per_task_unique")
      .on(table.task_id)
      .where(sql`${table.status} = 'running'`),
    index("task_runs_task_id_idx").on(table.task_id),
    index("task_runs_task_status_idx").on(table.task_id, table.status),
  ],
);
