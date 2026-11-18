import { authorizationScopeFields, authorizationScopeFilter, type AuthorizationScope } from "./authorization-scope";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import {
  resolveGrantTarget,
  type OperationPolicy,
} from "@/operations/operation-registry";
import type { DrizzleDB } from "@/data";
import {
  authorizationRules,
  groupMemberships,
  groups,
  accounts,
  users,
} from "@/data/schema";
import { uuid } from "@/shared";

import type {
  AuthorizationSubjectType,
  OperationGrantEffect,
} from "./authorization-subject";
import { isAuthorizationSubjectType } from "./authorization-subject";

export interface AuthorizationRuleRecord {
  readonly id: string;
  readonly subjectType: AuthorizationSubjectType;
  readonly subjectId: string;
  readonly target: string;
  readonly matchType: "exact" | "prefix";
  readonly effect: OperationGrantEffect;
  readonly expiresAt?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthorizationRuleInput {
  readonly subjectType: AuthorizationSubjectType;
  readonly subjectId: string;
  readonly target: string;
  readonly matchType?: "exact" | "prefix";
  readonly effect: OperationGrantEffect;
  readonly expiresAt?: number;
}

export class AuthorizationRuleStore {
  constructor(private readonly _db: DrizzleDB, private readonly _scope?: AuthorizationScope, private readonly _catalogDb: DrizzleDB = _db) {}

  addGrant(input: AuthorizationRuleInput): AuthorizationRuleRecord {
    authorizationScopeFields(this._scope);
    if (this._scope?.kind === "agent" && (input.target === "system.admin" || input.target.startsWith("system."))) {
      throw new HTTPException(403, {message: "platform_operation_requires_platform_scope"});
    }
    if (this._scope?.kind === "platform" && input.target !== "system.admin") throw new HTTPException(400, {message: "business_operation_requires_agent_scope"});
    if (input.matchType === "exact" && input.target.endsWith(".*")) {
      throw new HTTPException(400, {message: "Use prefix matching for wildcard targets"});
    }
    const matchType = input.matchType ?? (input.target.endsWith(".*") ? "prefix" : "exact");
    if (matchType !== "exact" && matchType !== "prefix") throw new Error("Invalid match type");
    const target = input.target.endsWith(".*") ? input.target.slice(0, -2) : input.target;
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(target)) throw new HTTPException(400, {message: "Invalid authorization target"});
    input = {...input, target, matchType};
    this._requireSubject(input.subjectType, input.subjectId);
    const operation = this._requireOperation(matchType === "prefix" ? `${target}.*` : target);
    if (!operation.allowedSubjectTypes.includes(input.subjectType)) {
      throw new HTTPException(400, {message: `Operation ${input.target} does not allow ${input.subjectType} subjects`});
    }

    const existing = this._db
      .select()
      .from(authorizationRules)
      .where(
        and(
          authorizationScopeFilter(this._scope),
          eq(authorizationRules.subjectType, input.subjectType),
          eq(authorizationRules.subjectId, input.subjectId),
          eq(authorizationRules.target, input.target),
          eq(authorizationRules.matchType, matchType),
          eq(authorizationRules.effect, input.effect),
        ),
      )
      .get();
    const now = String(Date.now());
    if (existing !== undefined) {
      this._db
        .update(authorizationRules)
        .set({
          expiresAt: input.expiresAt ?? null,
          updatedAt: now,
        })
        .where(eq(authorizationRules.id, existing.id))
        .run();
      return this._requireGrant(existing.id);
    }

    this._db
      .insert(authorizationRules)
      .values({
        id: uuid(),
        ...authorizationScopeFields(this._scope),
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        target: input.target,
        effect: input.effect,
        matchType,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const grant = this._db
      .select()
      .from(authorizationRules)
      .where(
        and(
          authorizationScopeFilter(this._scope),
          eq(authorizationRules.subjectType, input.subjectType),
          eq(authorizationRules.subjectId, input.subjectId),
          eq(authorizationRules.target, input.target),
          eq(authorizationRules.matchType, matchType),
          eq(authorizationRules.effect, input.effect),
        ),
      )
      .get();
    if (grant === undefined) {
      throw new Error(
        `Operation grant was not persisted: ${input.subjectType}:${input.subjectId}:${input.target}:${input.effect}`,
      );
    }
    return operationGrantRecord(grant);
  }

  addGrants(inputs: readonly AuthorizationRuleInput[]): AuthorizationRuleRecord[] {
    if (inputs.length === 0) {
      return [];
    }
    return this._db.transaction((tx) => {
      const store = new AuthorizationRuleStore(tx as unknown as DrizzleDB, this._scope, this._catalogDb);
      return inputs.map((input) => store.addGrant(input));
    });
  }

  deleteGrant(grantId: string): AuthorizationRuleRecord | null {
    const existing = this._db
      .select()
      .from(authorizationRules)
      .where(and(eq(authorizationRules.id, grantId), authorizationScopeFilter(this._scope)))
      .get();
    if (existing === undefined) {
      return null;
    }
    this._db
      .delete(authorizationRules)
      .where(and(eq(authorizationRules.id, grantId), authorizationScopeFilter(this._scope)))
      .run();
    return operationGrantRecord(existing);
  }

  listGrants(input: {
    readonly subjectType?: AuthorizationSubjectType;
    readonly subjectId?: string;
  } = {}): AuthorizationRuleRecord[] {
    const filters = [
      authorizationScopeFilter(this._scope),
      input.subjectType === undefined
        ? undefined
        : eq(authorizationRules.subjectType, input.subjectType),
      input.subjectId === undefined
        ? undefined
        : eq(authorizationRules.subjectId, input.subjectId),
    ].filter((item) => item !== undefined);
    const query = this._db.select().from(authorizationRules);
    const rows =
      filters.length === 0
        ? query
            .orderBy(
              asc(authorizationRules.subjectType),
              asc(authorizationRules.subjectId),
              asc(authorizationRules.target),
              asc(authorizationRules.effect),
            )
            .all()
        : query
            .where(and(...filters))
            .orderBy(
              asc(authorizationRules.subjectType),
              asc(authorizationRules.subjectId),
              asc(authorizationRules.target),
              asc(authorizationRules.effect),
            )
            .all();
    return rows.map(operationGrantRecord);
  }

  /** Effective rules of a subject: an account in the platform scope, a user of the Agent in an Agent scope. */
  getEffectiveGrantsForUser(userId: string): AuthorizationRuleRecord[] {
    authorizationScopeFields(this._scope);
    if (this._subjectStatus(userId) !== "active") {
      return [];
    }

    const activeGroupIds = this._scope?.kind === "platform" ? [] : this._db
      .select({ id: groups.id })
      .from(groupMemberships)
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .where(
        and(
          eq(groupMemberships.userId, userId),
          eq(groups.status, "active"),
          this._scope?.kind === "agent" ? eq(groups.agentId, this._scope.agentId) : undefined,
        ),
      )
      .all()
      .map((row) => row.id);

    const now = Date.now();
    const subjectFilters = [
      and(
        eq(authorizationRules.subjectType, "user"),
        eq(authorizationRules.subjectId, userId),
      ),
      activeGroupIds.length === 0
        ? undefined
        : and(
            eq(authorizationRules.subjectType, "group"),
            inArray(authorizationRules.subjectId, activeGroupIds),
          ),
    ].filter((item) => item !== undefined);
    return this._db
      .select()
      .from(authorizationRules)
      .where(and(authorizationScopeFilter(this._scope), or(...subjectFilters)))
      .orderBy(
        asc(authorizationRules.subjectType),
        asc(authorizationRules.subjectId),
        asc(authorizationRules.target),
        asc(authorizationRules.effect),
      )
      .all()
      .map(operationGrantRecord)
      .filter((grant) => !isExpired(grant, now));
  }

  getIndirectGrantsForUser(userId: string): AuthorizationRuleRecord[] {
    authorizationScopeFields(this._scope);
    if (this._subjectStatus(userId) !== "active") {
      return [];
    }

    const activeGroupIds = this._scope?.kind === "platform" ? [] : this._db
      .select({ id: groups.id })
      .from(groupMemberships)
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .where(
        and(
          eq(groupMemberships.userId, userId),
          eq(groups.status, "active"),
          this._scope?.kind === "agent" ? eq(groups.agentId, this._scope.agentId) : undefined,
        ),
      )
      .all()
      .map((row) => row.id);
    if (activeGroupIds.length === 0) {
      return [];
    }

    const now = Date.now();
    return this._db
      .select()
      .from(authorizationRules)
      .where(
        and(
          authorizationScopeFilter(this._scope),
          eq(authorizationRules.subjectType, "group"),
          inArray(authorizationRules.subjectId, activeGroupIds),
        ),
      )
      .orderBy(
        asc(authorizationRules.subjectId),
        asc(authorizationRules.target),
        asc(authorizationRules.effect),
      )
      .all()
      .map(operationGrantRecord)
      .filter((grant) => !isExpired(grant, now));
  }

  private _requireOperation(target: string): OperationPolicy {
    const operation = resolveGrantTarget(this._catalogDb, target);
    if (operation === undefined) {
      throw new HTTPException(400, {message: `Operation not found: ${target}`});
    }
    return operation;
  }

  private _requireSubject(
    subjectType: AuthorizationSubjectType,
    subjectId: string,
  ): void {
    if (!isAuthorizationSubjectType(subjectType)) {
      throw new Error(`Unsupported authorization subject type: ${subjectType}`);
    }
    if (subjectType === "user") {
      if (this._subjectStatus(subjectId) !== "active") {
        throw new HTTPException(409, { message: "只能给有效的用户添加权限" });
      }
      return;
    }
    if (this._scope?.kind !== "agent") throw new HTTPException(400, {message: "group_requires_agent_scope"});
    const group = this._findGroup(subjectId);
    if (group === undefined) {
      throw new HTTPException(404, {message: `Group not found: ${subjectId}`});
    }
  }

  /** Platform rules name accounts; Agent rules name users of that Agent. */
  private _subjectStatus(subjectId: string): string {
    const scope = this._scope;
    const status = scope?.kind === "agent"
      ? this._db.select({ status: users.status }).from(users)
        .where(and(eq(users.id, subjectId), eq(users.agentId, scope.agentId))).get()?.status
      : this._db.select({ status: accounts.status }).from(accounts).where(eq(accounts.id, subjectId)).get()?.status;
    if (status === undefined) {
      throw new HTTPException(404, {message: `User not found: ${subjectId}`});
    }
    return status;
  }

  private _findGroup(groupId: string): typeof groups.$inferSelect | undefined {
    return this._db
      .select()
      .from(groups)
      .where(and(eq(groups.id, groupId), this._scope?.kind === "agent" ? eq(groups.agentId, this._scope.agentId) : undefined))
      .get();
  }

  private _requireGrant(grantId: string): AuthorizationRuleRecord {
    const grant = this._db
      .select()
      .from(authorizationRules)
      .where(and(eq(authorizationRules.id, grantId), authorizationScopeFilter(this._scope)))
      .get();
    if (grant === undefined) {
      throw new Error(`Operation grant not found: ${grantId}`);
    }
    return operationGrantRecord(grant);
  }
}

function operationGrantRecord(
  row: typeof authorizationRules.$inferSelect,
): AuthorizationRuleRecord {
  return {
    id: row.id,
    subjectType: row.subjectType as AuthorizationSubjectType,
    subjectId: row.subjectId,
    target: row.target,
    effect: row.effect as OperationGrantEffect,
    matchType: row.matchType as "exact" | "prefix",
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isExpired(grant: AuthorizationRuleRecord, now: number): boolean {
  return grant.expiresAt !== undefined && grant.expiresAt <= now;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
