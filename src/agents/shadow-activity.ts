import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { resolvePersistedSurfaceKind } from "@/channels/directory-store";
import type { DrizzleDB } from "@/data";
import {
  channelSurfaces,
  correlatedRequests,
  directRecipients,
  messages,
  scheduleOccurrences,
  sessionSchedules,
  sessions,
  taskRuns,
  userIdentityLinks,
  users,
} from "@/data/schema";

export type ShadowSessionSurfaceKind = "local" | "p2p" | "group" | "thread";

export interface ShadowSessionSummary {
  readonly sessionId: string;
  readonly title: string | null;
  readonly runnerKind: string;
  readonly surfaceKind: ShadowSessionSurfaceKind;
  readonly channelType: string;
  readonly channelId: string;
  readonly groupId: string | null;
  readonly parentSessionId: string | null;
  readonly participantUserIds: readonly string[];
  readonly lastActivityAt: number;
}

export interface ActivityMessageSessionItem {
  readonly sessionId: string;
  readonly title: string | null;
  readonly surfaceKind: ShadowSessionSurfaceKind;
  readonly messageCount: number;
  readonly latestMessageId: string;
  readonly latestMessageAt: number;
  readonly senderUserIds: readonly string[];
}

export interface ActivityTaskRunItem {
  readonly runId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly primarySessionId: string | null;
  readonly status: string;
  readonly finishedAt: number;
}

export interface ActivityScheduleOccurrenceItem {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly scheduleTitle: string;
  readonly targetSessionId: string;
  readonly actionKind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly scheduledAt: number;
  readonly createdAt: number;
}

export interface ActivityCorrelatedRequestItem {
  readonly requestId: string;
  readonly kind: "ask" | "handoff";
  readonly originSessionId: string;
  readonly targetSessionId: string;
  readonly status: string;
  readonly updatedAt: number;
}

export interface ShadowActivityReport {
  readonly shadowId: string;
  readonly since: number;
  readonly latestCursorAt: number;
  readonly hasWakeActivity: boolean;
  readonly messagesBySession: readonly ActivityMessageSessionItem[];
  readonly taskRuns: readonly ActivityTaskRunItem[];
  readonly scheduleOccurrences: readonly ActivityScheduleOccurrenceItem[];
  readonly correlatedRequests: readonly ActivityCorrelatedRequestItem[];
}

export function classifyShadowSessionSurface(
  row: typeof sessions.$inferSelect,
  surfaceByKey: ReadonlyMap<string, typeof channelSurfaces.$inferSelect>,
  directSessionIds: ReadonlySet<string>,
): ShadowSessionSurfaceKind {
  if (row.channel_type === "dashboard") return "local";
  if (row.thread_key) return "thread";
  if (directSessionIds.has(row.id)) return "p2p";
  if (row.group_id) {
    const surface = surfaceByKey.get(
      `${row.channel_type}:${row.channel_id}:${row.group_id}`,
    );
    if (surface && resolvePersistedSurfaceKind(surface) === "p2p") return "p2p";
    return "group";
  }
  return "local";
}

function loadSurfaceLookups(
  db: DrizzleDB,
  rows: readonly (typeof sessions.$inferSelect)[],
) {
  const sessionIds = rows.map(r => r.id);
  const directIds = new Set<string>(
    sessionIds.length
      ? db
          .select({ sessionId: directRecipients.sessionId })
          .from(directRecipients)
          .where(inArray(directRecipients.sessionId, sessionIds))
          .all()
          .map(r => r.sessionId)
      : [],
  );
  const groupIds = [
    ...new Set(rows.map(r => r.group_id).filter((v): v is string => Boolean(v))),
  ];
  const surfaceRows = groupIds.length
    ? db
        .select()
        .from(channelSurfaces)
        .where(inArray(channelSurfaces.externalId, groupIds))
        .all()
    : [];
  const surfaceByKey = new Map<string, typeof channelSurfaces.$inferSelect>();
  for (const s of surfaceRows) {
    surfaceByKey.set(`${s.channelType}:${s.channelId}:${s.externalId}`, s);
  }
  return { directIds, surfaceByKey };
}

export function listShadowSessions(
  db: DrizzleDB,
  shadowId: string,
  options: {
    readonly kind?: ShadowSessionSurfaceKind | undefined;
    readonly withUserId?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): ShadowSessionSummary[] {
  const rows = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.shadow_id, shadowId), eq(sessions.status, "active")))
    .orderBy(desc(sessions.last_activity_at), desc(sessions.updated_at))
    .all();
  if (!rows.length) return [];

  const { directIds, surfaceByKey } = loadSurfaceLookups(db, rows);
  const sessionIds = rows.map(r => r.id);

  // Gather human participants who have spoken in or are direct recipients of each session.
  const participantMap = new Map<string, Set<string>>();
  for (const r of db
    .selectDistinct({
      sessionId: messages.ownerSessionId,
      userId: messages.senderUserId,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderUserId))
    .where(
      and(
        inArray(messages.ownerSessionId, sessionIds),
        isNull(messages.deletedAt),
        eq(users.kind, "human"),
      ),
    )
    .all()) {
    if (!r.sessionId) continue;
    let set = participantMap.get(r.sessionId);
    if (!set) {
      set = new Set();
      participantMap.set(r.sessionId, set);
    }
    set.add(r.userId);
  }
  for (const d of db
    .select({
      sessionId: directRecipients.sessionId,
      userId: userIdentityLinks.userId,
    })
    .from(directRecipients)
    .innerJoin(userIdentityLinks, eq(userIdentityLinks.id, directRecipients.claimId))
    .where(inArray(directRecipients.sessionId, sessionIds))
    .all()) {
    if (!d.userId) continue;
    let set = participantMap.get(d.sessionId);
    if (!set) {
      set = new Set();
      participantMap.set(d.sessionId, set);
    }
    set.add(d.userId);
  }

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const summaries: ShadowSessionSummary[] = [];
  for (const row of rows) {
    const surfaceKind = classifyShadowSessionSurface(
      row,
      surfaceByKey,
      directIds,
    );
    if (options.kind && surfaceKind !== options.kind) continue;
    const participants = [...(participantMap.get(row.id) ?? [])];
    if (options.withUserId && !participants.includes(options.withUserId)) {
      continue;
    }
    // Resolve human-friendly surface title when session.title is unset.
    const surface = row.group_id
      ? surfaceByKey.get(
          `${row.channel_type}:${row.channel_id}:${row.group_id}`,
        )
      : undefined;
    const title = row.title ?? surface?.displayName ?? null;
    summaries.push({
      sessionId: row.id,
      title,
      runnerKind: row.kind,
      surfaceKind,
      channelType: row.channel_type,
      channelId: row.channel_id,
      groupId: row.group_id,
      parentSessionId: row.parent_session_id,
      participantUserIds: participants,
      lastActivityAt: row.last_activity_at || row.updated_at,
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
}

export function queryShadowActivity(
  db: DrizzleDB,
  shadowId: string,
  options: {
    readonly since: number;
    readonly limit?: number | undefined;
    readonly excludeSessionIds?: readonly string[] | undefined;
  },
): ShadowActivityReport {
  const since = Math.max(0, options.since);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const excluded = new Set(options.excludeSessionIds ?? []);

  const sessionRows = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.shadow_id, shadowId), eq(sessions.status, "active")))
    .all();
  const { directIds, surfaceByKey } = loadSurfaceLookups(db, sessionRows);
  const sessionById = new Map(sessionRows.map(s => [s.id, s]));

  // 1. Human inbound messages since `since` (never bot/shadow replies or self-routine local sessions).
  const msgRows = db.all<{
    messageId: string;
    sessionId: string;
    senderUserId: string;
    createdAt: number;
  }>(sql`
    SELECT m.id AS messageId, m.owner_session_id AS sessionId, m.sender_user_id AS senderUserId, m.created_at AS createdAt
    FROM messages m
    JOIN sessions s ON s.id = m.owner_session_id
    JOIN users u ON u.id = m.sender_user_id
    WHERE s.shadow_id = ${shadowId} AND s.status = 'active'
      AND m.role = 'user' AND m.deleted_at IS NULL
      AND u.kind = 'human' AND u.status = 'active'
      AND m.created_at > ${since}
    ORDER BY m.created_at ASC
  `);

  const msgGroup = new Map<
    string,
    {
      count: number;
      latestMessageId: string;
      latestMessageAt: number;
      senders: Set<string>;
    }
  >();
  let maxMsgAt = since;
  for (const row of msgRows) {
    if (excluded.has(row.sessionId)) continue;
    if (row.createdAt > maxMsgAt) maxMsgAt = row.createdAt;
    const existing = msgGroup.get(row.sessionId);
    if (!existing) {
      msgGroup.set(row.sessionId, {
        count: 1,
        latestMessageId: row.messageId,
        latestMessageAt: row.createdAt,
        senders: new Set([row.senderUserId]),
      });
    } else {
      existing.count++;
      existing.latestMessageId = row.messageId;
      existing.latestMessageAt = row.createdAt;
      existing.senders.add(row.senderUserId);
    }
  }

  const messagesBySession: ActivityMessageSessionItem[] = [...msgGroup.entries()]
    .sort((a, b) => b[1].latestMessageAt - a[1].latestMessageAt)
    .slice(0, limit)
    .map(([sessionId, info]) => {
      const s = sessionById.get(sessionId);
      const surface =
        s?.group_id
          ? surfaceByKey.get(`${s.channel_type}:${s.channel_id}:${s.group_id}`)
          : undefined;
      return {
        sessionId,
        title: s?.title ?? surface?.displayName ?? null,
        surfaceKind: s
          ? classifyShadowSessionSurface(s, surfaceByKey, directIds)
          : "local",
        messageCount: info.count,
        latestMessageId: info.latestMessageId,
        latestMessageAt: info.latestMessageAt,
        senderUserIds: [...info.senders],
      };
    });

  // 2. Settled Task Runs since `since`.
  const runRows = db.all<{
    runId: string;
    taskId: string;
    taskTitle: string;
    primarySessionId: string | null;
    status: string;
    finishedAt: number;
  }>(sql`
    SELECT r.id AS runId, r.task_id AS taskId, t.title AS taskTitle, t.primary_session_id AS primarySessionId,
      r.status AS status, coalesce(r.finished_at, r.started_at) AS finishedAt
    FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    WHERE t.shadow_id = ${shadowId}
      AND r.status IN ('completed', 'failed', 'cancelled')
      AND coalesce(r.finished_at, r.started_at) > ${since}
    ORDER BY coalesce(r.finished_at, r.started_at) DESC
    LIMIT ${limit}
  `);
  let maxRunAt = since;
  for (const r of runRows) {
    if (r.finishedAt > maxRunAt) maxRunAt = r.finishedAt;
  }

  // 3. Settled Schedule Occurrences since `since` (excluding `:missed` coalescing bookkeeping rows).
  const occRows = db.all<{
    occurrenceId: string;
    scheduleId: string;
    scheduleTitle: string;
    targetSessionId: string;
    actionJson: string;
    status: string;
    reason: string | null;
    scheduledAt: number;
    settledAt: number;
  }>(sql`
    SELECT o.id AS occurrenceId, o.schedule_id AS scheduleId, sc.title AS scheduleTitle,
      sc.target_session_id AS targetSessionId, sc.action AS actionJson,
      o.status AS status, o.reason AS reason, o.scheduledAt_alias AS scheduledAt, o.settledAt_alias AS settledAt
    FROM (
      SELECT o2.id, o2.schedule_id, o2.status, o2.reason, o2.scheduled_at AS scheduledAt_alias,
        coalesce(cmd.updated_at, o2.created_at) AS settledAt_alias
      FROM schedule_occurrences o2
      LEFT JOIN session_commands cmd ON cmd.id = o2.command_id
      WHERE o2.id NOT LIKE '%:missed'
        AND o2.status NOT IN ('pending', 'running')
    ) o
    JOIN session_schedules sc ON sc.id = o.schedule_id
    JOIN sessions s ON s.id = sc.target_session_id
    WHERE s.shadow_id = ${shadowId}
      AND o.settledAt_alias > ${since}
    ORDER BY o.settledAt_alias DESC
    LIMIT ${limit}
  `);
  let maxOccAt = since;
  const scheduleOccurrencesList: ActivityScheduleOccurrenceItem[] = occRows.map(
    row => {
      if (row.settledAt > maxOccAt) maxOccAt = row.settledAt;
      let actionKind = "unknown";
      try {
        const parsed =
          typeof row.actionJson === "string"
            ? JSON.parse(row.actionJson)
            : row.actionJson;
        if (parsed && typeof parsed === "object" && "kind" in parsed) {
          actionKind = String((parsed as { kind: unknown }).kind);
        }
      } catch {
        /* ignore malformed JSON */
      }
      return {
        occurrenceId: row.occurrenceId,
        scheduleId: row.scheduleId,
        scheduleTitle: row.scheduleTitle,
        targetSessionId: row.targetSessionId,
        actionKind,
        status: row.status,
        reason: row.reason,
        scheduledAt: row.scheduledAt,
        createdAt: row.settledAt,
      };
    },
  );

  // 4. Resolved correlated requests (for `luna activity`; does NOT drive `hasWakeActivity` to prevent handoff loops).
  const reqRows = db
    .select()
    .from(correlatedRequests)
    .where(
      and(
        eq(correlatedRequests.shadowId, shadowId),
        sql`${correlatedRequests.status} <> 'pending'`,
        sql`${correlatedRequests.updatedAt} > ${since}`,
      ),
    )
    .orderBy(desc(correlatedRequests.updatedAt))
    .limit(limit)
    .all();

  const correlatedList: ActivityCorrelatedRequestItem[] = reqRows.map(r => ({
    requestId: r.id,
    kind: r.kind,
    originSessionId: r.originSessionId,
    targetSessionId: r.targetSessionId,
    status: r.status,
    updatedAt: r.updatedAt,
  }));

  const hasWakeActivity =
    messagesBySession.length > 0 ||
    runRows.length > 0 ||
    scheduleOccurrencesList.length > 0;
  const latestCursorAt = Math.max(since, maxMsgAt, maxRunAt, maxOccAt);

  return {
    shadowId,
    since,
    latestCursorAt,
    hasWakeActivity,
    messagesBySession,
    taskRuns: runRows,
    scheduleOccurrences: scheduleOccurrencesList,
    correlatedRequests: correlatedList,
  };
}
