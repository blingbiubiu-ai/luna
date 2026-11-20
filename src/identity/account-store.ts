import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { accountIdentityClaims, accounts, lunaAgents, users } from "@/data/schema";
import { AgentError } from "@/agents/agent-store";
import { validateIdentityClaim } from "./claim-validation";

/** Built-in super administrator account authenticated via `LUNA_DASHBOARD_TOKEN`. */
export const SUPER_ADMIN_ACCOUNT_ID = "local-dashboard-user";

export function isSuperAdminAccountId(accountId: string): boolean {
  return accountId === SUPER_ADMIN_ACCOUNT_ID;
}

export type AccountRecord = typeof accounts.$inferSelect;

/** Channel-agnostic verified identity claim attached to an account at OAuth/OIDC/SSO sign-in. */
export interface AccountIdentityClaimInput {
  readonly namespace: string;
  readonly kind: string;
  readonly value: string;
  readonly scope: string;
  readonly confidence?: "verified" | "inferred" | "manual";
}

/** The profile a sign-in provider returns for an account. */
export interface AccountProfile {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl?: string | null;
  readonly identityClaims?: readonly AccountIdentityClaimInput[];
  /** The sign-in names nobody in particular; a stored name is kept rather than reset to it. */
  readonly placeholderName?: boolean;
}

type Db = Pick<DrizzleDB, "select" | "insert" | "update" | "delete">;

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

  /** Creates the account on first sign-in and keeps its profile and verified claims current. A deleted account is not revived. */
  ensure(profile: AccountProfile, now = Date.now()): AccountRecord {
    const existing = this.get(profile.id);
    if (!existing) {
      this.db.insert(accounts).values({
        id: profile.id,
        displayName: profile.name,
        avatarUrl: profile.avatarUrl ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }).run();
      this.syncIdentityClaims(profile.id, profile.identityClaims, now);
      return this.get(profile.id)!;
    }
    if (existing.status === "active") {
      this.syncIdentityClaims(profile.id, profile.identityClaims, now);
    }
    // A placeholder sign-in keeps a real stored name; a stored name that is only the id is no better than the placeholder.
    if (profile.placeholderName && existing.displayName !== existing.id) return existing;
    const nextAvatar = profile.avatarUrl === undefined ? existing.avatarUrl : profile.avatarUrl;
    if (
      existing.status === "active" &&
      (existing.displayName !== profile.name || existing.avatarUrl !== nextAvatar)
    ) {
      this.db.update(accounts).set({
        displayName: profile.name,
        avatarUrl: nextAvatar,
        updatedAt: now,
      }).where(eq(accounts.id, profile.id)).run();
      return this.get(profile.id)!;
    }
    return existing;
  }

  private syncIdentityClaims(
    accountId: string,
    claims: readonly AccountIdentityClaimInput[] | undefined,
    now: number,
  ): void {
    if (claims === undefined || isSuperAdminAccountId(accountId)) return;
    const verified = claims.filter((claim) => claim.confidence === undefined || claim.confidence === "verified");
    for (const claim of verified) {
      validateIdentityClaim(claim);
    }
    const namespaces = [...new Set(verified.map((claim) => claim.namespace))];
    for (const namespace of namespaces) {
      const freshForNamespace = verified.filter((claim) => claim.namespace === namespace);
      const freshKeys = new Set(freshForNamespace.map((claim) => `${claim.kind}\0${claim.value}\0${claim.scope}`));
      const existingRows = this.db
        .select()
        .from(accountIdentityClaims)
        .where(
          and(
            eq(accountIdentityClaims.accountId, accountId),
            eq(accountIdentityClaims.identityNamespace, namespace),
          ),
        )
        .all();
      for (const row of existingRows) {
        if (!freshKeys.has(`${row.identityKind}\0${row.identityValue}\0${row.identityScope}`)) {
          this.db
            .delete(accountIdentityClaims)
            .where(
              and(
                eq(accountIdentityClaims.accountId, accountId),
                eq(accountIdentityClaims.identityNamespace, row.identityNamespace),
                eq(accountIdentityClaims.identityKind, row.identityKind),
                eq(accountIdentityClaims.identityValue, row.identityValue),
                eq(accountIdentityClaims.identityScope, row.identityScope),
              ),
            )
            .run();
        }
      }
      for (const claim of freshForNamespace) {
        this.db
          .insert(accountIdentityClaims)
          .values({
            accountId,
            identityNamespace: claim.namespace,
            identityKind: claim.kind,
            identityValue: claim.value,
            identityScope: claim.scope,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              accountIdentityClaims.accountId,
              accountIdentityClaims.identityNamespace,
              accountIdentityClaims.identityKind,
              accountIdentityClaims.identityValue,
              accountIdentityClaims.identityScope,
            ],
            set: { updatedAt: now },
          })
          .run();
      }
    }
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
