import { lunaAgents } from "./luna-agents";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { EncryptedSecret } from "@/agent-config/secret-cipher";
import type { ChannelIdentity } from "@/channels";
export const channelConfigs=sqliteTable("channel_configs",{
 id:text("id").primaryKey(),agentId:text("agent_id").notNull().references(() => lunaAgents.id),type:text("type").notNull(),name:text("name").notNull(),appId:text("app_id").notNull().unique(),
 secret:text("secret",{mode:"json"}).$type<EncryptedSecret>().notNull(),chatId:text("chat_id").notNull().default(""),
 enabled:integer("enabled",{mode:"boolean"}).notNull().default(true),botIdentity:text("bot_identity",{mode:"json"}).$type<ChannelIdentity>(),
 updatedAt:integer("updated_at").notNull(),
},t=>[uniqueIndex("channel_configs_agent_id").on(t.agentId,t.id)]);
