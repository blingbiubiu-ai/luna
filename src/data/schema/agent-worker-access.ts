import {integer,primaryKey,sqliteTable,text} from "drizzle-orm/sqlite-core";
import {lunaAgents} from "./luna-agents";
import {accounts} from "./accounts";

/** Worker IDs refer to the independently owned Runtime registry; approval is Service policy. */
export const agentWorkerAccess=sqliteTable("agent_worker_access",{
 agentId:text("agent_id").notNull().references(()=>lunaAgents.id),
 workerId:text("worker_id").notNull(),
 status:text("status",{enum:["active","disabled"]}).notNull(),
 paused:integer("paused",{mode:"boolean"}).notNull().default(false),
 updatedByAccountId:text("updated_by_account_id").notNull().references(()=>accounts.id),
 updatedAt:integer("updated_at").notNull(),
},t=>[primaryKey({columns:[t.agentId,t.workerId]})]);
