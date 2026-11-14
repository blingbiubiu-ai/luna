import {lunaAgents,agentShadows} from "./luna-agents";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const operationInvocationAudits = sqliteTable(
  "operation_invocation_audits",
  {
    id: text("id").primaryKey(),
    agent_id:text("agent_id").notNull().references(()=>lunaAgents.id),
    shadow_id:text("shadow_id").notNull().references(()=>agentShadows.id),
    invocation_id: text("invocation_id").notNull(),
    operation_id: text("operation_id").notNull(),
    provider_type: text("provider_type").notNull(),
    plugin_id: text("plugin_id"),
    subject_type: text("subject_type"),
    subject_id: text("subject_id"),
    source: text("source").notNull(),
    session_id: text("session_id"),
    task_id: text("task_id"),
    message_id: text("message_id"),
    status: text("status").notNull(),
    error_code: text("error_code"),
    authorization_json: text("authorization_json", {mode:"json"}),
    artifact_count: integer("artifact_count").notNull().default(0),
    started_at: integer("started_at").notNull(),
    ended_at: integer("ended_at"),
    duration_ms: integer("duration_ms"),
    expires_at: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("operation_invocation_audits_invocation_unique").on(
      table.invocation_id,
    ),
    index("operation_invocation_audits_operation_idx").on(
      table.operation_id,
    ),
    index("operation_invocation_audits_plugin_idx").on(table.plugin_id),
    index("operation_invocation_audits_subject_idx").on(
      table.subject_type,
      table.subject_id,
    ),
    index("operation_invocation_audits_expires_idx").on(table.expires_at),
  ],
);
