import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { lunaAgents, agentShadows } from "./luna-agents";
import { shadowBotBindings } from "./shadow-bot-bindings";
import { users } from "./users";

/**
 * Drizzle table definition for Luna session surfaces.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id").notNull().references(() => lunaAgents.id),
    shadow_id: text("shadow_id").notNull().references(() => agentShadows.id),
    binding_id: text("binding_id").references(() => shadowBotBindings.id),
    surface_key: text("surface_key"),
    channel_type: text("channel_type").notNull(),
    channel_id: text("channel_id").notNull(),
    group_id: text("group_id"),
    root_message_key: text("root_message_key"),
    thread_key: text("thread_key"),
    parent_session_id: text("parent_session_id"),
    title: text("title"),
    bot_user_id: text("bot_user_id").references(() => users.id),
    status: text("status").notNull().default("active"),
    kind: text("kind").notNull().default("main"),
    created_by_user_id: text("created_by_user_id"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    last_activity_at: integer("last_activity_at").notNull().default(0),
  },
  (table) => [
    uniqueIndex("sessions_surface_key_unique").on(table.surface_key),
    uniqueIndex("sessions_surface_unique").on(
      table.binding_id,
      table.channel_type,
      table.channel_id,
      table.group_id,
      table.root_message_key,
      table.thread_key,
    ),
  ],
);
