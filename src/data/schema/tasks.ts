import {lunaAgents,agentShadows} from "./luna-agents";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for persisted task records.
 */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull().references(()=>lunaAgents.id),
  shadow_id: text("shadow_id").notNull().references(()=>agentShadows.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  status: text("status").notNull(),
  block_reason: text("block_reason"),
  wake_at: integer("wake_at"),
  wake_reason: text("wake_reason"),
  priority: text("priority").notNull().default("medium"),
  severity: text("severity"),
  creator_user_id: text("creator_user_id"),
  primary_session_id: text("primary_session_id"),
  source_message_id: text("source_message_id"),
  source_entry_id: text("source_entry_id"),
  context_json: text("context_json", { mode: "json" }),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  last_activity_at: integer("last_activity_at").notNull(),
}, (table) => [
  index("tasks_wake_at_idx").on(table.status, table.wake_at),
]);

/**
 * Drizzle table definition for users participating in a task.
 */
export const taskParticipants = sqliteTable(
  "task_participants",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id").notNull(),
    user_id: text("user_id").notNull(),
    role: text("role").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("task_participants_task_user_role_unique").on(
      table.task_id,
      table.user_id,
      table.role,
    ),
  ],
);

/**
 * Drizzle table definition for per-channel task status subscriptions.
 */
export const taskSubscriptions = sqliteTable(
  "task_subscriptions",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id").notNull(),
    session_id: text("session_id").notNull(),
    channel_type: text("channel_type").notNull(),
    channel_id: text("channel_id").notNull(),
    group_id: text("group_id"),
    thread_key: text("thread_key"),
    root_message_key: text("root_message_key"),
    surface_key: text("surface_key"),
    status_card_style: text("status_card_style", {enum: ["card", "native"]}).notNull().default("card"),
    visibility: text("visibility").notNull(),
    notification_level: text("notification_level")
      .notNull()
      .default("major_updates"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("task_subscriptions_task_surface_unique").on(
      table.task_id,
      table.surface_key,
    ),
  ],
);
