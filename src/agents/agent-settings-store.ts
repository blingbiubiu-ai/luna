import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "@/data";
import { agentSettings, sessions } from "@/data/schema";
import {
  PlatformSettingsStore,
  QuietHoursWindow,
  type PlatformProactivitySettings,
} from "@/platform/platform-settings-store";
import type { SessionConfig } from "@/shared";
import { AgentError, AgentStore } from "./agent-store";

const ProgressCardStyle = z.enum(["card", "native"]);
const count = (max: number) => z.number().int().min(0).max(max).optional();
const duration = (min: number, max: number) => z.number().int().min(min).max(max).optional();

/**
 * How incoming messages become Runner turns. Every field is optional: one left out follows the
 * Service configuration (`session` in the config file), which is also what the Dashboard shows as its default.
 */
const MessageSettings = z.object({
  /** A lone message waits this long for the sender's next one before its turn starts. */
  coalesceIdleMs: duration(100, 60_000),
  /** Messages are gathered into one turn for at most this long after the first. */
  coalesceMaxWaitMs: duration(100, 300_000),
  /** Most messages one turn takes. */
  maxBatchSize: z.number().int().min(1).max(50).optional(),
  /** A group message starting with one of these names addresses the Agent like an @ mention. */
  groupBotAliases: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
  /** After someone addresses the Agent in a group, how long their next messages count as addressed without an @ (0 turns this off). */
  followupWindowMs: duration(0, 3_600_000),
  /** Most such follow-up messages after one activation. */
  followupMaxMessages: count(50),
  /** Whose messages count as follow-ups: the person who addressed the Agent, or also people who reported to it. */
  followupSenders: z.enum(["requester_only", "requester_and_reporters"]).optional(),
  /** Someone else speaking ends the follow-up. */
  followupInterruptOnOtherUser: z.boolean().optional(),
  /** Recent messages a follow-up decision, and an explicit activation's context, look back over. */
  followupRecentMessages: count(20),
  /** Group messages before an activation that are given to the Runner as context: how far back, how many and how much text. */
  contextWindowMs: duration(0, 86_400_000),
  contextMaxMessages: count(100),
  contextMaxChars: count(50_000),
  /** Earlier messages never sent to a Runner that an activation may still take when its window holds too few. */
  contextRecentUnprocessedMessages: count(100),
}).strict();
export type MessageSettings = z.infer<typeof MessageSettings>;

/** Which `session` configuration key each message setting overrides. */
const MESSAGE_SETTING_KEYS = {
  coalesceIdleMs: "coalesce_idle_ms",
  coalesceMaxWaitMs: "coalesce_max_wait_ms",
  maxBatchSize: "max_batch_size",
  groupBotAliases: "group_bot_aliases",
  followupWindowMs: "group_activation_followup_window_ms",
  followupMaxMessages: "group_activation_followup_max_messages",
  followupSenders: "group_activation_followup_senders",
  followupInterruptOnOtherUser: "group_activation_followup_interrupt_on_other_user",
  followupRecentMessages: "group_activation_followup_recent_messages",
  contextWindowMs: "activation_context_window_ms",
  contextMaxMessages: "activation_context_max_messages",
  contextMaxChars: "activation_context_max_chars",
  contextRecentUnprocessedMessages: "activation_context_recent_unprocessed_messages",
} as const satisfies Record<keyof MessageSettings, keyof SessionConfig>;

/** The message settings an Agent gets when it sets none: the Service configuration. */
export function messageDefaults(base: SessionConfig): Required<MessageSettings> {
  return Object.fromEntries(Object.entries(MESSAGE_SETTING_KEYS).map(([field, key]) => [field, base[key]])) as Required<MessageSettings>;
}

/** The Service session configuration with an Agent's own message settings in place of the defaults. */
export function sessionConfigForAgent(db: DrizzleDB, agentId: string | null | undefined, base: SessionConfig): SessionConfig {
  if (!agentId) return base;
  const own = new AgentSettingsStore(db).get(agentId).messages;
  const merged: Record<string, unknown> = { ...base };
  for (const [field, key] of Object.entries(MESSAGE_SETTING_KEYS)) {
    const value = own[field as keyof MessageSettings];
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as SessionConfig;
}

/** The session configuration for the Agent a session belongs to. */
export function sessionConfigForSession(db: DrizzleDB, sessionId: string, base: SessionConfig): SessionConfig {
  const row = db.select({ agentId: sessions.agent_id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  return sessionConfigForAgent(db, row?.agentId, base);
}

/**
 * An Agent's own settings. Each group fills in its defaults, so a stored value may omit
 * groups or fields added later; the defaults are today's behaviour.
 */
export const AgentSettings = z.object({
  /** Incoming messages: the reaction a channel adds while a message addressed to the Agent waits for its reply. */
  inbound: z.object({
    processingReaction: z.boolean().default(true),
  }).strict().default({ processingReaction: true }),
  /** Work sessions: the progress card Runtime keeps while a turn runs. */
  work: z.object({
    progressCard: z.object({
      show: z.boolean().default(true),
      style: ProgressCardStyle.default("card"),
    }).strict().default({ show: true, style: "card" }),
  }).strict().default({ progressCard: { show: true, style: "card" } }),
  /** Main: the progress card of a Task it starts, unless the Runner chooses otherwise. */
  main: z.object({
    taskProgressCard: z.object({
      send: z.boolean().default(true),
      style: ProgressCardStyle.default("native"),
    }).strict().default({ send: true, style: "native" }),
  }).strict().default({ taskProgressCard: { send: true, style: "native" } }),
  /** Interactive PTY execution: minutes an idle CLI TUI stays resident before sleeping (0 = never sleep). */
  pty: z.object({
    idleTimeoutMinutes: z.number().int().min(0).max(10080).default(10),
  }).strict().default({ idleTimeoutMinutes: 10 }),
  messages: MessageSettings.default({}),
  /**
   * Listening: in a group chat where it is switched on, messages nobody addressed to the Agent are gathered and
   * given to the Runner together, which answers only when it has reason to.
   */
  listening: z.object({
    /** Whether a group chat without its own switch is listened to. */
    defaultEnabled: z.boolean().default(false),
    /** A batch is given to the Runner once the chat has been quiet this long. */
    quietMs: z.number().int().min(5_000).max(3_600_000).default(30_000),
    /** Or once it holds this many messages. */
    batchSize: z.number().int().min(1).max(100).default(10),
    /** Or once its first message has waited this long. */
    maxWaitMs: z.number().int().min(10_000).max(3_600_000).default(180_000),
    /** Each listening turn that ends in silence doubles the quiet time, up to this. */
    backoffMaxMs: z.number().int().min(5_000).max(86_400_000).default(600_000),
    /** Most listening turns one chat gets in an hour. */
    maxTurnsPerHour: z.number().int().min(1).max(120).default(12),
  }).strict().default({ defaultEnabled: false, quietMs: 30_000, batchSize: 10, maxWaitMs: 180_000, backoffMaxMs: 600_000, maxTurnsPerHour: 12 }),
  /**
   * Proactivity overrides: `null` or omitted inherits `PlatformRuntimeSettings.proactivity`.
   * For `quietHours`, `false` explicitly disables quiet hours even when platform defaults enable them.
   */
  proactivity: z.object({
    heartbeatIntervalMs: z.number().int().min(0).max(30 * 86_400_000).nullable().optional(),
    heartbeatApprovalRequired: z.boolean().nullable().optional(),
    outboundPerSessionPerHour: z.number().int().min(0).max(1_000).nullable().optional(),
    outboundPerRecipientPerDay: z.number().int().min(0).max(1_000).nullable().optional(),
    outboundDedupWindowMs: z.number().int().min(0).max(30 * 86_400_000).nullable().optional(),
    quietHours: z.union([QuietHoursWindow, z.literal(false)]).nullable().optional(),
    askDefaultExpiresMs: z.number().int().min(60_000).max(30 * 86_400_000).nullable().optional(),
    scheduleFailureNotifyIntervalMs: z.number().int().min(0).max(30 * 86_400_000).nullable().optional(),
  }).strict().default({}),
}).strict();
export type AgentSettings = z.infer<typeof AgentSettings>;

/** Resolves effective proactivity settings for an Agent (`Agent override ?? Platform default`). */
export function resolveProactivitySettings(
  db: DrizzleDB,
  agentId: string | null | undefined,
): PlatformProactivitySettings {
  const defaults = new PlatformSettingsStore(db).get().proactivity;
  if (!agentId) return defaults;
  const own = new AgentSettingsStore(db).get(agentId).proactivity;
  return {
    heartbeatIntervalMs: own.heartbeatIntervalMs ?? defaults.heartbeatIntervalMs,
    heartbeatApprovalRequired:
      own.heartbeatApprovalRequired ?? defaults.heartbeatApprovalRequired,
    outboundPerSessionPerHour: own.outboundPerSessionPerHour ?? defaults.outboundPerSessionPerHour,
    outboundPerRecipientPerDay: own.outboundPerRecipientPerDay ?? defaults.outboundPerRecipientPerDay,
    outboundDedupWindowMs: own.outboundDedupWindowMs ?? defaults.outboundDedupWindowMs,
    quietHours:
      own.quietHours === false
        ? null
        : own.quietHours !== undefined && own.quietHours !== null
          ? own.quietHours
          : defaults.quietHours,
    askDefaultExpiresMs: own.askDefaultExpiresMs ?? defaults.askDefaultExpiresMs,
    scheduleFailureNotifyIntervalMs:
      own.scheduleFailureNotifyIntervalMs ?? defaults.scheduleFailureNotifyIntervalMs,
  };
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = AgentSettings.parse({});

/** Read by runtime code for any Agent; read and changed by the Agent's owner. */
export class AgentSettingsStore {
  constructor(private readonly db: DrizzleDB) {}

  get(agentId: string): AgentSettings {
    const row = this.db.select().from(agentSettings).where(eq(agentSettings.agentId, agentId)).get();
    if (!row) return DEFAULT_AGENT_SETTINGS;
    const raw = row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? (({ task: _retiredTask, ...rest }) => rest)(row.settings as Record<string, unknown>)
      : row.settings;
    const parsed = AgentSettings.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_AGENT_SETTINGS;
  }

  read(accountId: string, agentId: string): AgentSettings {
    new AgentStore(this.db).requireOwner(accountId, agentId);
    return this.get(agentId);
  }

  /** `base` is the Service session configuration, against which the message settings are checked. */
  save(accountId: string, agentId: string, input: unknown, base?: SessionConfig): AgentSettings {
    const settings = AgentSettings.parse(input);
    if (base) {
      const idle = settings.messages.coalesceIdleMs ?? base.coalesce_idle_ms;
      const maxWait = settings.messages.coalesceMaxWaitMs ?? base.coalesce_max_wait_ms;
      if (maxWait < idle) throw new AgentError("invalid_message_coalesce", 400);
    }
    return this.db.transaction(() => {
      new AgentStore(this.db).requireOwner(accountId, agentId);
      const values = { agentId, settings, updatedByAccountId: accountId, updatedAt: Date.now() };
      this.db.insert(agentSettings).values(values).onConflictDoUpdate({ target: agentSettings.agentId, set: values }).run();
      return this.get(agentId);
    });
  }
}
