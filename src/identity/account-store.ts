import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { accounts, lunaAgents, users } from "@/data/schema";
import { AgentError } from "@/agents/agent-store";

export type AccountRecord = typeof accounts.$inferSelect;

/** The profile a sign-in provider returns for an account. */
export interface AccountProfile {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl?: string | null;
  /** The sign-in names nobody in particular; a stored name is kept rather than reset to it. */
  readonly placeholderName?: boolean;
}

type Db = Pick<DrizzleDB, "select" | "insert" | "update">;

/** Platform accounts: who signs in to the Dashboard. */
export class AccountStore {
  constructor(private readonly db: Db) {}

  get(id: string): AccountRecord | undefined {
    return this.db.select().from(accounts).where(eq(accounts.id, id)).get();
  }

  requireActive(id: string): AccountRecord {
    const account = this.get(id);
    if (account?.status !== "active") throw new AgentError("active_account_required", 403);
    return account;
  }

  /** Creates the account on first sign-in and keeps its profile current. A deleted account is not revived. */
  ensure(profile: AccountProfile, now = Date.now()): AccountRecord {
    const existing = this.get(profile.id);
    if (!existing) {
      this.db.insert(accounts).values({id: profile.id, displayName: profile.name, avatarUrl: profile.avatarUrl ?? null,
        status: "active", createdAt: now, updatedAt: now}).run();
      return this.get(profile.id)!;
    }
    // A placeholder sign-in keeps a real stored name; a stored name that is only the id is no better than the placeholder.
    if (profile.placeholderName && existing.displayName !== existing.id) return existing;
    if (existing.status === "active" && (existing.displayName !== profile.name
      || (profile.avatarUrl !== undefined && existing.avatarUrl !== profile.avatarUrl))) {
      this.db.update(accounts).set({displayName: profile.name, ...(profile.avatarUrl === undefined ? {} : {avatarUrl: profile.avatarUrl}), updatedAt: now})
        .where(eq(accounts.id, profile.id)).run();
      return this.get(profile.id)!;
    }
    return existing;
  }
}

/** The user an account is inside one Agent; today only the owner has one. */
export function accountUserId(db: Pick<DrizzleDB, "select">, accountId: string, agentId: string): string | undefined {
  return db.select({id: users.id}).from(users)
    .where(and(eq(users.agentId, agentId), eq(users.accountId, accountId))).get()?.id;
}

/** The owner's user in an Agent; every Agent has one from its creation. */
export function ownerUserId(db: Pick<DrizzleDB, "select">, agentId: string): string {
  const row = db.select({id: users.id}).from(users)
    .innerJoin(lunaAgents, and(eq(lunaAgents.id, users.agentId), eq(lunaAgents.ownerAccountId, users.accountId)))
    .where(eq(users.agentId, agentId)).get();
  if (!row) throw new AgentError("agent_owner_user_missing", 409);
  return row.id;
}

/** Whether a user is the Agent owner acting inside it. */
export function isOwnerUser(db: Pick<DrizzleDB, "select">, agentId: string, userId: string): boolean {
  return Boolean(db.select({id: users.id}).from(users)
    .innerJoin(lunaAgents, and(eq(lunaAgents.id, users.agentId), eq(lunaAgents.ownerAccountId, users.accountId)))
    .where(and(eq(users.id, userId), eq(users.agentId, agentId))).get());
}
