import type {AgentExecutionReference} from "@/agent-config/execution-reference";
import {lunaAgents,agentShadows} from "./luna-agents";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { JobRequest, RuntimeEvent } from "@luna/runner-protocol";

/** Service-owned authority survives transport disconnects and process restarts. */
export const runnerInvocations = sqliteTable("runner_invocations", {
  id: text("invocation_id").primaryKey(),
  agentId:text("agent_id").notNull().references(()=>lunaAgents.id),
  shadowId:text("shadow_id").notNull().references(()=>agentShadows.id),
  runnerKind: text("runner_kind").$type<"main" | "work" | "task">().notNull(),
  actorUserId: text("actor_user_id").notNull(),
  runnerContextId: text("runner_context_id").notNull(),
  sessionId: text("session_id"), taskId: text("task_id"), taskRunId: text("task_run_id"),
  originId: text("origin_id").notNull(),
  state: text("state").$type<"active" | "revoked" | "settled">().notNull(),
  agentConfig: text("agent_config_json", {mode:"json"}).$type<AgentExecutionReference>(),
  inputSnapshot: text("input_snapshot_json", { mode: "json" }).$type<{ version: 1; input: unknown }>().notNull(),
  contextPackIds: text("context_pack_ids_json", { mode: "json" }).$type<string[]>().notNull(),
  tokenId: text("token_id"), activeJobId: text("active_job_id"),
  createdAt: integer("created_at").notNull(), revokedAt: integer("revoked_at"), settledAt: integer("settled_at"),
  revokeReason: text("revoke_reason"),
}, (table) => [index("runner_invocations_state_idx").on(table.state), index("runner_invocations_session_idx").on(table.sessionId), index("runner_invocations_task_idx").on(table.taskId)]);

/** Runtime facts and business settlement are separate, durable Service projections. */
export const runnerJobs = sqliteTable("runner_jobs", {
  id: text("job_id").primaryKey(), runtimeId: text("runtime_id").notNull(),
  invocationId: text("invocation_id").notNull().references(() => runnerInvocations.id),
  request: text("request_json", { mode: "json" }).$type<JobRequest>().notNull(),
  requestHash: text("request_hash").notNull(),
  cursor: integer("cursor").notNull().default(0),
  credentialsRevision: integer("credentials_revision").notNull().default(0),
  credentialsHash: text("credentials_hash"),
  state: text("state").$type<"pending" | "active" | "terminal" | "settled">().notNull(),
  providerState: text("provider_state_json", { mode: "json" }).$type<{ sessionId?: string; text?: string; checkpoint?: boolean; error?: Record<string, unknown> }>(),
  lastEvent: text("last_event_json", { mode: "json" }).$type<RuntimeEvent>(),
  terminalSequence: integer("terminal_sequence"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("runner_jobs_invocation_idx").on(table.invocationId), index("runner_jobs_state_idx").on(table.state)]);

/** Runtime ownership is bound when a context is created or its provider context is rebuilt. */
export const runnerContextOrigins = sqliteTable("runner_context_origins", {
  contextId: text("context_id").primaryKey(),
  runtimeId: text("runtime_id").notNull(),
});
