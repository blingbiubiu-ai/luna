import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users, userIdentityLinks } from "./users";

/** One channel identity has one canonical owner; shared claims do not overwrite this link. */
export const channelUserBindings = sqliteTable("channel_user_bindings", {
  channelIdentityId: text("channel_identity_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

/** A canonical claim can be observed by several independently scoped bot identities. */
export const identityObservations = sqliteTable("identity_observations", {
  claimId: text("claim_id").notNull().references(() => userIdentityLinks.id),
  channelIdentityId: text("channel_identity_id").notNull().references(() => channelUserBindings.channelIdentityId),
  confidence: text("confidence", {enum: ["verified", "inferred", "manual"]}).notNull(),
  observedAt: integer("observed_at").notNull(),
}, t => [primaryKey({columns: [t.claimId, t.channelIdentityId]})]);
