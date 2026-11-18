import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { users } from "@/data/schema";

/**
 * Callers name Luna's own authors with these ids; each Agent stores them as its
 * own users (`<id>:<agentId>`), since every user belongs to one Agent.
 */
export const LUNA_SYSTEM_USER_ID = "reserved:system:luna";
export const LUNA_INTERNAL_USER_ID = "reserved:internal:luna";

const SYSTEM_USER_RECORDS = {
  system: {
    id: LUNA_SYSTEM_USER_ID,
    displayName: "Luna System",
  },
  internal: {
    id: LUNA_INTERNAL_USER_ID,
    displayName: "Luna Internal",
  },
} as const;

export type LunaSystemUserKind = keyof typeof SYSTEM_USER_RECORDS;

export class SystemUserStore {
  constructor(private readonly _db: DrizzleDB) {}

  /** The Agent's own user for Luna's `kind` author, created on first use. */
  requireUserId(kind: LunaSystemUserKind, agentId: string): string {
    const record = SYSTEM_USER_RECORDS[kind];
    const id = `${record.id}:${agentId}`;
    const existing = this._db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    if (existing !== undefined) {
      return existing.id;
    }
    const now = String(Date.now());
    this._db
      .insert(users)
      .values({
        id,
        agentId,
        kind: "system",
        displayName: record.displayName,
        avatarUrl: null,
        status: "active",
        mergedIntoUserId: null,
        profileSource: "system",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }
}

/** Whether an id names one of Luna's own authors, by its alias or as an Agent's user. */
export function isReservedSystemUserId(userId: string): boolean {
  return [LUNA_SYSTEM_USER_ID, LUNA_INTERNAL_USER_ID].some(id => userId === id || userId.startsWith(`${id}:`));
}

/** Which of Luna's authors a reserved id names. */
export function systemUserKind(userId: string): LunaSystemUserKind {
  return userId === LUNA_SYSTEM_USER_ID || userId.startsWith(`${LUNA_SYSTEM_USER_ID}:`) ? "system" : "internal";
}
