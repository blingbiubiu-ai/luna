import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition mapping duplicate surfaces to canonical sessions.
 */
export const sessionSurfaceAliases = sqliteTable(
  "session_surface_aliases",
  {
    alias_key: text("alias_key").primaryKey(),
    session_id: text("session_id").notNull(),
    created_at: integer("created_at").notNull(),
  },
);
