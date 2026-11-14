import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const channelMessageMarkers = sqliteTable(
  "channel_message_markers",
  {
    id: text("id").primaryKey(),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    markerType: text("marker_type").notNull(),
    providerMarkerId: text("provider_marker_id").notNull(),
    providerPayloadJson: text("provider_payload_json", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("channel_message_markers_unique").on(
      table.channelType,
      table.channelId,
      table.messageId,
      table.markerType,
    ),
    index("channel_message_markers_channel_idx").on(
      table.channelType,
      table.channelId,
    ),
  ],
);
