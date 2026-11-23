import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agentShadows, lunaAgents } from "./luna-agents";

export const CORRELATED_REQUEST_KINDS = ["ask", "handoff"] as const;
export type CorrelatedRequestKind = (typeof CORRELATED_REQUEST_KINDS)[number];

export const CORRELATED_REQUEST_STATUSES = [
  "pending",
  "answered",
  "done",
  "declined",
  "expired",
  "failed",
  "cancelled",
] as const;
export type CorrelatedRequestStatus = (typeof CORRELATED_REQUEST_STATUSES)[number];

/**
 * Per-Shadow self-driven heartbeat cursor and dedicated local session.
 * If the latest heartbeat command did not complete, the next pass re-evaluates from `coveredFrom`.
 */
export const shadowHeartbeats = sqliteTable("shadow_heartbeats", {
  shadowId: text("shadow_id").primaryKey().references(() => agentShadows.id),
  agentId: text("agent_id").notNull().references(() => lunaAgents.id),
  sessionId: text("session_id").notNull(),
  /** Activity timestamp covered through the latest queued heartbeat. */
  cursorAt: integer("cursor_at").notNull().default(0),
  /** Cursor where the latest queued heartbeat started, restored if that command fails/cancels/expires. */
  coveredFrom: integer("covered_from").notNull().default(0),
  lastQueuedAt: integer("last_queued_at").notNull().default(0),
  commandId: text("command_id"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Rate-limited owner failure notification and Dashboard failure marker for `session_schedules`.
 */
export const scheduleFailureNotifications = sqliteTable(
  "schedule_failure_notifications",
  {
    scheduleId: text("schedule_id").primaryKey(),
    lastFailedOccurrenceId: text("last_failed_occurrence_id").notNull(),
    lastFailedAt: integer("last_failed_at").notNull(),
    lastReason: text("last_reason").notNull(),
    lastNotifiedAt: integer("last_notified_at"),
    notificationCommandId: text("notification_command_id"),
    updatedAt: integer("updated_at").notNull(),
  },
);

/**
 * Unified correlated request ledger for `ask` (awaiting human answer/card action)
 * and `handoff` (delegated session work with automatic or explicit result return).
 */
export const correlatedRequests = sqliteTable(
  "correlated_requests",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: CORRELATED_REQUEST_KINDS }).notNull(),
    agentId: text("agent_id").notNull().references(() => lunaAgents.id),
    shadowId: text("shadow_id").notNull().references(() => agentShadows.id),
    originSessionId: text("origin_session_id").notNull(),
    originTurnId: text("origin_turn_id"),
    targetAddress: text("target_address").notNull(),
    targetSessionId: text("target_session_id").notNull(),
    targetUserId: text("target_user_id"),
    outboundCommandId: text("outbound_command_id"),
    outboundMessageId: text("outbound_message_id"),
    instruction: text("instruction").notNull(),
    contextSummary: text("context_summary"),
    optionsJson: text("options_json", { mode: "json" }).$type<string[] | null>(),
    hops: integer("hops").notNull().default(3),
    status: text("status", { enum: CORRELATED_REQUEST_STATUSES }).notNull(),
    resultJson: text("result_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    resolvedByUserId: text("resolved_by_user_id"),
    returnCommandId: text("return_command_id"),
    expiresAt: integer("expires_at"),
    createdByInvocationId: text("created_by_invocation_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  t => [
    index("correlated_requests_shadow_status_idx").on(t.shadowId, t.status, t.expiresAt),
    index("correlated_requests_target_session_idx").on(t.targetSessionId, t.status),
    index("correlated_requests_origin_session_idx").on(t.originSessionId, t.createdAt),
    index("correlated_requests_outbound_msg_idx").on(t.outboundMessageId),
    index("correlated_requests_outbound_cmd_idx").on(t.outboundCommandId),
  ],
);
