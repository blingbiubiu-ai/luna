import {sql} from "drizzle-orm";
import {lunaAgents,agentShadows} from "./luna-agents";
import {shadowBotBindings} from "./shadow-bot-bindings";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    agentId:text("agent_id").notNull().references(()=>lunaAgents.id),
    shadowId:text("shadow_id").notNull().references(()=>agentShadows.id),
    bindingId:text("binding_id").references(()=>shadowBotBindings.id),
    ownerSessionId: text("owner_session_id"),
    deletedAt: integer("deleted_at"),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    senderUserId: text("sender_user_id").notNull(),
    senderIdentityId: text("sender_identity_id"),
    role: text("role").notNull(),
    contentKind: text("content_kind").notNull(),
    presentationKind: text("presentation_kind").notNull(),
    providerMessageType: text("provider_message_type"),
    contentJson: text("content_json", { mode: "json" }).notNull(),
    rawPayloadJson: text("raw_payload_json", { mode: "json" }),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("messages_owner_session_idx").on(table.ownerSessionId),
    uniqueIndex("messages_channel_external_role_unique").on(
      table.agentId,table.shadowId,sql`coalesce(${table.bindingId}, '')`,
      table.channelType,
      table.channelId,
      table.externalMessageId,
      table.role,
    ),
    index("messages_channel_sender_created_idx").on(
      table.channelType,
      table.channelId,
      table.senderUserId,
      table.occurredAt,
    ),
  ],
);
