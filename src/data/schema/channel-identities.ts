import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Channel identities are provider-neutral actors visible to Luna runtime.
export const channelIdentities = sqliteTable(
  "channel_identities",
  {
    id: text("id").primaryKey(),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    externalId: text("external_id").notNull(),
    identityKind: text("identity_kind").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    providerIdsJson: text("provider_ids_json"),
    rawProfileJson: text("raw_profile_json"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    profileUpdatedAt: text("profile_updated_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    channelIdentityUnique: uniqueIndex(
      "channel_identities_channel_external_unique",
    ).on(table.channelType, table.channelId, table.externalId),
    channelIdentityKindIdx: index("channel_identities_kind_idx").on(
      table.identityKind,
    ),
  }),
);
