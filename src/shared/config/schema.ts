import { z } from "zod";

export const GroupActivationFollowupSenders = z.enum([
  "requester_only",
  "requester_and_reporters",
]);
export type GroupActivationFollowupSenders = z.infer<
  typeof GroupActivationFollowupSenders
>;

/** Built-in defaults for how incoming messages become Runner turns (overridable per Agent in `agent_settings`). */
export const SessionConfig = z
  .object({
    coalesce_idle_ms: z.number().int().positive().default(1200),
    coalesce_max_wait_ms: z.number().int().positive().default(5000),
    max_batch_size: z.number().int().positive().default(8),
    stale_claim_ms: z.number().int().positive().default(120000),
    activation_context_window_ms: z.number().int().nonnegative().default(300000),
    activation_context_max_messages: z.number().int().nonnegative().default(12),
    activation_context_max_chars: z.number().int().nonnegative().default(6000),
    activation_context_recent_unprocessed_messages: z
      .number()
      .int()
      .nonnegative()
      .default(10),
    group_activation_followup_window_ms: z
      .number()
      .int()
      .nonnegative()
      .default(300000),
    group_activation_followup_senders: GroupActivationFollowupSenders.default(
      "requester_and_reporters",
    ),
    group_activation_followup_max_messages: z
      .number()
      .int()
      .nonnegative()
      .default(8),
    group_activation_followup_recent_messages: z
      .number()
      .int()
      .nonnegative()
      .default(3),
    group_activation_followup_interrupt_on_other_user: z.boolean().default(true),
    group_bot_aliases: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export interface SessionConfig extends z.infer<typeof SessionConfig> {}

export const DEFAULT_SESSION_CONFIG: SessionConfig = SessionConfig.parse({});

export const ServiceConfig = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().max(65535).default(8090),
  })
  .strict();
export interface ServiceConfig extends z.infer<typeof ServiceConfig> {}

export const PathsConfig = z
  .object({
    repoRoot: z.string().optional(),
    runtimeDir: z.string().optional(),
    artifactsDir: z.string().optional(),
    runnersDir: z.string().optional(),
    sharedWorkspaceDir: z.string().optional(),
  })
  .strict();
export interface PathsConfig extends z.infer<typeof PathsConfig> {}

export const LoggingConfig = z
  .object({
    level: z.string().default("info"),
    pretty: z.boolean().default(false),
  })
  .strict();
export interface LoggingConfig extends z.infer<typeof LoggingConfig> {}

export const SandboxConfig = z
  .object({
    /** Override the private Runtime client file under the Luna home. */
    runtimeConfigFile: z.string().min(1).optional(),
  })
  .strict();
export interface SandboxConfig extends z.infer<typeof SandboxConfig> {}

/**
 * Bootstrap-only application configuration loaded from `$LUNA_HOME/config.yaml`.
 * Platform runtime settings live in SQLite (`platform_settings`) and are managed from Dashboard.
 */
export const AppConfig = z
  .object({
    service: ServiceConfig.default(() => ServiceConfig.parse({})),
    paths: PathsConfig.default(() => PathsConfig.parse({})),
    logging: LoggingConfig.default(() => LoggingConfig.parse({})),
    sandbox: SandboxConfig.default(() => SandboxConfig.parse({})),
  })
  .strict();
export interface AppConfig extends z.infer<typeof AppConfig> {}
