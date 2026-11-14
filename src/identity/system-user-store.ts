import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { users } from "@/data/schema";

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

  requireUserId(kind: LunaSystemUserKind): string {
    const record = SYSTEM_USER_RECORDS[kind];
    const existing = this._db
      .select()
      .from(users)
      .where(eq(users.id, record.id))
      .get();
    if (existing !== undefined) {
      return existing.id;
    }
    const now = String(Date.now());
    this._db
      .insert(users)
      .values({
        id: record.id,
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
    return record.id;
  }
}

export function isReservedSystemUserId(userId: string): boolean {
  return userId === LUNA_SYSTEM_USER_ID ||
    userId === LUNA_INTERNAL_USER_ID;
}
