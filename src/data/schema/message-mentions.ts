import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { channelIdentities } from "./channel-identities";
import { messages } from "./messages";

export const messageMentions = sqliteTable(
  "message_mentions",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    mentionKey: text("mention_key").notNull(),
    mentionLabel: text("mention_label").notNull(),
    targetIdentityId: text("target_identity_id").references(
      () => channelIdentities.id,
      { onDelete: "set null" },
    ),
    targetExternalId: text("target_external_id").notNull(),
    targetKind: text("target_kind").notNull(),
    rawMentionJson: text("raw_mention_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("message_mentions_unique").on(
      table.messageId,
      table.mentionKey,
      table.mentionLabel,
      table.targetExternalId,
      table.targetKind,
    ),
    index("message_mentions_message_idx").on(table.messageId),
  ],
);
