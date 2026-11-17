import {AgentError, AgentStore} from "@/agents/agent-store";
import {dashboardRequesterUserIdFromContext} from "@/server/auth";
import { loadDashboardUserRows } from "@/dashboard-api/user-display";
import { grantInputFromBody } from "./authorization-rule-input";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  resolveGrantTarget,
  type OperationPolicy,
} from "@/operations/operation-registry";
import type { DrizzleDB } from "@/data";
import { users } from "@/data/schema";
import { eq } from "drizzle-orm";

import {
  GroupStore,
  type GroupMemberRecord,
  type GroupRecord,
  type GroupRole,
} from "../groups/group-store";
import type { AuthorizationSubjectType } from "../policy/authorization-subject";
import {
  AuthorizationRuleStore,
  type AuthorizationRuleRecord,
} from "../policy/authorization-rule-store";
import { isGuardResponse, requireDashboardOnly } from "../auth/guards";
import { getKernel } from "./kernel";

export interface GroupsRouteOptions {
  readonly db?: DrizzleDB;
}

export interface DashboardGroup {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly avatarUrl: string | null;
  readonly status: "active" | "disabled";
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly members: DashboardGroupMember[];
  readonly directGrants: AuthorizationRuleRecord[];
}

export interface DashboardGroupMember extends GroupMemberRecord {
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly displayNameSource?: string;
}

export function createGroupsRoutes(options: GroupsRouteOptions = {}) {
  const getDb = () => options.db ?? getKernel().database.db;

  return new Hono()
    .onError((error, c) => {
      if (error instanceof AgentError) return c.json({code: error.code}, error.status);
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    })
    .use("*", async (c, next) => {
      // Groups belong to an Agent; every write route checks that the requester owns it.
      const auth = requireDashboardOnly(c);
      if (isGuardResponse(auth)) return auth;
      await next();
    })
    .get("/", (c) => {
      const db = getDb();
      const agent = requireGroupDirectoryAgent(c, db);
      const agentId = agent.id;
      return c.json({
        status: "ok",
        canManageGroups: true,
        groups: new GroupStore(db).listGroups(agentId).map((group) =>
          toDashboardGroup(db, group),
        ),
      });
    })
    .post("/", async (c) => {
      const db = getDb();
      const body = await readBody(c.req.raw);
      const description = stringValue(body.description);
      const avatarUrl = stringValue(body.avatarUrl);
      const agentId = requiredString(body.agentId, "agentId");
      new AgentStore(db).requireOwner(dashboardRequesterUserIdFromContext(c)!, agentId);
      const group = new GroupStore(db).createGroup({
        agentId,
        slug: requiredString(body.slug, "slug"),
        displayName: requiredString(body.displayName, "displayName"),
        ...(description === undefined ? {} : { description }),
        ...(avatarUrl === undefined ? {} : { avatarUrl }),
      });
      return c.json({ status: "ok", group: toDashboardGroup(db, group) });
    })
    .get("/:id", (c) => {
      const db = getDb();
      const agent = requireGroupDirectoryAgent(c, db);
      const group = new GroupStore(db).requireGroup(c.req.param("id"), agent.id);
      return c.json({
        status: "ok",
        canManageGroups: true,
        group: toDashboardGroup(db, group),
      });
    })
    .patch("/:id", async (c) => {
      const db = getDb();
      const store = new GroupStore(db);
      const current = requireOwnedGroup(c, db);
      const body = await readBody(c.req.raw);
      const group = store.createGroup({
        agentId: current.agentId,
        slug: current.slug,
        displayName: stringValue(body.displayName) ?? current.displayName,
        description:
          body.description === null
            ? null
            : stringValue(body.description) ?? current.description ?? null,
        avatarUrl:
          body.avatarUrl === null
            ? null
            : stringValue(body.avatarUrl) ?? current.avatarUrl ?? null,
      });
      return c.json({ status: "ok", group: toDashboardGroup(db, group) });
    })
    .get("/:id/members", (c) => {
      const db = getDb();
      const agent = requireGroupDirectoryAgent(c, db);
      const {id: groupId} = new GroupStore(db).requireGroup(c.req.param("id"), agent.id);
      return c.json({ status: "ok", members: listDashboardMembers(db, groupId) });
    })
    .post("/:id/members", async (c) => {
      const db = getDb();
      const body = await readBody(c.req.raw);
      const group = requireOwnedGroup(c, db);
      const membership = new GroupStore(db).addMember({
        groupId: group.id,
        userId: requiredString(body.userId, "userId"),
        role: parseGroupRole(body.role),
      });
      return c.json({
        status: "ok",
        member: toDashboardMember(db, membership),
      });
    })
    .delete("/:id/members/:userId", (c) => {
      const db = getDb();
      const group = requireOwnedGroup(c, db);
      const removed = new GroupStore(db).removeMember({
        groupId: group.id,
        userId: c.req.param("userId"),
      });
      if (removed === null) {
        return c.json(
          {
            status: "error",
            code: "not_found",
            message: `Group membership not found: ${c.req.param("id")}:${c.req.param("userId")}`,
          },
          404,
        );
      }
      return c.json({ status: "ok", member: toDashboardMember(db, removed) });
    })
    .post("/:id/authorization-rules", async (c) => {
      const db = getDb();
      const body = await readBody(c.req.raw);
      const input = grantInputFromBody({...body,subjectType:"group",subjectId:c.req.param("id")});
      const validation = validateOperationGrantTarget({
        db,
        subjectType: "group",
        target: input.matchType === "prefix" ? `${input.target.replace(/\.\*$/, "")}.*` : input.target,
      });
      if (validation.status === "error") {
        return c.json(validation, 400);
      }
      const group = requireOwnedGroup(c, db);
      const grant = new AuthorizationRuleStore(db, {kind: "agent", agentId: group.agentId}).addGrant(input);
      return c.json({ status: "ok", grant });
    })
    .post("/:id/authorization-rules/batch", async (c) => {
      const db = getDb();
      const group = requireOwnedGroup(c, db);
      const body = await readBody(c.req.raw);
      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new HTTPException(400, {message: "Authorization rules are required"});
      }
      const rules = body.items.map((item, index) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new HTTPException(400, {message: `Invalid authorization rule at index ${index}`});
        }
        return grantInputFromBody({...item, subjectType: "group", subjectId: group.id});
      });
      const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId: group.agentId}).addGrants(rules);
      return c.json({grants});
    })
    .delete("/:id/authorization-rules/:grantId", (c) => {
      const db = getDb();
      const group = requireOwnedGroup(c, db);
      const store = new AuthorizationRuleStore(db, {kind: "agent", agentId: group.agentId});
      const id = c.req.param("grantId");
      const rule = store.listGrants({subjectType: "group", subjectId: group.id}).find(item => item.id === id);
      if (!rule) throw new HTTPException(404, {message: "Group authorization rule not found"});
      return c.json({grant: store.deleteGrant(id)});
    });
}

export const groupsRoutes = createGroupsRoutes();

function requireGroupDirectoryAgent(c: Context, db: DrizzleDB) {
  const agentId = c.req.query("agentId")?.trim();
  if (!agentId) throw new AgentError("agent_scope_required", 400);
  return new AgentStore(db).requireOwner(dashboardRequesterUserIdFromContext(c)!, agentId);
}

function requireOwnedGroup(c: Context, db: DrizzleDB) {
  const group = new GroupStore(db).requireGroup(c.req.param("id")!);
  new AgentStore(db).requireOwner(dashboardRequesterUserIdFromContext(c)!, group.agentId);
  return group;
}

export function validateOperationGrantTarget(input: {
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
  if (!policy.allowedSubjectTypes.includes(input.subjectType)) {
    return {
      status: "error",
      code: "subject_type_not_allowed",
      message: `Operation ${input.target} cannot be granted to ${input.subjectType}`,
    };
  }
  return { status: "ok", policy };
}

function toDashboardGroup(db: DrizzleDB, group: GroupRecord): DashboardGroup {
  return {
    ...group,
    description: group.description ?? null,
    avatarUrl: group.avatarUrl ?? null,
    members: listDashboardMembers(db, group.id),
    directGrants: new AuthorizationRuleStore(db, {kind: "agent", agentId: group.agentId}).listGrants({
      subjectType: "group",
      subjectId: group.id,
    }),
  };
}

function listDashboardMembers(
  db: DrizzleDB,
  groupId: string,
): DashboardGroupMember[] {
  const displayUsers = new Map(loadDashboardUserRows(db).map(user => [user.id, user]));
  return new GroupStore(db).listMembers(groupId).map((member) =>
    toDashboardMember(db, member, displayUsers),
  );
}

function toDashboardMember(
  db: DrizzleDB,
  member: GroupMemberRecord,
  displayUsers = new Map(loadDashboardUserRows(db).map(user => [user.id, user])),
): DashboardGroupMember {
  const user = displayUsers.get(member.userId);
  return {
    ...member,
    displayName: user?.displayName ?? member.userId,
    displayNameSource: user?.displayNameSource ?? "id",
    avatarUrl: user?.avatarUrl ?? null,
    status: user?.status ?? "unknown",
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function requiredString(value: unknown, name: string): string {
  const parsed = stringValue(value);
  if (parsed === undefined) {
    throw new HTTPException(400, { message: `${name} is required` });
  }
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseGroupRole(value: unknown): GroupRole {
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
  if (value === "allow" || value === "deny") {
    return value;
  }
  throw new HTTPException(400, {
    message: "effect must be allow or deny",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
