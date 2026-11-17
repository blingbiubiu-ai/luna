import { z } from "zod";

/**
 * Key-value parameters for a messaging channel.
 */
export const ChannelParams = z.record(z.string(), z.string());
/**
 * Represents Channel Params values used by runtime configuration.
 */
export type ChannelParams = z.infer<typeof ChannelParams>;

/**
 * Configuration for a single messaging channel.
 */
export const ChannelConfig = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string(),
  params: ChannelParams,
});
/**
 * Describes the Channel Config contract used by runtime configuration.
 */
export interface ChannelConfig extends z.infer<typeof ChannelConfig> {}

/**
 * Configuration for the messaging subsystem.
 */
export const MessagingConfig = z.object({
  default_channel_id: z.string(),
  max_visible_steps: z.number().int().positive().default(32),
  channels: z.array(ChannelConfig),
  feishu_developers: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
});
/**
 * Describes the Messaging Config contract used by runtime configuration.
 */
export interface MessagingConfig extends z.infer<typeof MessagingConfig> {}

export const GroupActivationFollowupSenders = z.enum([
  "requester_only",
  "requester_and_reporters",
]);
export type GroupActivationFollowupSenders = z.infer<
  typeof GroupActivationFollowupSenders
>;

export const SessionConfig = z.object({
  coalesce_idle_ms: z.number().int().positive().default(1200),
  coalesce_max_wait_ms: z.number().int().positive().default(5000),
  max_batch_size: z.number().int().positive().default(8),
  max_task_actions_per_batch: z.number().int().positive().default(3),
  processing_notice_after_ms: z.number().int().positive().default(1500),
  stale_claim_ms: z.number().int().positive().default(120000),
  turn_warn_after_ms: z.number().int().positive().default(120000),
  max_queue_depth: z.number().int().positive().default(50),
  activation_context_window_ms: z.number().int().nonnegative().default(300000),
  activation_context_max_messages: z.number().int().nonnegative().default(12),
  activation_context_max_chars: z.number().int().nonnegative().default(6000),
  activation_context_recent_unprocessed_messages: z
    .number()
    .int()
    .nonnegative()
    .default(10),
  activation_context_max_cc_reporters: z
    .number()
    .int()
    .nonnegative()
    .default(1),
  group_activation_followup_window_ms: z
    .number()
    .int()
    .nonnegative()
    .default(300000),
  group_activation_followup_senders: GroupActivationFollowupSenders.default(
    "requester_and_reporters",
  ),
  group_activation_followup_max_messages: z.number().int().nonnegative().default(8),
  group_activation_followup_recent_messages: z
    .number()
    .int()
    .nonnegative()
    .default(3),
  group_activation_followup_interrupt_on_other_user: z.boolean().default(true),
  group_bot_aliases: z.array(z.string().trim().min(1)).default([]),
}).strict();
export interface SessionConfig extends z.infer<typeof SessionConfig> {}

export const ServiceConfig = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().max(65535).default(8090),
  publicUrl: z.string().optional(),
}).strict();
export interface ServiceConfig extends z.infer<typeof ServiceConfig> {}

export const PathsConfig = z.object({
  repoRoot: z.string().optional(),
  runtimeDir: z.string().optional(),
  artifactsDir: z.string().optional(),
  runnersDir: z.string().optional(),
  sharedWorkspaceDir: z.string().optional(),
}).strict();
export interface PathsConfig extends z.infer<typeof PathsConfig> {}

export const LoggingConfig = z.object({
  level: z.string().default("info"),
  pretty: z.boolean().default(false),
}).strict();
export interface LoggingConfig extends z.infer<typeof LoggingConfig> {}

export const PluginMarketplaceConfig = z.object({
  gitUrl: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).default("main"),
}).strict();
export interface PluginMarketplaceConfig
  extends z.infer<typeof PluginMarketplaceConfig> {}

export const PluginsConfig = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  marketplace: PluginMarketplaceConfig.default(() =>
    PluginMarketplaceConfig.parse({}),
  ),
}).strict();
export interface PluginsConfig extends z.infer<typeof PluginsConfig> {}


export const SandboxConfig = z.object({
  /** Override the private Runtime client file under the Luna home. */
  runtimeConfigFile: z.string().min(1).optional(),
  /** Maximum running time in ms before force-reaping a container. */
  containerTimeoutMs: z.number().int().positive().default(30 * 60 * 1000),
}).strict();
export interface SandboxConfig extends z.infer<typeof SandboxConfig> {}

export const RunnerConfig = z.object({
  /** Additional retries allowed for consecutive transient provider failures. */
  maxTransientRetries: z.number().int().nonnegative().max(10).default(5),
}).strict();
export interface RunnerConfig extends z.infer<typeof RunnerConfig> {}

const GitIdentityValue = z.string().trim().min(1).refine(
  (value) => !/[\0\r\n]/.test(value),
  "Git identity values must not contain control characters",
);

export const GitConfig = z.object({
  /** Commit author name exposed to Work and Task Runner Git processes. */
  authorName: GitIdentityValue,
  /** Commit author email exposed to Work and Task Runner Git processes. */
  authorEmail: GitIdentityValue,
}).strict();
export interface GitConfig extends z.infer<typeof GitConfig> {}

/** Agent memory maintenance. A value of 0 turns the corresponding run off. */
export const MemoryConfig = z.object({
  /** A session is reflected on after its last human message is this old. */
  reflection_idle_ms: z.number().int().nonnegative().default(30 * 60 * 1000),
  /** Minimum time between consolidation runs of one Agent. */
  consolidation_interval_ms: z.number().int().nonnegative().default(24 * 60 * 60 * 1000),
  /** A non-core entry nobody read or changed for this long is archived. */
  forget_unused_ms: z.number().int().nonnegative().default(180 * 24 * 60 * 60 * 1000),
  /** An episode this old, and not read since, is archived; 0 keeps episodes. */
  episode_retention_ms: z.number().int().nonnegative().default(90 * 24 * 60 * 60 * 1000),
  /** Most entries recalled into one turn. */
  recall_limit: z.number().int().nonnegative().default(8),
  /** Most active core entries shared by all Shadows of one Agent. */
  core_limit: z.number().int().positive().default(30),
  /** Most active core entries private to one Shadow. */
  shadow_core_limit: z.number().int().nonnegative().default(10),
  /** Most active persona entries of one Shadow; each is told in full to every conversation. */
  persona_limit: z.number().int().positive().default(5),
});

/**
 * Top-level application configuration loaded from config.yaml.
 */
export const AppConfig = z.object({
  /** IANA timezone identifier, e.g. `"Asia/Shanghai"`. Defaults to the system timezone. */
  timezone: z
    .string()
    .default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  service: ServiceConfig.default(() => ServiceConfig.parse({})),
  paths: PathsConfig.default(() => PathsConfig.parse({})),
  logging: LoggingConfig.default(() => LoggingConfig.parse({})),
  plugins: PluginsConfig.default(() => PluginsConfig.parse({})),
  messaging: MessagingConfig.default({default_channel_id:"",channels:[],max_visible_steps:32}),
  session: SessionConfig.default(() => SessionConfig.parse({})),
  memory: MemoryConfig.default(() => MemoryConfig.parse({})),
  sandbox: SandboxConfig.default(() => SandboxConfig.parse({})),
  runner: RunnerConfig.default(() => RunnerConfig.parse({})),
  git: GitConfig.optional(),
}).strict();
/**
 * Describes the App Config contract used by runtime configuration.
 */
export interface AppConfig extends z.infer<typeof AppConfig> {}
