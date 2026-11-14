import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    agentId:text("agent_id"),
    shadowId:text("shadow_id"),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    sourceRunnerJobId: text("source_runner_job_id"),
    sourceSessionId: text("source_session_id"),
    sourceTurnId: text("source_turn_id"),
    sourceTaskId: text("source_task_id"),
    sourceTaskRunId: text("source_task_run_id"),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("access_tokens_token_hash_idx").on(
      table.tokenHash,
    ),
    userSourceIdx: index("access_tokens_user_source_idx").on(
      table.userId,
      table.source,
    ),
    sourceExpiresAtIdx: index("access_tokens_source_expires_at_idx").on(
      table.source,
      table.expiresAt,
    ),
    runnerJobIdx: index("access_tokens_runner_job_idx").on(
      table.sourceRunnerJobId,
    ),
  }),
);

export const cliAuthSessions = sqliteTable(
  "cli_auth_sessions",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCodeHash: text("user_code_hash").notNull(),
    status: text("status").notNull(),
    approvedByUserId: text("approved_by_user_id"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    approvedAt: integer("approved_at"),
    consumedAt: integer("consumed_at"),
    metadataJson: text("metadata_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),
  },
  (table) => ({
    deviceCodeHashIdx: uniqueIndex("cli_auth_sessions_device_code_hash_idx").on(
      table.deviceCodeHash,
    ),
    userCodeHashIdx: uniqueIndex("cli_auth_sessions_user_code_hash_idx").on(
      table.userCodeHash,
    ),
    statusExpiresAtIdx: index("cli_auth_sessions_status_expires_at_idx").on(
      table.status,
      table.expiresAt,
    ),
  }),
);

export const channelAuthTokens = sqliteTable(
  "channel_auth_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").notNull(),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    channelIdentityId: text("channel_identity_id"),
    purpose: text("purpose").notNull(),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }).$type<
      Record<string, unknown> | null
    >(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("channel_auth_tokens_token_hash_idx").on(
      table.tokenHash,
    ),
    userPurposeIdx: index("channel_auth_tokens_user_purpose_idx").on(
      table.userId,
      table.purpose,
    ),
    purposeExpiresAtIdx: index("channel_auth_tokens_purpose_expires_at_idx").on(
      table.purpose,
      table.expiresAt,
    ),
  }),
);
