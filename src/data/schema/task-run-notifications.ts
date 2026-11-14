import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for Task Run status-card notifications.
 */
export const taskRunNotifications = sqliteTable(
  "task_run_notifications",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id").notNull(),
    task_run_id: text("task_run_id").notNull(),
    run_index: integer("run_index").notNull(),
    subscription_id: text("subscription_id").notNull(),
    session_id: text("session_id").notNull(),
    channel_type: text("channel_type").notNull(),
    channel_id: text("channel_id").notNull(),
    group_id: text("group_id"),
    thread_key: text("thread_key"),
    root_message_key: text("root_message_key"),
    surface_key: text("surface_key"),
    status_card_style: text("status_card_style", {enum: ["card", "native"]}).notNull().default("card"),
    status_message_id: text("status_message_id"),
    state: text("state").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("task_run_notifications_run_subscription_unique").on(
      table.task_run_id,
      table.subscription_id,
    ),
    uniqueIndex("task_run_notifications_channel_message_unique")
      .on(table.channel_type, table.channel_id, table.status_message_id)
      .where(sql`${table.status_message_id} IS NOT NULL`),
    index("task_run_notifications_task_run_idx").on(table.task_run_id),
    index("task_run_notifications_task_idx").on(table.task_id),
    index("task_run_notifications_subscription_idx").on(table.subscription_id),
  ],
);
