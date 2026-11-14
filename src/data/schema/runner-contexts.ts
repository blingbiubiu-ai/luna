import {lunaAgents, agentShadows} from "./luna-agents";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for persisted runner session context.
 */
export const runnerContexts = sqliteTable(
  "runner_contexts",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id").notNull().references(() => lunaAgents.id),
    shadow_id: text("shadow_id").notNull().references(() => agentShadows.id),
    owner_type: text("owner_type").notNull(),
    owner_id: text("owner_id").notNull(),
    runner_type: text("runner_type").notNull(),
    runner_session_id: text("runner_session_id"),
    instruction_fingerprint: text("instruction_fingerprint"),
    provider_fingerprint: text("provider_fingerprint"),
    model_fingerprint: text("model_fingerprint"),
    runner_root_path: text("runner_root_path").notNull(),
    last_run_id: text("last_run_id"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("runner_contexts_owner_runner_unique").on(
      table.owner_type,
      table.owner_id,
      table.runner_type,
    ),
  ],
);
