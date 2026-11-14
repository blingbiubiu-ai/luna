import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export type SessionTurnEntryRole =
  | "trigger"
  | "coalesced_input"
  | "context"
  | "launch_context"
  | "output"
  | "skipped";

export const sessionInbox = sqliteTable(
  "session_inbox",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    entry_id: text("entry_id").notNull(),
    message_id: text("message_id").notNull(),
    sender_identity_id: text("sender_identity_id"),
    received_at: integer("received_at").notNull(),
    status: text("status").notNull(),
    turn_id: text("turn_id"),
    claimed_at: integer("claimed_at"),
    completed_at: integer("completed_at"),
    error: text("error"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_inbox_entry_unique").on(table.entry_id),
    index("session_inbox_queue_idx").on(
      table.session_id,
      table.status,
      table.received_at,
    ),
    index("session_inbox_turn_idx").on(table.turn_id),
  ],
);

export const sessionTurns = sqliteTable(
  "session_turns",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    turn_kind: text("turn_kind").notNull(),
    status: text("status").notNull(),
    runner_invoked: integer("runner_invoked", { mode: "boolean" }).notNull(),
    reason: text("reason").notNull(),
    materialized_prompt: text("materialized_prompt"),
    started_at: integer("started_at").notNull(),
    completed_at: integer("completed_at"),
    error: text("error"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [
    index("session_turns_session_idx").on(
      table.session_id,
      table.started_at,
    ),
  ],
);

export const sessionTurnEntries = sqliteTable(
  "session_turn_entries",
  {
    id: text("id").primaryKey(),
    turn_id: text("turn_id").notNull(),
    session_id: text("session_id").notNull(),
    entry_id: text("entry_id").notNull(),
    role: text("role").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("session_turn_entries_turn_idx").on(table.turn_id),
    index("session_turn_entries_entry_idx").on(table.entry_id),
  ],
);

export const sessionRunnerAttempts = sqliteTable(
  "session_runner_attempts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    runnerContextId: text("runner_context_id"),
    runnerType: text("runner_type").notNull(),
    runnerSessionId: text("runner_session_id"),
    attemptKind: text("attempt_kind").notNull(),
    attemptIndex: integer("attempt_index").notNull(),
    status: text("status").notNull(),
    inputPrompt: text("input_prompt").notNull(),
    rawOutput: text("raw_output"),
    rawOutputTruncated: integer("raw_output_truncated", {
      mode: "boolean",
    }).notNull(),
    parsedActionJson: text("parsed_action_json", { mode: "json" }),
    parseErrorJson: text("parse_error_json", { mode: "json" }),
    repairSourceAttemptId: text("repair_source_attempt_id"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("session_runner_attempts_turn_idx").on(
      table.turnId,
      table.attemptIndex,
    ),
    index("session_runner_attempts_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("session_runner_attempts_repair_source_idx").on(
      table.repairSourceAttemptId,
    ),
  ],
);
