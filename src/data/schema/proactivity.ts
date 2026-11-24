import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { agentShadows, lunaAgents } from "./luna-agents";

export const CORRELATED_REQUEST_KINDS = ["request"] as const;
export type CorrelatedRequestKind = (typeof CORRELATED_REQUEST_KINDS)[number];

export const CORRELATED_REQUEST_MODES = ["card", "delegate"] as const;
export type CorrelatedRequestMode = (typeof CORRELATED_REQUEST_MODES)[number];

export const CORRELATED_REQUEST_STATUSES = [
  "open",
  "in_progress",
  "done",
  "declined",
  "expired",
  "failed",
  "cancelled",
] as const;
export type CorrelatedRequestStatus = (typeof CORRELATED_REQUEST_STATUSES)[number];

export const CORRELATED_REQUEST_EVENT_DIRECTIONS = [
  "origin_to_target",
  "target_to_origin",
  "system",
] as const;
export type CorrelatedRequestEventDirection =
  (typeof CORRELATED_REQUEST_EVENT_DIRECTIONS)[number];

export const CORRELATED_REQUEST_EVENT_KINDS = [
  "opened",
  "message",
  "progress",
  "done",
  "declined",
  "cancelled",
  "expired",
  "card_click",
] as const;
export type CorrelatedRequestEventKind =
  (typeof CORRELATED_REQUEST_EVENT_KINDS)[number];

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
 * Unified correlated request ledger for tracked cross-session and Task -> Main requests.
 */
export const correlatedRequests = sqliteTable(
  "correlated_requests",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: CORRELATED_REQUEST_KINDS }).notNull().default("request"),
    mode: text("mode", { enum: CORRELATED_REQUEST_MODES }).notNull().default("delegate"),
    agentId: text("agent_id").notNull().references(() => lunaAgents.id),
    shadowId: text("shadow_id").notNull().references(() => agentShadows.id),
    originSessionId: text("origin_session_id").notNull(),
    originTurnId: text("origin_turn_id"),
    originTaskId: text("origin_task_id"),
    originTaskRunId: text("origin_task_run_id"),
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
    index("correlated_requests_origin_task_idx").on(t.originTaskId, t.status),
    index("correlated_requests_outbound_msg_idx").on(t.outboundMessageId),
    index("correlated_requests_outbound_cmd_idx").on(t.outboundCommandId),
  ],
);

/**
 * Append-only audit and back-and-forth event log for `correlated_requests`.
 */
export const correlatedRequestEvents = sqliteTable(
  "correlated_request_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => correlatedRequests.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    direction: text("direction", { enum: CORRELATED_REQUEST_EVENT_DIRECTIONS }).notNull(),
    kind: text("kind", { enum: CORRELATED_REQUEST_EVENT_KINDS }).notNull(),
    content: text("content").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    actorUserId: text("actor_user_id"),
    commandId: text("command_id"),
    createdAt: integer("created_at").notNull(),
  },
  t => [
    uniqueIndex("correlated_request_events_req_seq_unique").on(t.requestId, t.seq),
    index("correlated_request_events_req_created_idx").on(t.requestId, t.createdAt),
  ],
);
