import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Someone who signs in to the Dashboard: owns Agents, holds personal tokens, may administer the platform. */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  status: text("status", { enum: ["active", "disabled", "deleted"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Channel-agnostic verified identity claims recorded when an account signs in
 * via an external OAuth/OIDC/SSO provider. Mirrors `user_identity_links` so
 * `IdentityDirectory` can match incoming channel `IdentityClaim`s without
 * knowing any provider-specific fields.
 */
export const accountIdentityClaims = sqliteTable(
  "account_identity_claims",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    identityNamespace: text("identity_namespace").notNull(),
    identityKind: text("identity_kind").notNull(),
    identityValue: text("identity_value").notNull(),
    identityScope: text("identity_scope").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.accountId,
        table.identityNamespace,
        table.identityKind,
        table.identityValue,
        table.identityScope,
      ],
    }),
    index("account_identity_claims_lookup_idx").on(
      table.identityNamespace,
      table.identityKind,
      table.identityValue,
      table.identityScope,
    ),
  ],
);
