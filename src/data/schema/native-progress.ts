import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Provider checkpoints are separate from logical session message receipts. */
export const nativeProgressDeliveries = sqliteTable("native_progress_deliveries", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  state: text("state", {mode: "json"}).$type<{
    cotId?: string;
    started?: boolean;
    lastReasoningId?: string;
    openTools?: Record<string, string>;
    ended?: boolean;
    sentEntries: string[];
    terminal?: boolean;
    pending?: "create" | "append" | undefined;
    progressBudget?: { entries: number; bytes: number; exhausted: boolean };
  }>().notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("native_progress_channel_message").on(table.channelId, table.messageId)]);
