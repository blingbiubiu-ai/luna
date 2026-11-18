import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, ne, or } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { accounts, agentMutationReceipts, agentShadows, channelIdentities, channelUserBindings, lunaAgents, users } from "@/data/schema";
import { cleanDisplayName } from "@/identity/display-name";
import { followShadowBotName } from "@/identity/shadow-name";
import { isOwnerUser, ownerUserId } from "@/identity/account-store";

export type AgentRecord = typeof lunaAgents.$inferSelect;
export type ShadowRecord = typeof agentShadows.$inferSelect;
export type AgentAccessOptions = Readonly<{readHistory?: boolean}>;
export type AgentScope = Readonly<{agentId: string; shadowId: string}>;

/** Stable domain errors are translated into HTTP responses at the route boundary. */
export class AgentError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409) {
    super(code);
    this.name = "AgentError";
  }
}

/**
 * Owns Agent creation, ownership and Shadow identities in one database transaction.
 * Ownership and configuration take an account id (the Dashboard); access checks
 * take a user of the Agent (everything that runs inside it).
 */
export class AgentStore {
  constructor(private readonly db: Pick<DrizzleDB, "select" | "insert" | "transaction">) {}

  /** Creates the Agent with its owner user and default Shadow. */
  create(accountId: string, input: {name: string}, key: string): AgentRecord {
    const name = validName(input.name);
    validKey(key);
    return this.db.transaction(tx => {
      const store = new AgentStore(tx);
      const account = store.requireAccount(accountId);
      const hash = requestHash({name});
      const prior = store.receipt(accountId, "agent.create", key, hash);
      if (prior) return store.get(prior);
      const id = randomUUID(), shadowId = randomUUID(), now = Date.now(), timestamp = new Date(now).toISOString();
      tx.insert(lunaAgents).values({id, ownerAccountId: accountId, name, defaultShadowId: shadowId, status: "active", createdAt: now, updatedAt: now}).run();
      tx.insert(users).values({id: randomUUID(), agentId: id, accountId, kind: "human", displayName: account.displayName,
        avatarUrl: account.avatarUrl, status: "active", profileSource: "dashboard", createdAt: timestamp, updatedAt: timestamp}).run();
      store.insertShadow(id, shadowId, "本体", now);
      store.saveReceipt(accountId, "agent.create", key, hash, id, now);
      return store.get(id);
    });
  }

  /** The owner's user inside the Agent. */
  ownerUserId(agentId: string): string {
    return ownerUserId(this.db, agentId);
  }

  isOwnerUser(agentId: string, userId: string): boolean {
    return isOwnerUser(this.db, agentId, userId);
  }

  get(agentId: string): AgentRecord {
    const agent = this.db.select().from(lunaAgents).where(eq(lunaAgents.id, agentId)).get();
    if (!agent) throw new AgentError("agent_not_found", 404);
    return agent;
  }

  list(accountId: string, limit = 50, cursor?: {createdAt: number; id: string}): AgentRecord[] {
    this.requireAccount(accountId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentError("invalid_limit", 400);
    return this.db.select().from(lunaAgents).where(and(
      ne(lunaAgents.status, "deleted"),
      eq(lunaAgents.ownerAccountId, accountId),
      cursor ? or(gt(lunaAgents.createdAt, cursor.createdAt), and(eq(lunaAgents.createdAt, cursor.createdAt), gt(lunaAgents.id, cursor.id))) : undefined,
    )).orderBy(asc(lunaAgents.createdAt), asc(lunaAgents.id)).limit(limit).all();
  }

  shadow(shadowId: string): ShadowRecord {
    const shadow = this.db.select().from(agentShadows).where(eq(agentShadows.id, shadowId)).get();
    if (!shadow) throw new AgentError("shadow_not_found", 404);
    return shadow;
  }

  /** The account owns the Agent. */
  requireOwner(accountId: string, agentId: string, options: {includeDeleted?: boolean} = {}): AgentRecord {
    this.requireAccount(accountId);
    const agent = this.get(agentId);
    if (agent.ownerAccountId !== accountId) throw new AgentError("agent_access_denied", 403);
    if (agent.status === "deleted" && !options.includeDeleted) throw new AgentError("agent_deleted", 409);
    return agent;
  }

  /** An active user of this Agent may use it. */
  requireAccess(actorUserId: string, agentId: string, options: AgentAccessOptions = {}): AgentRecord {
    const user = this.db.select().from(users).where(eq(users.id, actorUserId)).get();
    if (user?.agentId !== agentId) throw new AgentError("agent_access_denied", 403);
    if (user.status !== "active" || (user.kind !== "human" && user.kind !== "bot" &&
      !(user.kind === "shadow" && this.db.select().from(agentShadows).where(eq(agentShadows.replyUserId, user.id)).get()?.status === "active"))) {
      throw new AgentError("active_user_required", 403);
    }
    const agent = this.get(agentId);
    if (options.readHistory && this.isOwnerUser(agentId, actorUserId)) return agent;
    if (agent.status !== "active") throw new AgentError("agent_disabled", 409);
    return agent;
  }

  requireScope(actorUserId: string, scope: AgentScope, options: AgentAccessOptions = {}): ShadowRecord {
    const agent = this.requireAccess(actorUserId, scope.agentId, options);
    const shadow = this.shadow(scope.shadowId);
    if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
    if (shadow.status !== "active" && !(options.readHistory && this.isOwnerUser(agent.id, actorUserId))) throw new AgentError("shadow_disabled", 409);
    return shadow;
  }

  listShadows(accountId: string, agentId: string): ShadowRecord[] {
    this.requireOwner(accountId, agentId);
    return this.db.select().from(agentShadows).where(eq(agentShadows.agentId, agentId))
      .orderBy(asc(agentShadows.createdAt), asc(agentShadows.id)).all();
  }

  /**
   * The owner names a Shadow; the name then stays even if its bot is renamed.
   * An empty name hands the name back to the Shadow's bot.
   */
  renameShadow(accountId: string, scope: AgentScope, input: {name: string}): ShadowRecord {
    const follow = input.name.trim() === "";
    const name = follow ? "" : validName(input.name);
    return this.db.transaction(tx => {
      const store = new AgentStore(tx);
      store.requireOwner(accountId, scope.agentId);
      store.requireAccess(store.ownerUserId(scope.agentId), scope.agentId);
      const shadow = store.shadow(scope.shadowId);
      if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
      if (shadow.status === "deleted") throw new AgentError("shadow_deleted", 409);
      const now = Date.now();
      if (follow) {
        const botName = tx.select({name: channelIdentities.displayName}).from(channelUserBindings)
          .innerJoin(channelIdentities, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
          .where(and(eq(channelUserBindings.userId, shadow.replyUserId), eq(channelIdentities.identityKind, "bot")))
          .orderBy(desc(channelIdentities.lastSeenAt)).get()?.name;
        if (!cleanDisplayName(botName)) throw new AgentError("shadow_bot_name_unknown", 409);
        tx.update(users).set({profileSource: "channel", updatedAt: new Date(now).toISOString()}).where(eq(users.id, shadow.replyUserId)).run();
        followShadowBotName(tx, shadow.replyUserId, botName);
        return store.shadow(shadow.id);
      }
      tx.update(agentShadows).set({name, updatedAt: now}).where(eq(agentShadows.id, shadow.id)).run();
      tx.update(users).set({displayName: name, profileSource: "manual", updatedAt: new Date(now).toISOString()})
        .where(eq(users.id, shadow.replyUserId)).run();
      return store.shadow(shadow.id);
    });
  }

  createShadow(accountId: string, agentId: string, input: {name: string}, key: string): ShadowRecord {
    const name = validName(input.name);
    validKey(key);
    return this.db.transaction(tx => {
      const store = new AgentStore(tx);
      store.requireOwner(accountId, agentId);
      store.requireAccess(store.ownerUserId(agentId), agentId);
      const hash = requestHash({agentId, name});
      const prior = store.receipt(accountId, "shadow.create", key, hash);
      if (prior) return store.shadow(prior);
      const id = randomUUID(), now = Date.now();
      store.insertShadow(agentId, id, name, now);
      store.saveReceipt(accountId, "shadow.create", key, hash, id, now);
      return store.shadow(id);
    });
  }

  private requireAccount(id: string) {
    const account = this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (account?.status !== "active") throw new AgentError("active_account_required", 403);
    return account;
  }

  private insertShadow(agentId: string, id: string, name: string, now: number): void {
    const replyUserId = randomUUID(), timestamp = new Date(now).toISOString();
    this.db.insert(users).values({id: replyUserId, agentId, kind: "shadow", displayName: name, status: "active",
      profileSource: "system", createdAt: timestamp, updatedAt: timestamp}).run();
    this.db.insert(agentShadows).values({id, agentId, name, replyUserId, status: "active", createdAt: now, updatedAt: now}).run();
  }

  private receipt(actor: string, operation: string, key: string, hash: string): string | undefined {
    const row = this.db.select().from(agentMutationReceipts).where(and(eq(agentMutationReceipts.actorAccountId, actor),
      eq(agentMutationReceipts.operation, operation), eq(agentMutationReceipts.key, key))).get();
    if (row && row.requestHash !== hash) throw new AgentError("idempotency_conflict", 409);
    return row?.entityId;
  }

  private saveReceipt(actorAccountId: string, operation: string, key: string, hash: string, entityId: string, now: number): void {
    this.db.insert(agentMutationReceipts).values({actorAccountId, operation, key, requestHash: hash, entityId, createdAt: now}).run();
  }
}

function validName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw new AgentError("invalid_name", 400);
  return name;
}
function validKey(key: string): void {
  if (!key || key.length > 200 || key.trim() !== key) throw new AgentError("invalid_idempotency_key", 400);
}
function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
