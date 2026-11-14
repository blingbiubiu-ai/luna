import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessionTimelineEntries = sqliteTable(
  "session_timeline_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id").notNull(),
    entryKind: text("entry_kind").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_timeline_entries_unique").on(
      table.sessionId,
      table.messageId,
      table.entryKind,
    ),
    index("session_timeline_entries_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("session_timeline_entries_message_idx").on(table.messageId),
  ],
);
