import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for task timeline events.
 */
export const timelineEvents = sqliteTable(
  "timeline_events",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id").notNull(),
    session_id: text("session_id"),
    message_id: text("message_id"),
    actor_user_id: text("actor_user_id"),
    source_message_id: text("source_message_id"),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    data: text("data", { mode: "json" }),
    visibility: text("visibility").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("timeline_events_task_message_type_unique").on(
      table.task_id,
      table.message_id,
      table.type,
    ),
  ],
);

/**
 * Drizzle table definition for durable task artifacts.
 */
export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  timeline_event_id: text("timeline_event_id"),
  type: text("type").notNull(),
  name: text("name").notNull(),
  mime_type: text("mime_type"),
  path: text("path"),
  content: text("content"),
  metadata: text("metadata", { mode: "json" }),
  status: text("status").notNull().default("active"),
  retention_expires_at: integer("retention_expires_at"),
  created_at: integer("created_at").notNull(),
});
