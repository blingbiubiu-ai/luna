import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { accounts } from "./accounts";
import { lunaAgents } from "./luna-agents";

/** One row per Agent with its display settings; an Agent without one uses the defaults. */
export const agentSettings = sqliteTable("agent_settings", {
  agentId: text("agent_id").primaryKey().references(() => lunaAgents.id),
  settings: text("settings", { mode: "json" }).notNull().$type<unknown>(),
  updatedByAccountId: text("updated_by_account_id").notNull().references(() => accounts.id),
  updatedAt: integer("updated_at").notNull(),
});
