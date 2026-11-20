import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Whether a Shadow listens to one group chat without being addressed, and how often it has just stayed silent there.
 * A chat without a row, or with `enabled` null, follows the Agent's listening default.
 */
export const chatListening = sqliteTable("chat_listening", {
  shadowId: text("shadow_id").notNull(),
  /** Provider chat id, as in `sessions.group_id`. */
  chatId: text("chat_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }),
  /** Listening turns in a row that ended without a reply; each doubles the wait before the next. */
  silentStreak: integer("silent_streak").notNull().default(0),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: integer("updated_at").notNull(),
}, t => [primaryKey({ columns: [t.shadowId, t.chatId] })]);
