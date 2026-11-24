import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tasks } from "./tasks";

export const TASK_INBOX_EVENT_KINDS = [
  "peer_message",
  "request_update",
  "wake_timer",
] as const;
export type TaskInboxEventKind = (typeof TASK_INBOX_EVENT_KINDS)[number];

/**
 * Durable inbox of runtime events (Main -> Task soft `say`, settled `request_update`,
 * and scheduled wake-ups) consumed either mid-run via native CLI hooks or on `--resume`.
 */
export const taskInboxEvents = sqliteTable(
  "task_inbox_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: TASK_INBOX_EVENT_KINDS }).notNull(),
    source: text("source").notNull(),
    correlationId: text("correlation_id"),
    content: text("content").notNull(),
    payloadJson: text("payload_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    deliveredContextId: text("delivered_context_id"),
    deliveredRunId: text("delivered_run_id"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull(),
  },
  t => [
    uniqueIndex("task_inbox_events_task_seq_unique").on(t.taskId, t.seq),
    index("task_inbox_events_pending_idx").on(t.taskId, t.deliveredContextId, t.seq),
  ],
);
