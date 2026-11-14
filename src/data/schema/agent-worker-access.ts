import {integer,primaryKey,sqliteTable,text} from "drizzle-orm/sqlite-core";
import {lunaAgents} from "./luna-agents";
import {users} from "./users";

/** Worker IDs refer to the independently owned Runtime registry; approval is Service policy. */
export const agentWorkerAccess=sqliteTable("agent_worker_access",{
 agentId:text("agent_id").notNull().references(()=>lunaAgents.id),
 workerId:text("worker_id").notNull(),
 status:text("status",{enum:["active","disabled"]}).notNull(),
 paused:integer("paused",{mode:"boolean"}).notNull().default(false),
 updatedBy:text("updated_by").notNull().references(()=>users.id),
 updatedAt:integer("updated_at").notNull(),
},t=>[primaryKey({columns:[t.agentId,t.workerId]})]);
