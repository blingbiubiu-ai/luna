import {AgentError, AgentStore} from "@/agents/agent-store";
import { requesterAccountIdFromContext } from "../auth";
import { loadDashboardUserRows, type DisplayUserRow } from "@/dashboard-api/user-display";
import { grantInputFromBody } from "./authorization-rule-input";
import { and, asc, desc, eq, inArray, notExists, or } from "drizzle-orm";
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
  channelSurfaces,
  directRecipients,
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
import {
  type DirectRecipientRow,
  resolveSessionDisplayTitle,
  type SessionDisplayTitleMessage,
  type UserIdentityLinkRow as RawUserIdentityLinkRow,
} from "@/dashboard-api/session-display-title";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import {
  selectSessionDisplayTitleMessages,
  selectUserActivitySummaries,
} from "./dashboard-message-summaries";
import { getKernel } from "./kernel";
import { AgentUserStore, type ManagedUserStatus } from "@/identity/agent-user-store";

function parseManagedStatus(value: unknown): ManagedUserStatus {
  if (value === "active" || value === "blocked") return value;
  throw new HTTPException(400, { message: "status must be active or blocked" });
}

type ChannelSurfaceRow = typeof channelSurfaces.$inferSelect;
type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
type UserRow = typeof users.$inferSelect;
type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect & {channelIdentityId: string | null};
type SessionRow = typeof sessions.$inferSelect;

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
  readonly messageCount: number;
  readonly sessionCount: number;
  readonly latestSession: SessionRow | null;
};

type DashboardUserContext = {
  readonly agentId: string;
  readonly ownerAccountId: string;
  readonly summaryOnly: boolean;
  readonly groupStore: GroupStore;
  readonly grantStore: AuthorizationRuleStore;
  readonly userRows: readonly DisplayUserRow[];
  readonly surfaceRows: readonly ChannelSurfaceRow[];
  readonly channelIdentityRows: readonly ChannelIdentityRow[];
  readonly directRecipientRows: readonly DirectRecipientRow[];
  readonly rawIdentityLinkRows: readonly RawUserIdentityLinkRow[];
  readonly displayTitleMessages: readonly SessionDisplayTitleMessage[];
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
      // Users belong to one Agent: its owner lists, renames, blocks and removes them and manages their groups and grants.
      const auth = requireDashboardOnly(c);
      if (isGuardResponse(auth)) return auth;
      await next();
    })
    .get("/", (c) => {
      const db = getDb();
      const {id: agentId} = requireUserDirectoryAgent(c, db);
      const hiddenShadows = db.select({ id: agentShadows.id }).from(agentShadows).where(and(
        eq(agentShadows.replyUserId, users.id),
        eq(agentShadows.status, "deleted"),
      ));
      // Removed users come back to the list when they write again; merged users live on in another row.
      const userRows = db
        .select()
        .from(users)
        .where(and(eq(users.agentId, agentId), inArray(users.status, ["active", "blocked"]), notExists(hiddenShadows)))
        .orderBy(desc(users.updatedAt), asc(users.displayName), asc(users.id))
        .all();
      const context = loadDashboardUserContext(db, agentId, true);

      return c.json({
        users: userRows.map((row) =>
          toDashboardUser(row, context.activityByUserId.get(row.id), context),
        ),
      });
    })
    .patch("/:id", async (c) => {
      const db = getDb();
      const agent = requireUserDirectoryAgent(c, db);
      const body = await readBody(c.req.raw);
      const user = new AgentUserStore(db).update(agent.id, c.req.param("id"), {
        ...(body.displayName === undefined ? {} : { displayName: requiredString(body.displayName, "displayName") }),
        ...(body.status === undefined ? {} : { status: parseManagedStatus(body.status) }),
      });
      return c.json({ status: "ok", user });
    })
    .delete("/:id", (c) => {
      // Removing takes a user off this Agent's list; it never touches other Agents or the platform account.
      const db = getDb();
      const agent = requireUserDirectoryAgent(c, db);
      return c.json({ status: "ok", user: new AgentUserStore(db).remove(agent.id, c.req.param("id")) });
    })
    .post("/:id/group-memberships", async (c) => {
      const db = getDb();
      const targetUserId = c.req.param("id");
      requireUserRow(db, targetUserId);
      const body = await readBody(c.req.raw);
      const groupStore = new GroupStore(db);
      const group = groupStore.requireGroup(requiredString(body.groupId, "groupId"));
      const agent = new AgentStore(db).requireOwner(requesterAccountIdFromContext(c)!, group.agentId);
      requireAgentUser(db, agent.id, targetUserId);
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
      new AgentStore(db).requireOwner(requesterAccountIdFromContext(c)!, group.agentId);
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
      const {id: agentId} = requireUserDirectoryAgent(c, db);
      const row = requireAgentUser(db, agentId, c.req.param("id"));
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
      const {id: agentId} = requireUserDirectoryAgent(c, db);
      const requestedId = c.req.param("id");
      const row = requireUserRow(db, requestedId, true);
      const canonicalRow = resolveCanonicalUserRow(requestedId, loadDashboardUserRows(db, agentId)) ?? row;
      if (canonicalRow.agentId !== agentId) {
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
      const {id: agentId} = requireUserDirectoryAgent(c, db);
      const context = loadDashboardUserContext(db, agentId);
      const requestedId = c.req.param("id");
      const row = requireUserRow(db, requestedId, true);
      const canonicalRow = resolveCanonicalUserRow(requestedId, context.userRows);
      if (canonicalRow === undefined || canonicalRow.agentId !== agentId) {
        throw new HTTPException(404, {
          message: `Canonical user not found: ${requestedId}`,
        });
      }
      return c.json({
        // The requester reached here as the Agent owner.
        canManageUsers: true,
        isOwner: canonicalRow.accountId !== null && canonicalRow.accountId === context.ownerAccountId,
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

/** A user of this Agent: only those can receive the Agent's grants or group memberships. */
export function requireAgentUser(db: DrizzleDB, agentId: string, id: string): UserRow {
  const row = requireUserRow(db, id);
  if (row.agentId !== agentId) {
    throw new HTTPException(404, { message: `User not found: ${id}` });
  }
  return row;
}

function requireUserDirectoryAgent(c: Context, db: DrizzleDB) {
  const agentId = c.req.query("agentId")?.trim();
  if (!agentId) throw new AgentError("agent_scope_required", 400);
  return new AgentStore(db).requireOwner(requesterAccountIdFromContext(c)!, agentId);
}

function loadDashboardUserContext(
  db: DrizzleDB,
  agentId: string,
  summaryOnly = false,
): DashboardUserContext {
  const userRows = loadDashboardUserRows(db, agentId);
  const channelIds = db.select({id: channelConfigs.id}).from(channelConfigs).where(eq(channelConfigs.agentId, agentId));
  // The shared Dashboard channel names each Agent's own users.
  const identityScope = or(
    inArray(channelIdentities.channelId, channelIds),
    and(eq(channelIdentities.channelType, "dashboard"), inArray(channelIdentities.externalId,
      db.select({ id: users.id }).from(users).where(eq(users.agentId, agentId)))),
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
  const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
  const sqlActivities = selectUserActivitySummaries(db, agentId);
  const activityByUserId = new Map<string, UserActivitySummary>();
  const latestSessionIds = new Set<string>();
  for (const [userId, item] of sqlActivities) {
    const latestSession = sessionById.get(item.latestSessionId) ?? null;
    if (latestSession !== null) {
      latestSessionIds.add(latestSession.id);
    }
    activityByUserId.set(userId, {
      messageCount: item.messageCount,
      sessionCount: item.sessionCount,
      latestSession,
    });
  }
  const displayTitleMessages = selectSessionDisplayTitleMessages(
    db,
    [...latestSessionIds],
  );

  return {
    agentId,
    ownerAccountId: new AgentStore(db).get(agentId).ownerAccountId,
    summaryOnly,
    groupStore: new GroupStore(db),
    grantStore: new AuthorizationRuleStore(db, {kind: "agent", agentId}),
    userRows,
    surfaceRows: db.select().from(channelSurfaces).all(),
    channelIdentityRows,
    directRecipientRows: db.select().from(directRecipients).all(),
    rawIdentityLinkRows: db.select().from(userIdentityLinks).where(eq(userIdentityLinks.agentId, agentId)).all(),
    displayTitleMessages,
    linksByUserId: groupLinksByUserId(linkRows),
    channelIdentityById: new Map(
      channelIdentityRows.map((row) => [row.id, row]),
    ),
    activityByUserId,
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
  const sessionCount = activity?.sessionCount ?? 0;
  const latestSessionId = latestSession?.id ?? null;
  const latestSessionTitle = latestSession === null
    ? null
    : resolveSessionDisplayTitle({
        row: latestSession,
        surfaceRows: context.surfaceRows,
        messageRows: context.displayTitleMessages,
        identityRows: context.channelIdentityRows,
        directRecipientRows: context.directRecipientRows,
        userIdentityLinkRows: context.rawIdentityLinkRows,
        userRows: context.userRows,
      });
  const userGroups = context.summaryOnly
    ? []
    : context.groupStore
        .listUserGroups(row.id)
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
    directGrants: context.summaryOnly
      ? []
      : context.grantStore.listGrants({
          subjectType: "user",
          subjectId: row.id,
        }),
    indirectGrants: context.summaryOnly
      ? []
      : context.grantStore.getIndirectGrantsForUser(row.id)
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
  if (row === undefined || (!includeDeleted && row.status === "merged")) {
    throw new HTTPException(404, {
      message: `User not found: ${id}`,
    });
  }
  return row;
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
