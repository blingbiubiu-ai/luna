import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessionTimelineEvents = sqliteTable(
  "session_timeline_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    entryId: text("entry_id").notNull(),
    eventType: text("event_type").notNull(),
    controlKind: text("control_kind").notNull(),
    reasonKind: text("reason_kind").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    anchorMessageId: text("anchor_message_id").notNull(),
    sessionSourceMessageId: text("session_source_message_id").notNull(),
    turnId: text("turn_id").notNull(),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_timeline_events_source_control_unique").on(
      table.sessionId,
      table.sourceMessageId,
      table.controlKind,
      table.reasonKind,
    ),
    index("session_timeline_events_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);
