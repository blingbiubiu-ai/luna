import {ResourceRouteAccess, activeShadowRoutineScope} from "../policy/resource-route-access";
import {AgentError} from "@/agents/agent-store";
import { deletedTaskReferences } from "@/dashboard-api/deleted-task-references";
import { deleteDashboardSession } from "@/dashboard-api/deletion";
import { createSessionChatRoutes } from "./session-chat";
import { loadDashboardUserRows } from "@/dashboard-api/user-display";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { scanArtifactRefs } from "@luna/service-client/artifact-ref";
import { ContextPackStore } from "@/context";
import type { DrizzleDB } from "@/data";
import { agentShadows, channelIdentities, channelSurfaces, directRecipients, messageMentions, messages, runnerContexts, sessionCommands, sessionInbox, sessionRunnerAttempts, sessionStates, sessionTimelineEntries, sessionTimelineEvents, sessionTurnEntries, sessionTurns, sessions, shadowBotBindings, taskSubscriptions, tasks, channelUserBindings, userIdentityLinks, users } from "@/data/schema";
import { resolveChannelSurfaceKind } from "@/dashboard-api/session-display-title";
import { dashboardTimelineItemCursor, isInternalMessage, toDashboardSession, toDashboardSessionConversationControlEvent, toDashboardSessionMessage, toDashboardSessionTimeline, toDashboardSessionTurn, type DashboardMessageProjection, type DashboardSessionTurn, type MessageRow, type SessionRunnerAttemptRow, type SessionRow, type SessionTurnRow } from "@/dashboard-api/sessions";
import { createDashboardArtifactSigner } from "@/dashboard-api/local-paths";
import { SessionTimelineTools } from "@/main-runner/session-timeline-tools";
import { ChatListeningStore } from "@/sessions/chat-listening-store";
import {
  requesterAccountIdFromContext,
  lunaAccessTokenClaimsFromContext,
} from "@/server/auth";
import { RunnerArtifactGrantStore } from "@/server/auth/runner-artifact-grant-store";

import { selectDashboardContextBundleRows } from "./dashboard-context-selection";
import { getKernel } from "./kernel";

export interface SessionsRouteOptions {
  readonly db?: DrizzleDB;
  readonly contextWorkerId?: (scope: { agentId: string; shadowId: string }, contextId: string) => string | null | undefined;
}

/**
 * Hono route collection for HTTP route DTO endpoints.
 */
export function createSessionsRoutes(options: SessionsRouteOptions = {}) {
  const routeDb = () => options.db ?? getKernel().database.db;
  const contextWorkerId = options.contextWorkerId ?? ((scope, contextId) => getKernel().executionRuntime?.contextWorkerId(scope, contextId));
  const access=(c:Context)=>new ResourceRouteAccess(routeDb());
  const guard=async(c:Context,next:()=>Promise<void>)=>{
    if(c.req.param("id")==="dashboard"&&c.req.method==="POST")return next();
    if (c.req.method === "DELETE") access(c).requireDeletion(c, "session", c.req.param("id")!);
    else access(c).require(c, "session", c.req.param("id")!);
    await next();
  };
  return new Hono()
    .onError((error,c)=>{if(error instanceof AgentError)return c.json({code:error.code},error.status);if(error instanceof HTTPException)return error.res ?? c.json({message:error.message},error.status);throw error;})
    .use("/:id",guard).use("/:id/*",guard)
  .route("/", createSessionChatRoutes(options))
  .delete("/:id", (c) => {
    deleteDashboardSession(routeDb(), c.req.param("id"));
    return c.json({ status: "ok" });
  })
  .get("/", (c) => {
    const db = routeDb();
    const artifactSigner = dashboardArtifactSignerForContext(c, db);
    const summaryOnly = c.req.query("view") === "summary";
    const sessionRows = db
      .select()
      .from(sessions)
      .where(access(c).listPredicate(c,"session"))
      .orderBy(desc(sessions.updated_at))
      .all();
    return c.json(dashboardSessionRows(db, sessionRows, artifactSigner, summaryOnly));
  })
  .get("/:id", c => {
    const db = routeDb();
    const row = requireSession(db, c.req.param("id"));
    const session = dashboardSessionRows(db, [row], dashboardArtifactSignerForContext(c, db))[0]!;
    if (!requesterAccountIdFromContext(c)) return c.json(session);
    const contexts = db.select({ id: runnerContexts.id }).from(runnerContexts)
      .where(and(eq(runnerContexts.owner_type, "session"), eq(runnerContexts.owner_id, row.id)))
      .orderBy(desc(runnerContexts.updated_at), desc(runnerContexts.id)).all();
    const scope = { agentId: row.agent_id, shadowId: row.shadow_id };
    const workerId = contexts.map(({ id }) => contextWorkerId(scope, id)).find(Boolean) ?? null;
    return c.json({ ...session, workerId });
  })
  .get("/:id/messages", (c) => {
    const sessionId = c.req.param("id");
    const db = routeDb();
    const artifactSigner = dashboardArtifactSignerForContext(c, db);
    const session = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (!session || session.status === "deleted") {
      throw new HTTPException(404, {
        message: `Session not found: ${sessionId}`,
      });
    }

    const messageRows = dashboardMessageProjectionsForSession(db, sessionId);
    const identityRows = db.select().from(channelIdentities).all();
    const userRows = loadDashboardUserRows(db);
    const channelUserBindingRows = db.select().from(channelUserBindings).all();
    const mentionRows = db.select().from(messageMentions).all();
    const sessionRows = db.select().from(sessions).all();
    const taskRows = db.select().from(tasks).all();
    const deletedTaskRefs = deletedTaskReferences(db);
    const sourceContextItems = new ContextPackStore(db).listTaskSourceItems();
    const turnEntryRows = db
      .select({ turn: sessionTurns, entry: sessionTurnEntries })
      .from(sessionTurnEntries)
      .innerJoin(sessionTurns, eq(sessionTurns.id, sessionTurnEntries.turn_id))
      .where(eq(sessionTurnEntries.session_id, sessionId))
      .all();
    const replyTargetExternalIds = dashboardReplyTargetExternalIds(messageRows);
    const commandReplyToByCommandId = selectCommandReplyToMap(db, sessionId);

    return c.json(
      messageRows.map((projection) =>
        toDashboardSessionMessage(projection, {
          identityRows,
          userRows,
          channelUserBindingRows,
          mentionRows,
          sessionRows,
          taskRows,
          deletedTaskRefs,
          sourceContextItems,
          turnEntryRows,
          replyTargetExternalIds,
          sessionProjections: messageRows,
          commandReplyToByCommandId,
          owningSessionIdForMessage: (messageId) =>
            owningSessionIdForMessage(db, messageId),
          artifactSigner,
        }),
      ),
    );
  })
  .get("/:id/timeline/read", (c) => {
    const sessionId = c.req.param("id");
    const db = routeDb();
    const claims = lunaAccessTokenClaimsFromContext(c);
    if (
      claims?.source === "runner" &&
      claims.role === "runner" &&
      claims.sessionId !== sessionId &&
      !activeShadowRoutineScope(db, claims)
    ) {
      throw new HTTPException(403, {
        message: "runner session access denied",
      });
    }
    requireSession(db, sessionId);
    const result = new SessionTimelineTools(db, {
      allowedSessionIds: [sessionId],
    }).readSessionTimeline({
      sessionId,
      ...optionalQueryString(c.req.query("beforeEntryId"), "beforeEntryId"),
      ...optionalQueryString(c.req.query("afterEntryId"), "afterEntryId"),
      ...optionalQueryNumber(c.req.query("limit"), "limit"),
      ...optionalIncludeReferences(c.req.query("includeReferences")),
    });
    if (claims?.source === "runner" && claims.role === "runner") {
      new RunnerArtifactGrantStore(db).grant(
        claims.tokenId,
        scanArtifactRefs(result.entries),
      );
    }
    return c.json(result);
  })
  .get("/:id/turns", (c) => {
    const sessionId = c.req.param("id");
    const db = routeDb();
    const session = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (!session || session.status === "deleted") {
      throw new HTTPException(404, {
        message: `Session not found: ${sessionId}`,
      });
    }

    return c.json(selectDashboardSessionTurns(db, sessionId));
  })
  .get("/:id/timeline", (c) => {
    const sessionId = c.req.param("id");
    const db = routeDb();
    const artifactSigner = dashboardArtifactSignerForContext(c, db);
    const session = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (!session || session.status === "deleted") {
      throw new HTTPException(404, {
        message: `Session not found: ${sessionId}`,
      });
    }

    const messageRows = dashboardMessageProjectionsForSession(db, sessionId);
    const identityRows = db.select().from(channelIdentities).all();
    const userRows = loadDashboardUserRows(db);
    const channelUserBindingRows = db.select().from(channelUserBindings).all();
    const mentionRows = db.select().from(messageMentions).all();
    const sessionRows = db.select().from(sessions).all();
    const taskRows = db.select().from(tasks).all();
    const deletedTaskRefs = deletedTaskReferences(db);
    const sourceContextItems = new ContextPackStore(db).listTaskSourceItems();
    const turns = selectDashboardSessionTurns(db, sessionId);
    const eventRows = selectDashboardSessionTimelineEventRows(db, sessionId);
    const turnEntryRows = db
      .select({ turn: sessionTurns, entry: sessionTurnEntries })
      .from(sessionTurnEntries)
      .innerJoin(sessionTurns, eq(sessionTurns.id, sessionTurnEntries.turn_id))
      .where(eq(sessionTurnEntries.session_id, sessionId))
      .all();
    const replyTargetExternalIds = dashboardReplyTargetExternalIds(messageRows);
    const commandReplyToByCommandId = selectCommandReplyToMap(db, sessionId);
    const sessionMessageDtos = messageRows.map((projection) =>
      toDashboardSessionMessage(projection, {
        identityRows,
        userRows,
        channelUserBindingRows,
        mentionRows,
        sessionRows,
        taskRows,
        deletedTaskRefs,
        sourceContextItems,
        turnEntryRows,
        replyTargetExternalIds,
        sessionProjections: messageRows,
        commandReplyToByCommandId,
        owningSessionIdForMessage: (messageId) =>
          owningSessionIdForMessage(db, messageId),
        artifactSigner,
      }),
    );

    const timeline = toDashboardSessionTimeline({
      messages: sessionMessageDtos,
      turns,
      events: eventRows.map((row) => toDashboardSessionConversationControlEvent(row)),
    });

    const rawLimit = c.req.query("limit");
    const before = c.req.query("before");
    if (rawLimit === undefined && before === undefined) {
      return c.json(timeline);
    }

    const limit = Number(rawLimit ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HTTPException(400, { message: "Timeline limit must be between 1 and 100" });
    }
    const end = before === undefined
      ? timeline.length
      : timeline.findIndex((item) => dashboardTimelineItemCursor(item) === before);
    if (end < 0) {
      throw new HTTPException(400, { message: "Unknown timeline cursor" });
    }
    const start = Math.max(0, end - limit);
    return c.json({
      items: timeline.slice(start, end),
      olderCursor: start > 0 ? dashboardTimelineItemCursor(timeline[start]!) : null,
    });
  });
}

export const sessionsRoutes = createSessionsRoutes();

function dashboardArtifactSignerForContext(c: Context, db: DrizzleDB) {
  return createDashboardArtifactSigner({
    db,
    requesterAccountId: requesterAccountIdFromContext(c),
    accessTokenClaims: lunaAccessTokenClaimsFromContext(c),
  });
}

function dashboardReplyTargetExternalIds(
  projections: readonly DashboardMessageProjection[],
): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const projection of projections) {
    const payload =
      typeof projection.row.rawPayloadJson === "object" &&
      projection.row.rawPayloadJson !== null &&
      !Array.isArray(projection.row.rawPayloadJson)
        ? projection.row.rawPayloadJson as Record<string, unknown>
        : null;
    const normalizedThread =
      payload !== null &&
      typeof payload.thread === "object" &&
      payload.thread !== null &&
      !Array.isArray(payload.thread)
        ? payload.thread as Record<string, unknown>
        : null;
    const rawPayload =
      payload !== null &&
      typeof payload.rawPayload === "object" &&
      payload.rawPayload !== null &&
      !Array.isArray(payload.rawPayload)
        ? payload.rawPayload as Record<string, unknown>
        : null;
    const rootMessageExternalId =
      stringRecordField(normalizedThread, "rootMessageExternalId") ??
      stringRecordField(rawPayload, "root_id");
    const parentMessageExternalId =
      stringRecordField(normalizedThread, "parentMessageExternalId") ??
      stringRecordField(rawPayload, "parent_id");
    if (rootMessageExternalId) {
      targets.add(rootMessageExternalId);
    }
    if (parentMessageExternalId) {
      targets.add(parentMessageExternalId);
    }
  }
  return targets;
}

function stringRecordField(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function selectCommandReplyToMap(
  db: DrizzleDB,
  sessionId: string,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const rows = db
    .select({ id: sessionCommands.id, payload: sessionCommands.payload })
    .from(sessionCommands)
    .where(and(eq(sessionCommands.sessionId, sessionId), eq(sessionCommands.kind, "message.send")))
    .all();
  for (const row of rows) {
    const reply =
      row.payload &&
      typeof row.payload === "object" &&
      "reply" in row.payload &&
      typeof row.payload.reply === "object" &&
      row.payload.reply !== null
        ? (row.payload.reply as Record<string, unknown>)
        : null;
    if (reply && typeof reply.replyTo === "string" && reply.replyTo.length > 0) {
      map.set(row.id, reply.replyTo);
    }
  }
  return map;
}

function dashboardSessionRows(
  db: DrizzleDB,
  sessionRows: SessionRow[],
  artifactSigner: ReturnType<typeof dashboardArtifactSignerForContext>,
  summaryOnly = false,
) {
  if (sessionRows.length === 0) return [];
  const sessionIdSet = new Set(sessionRows.map((row) => row.id));
  const missingParentIds = [...new Set(
    sessionRows
      .map((row) => row.parent_session_id)
      .filter((parentId): parentId is string => parentId !== null && !sessionIdSet.has(parentId)),
  )];
  const extraParentRows = missingParentIds.length
    ? db.select().from(sessions).where(and(inArray(sessions.id, missingParentIds), ne(sessions.status, "deleted"))).all()
    : [];
  const allSessionRows = [...sessionRows, ...extraParentRows];
  const sessionIds = sessionRows.map((row) => row.id);
  const shadowIds = [...new Set(sessionRows.map((row) => row.shadow_id))];
  const shadowNames = new Map(
    shadowIds.length
      ? db.select({ id: agentShadows.id, name: agentShadows.name }).from(agentShadows).where(inArray(agentShadows.id, shadowIds)).all().map((row) => [row.id, row.name])
      : [],
  );
  const bindingIds = [...new Set(sessionRows.flatMap(row => row.binding_id ? [row.binding_id] : []))];
  const bindingStatuses = new Map(bindingIds.length ? db.select({
    id: shadowBotBindings.id, status: shadowBotBindings.status,
  }).from(shadowBotBindings).where(inArray(shadowBotBindings.id, bindingIds)).all().map(row => [row.id, row.status]) : []);
  const timelineRows = selectDashboardTimelineRows(db);
  const surfaceRows = db.select().from(channelSurfaces).all();
  const identityRows = db.select().from(channelIdentities).all();
  const userRows = loadDashboardUserRows(db);
  const channelUserBindingRows = db.select().from(channelUserBindings).all();
  const directRecipientRows = db.select().from(directRecipients).all();
  const userIdentityLinkRows = db.select().from(userIdentityLinks).all();
  const taskRows = db.select().from(tasks).all();
  const deletedTaskRefs = deletedTaskReferences(db);
  const contextPackStore = new ContextPackStore(db);
  const sourceContextItems = contextPackStore.listTaskSourceItems();
  const subscriptionRows = db.select().from(taskSubscriptions).all();
  const contextBundleRows = selectDashboardContextBundleRows(
    db,
    "session",
    summaryOnly ? [] : sessionIds,
  );
  const listeningStore = new ChatListeningStore(db);
  const clarificationSessionIds = new Set(
    db.select({ sessionId: sessionStates.session_id, clarification: sessionStates.clarification_json })
      .from(sessionStates)
      .where(inArray(sessionStates.session_id, sessionIds))
      .all()
      .filter((row) => row.clarification !== null)
      .map((row) => row.sessionId),
  );
  const activeInboxSessionIds = new Set(
    db.select({ sessionId: sessionInbox.session_id })
      .from(sessionInbox)
      .where(and(
        inArray(sessionInbox.session_id, sessionIds),
        eq(sessionInbox.lane, "direct"),
        inArray(sessionInbox.status, ["pending", "claimed"]),
      ))
      .all()
      .map((row) => row.sessionId),
  );
  const turnStatusRows = db.select({
    sessionId: sessionTurns.session_id,
    status: sessionTurns.status,
    reason: sessionTurns.reason,
    startedAt: sessionTurns.started_at,
  })
    .from(sessionTurns)
    .where(inArray(sessionTurns.session_id, sessionIds))
    .orderBy(desc(sessionTurns.started_at))
    .all();
  const runningTurnSessionIds = new Set<string>();
  const latestNonAmbientTurnStatus = new Map<string, string>();
  for (const turn of turnStatusRows) {
    if (turn.status === "running" && turn.reason !== "ambient") {
      runningTurnSessionIds.add(turn.sessionId);
    }
    if (turn.reason !== "ambient" && !latestNonAmbientTurnStatus.has(turn.sessionId)) {
      latestNonAmbientTurnStatus.set(turn.sessionId, turn.status);
    }
  }

  return sessionRows.map((row) => {
    const surface = row.group_id === null
      ? undefined
      : surfaceRows.find(
          (candidate) =>
            candidate.channelType === row.channel_type &&
            candidate.channelId === row.channel_id &&
            candidate.externalId === row.group_id,
        );
    const isGroupMain =
      row.kind === "main" &&
      row.group_id !== null &&
      surface !== undefined &&
      resolveChannelSurfaceKind(surface) === "group";
    return toDashboardSession(row, {
      bindingStatus: row.binding_id ? bindingStatuses.get(row.binding_id) ?? null : null,
      shadowName: shadowNames.get(row.shadow_id) ?? null,
      listening: isGroupMain ? listeningStore.enabled(row) : null,
      hasPendingWork: activeInboxSessionIds.has(row.id) || runningTurnSessionIds.has(row.id),
      hasClarification: clarificationSessionIds.has(row.id),
      latestTurnFailed: latestNonAmbientTurnStatus.get(row.id) === "failed",
      sessionRows: allSessionRows,
      timelineRows,
      surfaceRows,
      identityRows,
      userRows,
      channelUserBindingRows,
      directRecipientRows,
      userIdentityLinkRows,
      taskRows,
      deletedTaskRefs,
      sourceContextItems,
      subscriptionRows,
      contextBundleRows,
      artifactSigner,
    });
  });
}

function requireSession(db: DrizzleDB, sessionId: string): SessionRow {
  const session = db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session || session.status === "deleted") {
    throw new HTTPException(404, {
      message: `Session not found: ${sessionId}`,
    });
  }
  return session;
}

function optionalQueryString<T extends string>(
  value: string | undefined,
  key: T,
): Record<T, string> {
  return value === undefined || value.length === 0
    ? ({} as Record<T, string>)
    : ({ [key]: value } as Record<T, string>);
}

function optionalQueryNumber<T extends string>(
  value: string | undefined,
  key: T,
): Record<T, number> {
  if (value === undefined || value.length === 0) {
    return {} as Record<T, number>;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? ({ [key]: parsed } as Record<T, number>)
    : ({} as Record<T, number>);
}

function optionalIncludeReferences(
  value: string | undefined,
): { readonly includeReferences?: boolean } {
  if (value === undefined || value.length === 0) {
    return {};
  }
  return { includeReferences: value !== "false" };
}

function dedupeDashboardMessageProjections(
  projections: readonly DashboardMessageProjection[],
): DashboardMessageProjection[] {
  const byEntryId = new Map<string, DashboardMessageProjection>();
  for (const projection of projections) {
    byEntryId.set(projection.entry.id, projection);
  }
  return [...byEntryId.values()];
}

function dashboardMessageProjectionsForSession(
  db: DrizzleDB,
  sessionId: string,
): DashboardMessageProjection[] {
  return selectDashboardTimelineRows(db, sessionId)
    .filter((projection) => !isInternalMessage(projection.row))
    .sort(compareDashboardMessageProjection);
}

export function selectDashboardTimelineRows(
  db: DrizzleDB,
  sessionId?: string,
): DashboardMessageProjection[] {
  const rows = db
    .select({ entry: sessionTimelineEntries, row: messages })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .orderBy(
      asc(messages.occurredAt),
      asc(sessionTimelineEntries.createdAt),
      asc(sessionTimelineEntries.id),
    )
    .all();
  return dedupeDashboardMessageProjections(
    rows.filter((item) =>
      sessionId === undefined ? true : item.entry.sessionId === sessionId,
    ).map(item => item.row.deletedAt === null ? item : { ...item, row: { ...item.row, occurredAt: item.entry.createdAt, createdAt: item.entry.createdAt } }),
  );
}

function compareDashboardMessageProjection(
  left: DashboardMessageProjection,
  right: DashboardMessageProjection,
): number {
  return (
    left.row.occurredAt - right.row.occurredAt ||
    left.entry.createdAt - right.entry.createdAt ||
    left.entry.id.localeCompare(right.entry.id)
  );
}

function owningSessionIdForMessage(
  db: DrizzleDB,
  messageId: string,
): string | null {
  return db.select({ owner: messages.ownerSessionId }).from(messages)
    .where(eq(messages.id, messageId)).get()?.owner ?? null;
}


function selectDashboardSessionTurnRows(
  db: DrizzleDB,
  sessionId: string,
): SessionTurnRow[] {
  return db
    .select()
    .from(sessionTurns)
    .where(eq(sessionTurns.session_id, sessionId))
    .orderBy(asc(sessionTurns.started_at))
    .all();
}

export function selectDashboardSessionTurns(
  db: DrizzleDB,
  sessionId: string,
): DashboardSessionTurn[] {
  const turnRows = selectDashboardSessionTurnRows(db, sessionId);
  const attemptRows = selectDashboardSessionRunnerAttemptRows(db, sessionId);
  const entryRows = db
    .select({ entry: sessionTurnEntries, timeline: sessionTimelineEntries })
    .from(sessionTurnEntries)
    .innerJoin(
      sessionTimelineEntries,
      eq(sessionTimelineEntries.id, sessionTurnEntries.entry_id),
    )
    .where(eq(sessionTurnEntries.session_id, sessionId))
    .orderBy(asc(sessionTurnEntries.created_at), asc(sessionTurnEntries.id))
    .all();
  return turnRows.map((row) =>
    toDashboardSessionTurn(row, entryRows, attemptRows),
  );
}

function selectDashboardSessionTimelineEventRows(
  db: DrizzleDB,
  sessionId: string,
): typeof sessionTimelineEvents.$inferSelect[] {
  return db
    .select()
    .from(sessionTimelineEvents)
    .where(eq(sessionTimelineEvents.sessionId, sessionId))
    .orderBy(
      asc(sessionTimelineEvents.createdAt),
      asc(sessionTimelineEvents.id),
    )
    .all();
}

function selectDashboardSessionRunnerAttemptRows(
  db: DrizzleDB,
  sessionId: string,
): SessionRunnerAttemptRow[] {
  return db
    .select()
    .from(sessionRunnerAttempts)
    .where(eq(sessionRunnerAttempts.sessionId, sessionId))
    .orderBy(
      asc(sessionRunnerAttempts.startedAt),
      asc(sessionRunnerAttempts.attemptIndex),
    )
    .all();
}
