import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agentShadows } from "./luna-agents";
import { agentWorkerAccess } from "./agent-worker-access";
import {accounts} from "./accounts";

export const shadowWorkerRouting = sqliteTable("shadow_worker_routing", {
  shadowId: text("shadow_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  mode: text("mode", { enum: ["automatic", "bound"] }).notNull(),
  workerId: text("worker_id"),
  updatedByAccountId: text("updated_by_account_id").notNull().references(() => accounts.id),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  foreignKey({ columns: [table.agentId, table.shadowId], foreignColumns: [agentShadows.agentId, agentShadows.id] }),
  foreignKey({ columns: [table.agentId, table.workerId], foreignColumns: [agentWorkerAccess.agentId, agentWorkerAccess.workerId] }),
  check("shadow_worker_routing_mode", sql`(${table.mode}='automatic' AND ${table.workerId} IS NULL) OR (${table.mode}='bound' AND ${table.workerId} IS NOT NULL)`),
]);
