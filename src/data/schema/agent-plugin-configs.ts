import {primaryKey,integer,sqliteTable,text} from "drizzle-orm/sqlite-core";
import {lunaAgents} from "./luna-agents";
import {accounts} from "./accounts";
import type {EncryptedSecret} from "@/agent-config/secret-cipher";

/** Agent-owned activation/configuration. Registry installation remains platform-wide. */
export const agentPluginConfigs=sqliteTable("agent_plugin_configs",{
 agentId:text("agent_id").notNull().references(()=>lunaAgents.id),
 pluginId:text("plugin_id").notNull(),
 revision:text("revision").notNull(),
 enabled:integer("enabled",{mode:"boolean"}).notNull(),
 config:text("config_json",{mode:"json"}).$type<Record<string,unknown>>().notNull(),
 secrets:text("secrets_json",{mode:"json"}).$type<Record<string,EncryptedSecret & {revision:string}>>().notNull(),
 updatedByAccountId:text("updated_by_account_id").notNull().references(()=>accounts.id),
 updatedAt:integer("updated_at").notNull(),
},t=>[primaryKey({columns:[t.agentId,t.pluginId]})]);
