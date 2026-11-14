import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { lunaAgents, agentShadows } from "./luna-agents";
import { channelConfigs } from "./channel-configs";

/** Immutable binding history; only active rows participate in routing. */
export const shadowBotBindings = sqliteTable("shadow_bot_bindings", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => lunaAgents.id),
  shadowId: text("shadow_id").notNull(),
  channelConfigId: text("channel_config_id").notNull().references(() => channelConfigs.id),
  revision: integer("revision").notNull(),
  status: text("status", {enum: ["active", "retired"]}).notNull(),
  createdAt: integer("created_at").notNull(),
  retiredAt: integer("retired_at"),
}, t => [
  foreignKey({columns: [t.agentId, t.shadowId], foreignColumns: [agentShadows.agentId, agentShadows.id]}),
  foreignKey({columns: [t.agentId, t.channelConfigId], foreignColumns: [channelConfigs.agentId, channelConfigs.id]}),
  uniqueIndex("shadow_bot_bindings_active_shadow").on(t.shadowId).where(sql`${t.status}='active'`),
  uniqueIndex("shadow_bot_bindings_active_channel").on(t.channelConfigId).where(sql`${t.status}='active'`),
  uniqueIndex("shadow_bot_bindings_revision").on(t.channelConfigId, t.revision),
  check("shadow_bot_bindings_revision_check", sql`${t.revision} >= 1`),
  check("shadow_bot_bindings_status_check", sql`(${t.status}='active' AND ${t.retiredAt} IS NULL) OR (${t.status}='retired' AND ${t.retiredAt} IS NOT NULL)`),
]);
