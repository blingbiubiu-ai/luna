import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for persisted session-level state.
 */
export const sessionStates = sqliteTable("session_states", {
  session_id: text("session_id").primaryKey(),
  clarification_json: text("clarification_json", { mode: "json" }),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});
