import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import {
  channelIdentities,
  messages,
  sessionTimelineEntries,
  type sessions,
} from "@/data/schema";
import type { SessionDisplayTitleMessage } from "@/dashboard-api/session-display-title";
import type { DashboardMessageProjection } from "@/dashboard-api/sessions";

type SessionRow = typeof sessions.$inferSelect;

/**
 * Loads only the scalar user-sender columns needed by `resolveSessionDisplayTitle`
 * for P2P chats, avoiding reading or JSON-parsing `content_json` / `raw_payload_json`.
 */
export function selectSessionDisplayTitleMessages(
  db: DrizzleDB,
  sessionIds: readonly string[],
): SessionDisplayTitleMessage[] {
  const uniqueIds = [...new Set(sessionIds)];
  if (uniqueIds.length === 0) return [];
  return db
    .select({
      id: messages.id,
      sessionId: sessionTimelineEntries.sessionId,
      role: messages.role,
      senderExternalId: channelIdentities.externalId,
      createdAt: sql<number>`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.occurredAt} ELSE ${sessionTimelineEntries.createdAt} END`,
    })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .innerJoin(channelIdentities, eq(channelIdentities.id, messages.senderIdentityId))
    .where(
      and(
        eq(messages.role, "user"),
        inArray(sessionTimelineEntries.sessionId, uniqueIds),
      ),
    )
    .all();
}

const NON_INTERNAL_MESSAGE_SQL = sql`
  COALESCE(${messages.presentationKind}, '') != 'internal'
  AND COALESCE(
    CASE
      WHEN ${messages.rawPayloadJson} IS NOT NULL AND json_valid(${messages.rawPayloadJson})
        THEN json_extract(${messages.rawPayloadJson}, '$.origin')
      ELSE NULL
    END,
    ''
  ) NOT IN ('main_runner_action_marker', 'main_runner_action_reply_marker', 'task_result_event')
`;

/**
 * Computes per-session non-internal message counts and fetches ONLY the boundary
 * message rows (latest message per session + thread anchor candidates) needed by
 * `GET /api/sessions` list items, avoiding full-table scans over `messages`.
 */
export function selectDashboardSessionListMessageData(
  db: DrizzleDB,
  sessionRows: readonly SessionRow[],
): {
  readonly messageCountBySessionId: ReadonlyMap<string, number>;
  readonly boundaryTimelineRows: DashboardMessageProjection[];
  readonly displayTitleMessages: SessionDisplayTitleMessage[];
} {
  if (sessionRows.length === 0) {
    return {
      messageCountBySessionId: new Map(),
      boundaryTimelineRows: [],
      displayTitleMessages: [],
    };
  }
  const sessionIds = [...new Set(sessionRows.map((row) => row.id))];

  // 1. Exact non-internal message counts per session (deduped by entry.id, which is PK).
  const countRows = db
    .select({
      sessionId: sessionTimelineEntries.sessionId,
      count: sql<number>`COUNT(*)`,
    })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .where(
      and(
        inArray(sessionTimelineEntries.sessionId, sessionIds),
        NON_INTERNAL_MESSAGE_SQL,
      ),
    )
    .groupBy(sessionTimelineEntries.sessionId)
    .all();
  const messageCountBySessionId = new Map(
    countRows.map((row) => [row.sessionId, Number(row.count)]),
  );

  // 2. Select only entry IDs for:
  //    - latest non-internal message per session (for preview, sender, timestamp)
  //    - earliest reference/message + explicit root_message_key matches on thread sessions
  const threadSessionIds = new Set(
    sessionRows
      .filter((s) => s.root_message_key !== null || s.thread_key !== null)
      .map((s) => s.id),
  );
  const rootKeys = [
    ...new Set(
      sessionRows
        .map((s) => s.root_message_key)
        .filter((k): k is string => k !== null && k.length > 0),
    ),
  ];

  const sessionIdListSql = sql.join(sessionIds.map((id) => sql`${id}`), sql`, `);
  const rankedQuery = sql<{ entry_id: string }>`
    WITH ranked AS (
      SELECT
        ste.id AS entry_id,
        ste.session_id AS session_id,
        ste.entry_kind AS entry_kind,
        m.id AS msg_id,
        m.external_message_id AS ext_msg_id,
        ROW_NUMBER() OVER (
          PARTITION BY ste.session_id
          ORDER BY
            (CASE WHEN m.deleted_at IS NULL THEN m.occurred_at ELSE ste.created_at END) DESC,
            ste.created_at DESC,
            ste.id DESC
        ) AS rn_latest,
        ROW_NUMBER() OVER (
          PARTITION BY ste.session_id, ste.entry_kind
          ORDER BY
            (CASE WHEN m.deleted_at IS NULL THEN m.occurred_at ELSE ste.created_at END) ASC,
            ste.created_at ASC,
            ste.id ASC
        ) AS rn_earliest_kind
      FROM session_timeline_entries ste
      INNER JOIN messages m ON m.id = ste.message_id
      WHERE ste.session_id IN (${sessionIdListSql})
        AND COALESCE(m.presentation_kind, '') != 'internal'
        AND COALESCE(
          CASE
            WHEN m.raw_payload_json IS NOT NULL AND json_valid(m.raw_payload_json)
              THEN json_extract(m.raw_payload_json, '$.origin')
            ELSE NULL
          END,
          ''
        ) NOT IN ('main_runner_action_marker', 'main_runner_action_reply_marker', 'task_result_event')
    )
    SELECT entry_id FROM ranked
    WHERE rn_latest = 1
      ${
        threadSessionIds.size > 0
          ? sql`OR (session_id IN (${sql.join([...threadSessionIds].map((id) => sql`${id}`), sql`, `)}) AND rn_earliest_kind = 1)`
          : sql``
      }
      ${
        rootKeys.length > 0
          ? sql`OR msg_id IN (${sql.join(rootKeys.map((k) => sql`${k}`), sql`, `)}) OR ext_msg_id IN (${sql.join(rootKeys.map((k) => sql`${k}`), sql`, `)})`
          : sql``
      }
  `;

  const boundaryEntryIds = db.all<{ entry_id: string }>(rankedQuery).map((r) => r.entry_id);
  const boundaryTimelineRows: DashboardMessageProjection[] =
    boundaryEntryIds.length === 0
      ? []
      : db
          .select({ entry: sessionTimelineEntries, row: messages })
          .from(sessionTimelineEntries)
          .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
          .where(inArray(sessionTimelineEntries.id, boundaryEntryIds))
          .all()
          .map((item) =>
            item.row.deletedAt === null
              ? item
              : {
                  ...item,
                  row: {
                    ...item.row,
                    occurredAt: item.entry.createdAt,
                    createdAt: item.entry.createdAt,
                  },
                },
          )
          .sort(
            (left, right) =>
              left.row.occurredAt - right.row.occurredAt ||
              left.entry.createdAt - right.entry.createdAt ||
              left.entry.id.localeCompare(right.entry.id),
          );

  const displayTitleMessages = selectSessionDisplayTitleMessages(db, sessionIds);
  return {
    messageCountBySessionId,
    boundaryTimelineRows,
    displayTitleMessages,
  };
}

export interface SqlUserActivitySummary {
  readonly senderUserId: string;
  readonly messageCount: number;
  readonly sessionCount: number;
  readonly latestSessionId: string;
}

/**
 * Aggregates message count, distinct session count, and latest active session per user
 * directly in SQLite without loading or JSON-parsing message bodies.
 */
export function selectUserActivitySummaries(
  db: DrizzleDB,
  agentId: string,
): ReadonlyMap<string, SqlUserActivitySummary> {
  const rows = db.all<{
    sender_user_id: string;
    message_count: number;
    session_count: number;
    latest_session_id: string;
  }>(sql`
    WITH filtered AS (
      SELECT
        m.sender_user_id,
        ste.session_id,
        m.occurred_at,
        ste.created_at,
        ste.id AS entry_id
      FROM session_timeline_entries ste
      INNER JOIN messages m ON m.id = ste.message_id
      INNER JOIN sessions s ON s.id = ste.session_id
      WHERE m.agent_id = ${agentId}
        AND s.agent_id = ${agentId}
        AND ste.entry_kind = 'message'
        AND m.external_message_id NOT LIKE 'main-runner-action:%'
        AND COALESCE(
          CASE
            WHEN m.raw_payload_json IS NOT NULL AND json_valid(m.raw_payload_json)
              THEN json_extract(m.raw_payload_json, '$.origin')
            ELSE NULL
          END,
          ''
        ) NOT IN ('main_runner_action_marker', 'main_runner_action_reply_marker', 'task_result_event')
    ),
    agg AS (
      SELECT
        sender_user_id,
        COUNT(*) AS message_count,
        COUNT(DISTINCT session_id) AS session_count
      FROM filtered
      GROUP BY sender_user_id
    ),
    latest AS (
      SELECT
        sender_user_id,
        session_id AS latest_session_id,
        ROW_NUMBER() OVER (
          PARTITION BY sender_user_id
          ORDER BY occurred_at DESC, created_at DESC, entry_id ASC
        ) AS rn
      FROM filtered
    )
    SELECT
      agg.sender_user_id,
      agg.message_count,
      agg.session_count,
      latest.latest_session_id
    FROM agg
    INNER JOIN latest ON latest.sender_user_id = agg.sender_user_id AND latest.rn = 1
  `);

  return new Map(
    rows.map((row) => [
      row.sender_user_id,
      {
        senderUserId: row.sender_user_id,
        messageCount: Number(row.message_count),
        sessionCount: Number(row.session_count),
        latestSessionId: row.latest_session_id,
      },
    ]),
  );
}
