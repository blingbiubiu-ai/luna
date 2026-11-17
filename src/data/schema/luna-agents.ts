import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { users } from "./users";

/** User-owned Agent; its default Shadow is enforced by a deferred composite FK. */
export const lunaAgents = sqliteTable("luna_agents", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  defaultShadowId: text("default_shadow_id").notNull(),
  status: text("status", {enum: ["active", "disabled", "deleted"]}).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [
  index("luna_agents_owner_idx").on(t.ownerUserId),
  check("luna_agents_status_check", sql`${t.status} IN ('active','disabled','deleted')`),
  foreignKey({columns: [t.id, t.defaultShadowId], foreignColumns: [agentShadows.agentId, agentShadows.id] as [AnySQLiteColumn, AnySQLiteColumn]}),
]);

/** A default Shadow and a bot Shadow have identical runtime ownership. */
export const agentShadows = sqliteTable("agent_shadows", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references((): AnySQLiteColumn => lunaAgents.id),
  name: text("name").notNull(),
  replyUserId: text("reply_user_id").notNull().references(() => users.id),
  status: text("status", {enum: ["active", "disabled", "deleted"]}).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [
  uniqueIndex("agent_shadows_scope_unique").on(t.agentId, t.id),
  uniqueIndex("agent_shadows_reply_unique").on(t.replyUserId),
  check("agent_shadows_status_check", sql`${t.status} IN ('active','disabled','deleted')`),
]);

/** Request receipts are scoped to the actor and operation, with a payload hash. */
export const agentMutationReceipts = sqliteTable("agent_mutation_receipts", {
  actorUserId: text("actor_user_id").notNull().references(() => users.id),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  entityId: text("entity_id").notNull(),
  createdAt: integer("created_at").notNull(),
}, t => [primaryKey({columns: [t.actorUserId, t.operation, t.key]})]);
