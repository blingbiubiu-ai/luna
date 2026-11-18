import { foreignKey, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agentShadows } from "./luna-agents";
import {accounts} from "./accounts";

/** Shadow root switch: the Shadow's container and its Jobs may use sudo. Trust is the `agent.root` grant. */
export const shadowRootAccess = sqliteTable("shadow_root_access", {
  shadowId: text("shadow_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  updatedByAccountId: text("updated_by_account_id").notNull().references(() => accounts.id),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  foreignKey({ columns: [table.agentId, table.shadowId], foreignColumns: [agentShadows.agentId, agentShadows.id] }),
]);

