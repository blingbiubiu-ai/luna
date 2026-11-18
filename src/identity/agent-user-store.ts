import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import type { DrizzleDB } from "@/data";
import { lunaAgents, users } from "@/data/schema";

export type ManagedUserStatus = "active" | "blocked";
type UserRow = typeof users.$inferSelect;

/**
 * The owner manages the users of one Agent: their name in it, whether it
 * answers them, and whether they are on its list. Nothing here reaches another
 * Agent or a platform account.
 */
export class AgentUserStore {
  constructor(private readonly db: DrizzleDB) {}

  update(agentId: string, userId: string, input: { displayName?: string; status?: ManagedUserStatus }): UserRow {
    const user = this.requireManaged(agentId, userId);
    const now = String(Date.now());
    const displayName = input.displayName?.trim();
    if (displayName !== undefined && (displayName.length === 0 || displayName.length > 100)) {
      throw new HTTPException(400, { message: "displayName must be 1 to 100 characters" });
    }
    if (input.status === "blocked" && this.isOwner(agentId, user)) {
      throw new HTTPException(409, { message: "The Agent owner cannot be blocked" });
    }
    this.db.update(users).set({
      ...(displayName === undefined ? {} : { displayName, profileSource: "manual" }),
      ...(input.status === undefined ? {} : { status: input.status }),
      updatedAt: now,
    }).where(eq(users.id, user.id)).run();
    return this.db.select().from(users).where(eq(users.id, user.id)).get()!;
  }

  /** Takes a user off the list; a later message from them puts them back. */
  remove(agentId: string, userId: string): UserRow {
    const user = this.requireManaged(agentId, userId);
    if (this.isOwner(agentId, user)) throw new HTTPException(409, { message: "The Agent owner cannot be removed" });
    this.db.update(users).set({ status: "removed", updatedAt: String(Date.now()) }).where(eq(users.id, user.id)).run();
    return this.db.select().from(users).where(eq(users.id, user.id)).get()!;
  }

  private requireManaged(agentId: string, userId: string): UserRow {
    const user = this.db.select().from(users).where(and(eq(users.id, userId), eq(users.agentId, agentId))).get();
    if (!user || user.status === "merged") throw new HTTPException(404, { message: `User not found: ${userId}` });
    // Shadows and Luna's own authors are managed with the Shadow, not here.
    if (user.kind === "shadow" || user.kind === "system") throw new HTTPException(409, { message: "Shadow and system users are not managed here" });
    return user;
  }

  private isOwner(agentId: string, user: UserRow): boolean {
    return user.accountId !== null && this.db.select({ id: lunaAgents.id }).from(lunaAgents)
      .where(and(eq(lunaAgents.id, agentId), eq(lunaAgents.ownerAccountId, user.accountId))).get() !== undefined;
  }
}
