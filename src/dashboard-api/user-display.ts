import type { DrizzleDB } from "@/data";
import { eq } from "drizzle-orm";
import { users } from "@/data/schema";
import { usableDisplayName } from "@/identity/display-name";
import type { UserRow } from "./identity";
export type DisplayNameSource = "manual" | "channel" | "mention" | "id";
export type DisplayUserRow = UserRow & { displayNameSource: DisplayNameSource };
/** Users, of one Agent when given, with where their shown name comes from. */
export function loadDashboardUserRows(db: DrizzleDB, agentId?: string): DisplayUserRow[] {
  return db.select().from(users).where(agentId === undefined ? undefined : eq(users.agentId, agentId)).all().map(row => ({ ...row,
    displayNameSource: row.profileSource === "mention" ? "mention" : row.profileSource !== "channel" ? "manual" : usableDisplayName(row.displayName, new Set([row.id])) ? "channel" : "id",
  }));
}
