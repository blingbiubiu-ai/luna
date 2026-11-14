import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("active"),
    mergedIntoUserId: text("merged_into_user_id"),
    profileSource: text("profile_source").notNull().default("channel"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    kindIdx: index("users_kind_idx").on(table.kind),
    statusIdx: index("users_status_idx").on(table.status),
    mergedIntoIdx: index("users_merged_into_idx").on(table.mergedIntoUserId),
  }),
);

export const userIdentityLinks = sqliteTable(
  "user_identity_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    identityNamespace: text("identity_namespace").notNull(),
    identityKind: text("identity_kind").notNull(),
    identityValue: text("identity_value").notNull(),
    identityScope: text("identity_scope").notNull().default(""),
    confidence: text("confidence").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    identityUnique: uniqueIndex("user_identity_links_identity_unique").on(
      table.identityNamespace,
      table.identityKind,
      table.identityValue,
      table.identityScope,
    ),
    userIdx: index("user_identity_links_user_idx").on(table.userId),
  }),
);
