import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, ne, or } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { agentMutationReceipts, agentShadows, lunaAgents, users } from "@/data/schema";

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

/** Owns Agent creation, ownership and Shadow identities in one database transaction. */
export class AgentStore {
  constructor(private readonly db: Pick<DrizzleDB, "select" | "insert" | "transaction">) {}

  create(actorUserId: string, input: {name: string}, key: string): AgentRecord {
    const name = validName(input.name);
    validKey(key);
    return this.db.transaction(tx => {
      const store = new AgentStore(tx);
      store.requireHuman(actorUserId);
      const hash = requestHash({name});
      const prior = store.receipt(actorUserId, "agent.create", key, hash);
      if (prior) return store.get(prior);
      const id = randomUUID(), shadowId = randomUUID(), now = Date.now();
      tx.insert(lunaAgents).values({id, ownerUserId: actorUserId, name, defaultShadowId: shadowId, status: "active", createdAt: now, updatedAt: now}).run();
      store.insertShadow(id, shadowId, "本体", now);
      store.saveReceipt(actorUserId, "agent.create", key, hash, id, now);
      return store.get(id);
    });
  }

  get(agentId: string): AgentRecord {
    const agent = this.db.select().from(lunaAgents).where(eq(lunaAgents.id, agentId)).get();
    if (!agent) throw new AgentError("agent_not_found", 404);
    return agent;
  }

  list(actorUserId: string, limit = 50, cursor?: {createdAt: number; id: string}): AgentRecord[] {
    this.requireHuman(actorUserId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentError("invalid_limit", 400);
    return this.db.select().from(lunaAgents).where(and(
      ne(lunaAgents.status, "deleted"),
      eq(lunaAgents.ownerUserId, actorUserId),
      cursor ? or(gt(lunaAgents.createdAt, cursor.createdAt), and(eq(lunaAgents.createdAt, cursor.createdAt), gt(lunaAgents.id, cursor.id))) : undefined,
    )).orderBy(asc(lunaAgents.createdAt), asc(lunaAgents.id)).limit(limit).all();
  }

  shadow(shadowId: string): ShadowRecord {
    const shadow = this.db.select().from(agentShadows).where(eq(agentShadows.id, shadowId)).get();
    if (!shadow) throw new AgentError("shadow_not_found", 404);
    return shadow;
  }

  requireOwner(actorUserId: string, agentId: string, options: {includeDeleted?: boolean} = {}): AgentRecord {
    this.requireHuman(actorUserId);
    const agent = this.get(agentId);
    if (agent.ownerUserId !== actorUserId) throw new AgentError("agent_access_denied", 403);
    if (agent.status === "deleted" && !options.includeDeleted) throw new AgentError("agent_deleted", 409);
    return agent;
  }

  requireAccess(actorUserId: string, agentId: string, options: AgentAccessOptions = {}): AgentRecord {
    const user = this.db.select().from(users).where(eq(users.id, actorUserId)).get();
    if (user?.status !== "active" || (user.kind !== "human" && user.kind !== "bot" &&
      !(user.kind === "system" && this.db.select().from(agentShadows).where(eq(agentShadows.replyUserId, user.id)).get()?.status === "active"))) {
      throw new AgentError("active_user_required", 403);
    }
    const agent = this.get(agentId);
    if (options.readHistory && agent.ownerUserId === actorUserId) return agent;
    if (agent.status !== "active") throw new AgentError("agent_disabled", 409);
    return agent;
  }

  requireScope(actorUserId: string, scope: AgentScope, options: AgentAccessOptions = {}): ShadowRecord {
    const agent = this.requireAccess(actorUserId, scope.agentId, options);
    const shadow = this.shadow(scope.shadowId);
    if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
    if (shadow.status !== "active" && !(options.readHistory && agent.ownerUserId === actorUserId)) throw new AgentError("shadow_disabled", 409);
    return shadow;
  }

  listShadows(actorUserId: string, agentId: string): ShadowRecord[] {
    this.requireOwner(actorUserId, agentId);
    return this.db.select().from(agentShadows).where(eq(agentShadows.agentId, agentId))
      .orderBy(asc(agentShadows.createdAt), asc(agentShadows.id)).all();
  }

  renameShadow(actorUserId: string, scope: AgentScope, input: {name: string}): ShadowRecord {
    const name = validName(input.name);
    return this.db.transaction(tx => {
      const store = new AgentStore(tx);
      store.requireOwner(actorUserId, scope.agentId);
      store.requireAccess(actorUserId, scope.agentId);
      const shadow = store.shadow(scope.shadowId);
      if (shadow.agentId !== scope.agentId) throw new AgentError("scope_mismatch", 409);
      if (shadow.status === "deleted") throw new AgentError("shadow_deleted", 409);
      if (shadow.name === name) return shadow;
      const now = Date.now();
      tx.update(agentShadows).set({name, updatedAt: now}).where(eq(agentShadows.id, shadow.id)).run();
      tx.update(users).set({displayName: name, updatedAt: new Date(now).toISOString()})
        .where(eq(users.id, shadow.replyUserId)).run();
      return store.shadow(shadow.id);
    });
  }

  createShadow(actorUserId: string, agentId: string, input: {name: string}, key: string): ShadowRecord {
    const name = validName(input.name);
    validKey(key);
    return this.db.transaction(tx => {
      const store = new AgentStore(tx);
      store.requireOwner(actorUserId, agentId);
      store.requireAccess(actorUserId, agentId);
      const hash = requestHash({agentId, name});
      const prior = store.receipt(actorUserId, "shadow.create", key, hash);
      if (prior) return store.shadow(prior);
      const id = randomUUID(), now = Date.now();
      store.insertShadow(agentId, id, name, now);
      store.saveReceipt(actorUserId, "shadow.create", key, hash, id, now);
      return store.shadow(id);
    });
  }

  private requireHuman(id: string): void {
    const user = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!user || user.kind !== "human" || user.status !== "active") throw new AgentError("active_user_required", 403);
  }

  private insertShadow(agentId: string, id: string, name: string, now: number): void {
    const replyUserId = randomUUID(), timestamp = new Date(now).toISOString();
    this.db.insert(users).values({id: replyUserId, kind: "system", displayName: name, status: "active",
      profileSource: "system", createdAt: timestamp, updatedAt: timestamp}).run();
    this.db.insert(agentShadows).values({id, agentId, name, replyUserId, status: "active", createdAt: now, updatedAt: now}).run();
  }

  private receipt(actor: string, operation: string, key: string, hash: string): string | undefined {
    const row = this.db.select().from(agentMutationReceipts).where(and(eq(agentMutationReceipts.actorUserId, actor),
      eq(agentMutationReceipts.operation, operation), eq(agentMutationReceipts.key, key))).get();
    if (row && row.requestHash !== hash) throw new AgentError("idempotency_conflict", 409);
    return row?.entityId;
  }

  private saveReceipt(actorUserId: string, operation: string, key: string, hash: string, entityId: string, now: number): void {
    this.db.insert(agentMutationReceipts).values({actorUserId, operation, key, requestHash: hash, entityId, createdAt: now}).run();
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
