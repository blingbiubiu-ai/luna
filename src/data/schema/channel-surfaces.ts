import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Channel surfaces are provider-neutral places where messages happen.
export const channelSurfaces = sqliteTable(
  "channel_surfaces",
  {
    id: text("id").primaryKey(),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    externalId: text("external_id").notNull(),
    surfaceKind: text("surface_kind").notNull(),
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
    channelSurfaceUnique: uniqueIndex(
      "channel_surfaces_channel_external_unique",
    ).on(table.channelType, table.channelId, table.externalId),
    channelSurfaceKindIdx: index("channel_surfaces_kind_idx").on(
      table.surfaceKind,
    ),
  }),
);
