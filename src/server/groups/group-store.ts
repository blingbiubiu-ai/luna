import { HTTPException } from "hono/http-exception";
import { and, asc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { groupMemberships, groups, users } from "@/data/schema";
import { uuid } from "@/shared";
import { AgentStore } from "@/agents/agent-store";

export type GroupRole = "member" | "owner" | "admin";

export interface GroupRecord {
  readonly id: string;
  readonly agentId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly status: "active" | "disabled";
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupMemberRecord {
  readonly id: string;
  readonly groupId: string;
  readonly userId: string;
  readonly role: GroupRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class GroupStore {
  constructor(private readonly _db: DrizzleDB) {}

  createGroup(input: {
    readonly agentId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly description?: string | null;
    readonly avatarUrl?: string | null;
  }): GroupRecord {
    const now = String(Date.now());
    this._db
      .insert(groups)
      .values({
        id: uuid(),
        agentId: input.agentId,
        slug: input.slug,
        displayName: input.displayName,
        description: input.description ?? null,
        avatarUrl: input.avatarUrl ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [groups.agentId, groups.slug],
        set: {
          displayName: input.displayName,
          description: input.description ?? null,
          avatarUrl: input.avatarUrl ?? null,
          updatedAt: now,
        },
      })
      .run();

    const group = this._db
      .select()
      .from(groups)
      .where(and(eq(groups.agentId, input.agentId), eq(groups.slug, input.slug)))
      .get();
    if (group === undefined) {
      throw new Error(`Group was not persisted: ${input.slug}`);
    }
    return this._groupRecord(group);
  }

  requireGroup(groupId: string, agentId?: string): GroupRecord {
    const group = this._db
      .select()
      .from(groups)
      .where(and(eq(groups.id, groupId), agentId === undefined ? undefined : eq(groups.agentId, agentId)))
      .get();
    if (group === undefined) {
      throw new HTTPException(404, {message: "Group not found"});
    }
    return this._groupRecord(group);
  }

  listGroups(agentId: string): GroupRecord[] {
    return this._db
      .select()
      .from(groups)
      .where(eq(groups.agentId, agentId))
      .orderBy(asc(groups.slug))
      .all()
      .map((row) => this._groupRecord(row));
  }

  addMember(input: {
    readonly groupId: string;
    readonly userId: string;
    readonly role?: GroupRole;
  }): GroupMemberRecord {
    const group = this.requireGroup(input.groupId);
    // Only an active user of the group's Agent can join it.
    new AgentStore(this._db).requireAccess(input.userId, group.agentId);
    const now = String(Date.now());
    const role = input.role ?? "member";

    this._db
      .insert(groupMemberships)
      .values({
        id: uuid(),
        groupId: input.groupId,
        userId: input.userId,
        role,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [groupMemberships.groupId, groupMemberships.userId],
        set: {
          role,
          updatedAt: now,
        },
      })
      .run();

    const membership = this._db
      .select()
      .from(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, input.groupId),
          eq(groupMemberships.userId, input.userId),
        ),
      )
      .get();
    if (membership === undefined) {
      throw new Error(
        `Group membership was not persisted: ${input.groupId}:${input.userId}`,
      );
    }
    return groupMemberRecord(membership);
  }

  removeMember(input: {
    readonly groupId: string;
    readonly userId: string;
  }): GroupMemberRecord | null {
    const existing = this._db
      .select()
      .from(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, input.groupId),
          eq(groupMemberships.userId, input.userId),
        ),
      )
      .get();
    if (existing === undefined) {
      return null;
    }
    this._db
      .delete(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, input.groupId),
          eq(groupMemberships.userId, input.userId),
        ),
      )
      .run();
    return groupMemberRecord(existing);
  }

  listMembers(groupId: string): GroupMemberRecord[] {
    this.requireGroup(groupId);
    return this._db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.groupId, groupId))
      .orderBy(asc(groupMemberships.userId))
      .all()
      .map(groupMemberRecord);
  }

  listUserGroups(userId: string): GroupRecord[] {
    this._requireUser(userId);
    const memberships = this._db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, userId))
      .orderBy(asc(groupMemberships.groupId))
      .all();
    return memberships.map((membership) =>
      this.requireGroup(membership.groupId),
    );
  }

  private _groupRecord(row: typeof groups.$inferSelect): GroupRecord {
    const memberCount = this._db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.groupId, row.id))
      .all().length;
    return {
      id: row.id,
      agentId: row.agentId,
      slug: row.slug,
      displayName: row.displayName,
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.avatarUrl === null ? {} : { avatarUrl: row.avatarUrl }),
      status: row.status as "active" | "disabled",
      memberCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private _requireUser(userId: string): typeof users.$inferSelect {
    const user = this._db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (user === undefined) {
      throw new Error(`User not found: ${userId}`);
    }
    return user;
  }
}

function groupMemberRecord(
  row: typeof groupMemberships.$inferSelect,
): GroupMemberRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    role: row.role as GroupRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
