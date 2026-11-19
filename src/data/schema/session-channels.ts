import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { NormalizedInboundMessage } from "@/channels";
import type { OutboundChannelOperation } from "@/channels/outbound";
export const sessionChannelBindings = sqliteTable("session_channel_bindings", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull(),
  channelType: text("channel_type").notNull(), channelId: text("channel_id").notNull(),
  surfaceId: text("surface_id").notNull(), threadId: text("thread_id"), rootMessageId: text("root_message_id"),
}, t => [uniqueIndex("session_channel_binding_unique").on(t.sessionId, t.channelId)]);
export const sessionReplyDispatches = sqliteTable("session_reply_dispatches", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(), signature: text("signature").notNull(),
  receipt: text("receipt", {mode:"json"}).$type<OutboundChannelOperation>(), createdAt: integer("created_at").notNull(),
});
export const sessionChannelDeliveries = sqliteTable("session_channel_deliveries", {
  id: text("id").primaryKey(), dispatchId: text("dispatch_id").notNull(),
  bindingId: text("binding_id").notNull(), channelId: text("channel_id").notNull(),
  inbound: text("inbound", {mode:"json"}).$type<NormalizedInboundMessage>().notNull(),
  operation: text("operation", {mode:"json"}).$type<Omit<OutboundChannelOperation,"id"|"channelId">>().notNull(),
  receipt: text("receipt", {mode:"json"}).$type<OutboundChannelOperation>(),
  status: text("status").notNull(), error: text("error"), updatedAt: integer("updated_at").notNull(),
}, t => [uniqueIndex("session_channel_delivery_unique").on(t.dispatchId,t.bindingId)]);
