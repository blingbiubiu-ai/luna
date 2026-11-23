import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { resolvePersistedSurfaceKind } from "@/channels/directory-store";
import { resolveProactivitySettings } from "@/agents/agent-settings-store";
import { isSelfRoutineOrigin } from "@/agents/self-routines";
import type { DrizzleDB } from "@/data";
import {
  channelSurfaces,
  correlatedRequests,
  directRecipients,
  messages,
  scheduleOccurrences,
  sessionCommands,
  sessions,
  sessionTurns,
  taskRuns,
  userIdentityLinks,
  users,
} from "@/data/schema";
import {
  PlatformSettingsStore,
  type QuietHoursWindow,
} from "@/platform/platform-settings-store";
import { GatewayError } from "@/server/gateway-error";
import { SessionTimelineEventStore } from "@/sessions/session-timeline-event-store";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface ProactiveGovernanceMetadata {
  readonly proactive: true;
  readonly contentHash: string;
  readonly recipientUserId?: string;
  readonly deferredUntil?: number;
}

export interface OutboundGovernanceDecision {
  readonly proactive: boolean;
  readonly status: "pending" | "deferred";
  readonly availableAt: number;
  readonly metadata?: ProactiveGovernanceMetadata;
}

export interface OutboundQuotaSnapshot {
  readonly heartbeatApprovalRequired: boolean;
  readonly sessionHourlyLimit: number;
  readonly sessionHourlyUsed: number;
  readonly sessionHourlyRemaining: number | null;
  readonly recipientDailyLimit: number;
  readonly quietHours: QuietHoursWindow | null;
  readonly inQuietHours: boolean;
  readonly quietHoursEndsAt: number | null;
}

function hashContent(text: string): string {
  return createHash("sha256")
    .update(text.trim().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Walks up to 5 hops along `originId` to classify whether a turn's root origin is
 * proactive (heartbeat, schedule, request-expiry, scheduled task.run, or unaddressed trigger)
 * vs passive (user-addressed turn) or ambient (listening, which owns its own budget).
 */
export function classifyOutboundOrigin(
  db: DrizzleDB,
  originId: string,
  depth = 0,
): "proactive" | "passive" | "ambient" {
  if (!originId || depth > 5) return "passive";
  if (originId.startsWith("schedule-failure:")) return "passive";
  if (isSelfRoutineOrigin(originId)) return "proactive";

  if (originId.startsWith("request-result:")) {
    const reqId = originId.slice("request-result:".length);
    const req = db
      .select()
      .from(correlatedRequests)
      .where(eq(correlatedRequests.id, reqId))
      .get();
    if (!req) return "proactive";
    if (req.status === "expired") return "proactive";
    if (req.originTurnId) {
      return classifyOutboundOrigin(db, req.originTurnId, depth + 1);
    }
    return "passive";
  }

  // Schedule occurrence origin (`<scheduleId>:<revision>:<scheduledAt>`).
  if (
    db
      .select({ id: scheduleOccurrences.id })
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.id, originId))
      .get()
  ) {
    return "proactive";
  }

  // Task result origin (`task-result:<taskRunId>:<sessionId>` or `task_result:...`).
  const taskResultMatch = /^task[-_]result:([^:]+):/.exec(originId);
  if (taskResultMatch?.[1]) {
    const run = db
      .select({ input: taskRuns.input_snapshot })
      .from(taskRuns)
      .where(eq(taskRuns.id, taskResultMatch[1]))
      .get();
    const op =
      run?.input && typeof run.input === "object" && "operation" in run.input
        ? (run.input as { operation?: unknown }).operation
        : undefined;
    return op === "task.run" ? "proactive" : "passive";
  }

  const turn = db
    .select({ reason: sessionTurns.reason })
    .from(sessionTurns)
    .where(eq(sessionTurns.id, originId))
    .get();
  if (turn?.reason === "ambient") return "ambient";
  if (turn?.reason === "addressed") return "passive";

  // Check if `originId` is a `session_commands` trigger row (e.g. handoff, schedule, routine).
  const cmd = db
    .select({
      originId: sessionCommands.originId,
      sourceSessionId: sessionCommands.sourceSessionId,
      sessionId: sessionCommands.sessionId,
    })
    .from(sessionCommands)
    .where(eq(sessionCommands.id, originId))
    .get();
  if (cmd) {
    if (cmd.originId && cmd.originId !== originId) {
      const upstream = classifyOutboundOrigin(db, cmd.originId, depth + 1);
      if (upstream === "proactive") return "proactive";
      if (upstream === "ambient") return "proactive";
      return "passive";
    }
    if (cmd.sourceSessionId !== cmd.sessionId) return "proactive";
  }

  return "passive";
}

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * If `now` falls inside `window` in `timezone`, returns the exact epoch ms when the quiet window ends;
 * otherwise returns `null`.
 */
export function resolveQuietHoursEnd(
  now: number,
  window: QuietHoursWindow | null,
  timezone: string,
): number | null {
  if (!window) return null;
  const startMin = parseMinutes(window.start);
  const endMin = parseMinutes(window.end);
  if (startMin === endMin) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (type: string) =>
    Number(parts.find(p => p.type === type)?.value ?? "0");
  const hour = get("hour") % 24;
  const minute = get("minute");
  const second = get("second");
  const curMin = hour * 60 + minute;

  const inside =
    startMin < endMin
      ? curMin >= startMin && curMin < endMin
      : curMin >= startMin || curMin < endMin;
  if (!inside) return null;

  const remainingMin =
    endMin > curMin ? endMin - curMin : 24 * 60 - curMin + endMin;
  const remainingMs = remainingMin * 60_000 - second * 1_000;
  return now + Math.max(1_000, remainingMs);
}

function resolveDirectRecipientUserId(
  db: DrizzleDB,
  target: typeof sessions.$inferSelect,
): string | undefined {
  if (target.thread_key) return undefined;
  const direct = db
    .select({ userId: userIdentityLinks.userId })
    .from(directRecipients)
    .innerJoin(
      userIdentityLinks,
      eq(userIdentityLinks.id, directRecipients.claimId),
    )
    .where(eq(directRecipients.sessionId, target.id))
    .get();
  if (direct?.userId) return direct.userId;

  if (!target.group_id) return undefined;
  const surface = db
    .select()
    .from(channelSurfaces)
    .where(
      and(
        eq(channelSurfaces.channelType, target.channel_type),
        eq(channelSurfaces.channelId, target.channel_id),
        eq(channelSurfaces.externalId, target.group_id),
      ),
    )
    .get();
  if (!surface || resolvePersistedSurfaceKind(surface) !== "p2p") {
    return undefined;
  }
  const humans = db
    .selectDistinct({ userId: messages.senderUserId })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderUserId))
    .where(
      and(
        eq(messages.ownerSessionId, target.id),
        isNull(messages.deletedAt),
        eq(users.kind, "human"),
      ),
    )
    .all();
  return humans.length === 1 ? humans[0]!.userId : undefined;
}

export function evaluateOutboundGovernance(
  db: DrizzleDB,
  input: {
    readonly target: typeof sessions.$inferSelect;
    readonly sourceSessionId: string;
    readonly originId: string;
    readonly purpose: "progress" | "answer" | "notification";
    readonly content: string;
    readonly requestedAvailableAt?: number | undefined;
    readonly now?: number | undefined;
  },
): OutboundGovernanceDecision {
  const now = input.now ?? Date.now();
  const baseAvailableAt = input.requestedAvailableAt ?? now;

  if (input.purpose === "progress") {
    return { proactive: false, status: "pending", availableAt: baseAvailableAt };
  }
  const classification = classifyOutboundOrigin(db, input.originId);
  if (classification !== "proactive") {
    return { proactive: false, status: "pending", availableAt: baseAvailableAt };
  }

  const settings = resolveProactivitySettings(db, input.target.agent_id);
  const contentHash = hashContent(input.content);
  const recipientUserId = resolveDirectRecipientUserId(db, input.target);
  const eventStore = new SessionTimelineEventStore(db);

  const recordThrottleEvent = (
    reasonKind:
      | "duplicate_content"
      | "session_hourly_limit"
      | "recipient_daily_limit",
    summary: string,
  ) => {
    eventStore.appendConversationControl({
      sessionId: input.target.id,
      eventType: "conversation_control",
      controlKind: "outbound_throttled",
      reasonKind,
      sourceMessageId: `${input.originId}:${contentHash.slice(0, 8)}`,
      anchorMessageId: input.originId,
      sessionSourceMessageId: input.sourceSessionId,
      turnId: input.originId,
      summary,
      payloadJson: {
        originId: input.originId,
        sourceSessionId: input.sourceSessionId,
        reasonKind,
      },
    });
  };

  // 1. 24h (configurable) content deduplication to the same target session.
  if (settings.outboundDedupWindowMs > 0) {
    const dup = db.get(sql`
      SELECT 1 FROM session_commands
      WHERE session_id = ${input.target.id}
        AND kind = 'message.send'
        AND status NOT IN ('cancelled', 'failed')
        AND created_at >= ${now - settings.outboundDedupWindowMs}
        AND json_extract(payload, '$.proactiveGovernance.proactive') = 1
        AND json_extract(payload, '$.proactiveGovernance.contentHash') = ${contentHash}
      LIMIT 1
    `);
    if (dup) {
      recordThrottleEvent(
        "duplicate_content",
        "主动发言被去重拦截：24 小时内已向该会话发送过相同内容。",
      );
      throw new GatewayError(
        "outbound_throttled",
        "Duplicate proactive message to this target within deduplication window",
        429,
      );
    }
  }

  // 2. Per-session hourly cap.
  if (settings.outboundPerSessionPerHour > 0) {
    const row = db.all<{ cnt: number }>(sql`
      SELECT count(*) AS cnt FROM session_commands
      WHERE session_id = ${input.target.id}
        AND kind = 'message.send'
        AND status NOT IN ('cancelled', 'failed')
        AND created_at >= ${now - HOUR_MS}
        AND json_extract(payload, '$.proactiveGovernance.proactive') = 1
    `)[0];
    if ((row?.cnt ?? 0) >= settings.outboundPerSessionPerHour) {
      recordThrottleEvent(
        "session_hourly_limit",
        `主动发言被限流：该会话过去 1 小时主动消息已达上限（${settings.outboundPerSessionPerHour} 条）。`,
      );
      throw new GatewayError(
        "outbound_throttled",
        `Session hourly proactive message limit (${settings.outboundPerSessionPerHour}) reached`,
        429,
      );
    }
  }

  // 3. Per-recipient daily direct cap.
  if (recipientUserId && settings.outboundPerRecipientPerDay > 0) {
    const row = db.all<{ cnt: number }>(sql`
      SELECT count(*) AS cnt FROM session_commands sc
      JOIN sessions s ON s.id = sc.session_id
      WHERE s.shadow_id = ${input.target.shadow_id}
        AND sc.kind = 'message.send'
        AND sc.status NOT IN ('cancelled', 'failed')
        AND sc.created_at >= ${now - DAY_MS}
        AND json_extract(sc.payload, '$.proactiveGovernance.proactive') = 1
        AND json_extract(sc.payload, '$.proactiveGovernance.recipientUserId') = ${recipientUserId}
    `)[0];
    if ((row?.cnt ?? 0) >= settings.outboundPerRecipientPerDay) {
      recordThrottleEvent(
        "recipient_daily_limit",
        `主动发言被限流：该接收人过去 24 小时主动私聊消息已达上限（${settings.outboundPerRecipientPerDay} 条）。`,
      );
      throw new GatewayError(
        "outbound_throttled",
        `Recipient daily proactive direct message limit (${settings.outboundPerRecipientPerDay}) reached`,
        429,
      );
    }
  }

  // 4. Quiet hours -> defer until window opens.
  const timezone = new PlatformSettingsStore(db).get().general.timezone;
  const quietEnd = resolveQuietHoursEnd(now, settings.quietHours, timezone);
  if (quietEnd !== null && quietEnd > baseAvailableAt) {
    eventStore.appendConversationControl({
      sessionId: input.target.id,
      eventType: "conversation_control",
      controlKind: "outbound_deferred",
      reasonKind: "quiet_hours",
      sourceMessageId: `${input.originId}:${contentHash.slice(0, 8)}`,
      anchorMessageId: input.originId,
      sessionSourceMessageId: input.sourceSessionId,
      turnId: input.originId,
      summary: `主动发言处于免打扰时段，已延后至 ${new Date(quietEnd).toISOString()} 投递。`,
      payloadJson: {
        originId: input.originId,
        deferredUntil: quietEnd,
      },
    });
    return {
      proactive: true,
      status: "deferred",
      availableAt: quietEnd,
      metadata: {
        proactive: true,
        contentHash,
        ...(recipientUserId ? { recipientUserId } : {}),
        deferredUntil: quietEnd,
      },
    };
  }

  return {
    proactive: true,
    status: "pending",
    availableAt: baseAvailableAt,
    metadata: {
      proactive: true,
      contentHash,
      ...(recipientUserId ? { recipientUserId } : {}),
    },
  };
}

export function inspectOutboundQuota(
  db: DrizzleDB,
  agentId: string,
  sessionId: string | null | undefined,
  now = Date.now(),
): OutboundQuotaSnapshot {
  const settings = resolveProactivitySettings(db, agentId);
  const timezone = new PlatformSettingsStore(db).get().general.timezone;
  const quietEnd = resolveQuietHoursEnd(now, settings.quietHours, timezone);

  let used = 0;
  if (sessionId) {
    const row = db.all<{ cnt: number }>(sql`
      SELECT count(*) AS cnt FROM session_commands
      WHERE session_id = ${sessionId}
        AND kind = 'message.send'
        AND status NOT IN ('cancelled', 'failed')
        AND created_at >= ${now - HOUR_MS}
        AND json_extract(payload, '$.proactiveGovernance.proactive') = 1
    `)[0];
    used = row?.cnt ?? 0;
  }

  return {
    heartbeatApprovalRequired: settings.heartbeatApprovalRequired,
    sessionHourlyLimit: settings.outboundPerSessionPerHour,
    sessionHourlyUsed: used,
    sessionHourlyRemaining:
      settings.outboundPerSessionPerHour > 0
        ? Math.max(0, settings.outboundPerSessionPerHour - used)
        : null,
    recipientDailyLimit: settings.outboundPerRecipientPerDay,
    quietHours: settings.quietHours,
    inQuietHours: quietEnd !== null,
    quietHoursEndsAt: quietEnd,
  };
}

export function releaseDeferredOutboundCommands(
  db: DrizzleDB,
  now = Date.now(),
): number {
  const due = db
    .select({ id: sessionCommands.id })
    .from(sessionCommands)
    .where(
      and(
        eq(sessionCommands.status, "deferred"),
        sql`${sessionCommands.availableAt} <= ${now}`,
      ),
    )
    .all();
  if (!due.length) return 0;
  db.update(sessionCommands)
    .set({ status: "pending", updatedAt: now })
    .where(
      and(
        inArray(
          sessionCommands.id,
          due.map(d => d.id),
        ),
        eq(sessionCommands.status, "deferred"),
      ),
    )
    .run();
  return due.length;
}
