import {AgentError, AgentStore} from "@/agents/agent-store";
import { deleteDashboardUser } from "@/dashboard-api/deletion";
import { dashboardRequesterUserIdFromContext } from "../auth";
import { loadDashboardUserRows, type DisplayUserRow } from "@/dashboard-api/user-display";
import { grantInputFromBody } from "./authorization-rule-input";
import { and, asc, desc, eq, inArray, isNull, ne, notExists, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { DrizzleDB } from "@/data";
import {
  resolveGrantTarget,
  type OperationPolicy,
} from "@/operations/operation-registry";
import { resolveCanonicalUserRow } from "@/dashboard-api/identity";
import {
  agentShadows,
  channelConfigs,
  channelIdentities,
  channelUserBindings,
  channelSurfaces,
  groupMemberships,
  groups,
  messages,
  sessionTimelineEntries,
  sessions,
  userIdentityLinks,
  identityObservations,
  users,
} from "@/data/schema";

import { GroupStore, type GroupRecord } from "../groups/group-store";
import {
  AuthorizationRuleStore,
  type AuthorizationRuleRecord,
} from "../policy/authorization-rule-store";
import type { AuthorizationSubjectType } from "../policy/authorization-subject";
import { resolveSessionDisplayTitle } from "@/dashboard-api/session-display-title";
import { isGuardResponse, requireAdmin, requireDashboardOnly } from "../auth/guards";
import { isPlatformAdministrator } from "../policy/platform-administrator";
import { getKernel } from "./kernel";

type ChannelSurfaceRow = typeof channelSurfaces.$inferSelect;
type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
type UserRow = typeof users.$inferSelect;
type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect & {channelIdentityId: string | null};
type SessionRow = typeof sessions.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type SessionTimelineEntryRow = typeof sessionTimelineEntries.$inferSelect;

type TimelineMessageRow = {
  readonly entry: SessionTimelineEntryRow;
  readonly message: MessageRow;
};

export interface DashboardUserIdentityLink {
  readonly id: string;
  readonly channelIdentityId: string | null;
  readonly identityNamespace: string;
  readonly identityKind: string;
  readonly identityValue: string;
  readonly identityScope: string;
  readonly confidence: string;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly channelIdentity: {
    readonly id: string;
    readonly channelType: string;
    readonly channelId: string;
    readonly externalId: string;
    readonly identityKind: string;
    readonly displayName: string | null;
    readonly displayNameSource?: string;
  readonly avatarUrl: string | null;
  } | null;
}

export interface DashboardUser {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly displayNameSource?: string;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly profileSource: string;
  readonly linkedIdentities: DashboardUserIdentityLink[];
  readonly messageCount: number;
  readonly sessionCount: number;
  readonly latestSessionId: string | null;
  readonly latestSessionTitle: string | null;
  readonly groups: DashboardUserGroup[];
  readonly directGrants: AuthorizationRuleRecord[];
  readonly indirectGrants: DashboardIndirectOperationGrant[];
}

export interface DashboardUserGroup {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly displayNameSource?: string;
  readonly avatarUrl: string | null;
  readonly status: string;
}

export interface DashboardIndirectOperationGrant extends AuthorizationRuleRecord {
  readonly sourceGroup: DashboardUserGroup;
}

type UserActivitySummary = {
  messageCount: number;
  readonly sessionIds: Set<string>;
  latestSession: SessionRow | null;
  latestActivityAt: number;
};

type DashboardUserContext = {
  readonly agentId: string;
  readonly groupStore: GroupStore;
  readonly grantStore: AuthorizationRuleStore;
  readonly userRows: readonly DisplayUserRow[];
  readonly surfaceRows: readonly ChannelSurfaceRow[];
  readonly channelIdentityRows: readonly ChannelIdentityRow[];
  readonly timelineRows: readonly TimelineMessageRow[];
  readonly linksByUserId: ReadonlyMap<string, readonly UserIdentityLinkRow[]>;
  readonly channelIdentityById: ReadonlyMap<string, ChannelIdentityRow>;
  readonly activityByUserId: ReadonlyMap<string, UserActivitySummary>;
};

export interface UsersRouteOptions {
  readonly db?: DrizzleDB;
}

export function createUsersRoutes(options: UsersRouteOptions = {}) {
  const getDb = () => options.db ?? getKernel().database.db;

  return new Hono()
    .onError((error, c) => {
      if (error instanceof AgentError) return c.json({code: error.code}, error.status);
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    })
    .use("*", async (c, next) => {
      // Users belong to an Agent's directory: the Agent owner manages memberships and grants.
      const auth = requireDashboardOnly(c);
      if (isGuardResponse(auth)) return auth;
      await next();
    })
    .get("/", (c) => {
      const db = getDb();
      const {id: agentId, ownerUserId} = requireUserDirectoryAgent(c, db);
      const hiddenShadows = db.select({ id: agentShadows.id }).from(agentShadows).where(and(
        eq(agentShadows.replyUserId, users.id),
        eq(agentShadows.status, "deleted"),
      ));
      const userRows = db
        .select()
        .from(users)
        .where(and(eq(users.status, "active"), isNull(users.mergedIntoUserId), notExists(hiddenShadows),
          agentUserVisibility(db, agentId, ownerUserId)))
        .orderBy(desc(users.updatedAt), asc(users.displayName), asc(users.id))
        .all();
      const context = loadDashboardUserContext(db, agentId, ownerUserId);

      return c.json({
        users: userRows.map((row) =>
          toDashboardUser(row, context.activityByUserId.get(row.id), context),
        ),
      });
    })
    .delete("/:id", (c) => {
      // Deleting a user removes a platform-wide account, so it stays admin-only.
      const admin = requireAdmin(c);
      if (isGuardResponse(admin)) return admin;
      deleteDashboardUser(getDb(), c.req.param("id"), dashboardRequesterUserIdFromContext(c));
      return c.json({ status: "ok" });
    })
    .post("/:id/group-memberships", async (c) => {
      const db = getDb();
      const targetUserId = c.req.param("id");
      requireUserRow(db, targetUserId);
      const body = await readBody(c.req.raw);
      const groupStore = new GroupStore(db);
      const group = groupStore.requireGroup(requiredString(body.groupId, "groupId"));
      const requesterId = dashboardRequesterUserIdFromContext(c)!;
      const agent = new AgentStore(db).requireOwner(requesterId, group.agentId);
      if (!isPlatformAdministrator(db, requesterId)) {
        requireAgentUser(db, agent.id, agent.ownerUserId, targetUserId);
      }
      const membership = groupStore.addMember({
        groupId: group.id,
        userId: targetUserId,
        role: parseGroupRole(body.role),
      });
      return c.json({ status: "ok", membership });
    })
    .delete("/:id/group-memberships/:groupId", (c) => {
      const db = getDb();
      requireUserRow(db, c.req.param("id"));
      const groupStore = new GroupStore(db);
      const group = groupStore.requireGroup(c.req.param("groupId"));
      new AgentStore(db).requireOwner(dashboardRequesterUserIdFromContext(c)!, group.agentId);
      const removed = groupStore.removeMember({
        groupId: group.id,
        userId: c.req.param("id"),
      });
      if (removed === null) {
        return c.json(
          {
            status: "error",
            code: "not_found",
            message: `Group membership not found: ${c.req.param("groupId")}:${c.req.param("id")}`,
          },
          404,
        );
      }
      return c.json({ status: "ok", membership: removed });
    })
    // Grants on the Users page are scoped to the Agent in ?agentId, like group grants.
    .post("/:id/authorization-rules/batch", async (c) => {
      const db = getDb();
      const {id: agentId, ownerUserId} = requireUserDirectoryAgent(c, db);
      const row = requireAgentUser(db, agentId, ownerUserId, c.req.param("id"));
      const body = await readBody(c.req.raw);
      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new HTTPException(400, {message: "Authorization rules are required"});
      }
      const rules = body.items.map((item, index) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new HTTPException(400, {message: `Invalid authorization rule at index ${index}`});
        }
        const input = grantInputFromBody({...item, subjectType: "user", subjectId: row.id});
        const validation = validateOperationGrantTarget({
          db,
          subjectType: "user",
          target: input.matchType === "prefix" ? `${input.target.replace(/\.\*$/, "")}.*` : input.target,
        });
        if (validation.status === "error") throw new HTTPException(400, {message: validation.message});
        return input;
      });
      const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId}).addGrants(rules);
      return c.json({grants});
    })
    .delete("/:id/authorization-rules/:grantId", (c) => {
      const db = getDb();
      const {id: agentId, ownerUserId} = requireUserDirectoryAgent(c, db);
      const requestedId = c.req.param("id");
      const row = requireUserRow(db, requestedId, true);
      const canonicalRow = resolveCanonicalUserRow(requestedId, loadDashboardUserRows(db)) ?? row;
      if (!db.select({ id: users.id }).from(users)
        .where(and(eq(users.id, canonicalRow.id), agentUserVisibility(db, agentId, ownerUserId))).get()) {
        throw new HTTPException(404, {message: "User authorization rule not found"});
      }
      const store = new AuthorizationRuleStore(db, {kind: "agent", agentId});
      const id = c.req.param("grantId");
      const subjectIds = new Set([row.id, canonicalRow.id]);
      const rule = store.listGrants().find(item => item.subjectType === "user" && subjectIds.has(item.subjectId) && item.id === id);
      if (!rule) throw new HTTPException(404, {message: "User authorization rule not found"});
      return c.json({grant: store.deleteGrant(id)});
    })
    .get("/:id", (c) => {
      const db = getDb();
      const {id: agentId, ownerUserId} = requireUserDirectoryAgent(c, db);
      const context = loadDashboardUserContext(db, agentId, ownerUserId);
      const requestedId = c.req.param("id");
      const row = requireUserRow(db, requestedId, true);
      const canonicalRow = resolveCanonicalUserRow(requestedId, context.userRows);
      if (canonicalRow === undefined || !db.select({ id: users.id }).from(users)
        .where(and(eq(users.id, canonicalRow.id), agentUserVisibility(db, agentId, ownerUserId))).get()) {
        throw new HTTPException(404, {
          message: `Canonical user not found: ${requestedId}`,
        });
      }
      return c.json({
        // The requester reached here as the Agent owner.
        canManageUsers: true,
        canDeleteUsers: isPlatformAdministrator(db, dashboardRequesterUserIdFromContext(c)!),
        ...toDashboardUser(
          canonicalRow,
          context.activityByUserId.get(canonicalRow.id),
          context,
        ),
        ...(row.id === canonicalRow.id ? {} : { canonicalizedFromUserId: row.id }),
      });
  });
}

export const usersRoutes = createUsersRoutes();

function validateOperationGrantTarget(input: {
  readonly db: DrizzleDB;
  readonly subjectType: AuthorizationSubjectType;
  readonly target: string;
}):
  | { readonly status: "ok"; readonly policy: OperationPolicy }
  | {
      readonly status: "error";
      readonly code: "invalid_operation" | "subject_type_not_allowed";
      readonly message: string;
    } {
  const policy = resolveGrantTarget(input.db, input.target);
  if (policy === undefined) {
    return {
      status: "error",
      code: "invalid_operation",
      message: `Operation is not registered: ${input.target}`,
    };
  }
  if (
    !policy.allowedSubjectTypes.includes(input.subjectType)
  ) {
    return {
      status: "error",
      code: "subject_type_not_allowed",
      message: `Operation ${input.target} cannot be granted to ${input.subjectType}`,
    };
  }
  return { status: "ok", policy };
}

/** A user in this Agent's directory: only those can receive the Agent's grants or group memberships from non-admin owners. */
export function requireAgentDirectoryUser(db: DrizzleDB, agentId: string, ownerUserId: string, requesterId: string, id: string): UserRow {
  if (isPlatformAdministrator(db, requesterId)) return requireUserRow(db, id);
  return requireAgentUser(db, agentId, ownerUserId, id);
}

function requireAgentUser(db: DrizzleDB, agentId: string, ownerUserId: string, id: string): UserRow {
  const row = requireUserRow(db, id);
  if (!db.select({ id: users.id }).from(users).where(and(eq(users.id, row.id), agentUserVisibility(db, agentId, ownerUserId))).get()) {
    throw new HTTPException(404, { message: `User not found: ${id}` });
  }
  return row;
}

function requireUserDirectoryAgent(c: Context, db: DrizzleDB) {
  const agentId = c.req.query("agentId")?.trim();
  if (!agentId) throw new AgentError("agent_scope_required", 400);
  return new AgentStore(db).requireOwner(dashboardRequesterUserIdFromContext(c)!, agentId);
}

function agentUserVisibility(db: DrizzleDB, agentId: string, ownerId: string) {
  const otherAgentShadows = db.select({id: agentShadows.id}).from(agentShadows)
    .where(and(eq(agentShadows.replyUserId, users.id), ne(agentShadows.agentId, agentId)));
  return and(notExists(otherAgentShadows), or(
    eq(users.id, ownerId),
    inArray(users.id, db.select({ id: agentShadows.replyUserId }).from(agentShadows).where(eq(agentShadows.agentId, agentId))),
    inArray(users.id, db.select({ id: messages.senderUserId }).from(messages).where(eq(messages.agentId, agentId))),
    inArray(users.id, db.select({ id: channelUserBindings.userId }).from(channelUserBindings)
      .innerJoin(channelIdentities, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
      .innerJoin(channelConfigs, eq(channelConfigs.id, channelIdentities.channelId)).where(eq(channelConfigs.agentId, agentId))),
    inArray(users.id, db.select({ id: groupMemberships.userId }).from(groupMemberships)
      .innerJoin(groups, eq(groupMemberships.groupId, groups.id)).where(eq(groups.agentId, agentId))),
  ));
}

function loadDashboardUserContext(db: DrizzleDB, agentId: string, ownerUserId: string): DashboardUserContext {
  const userRows = loadDashboardUserRows(db);
  const channelIds = db.select({id: channelConfigs.id}).from(channelConfigs).where(eq(channelConfigs.agentId, agentId));
  const identityScope = or(
    inArray(channelIdentities.channelId, channelIds),
    and(eq(channelIdentities.channelType, "dashboard"), eq(channelIdentities.externalId, ownerUserId)),
  );
  const channelIdentityRows = db.select().from(channelIdentities).where(identityScope).all();
  const linkRows = db.select({link: userIdentityLinks, channelIdentityId: identityObservations.channelIdentityId})
    .from(userIdentityLinks)
    .innerJoin(identityObservations, eq(identityObservations.claimId, userIdentityLinks.id))
    .innerJoin(channelIdentities, eq(channelIdentities.id, identityObservations.channelIdentityId))
    .where(identityScope)
    .all()
    .map(({link, channelIdentityId}) => ({
      ...link,
      id: JSON.stringify([link.id, channelIdentityId]),
      channelIdentityId,
    }));
  const sessionRows = db.select().from(sessions).where(eq(sessions.agent_id, agentId)).all();
  const timelineRows = selectTimelineMessageRows(db, agentId);

  return {
    agentId,
    groupStore: new GroupStore(db),
    grantStore: new AuthorizationRuleStore(db, {kind: "agent", agentId}),
    userRows,
    surfaceRows: db.select().from(channelSurfaces).all(),
    channelIdentityRows,
    timelineRows,
    linksByUserId: groupLinksByUserId(linkRows),
    channelIdentityById: new Map(
      channelIdentityRows.map((row) => [row.id, row]),
    ),
    activityByUserId: buildActivityByUserId({
      sessionRows,
      timelineRows,
    }),
  };
}

function toDashboardUser(
  row: UserRow,
  activity: UserActivitySummary | undefined,
  context: DashboardUserContext,
): DashboardUser {
  const display = context.userRows.find(user => user.id === row.id);
  const latestSession = activity?.latestSession ?? null;
  const messageCount = activity?.messageCount ?? 0;
  const sessionCount = activity?.sessionIds.size ?? 0;
  const latestSessionId = latestSession?.id ?? null;
  const latestSessionTitle = latestSession === null
    ? null
    : resolveSessionDisplayTitle({
        row: latestSession,
        surfaceRows: context.surfaceRows,
        messageRows: context.timelineRows.map((timelineRow) =>
          toDisplayTitleMessage(timelineRow, context.channelIdentityRows),
        ),
        identityRows: context.channelIdentityRows,
      });
  const userGroups = context.groupStore.listUserGroups(row.id)
    .filter(group => group.agentId === context.agentId)
    .map(toDashboardUserGroup);

  return {
    id: row.id,
    kind: row.kind,
    displayName: display?.displayName ?? row.displayName,
    displayNameSource: display?.displayNameSource ?? "id",
    avatarUrl: display?.avatarUrl ?? row.avatarUrl,
    status: row.status,
    profileSource: row.profileSource,
    linkedIdentities: toDashboardUserIdentityLinks(
      context.linksByUserId.get(row.id) ?? [],
      context.channelIdentityById,
    ),
    messageCount,
    sessionCount,
    latestSessionId,
    latestSessionTitle,
    groups: userGroups,
    directGrants: context.grantStore.listGrants({
      subjectType: "user",
      subjectId: row.id,
    }),
    indirectGrants: context.grantStore.getIndirectGrantsForUser(row.id)
      .map((grant) => ({
        ...grant,
        sourceGroup: userGroups.find((group) => group.id === grant.subjectId) ??
          toDashboardUserGroup(context.groupStore.requireGroup(grant.subjectId)),
      })),
  };
}

function requireUserRow(db: DrizzleDB, id: string, includeDeleted = false): UserRow {
  const row = db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .get();
  if (row === undefined || (!includeDeleted && row.status === "deleted")) {
    throw new HTTPException(404, {
      message: `User not found: ${id}`,
    });
  }
  return row;
}

function buildActivityByUserId(input: {
  readonly sessionRows: readonly SessionRow[];
  readonly timelineRows: readonly TimelineMessageRow[];
}): Map<string, UserActivitySummary> {
  const sessionById = new Map(
    input.sessionRows.map((session) => [session.id, session]),
  );
  const activityByUserId = new Map<string, UserActivitySummary>();
  for (const timelineRow of input.timelineRows) {
    const message = timelineRow.message;
    if (timelineRow.entry.entryKind !== "message") {
      continue;
    }
    if (isInternalMessage(message)) {
      continue;
    }
    const session = sessionById.get(timelineRow.entry.sessionId);
    if (session === undefined) {
      continue;
    }

    let summary = activityByUserId.get(message.senderUserId);
    if (summary === undefined) {
      summary = {
        messageCount: 0,
        sessionIds: new Set<string>(),
        latestSession: null,
        latestActivityAt: Number.NEGATIVE_INFINITY,
      };
      activityByUserId.set(message.senderUserId, summary);
    }
    summary.messageCount += 1;
    summary.sessionIds.add(session.id);
    if (message.occurredAt > summary.latestActivityAt) {
      summary.latestSession = session;
      summary.latestActivityAt = message.occurredAt;
    }
  }
  return activityByUserId;
}

function groupLinksByUserId(
  linkRows: readonly UserIdentityLinkRow[],
): Map<string, UserIdentityLinkRow[]> {
  const linksByUserId = new Map<string, UserIdentityLinkRow[]>();
  for (const link of linkRows) {
    const links = linksByUserId.get(link.userId) ?? [];
    links.push(link);
    linksByUserId.set(link.userId, links);
  }
  for (const links of linksByUserId.values()) {
    links.sort((left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) ||
      left.identityNamespace.localeCompare(right.identityNamespace) ||
      left.identityKind.localeCompare(right.identityKind) ||
      left.identityValue.localeCompare(right.identityValue),
    );
  }
  return linksByUserId;
}

function toDashboardUserIdentityLinks(
  linkRows: readonly UserIdentityLinkRow[],
  channelIdentityById: ReadonlyMap<string, ChannelIdentityRow>,
): DashboardUserIdentityLink[] {
  return linkRows.map((link) => {
    const channelIdentity = link.channelIdentityId === null
      ? null
      : channelIdentityById.get(link.channelIdentityId) ?? null;
    return {
      id: link.id,
      channelIdentityId: link.channelIdentityId,
      identityNamespace: link.identityNamespace,
      identityKind: link.identityKind,
      identityValue: link.identityValue,
      identityScope: link.identityScope,
      confidence: link.confidence,
      isPrimary: link.isPrimary,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      channelIdentity:
        channelIdentity === null
          ? null
          : {
              id: channelIdentity.id,
              channelType: channelIdentity.channelType,
              channelId: channelIdentity.channelId,
              externalId: channelIdentity.externalId,
              identityKind: channelIdentity.identityKind,
              displayName: channelIdentity.displayName,
              avatarUrl: channelIdentity.avatarUrl,
            },
    };
  });
}

function isInternalMessage(row: MessageRow): boolean {
  if (row.externalMessageId.startsWith("main-runner-action:") === true) {
    return true;
  }
  const rawPayload = row.rawPayloadJson;
  return (
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    "origin" in rawPayload &&
    (rawPayload.origin === "main_runner_action_marker" ||
      rawPayload.origin === "main_runner_action_reply_marker" ||
      rawPayload.origin === "task_result_event")
  );
}

function selectTimelineMessageRows(db: DrizzleDB, agentId: string): TimelineMessageRow[] {
  return db
    .select({ entry: sessionTimelineEntries, message: messages })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .where(eq(messages.agentId, agentId))
    .orderBy(
      asc(messages.occurredAt),
      asc(sessionTimelineEntries.createdAt),
      asc(sessionTimelineEntries.id),
    )
    .all();
}

function toDisplayTitleMessage(
  row: TimelineMessageRow,
  identityRows: readonly ChannelIdentityRow[],
): {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly senderExternalId: string | null;
  readonly createdAt: number;
} {
  const sender = row.message.senderIdentityId === null
    ? null
    : identityRows.find((identity) => identity.id === row.message.senderIdentityId)
      ?.externalId ?? null;
  return {
    id: row.message.id,
    sessionId: row.entry.sessionId,
    role: row.message.role,
    senderExternalId: sender,
    createdAt: row.message.occurredAt,
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function parseGroupRole(value: unknown): "member" | "owner" | "admin" {
  if (value === undefined) {
    return "member";
  }
  if (value === "member" || value === "owner" || value === "admin") {
    return value;
  }
  throw new HTTPException(400, {
    message: "role must be member, owner, or admin",
  });
}

function parseGrantEffect(value: unknown): "allow" | "deny" {
  const effect = grantEffectValue(value);
  if (effect !== undefined) {
    return effect;
  }
  throw new HTTPException(400, {
    message: "effect must be allow or deny",
  });
}

function requiredString(value: unknown, name: string): string {
  const parsed = stringValue(value);
  if (parsed === undefined) {
    throw new HTTPException(400, { message: `${name} is required` });
  }
  return parsed;
}

function invalidRequest(c: Context, message: string) {
  return c.json(
    {
      status: "error",
      code: "invalid_request",
      message,
    },
    400,
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function grantEffectValue(value: unknown): "allow" | "deny" | undefined {
  return value === "allow" || value === "deny" ? value : undefined;
}

function toDashboardUserGroup(group: GroupRecord): DashboardUserGroup {
  return {
    id: group.id,
    slug: group.slug,
    displayName: group.displayName,
    avatarUrl: group.avatarUrl ?? null,
    status: group.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
