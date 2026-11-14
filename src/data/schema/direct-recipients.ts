import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// A durable recipient address exists before the provider creates a conversation.
export const directRecipients = sqliteTable("direct_recipients", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  idType: text("id_type").$type<"open_id" | "user_id" | "union_id">().notNull(),
  recipientId: text("recipient_id").notNull(),
  sessionId: text("session_id").notNull(),
  claimId: text("claim_id"),
  surfaceId: text("surface_id"),
}, table => [index("direct_recipient_session").on(table.sessionId), uniqueIndex("direct_recipient_address").on(table.channelId, table.idType, table.recipientId, table.sessionId)]);
