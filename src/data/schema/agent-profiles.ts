import {lunaAgents} from "./luna-agents";
import { foreignKey, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const agentProfiles = sqliteTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id").notNull().references(() => lunaAgents.id),
    name: text("name").notNull(),
    agent_type: text("agent_type").notNull(),
    deleted_at: integer("deleted_at"),
    created_by_account_id: text("created_by_account_id"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_profiles_scope_id").on(table.agent_id, table.id),
    uniqueIndex("agent_profiles_type_name_unique").on(
      table.agent_id,
      table.agent_type,
      table.name,
    ),
  ],
);

export const agentProfileRevisions = sqliteTable(
  "agent_profile_revisions",
  {
    id: text("id").primaryKey(),
    profile_id: text("profile_id").notNull(),
    revision_number: integer("revision_number").notNull(),
    model: text("model").notNull(),
    execution_driver: text("execution_driver").notNull().default("stdio"),
    resume_on_model_change: integer("resume_on_model_change", {
      mode: "boolean",
    }).notNull().default(true),
    env_json: text("env_json").notNull().default("{}"),
    config_fingerprint: text("config_fingerprint").notNull(),
    validation_state: text("validation_state").notNull().default("draft"),
    validation_result_json: text("validation_result_json"),
    validated_at: integer("validated_at"),
    created_by_account_id: text("created_by_account_id"),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_profile_revisions_profile_id").on(table.profile_id, table.id),
    uniqueIndex("agent_profile_revisions_profile_number_unique").on(
      table.profile_id,
      table.revision_number,
    ),
  ],
);

export const agentProfileSecrets = sqliteTable(
  "agent_profile_secrets",
  {
    revision_id: text("revision_id").notNull(),
    env_key: text("env_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    auth_tag: text("auth_tag").notNull(),
    algorithm: text("algorithm").notNull(),
    key_version: integer("key_version").notNull(),
    credential_identity: text("credential_identity").notNull(),
    updated_by_account_id: text("updated_by_account_id"),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_profile_secrets_revision_key_unique").on(
      table.revision_id,
      table.env_key,
    ),
  ],
);

export const activeAgentConfig = sqliteTable("active_agent_config", {
  agent_id: text("agent_id").primaryKey().references(() => lunaAgents.id),
  agent_type: text("agent_type").notNull(),
  profile_id: text("profile_id").notNull(),
  revision_id: text("revision_id").notNull(),
  activation_sequence: integer("activation_sequence").notNull(),
  activated_by_account_id: text("activated_by_account_id"),
  activated_at: integer("activated_at").notNull(),
}, (table) => [
  foreignKey({columns:[table.agent_id,table.profile_id],foreignColumns:[agentProfiles.agent_id,agentProfiles.id]}),
  foreignKey({columns:[table.profile_id,table.revision_id],foreignColumns:[agentProfileRevisions.profile_id,agentProfileRevisions.id]}),
]);
