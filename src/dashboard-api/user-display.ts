import type { DrizzleDB } from "@/data";
import { users } from "@/data/schema";
import { usableDisplayName } from "@/identity/display-name";
import type { UserRow } from "./identity";
export type DisplayNameSource = "manual" | "channel" | "mention" | "id";
export type DisplayUserRow = UserRow & { displayNameSource: DisplayNameSource };
export function loadDashboardUserRows(db: DrizzleDB): DisplayUserRow[] {
  return db.select().from(users).all().map(row => ({ ...row,
    displayNameSource: row.profileSource === "mention" ? "mention" : row.profileSource !== "channel" ? "manual" : usableDisplayName(row.displayName, new Set([row.id])) ? "channel" : "id",
  }));
}
