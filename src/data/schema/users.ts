import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { accounts } from "./accounts";
import { lunaAgents } from "./luna-agents";

export const USER_KINDS = ["human", "bot", "shadow", "system"] as const;
export type UserKind = typeof USER_KINDS[number];
export const USER_STATUSES = ["active", "blocked", "removed", "merged"] as const;
export type UserStatus = typeof USER_STATUSES[number];

/**
 * Someone or something inside one Agent: a channel sender, another bot, a
 * Shadow's reply user, Luna's own author, and the owner as they appear in it.
 * `accountId` is set when this user is a Dashboard account in this Agent.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references((): AnySQLiteColumn => lunaAgents.id),
    accountId: text("account_id").references(() => accounts.id),
    kind: text("kind", { enum: USER_KINDS }).notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    status: text("status", { enum: USER_STATUSES }).notNull().default("active"),
    mergedIntoUserId: text("merged_into_user_id"),
    profileSource: text("profile_source").notNull().default("channel"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    agentIdx: index("users_agent_idx").on(table.agentId, table.status),
    mergedIntoIdx: index("users_merged_into_idx").on(table.mergedIntoUserId),
  }),
);

/** Verified identity evidence of a user; it merges one person only within one Agent. */
export const userIdentityLinks = sqliteTable(
  "user_identity_links",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references((): AnySQLiteColumn => lunaAgents.id),
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
      table.agentId,
      table.identityNamespace,
      table.identityKind,
      table.identityValue,
      table.identityScope,
    ),
    userIdx: index("user_identity_links_user_idx").on(table.userId),
  }),
);
