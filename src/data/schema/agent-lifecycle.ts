import {index, integer, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";
import {agentShadows, lunaAgents} from "./luna-agents";
import {users} from "./users";

/** Durable lifecycle intent and audit; pending includes remote work without terminal proof. */
export const agentLifecycleJobs = sqliteTable("agent_lifecycle_jobs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => lunaAgents.id),
  shadowId: text("shadow_id").references(() => agentShadows.id),
  actorUserId: text("actor_user_id").notNull().references(() => users.id),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  targetStatus: text("target_status", {enum: ["active", "disabled", "deleted"]}).notNull(),
  status: text("status", {enum: ["pending", "completed"]}).notNull(),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
}, t => [uniqueIndex("agent_lifecycle_actor_key").on(t.actorUserId, t.idempotencyKey), index("agent_lifecycle_pending").on(t.status, t.agentId)]);
