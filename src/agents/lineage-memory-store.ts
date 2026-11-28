import {createHash, randomBytes, randomUUID} from "node:crypto";
import {and, desc, eq, inArray, like, or, sql} from "drizzle-orm";
import type {DrizzleDB} from "@/data";
import {
  accounts,
  agentLineages,
  agentMemories,
  authorizationRules,
  lineageContributions,
  lineageInvites,
  lineageMaintainers,
  lineageMemories,
  lineageMemoryOverrides,
  lineageMemoryRevisions,
  lineageSubscriptions,
  lunaAgents,
  LINEAGE_CONTRIBUTION_KINDS,
  LINEAGE_CONTRIBUTION_ORIGIN_KINDS,
  LINEAGE_CONTRIBUTION_STATUSES,
  LINEAGE_MEMORY_TYPES,
  type LineageContributionKind,
  type LineageContributionOriginKind,
  type LineageContributionStatus,
  type LineageMaintainerRole,
  type LineageMemoryChangeKind,
  type LineageMemoryOriginKind,
  type LineageMemoryStatus,
  type LineageMemoryType,
  type LineageStatus,
  type LineageSubscriptionStatus,
  type LineageTemplateConfig,
} from "@/data/schema";
import {AgentError, AgentStore} from "./agent-store";
import {AgentMemoryStore, MEMORY_BODY_LIMIT, memoryTerms} from "./agent-memory-store";

export type LineageRecord = typeof agentLineages.$inferSelect;
export type LineageMaintainerRecord = typeof lineageMaintainers.$inferSelect;
export type LineageInviteRecord = typeof lineageInvites.$inferSelect;
export type LineageSubscriptionRecord = typeof lineageSubscriptions.$inferSelect;
export type LineageMemoryRecord = typeof lineageMemories.$inferSelect;
export type LineageMemoryRevisionRecord = typeof lineageMemoryRevisions.$inferSelect;
export type LineageMemoryOverrideRecord = typeof lineageMemoryOverrides.$inferSelect;
export type LineageContributionRecord = typeof lineageContributions.$inferSelect;

export interface LineageChainNode {
  lineage: LineageRecord;
  sourceAgentName: string;
  depth: number;
  lookupAllowed: boolean;
}

export interface LineageRecallEntry {
  memory: LineageMemoryRecord;
  lineageName: string;
  depth: number;
}

export class LineageConflictError extends AgentError {
  constructor(code: string, readonly currentRevision: number) {
    super(code, 409);
  }
}

const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 200;
const MATCH_TERM_LIMIT = 256;
const MAX_LINEAGE_DEPTH = 10;
export const MAX_ANCESTOR_LOOKUP_DEPTH = 5;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function validateMemoryFields(input: {type: LineageMemoryType; title: string; description: string; body: string}) {
  if (!LINEAGE_MEMORY_TYPES.includes(input.type)) throw new AgentError("invalid_lineage_memory_type", 400);
  const title = input.title.trim();
  const description = input.description.trim().replace(/\s+/g, " ");
  const body = input.body.trim();
  if (!title || title.length > TITLE_LIMIT) throw new AgentError("invalid_memory_title", 400);
  if (!description || description.length > DESCRIPTION_LIMIT) throw new AgentError("invalid_memory_description", 400);
  if (!body || Buffer.byteLength(body) > MEMORY_BODY_LIMIT) throw new AgentError("invalid_memory_body", 400);
  return {type: input.type, title, description, body};
}

function indexLineageTerms(tx: Pick<DrizzleDB, "run">, row: Pick<LineageMemoryRecord, "id" | "title" | "description" | "body">): void {
  const terms = (text: string) => memoryTerms(text).join(" ");
  tx.run(sql`DELETE FROM lineage_memory_terms WHERE lineage_memory_terms MATCH ${`memory_id:"${row.id}"`}`);
  tx.run(sql`INSERT INTO lineage_memory_terms (memory_id, title, description, body) VALUES (${row.id}, ${terms(row.title)}, ${terms(row.description)}, ${terms(row.body)})`);
}

function deleteLineageTerms(tx: Pick<DrizzleDB, "run">, id: string): void {
  tx.run(sql`DELETE FROM lineage_memory_terms WHERE lineage_memory_terms MATCH ${`memory_id:"${id}"`}`);
}

export const LINEAGE_PUBLISH_TARGET = "system.lineage.publish";

/** Whether a platform account is allowed to enable/publish outbound lineage memory on its Agents. Defaults to false. */
export function canAccountPublishLineage(db: DrizzleDB, accountId: string, now = Date.now()): boolean {
  const rows = db.select({
    effect: authorizationRules.effect,
    expiresAt: authorizationRules.expiresAt,
  }).from(authorizationRules)
    .where(and(
      eq(authorizationRules.scopeType, "platform"),
      eq(authorizationRules.subjectType, "user"),
      eq(authorizationRules.subjectId, accountId),
      eq(authorizationRules.target, LINEAGE_PUBLISH_TARGET),
    )).all();
  let allowed = false;
  for (const row of rows) {
    if (row.expiresAt !== null && row.expiresAt <= now) continue;
    if (row.effect === "deny") return false;
    if (row.effect === "allow") allowed = true;
  }
  return allowed;
}

/** Platform administrator helper to grant or revoke an account's outbound lineage publishing permission. */
export function setAccountPublishLineage(db: DrizzleDB, accountId: string, enabled: boolean): void {
  const iso = new Date().toISOString();
  db.transaction(tx => {
    tx.delete(authorizationRules).where(and(
      eq(authorizationRules.scopeType, "platform"),
      eq(authorizationRules.subjectType, "user"),
      eq(authorizationRules.subjectId, accountId),
      eq(authorizationRules.target, LINEAGE_PUBLISH_TARGET),
    )).run();
    if (enabled) {
      tx.insert(authorizationRules).values({
        id: `ar_${randomUUID()}`,
        scopeType: "platform",
        agentId: null,
        subjectType: "user",
        subjectId: accountId,
        target: LINEAGE_PUBLISH_TARGET,
        matchType: "exact",
        effect: "allow",
        expiresAt: null,
        createdAt: iso,
        updatedAt: iso,
      }).run();
    }
  });
}

export class LineageMemoryStore {
  constructor(private readonly db: DrizzleDB) {}

  private latestSeq(tx: Pick<DrizzleDB, "select"> = this.db): number {
    return tx.select({seq: sql<number>`coalesce(max(${lineageMemories.changeSeq}), 0)`}).from(lineageMemories).get()?.seq ?? 0;
  }

  // ── Lineage Config & Authorization ──────────────────────────────────────────

  getByAgent(sourceAgentId: string): LineageRecord | null {
    return this.db.select().from(agentLineages).where(eq(agentLineages.sourceAgentId, sourceAgentId)).get() ?? null;
  }

  getById(lineageId: string): LineageRecord | null {
    return this.db.select().from(agentLineages).where(eq(agentLineages.id, lineageId)).get() ?? null;
  }

  requireByAgent(sourceAgentId: string): LineageRecord {
    const row = this.getByAgent(sourceAgentId);
    if (!row) throw new AgentError("lineage_not_found", 404);
    return row;
  }

  /**
   * Checks whether `accountId` can manage or review a lineage.
   * The source Agent's owner always has full admin rights; `lineage_maintainers` grants co-maintainer access.
   */
  requireManager(accountId: string, lineageId: string, minRole: LineageMaintainerRole = "reviewer"): LineageRecord {
    const lineage = this.getById(lineageId);
    if (!lineage) throw new AgentError("lineage_not_found", 404);
    const sourceAgent = this.db.select({ownerAccountId: lunaAgents.ownerAccountId})
      .from(lunaAgents).where(eq(lunaAgents.id, lineage.sourceAgentId)).get();
    if (!sourceAgent) throw new AgentError("agent_not_found", 404);
    if (sourceAgent.ownerAccountId === accountId) return lineage;
    const maintainer = this.db.select().from(lineageMaintainers)
      .where(and(eq(lineageMaintainers.lineageId, lineageId), eq(lineageMaintainers.accountId, accountId))).get();
    if (!maintainer) throw new AgentError("lineage_forbidden", 403);
    if (minRole === "admin" && maintainer.role !== "admin") throw new AgentError("lineage_forbidden", 403);
    return lineage;
  }

  upsertForAgent(
    actorAccountId: string,
    sourceAgentId: string,
    input: {
      name: string;
      description?: string | undefined;
      intakeGuidelines?: string | undefined;
      allowAncestorLookup?: boolean | undefined;
      allowMemberInvite?: boolean | undefined;
      template?: LineageTemplateConfig | undefined;
      status?: LineageStatus | undefined;
    },
  ): LineageRecord {
    new AgentStore(this.db).requireOwner(actorAccountId, sourceAgentId);
    if (!canAccountPublishLineage(this.db, actorAccountId)) {
      throw new AgentError("lineage_publish_forbidden", 403);
    }
    const name = input.name.trim();
    if (!name || name.length > TITLE_LIMIT) throw new AgentError("invalid_lineage_name", 400);
    const now = Date.now();
    const existing = this.getByAgent(sourceAgentId);
    if (existing) {
      const updated: LineageRecord = {
        ...existing,
        name,
        description: input.description !== undefined ? input.description.trim() : existing.description,
        intakeGuidelines: input.intakeGuidelines !== undefined ? input.intakeGuidelines.trim() : existing.intakeGuidelines,
        allowAncestorLookup: input.allowAncestorLookup ?? existing.allowAncestorLookup,
        allowMemberInvite: input.allowMemberInvite ?? existing.allowMemberInvite,
        template: input.template ?? existing.template,
        status: input.status ?? existing.status,
        updatedAt: now,
      };
      this.db.update(agentLineages).set(updated).where(eq(agentLineages.id, existing.id)).run();
      return updated;
    }
    const created: LineageRecord = {
      id: `lin_${randomUUID()}`,
      sourceAgentId,
      name,
      description: input.description?.trim() ?? "",
      intakeGuidelines: input.intakeGuidelines?.trim() ?? "",
      allowAncestorLookup: input.allowAncestorLookup ?? true,
      allowMemberInvite: input.allowMemberInvite ?? false,
      template: input.template ?? {},
      status: input.status ?? "active",
      createdByAccountId: actorAccountId,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(agentLineages).values(created).run();
    return created;
  }

  // ── Maintainers ─────────────────────────────────────────────────────────────

  listMaintainers(lineageId: string) {
    return this.db.select({
      lineageId: lineageMaintainers.lineageId,
      accountId: lineageMaintainers.accountId,
      role: lineageMaintainers.role,
      createdAt: lineageMaintainers.createdAt,
      displayName: accounts.displayName,
    }).from(lineageMaintainers)
      .innerJoin(accounts, eq(accounts.id, lineageMaintainers.accountId))
      .where(eq(lineageMaintainers.lineageId, lineageId))
      .all();
  }

  addMaintainer(actorAccountId: string, sourceAgentId: string, targetAccountId: string, role: LineageMaintainerRole = "reviewer") {
    const lineage = this.requireByAgent(sourceAgentId);
    this.requireManager(actorAccountId, lineage.id, "admin");
    const account = this.db.select().from(accounts).where(eq(accounts.id, targetAccountId)).get();
    if (!account) throw new AgentError("account_not_found", 404);
    const now = Date.now();
    this.db.insert(lineageMaintainers).values({lineageId: lineage.id, accountId: targetAccountId, role, createdAt: now})
      .onConflictDoUpdate({target: [lineageMaintainers.lineageId, lineageMaintainers.accountId], set: {role}}).run();
    return {lineageId: lineage.id, accountId: targetAccountId, role, displayName: account.displayName, createdAt: now};
  }

  removeMaintainer(actorAccountId: string, sourceAgentId: string, targetAccountId: string) {
    const lineage = this.requireByAgent(sourceAgentId);
    this.requireManager(actorAccountId, lineage.id, "admin");
    this.db.delete(lineageMaintainers).where(and(eq(lineageMaintainers.lineageId, lineage.id), eq(lineageMaintainers.accountId, targetAccountId))).run();
  }

  // ── Invites & Subscriptions ─────────────────────────────────────────────────

  createInvite(
    actorAccountId: string,
    sourceAgentId: string,
    input: {label?: string | undefined; requireApproval?: boolean | undefined; maxUses?: number | null | undefined; expiresAt?: number | null | undefined} = {},
  ): {invite: LineageInviteRecord; token: string} {
    const lineage = this.requireByAgent(sourceAgentId);
    this.requireManager(actorAccountId, lineage.id, "admin");
    if (lineage.status !== "active") throw new AgentError("lineage_not_active", 409);
    const rawToken = `linv_${randomBytes(18).toString("base64url")}`;
    const now = Date.now();
    const invite: LineageInviteRecord = {
      id: `inv_${randomUUID()}`,
      lineageId: lineage.id,
      tokenHash: hashToken(rawToken),
      label: input.label?.trim() ?? "",
      requireApproval: input.requireApproval ?? false,
      maxUses: input.maxUses ?? null,
      usedCount: 0,
      expiresAt: input.expiresAt ?? null,
      status: "active",
      createdByAccountId: actorAccountId,
      createdAt: now,
    };
    this.db.insert(lineageInvites).values(invite).run();
    return {invite, token: rawToken};
  }

  listInvites(lineageId: string): LineageInviteRecord[] {
    return this.db.select().from(lineageInvites)
      .where(eq(lineageInvites.lineageId, lineageId))
      .orderBy(desc(lineageInvites.createdAt)).all();
  }

  revokeInvite(actorAccountId: string, sourceAgentId: string, inviteId: string): LineageInviteRecord {
    const lineage = this.requireByAgent(sourceAgentId);
    this.requireManager(actorAccountId, lineage.id, "admin");
    const invite = this.db.select().from(lineageInvites)
      .where(and(eq(lineageInvites.id, inviteId), eq(lineageInvites.lineageId, lineage.id))).get();
    if (!invite) throw new AgentError("invite_not_found", 404);
    this.db.update(lineageInvites).set({status: "revoked"}).where(eq(lineageInvites.id, inviteId)).run();
    return {...invite, status: "revoked"};
  }

  private resolveUsableInvite(rawToken: string, now = Date.now()): {invite: LineageInviteRecord; lineage: LineageRecord} {
    const invite = this.db.select().from(lineageInvites).where(eq(lineageInvites.tokenHash, hashToken(rawToken))).get();
    if (!invite || invite.status !== "active") throw new AgentError("invite_invalid", 404);
    if (invite.expiresAt !== null && invite.expiresAt <= now) throw new AgentError("invite_expired", 409);
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) throw new AgentError("invite_exhausted", 409);
    const lineage = this.getById(invite.lineageId);
    if (!lineage || lineage.status !== "active") throw new AgentError("lineage_not_active", 409);
    return {invite, lineage};
  }

  /** Safe public preview for an invite link. Never exposes any actual memory content. */
  previewInvite(rawToken: string) {
    const {invite, lineage} = this.resolveUsableInvite(rawToken);
    const sourceAgent = this.db.select({id: lunaAgents.id, name: lunaAgents.name}).from(lunaAgents).where(eq(lunaAgents.id, lineage.sourceAgentId)).get();
    const memoryCount = this.db.select({n: sql<number>`count(*)`}).from(lineageMemories)
      .where(and(eq(lineageMemories.lineageId, lineage.id), eq(lineageMemories.status, "active"))).get()?.n ?? 0;
    const memberCount = this.db.select({n: sql<number>`count(*)`}).from(lineageSubscriptions)
      .where(and(eq(lineageSubscriptions.lineageId, lineage.id), eq(lineageSubscriptions.status, "active"))).get()?.n ?? 0;
    return {
      inviteId: invite.id,
      label: invite.label,
      requireApproval: invite.requireApproval,
      expiresAt: invite.expiresAt,
      lineage: {
        id: lineage.id,
        name: lineage.name,
        description: lineage.description,
        intakeGuidelines: lineage.intakeGuidelines,
        sourceAgentName: sourceAgent?.name ?? "Unknown",
        memoryCount,
        memberCount,
        template: lineage.template,
      },
    };
  }

  /** Validates that subscribing `agentId` to `lineage` does not create a cycle or exceed max depth. */
  private assertNoCycle(tx: DrizzleDB, agentId: string, lineage: LineageRecord): void {
    if (lineage.sourceAgentId === agentId) throw new AgentError("lineage_cycle_detected", 409);
    let cursorAgentId: string | null = lineage.sourceAgentId;
    const visited = new Set<string>([agentId]);
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH && cursorAgentId; depth++) {
      if (visited.has(cursorAgentId)) throw new AgentError("lineage_cycle_detected", 409);
      visited.add(cursorAgentId);
      const sub = tx.select({lineageId: lineageSubscriptions.lineageId})
        .from(lineageSubscriptions)
        .where(and(eq(lineageSubscriptions.agentId, cursorAgentId), inArray(lineageSubscriptions.status, ["active", "pending_approval"])))
        .get();
      if (!sub) return;
      const parentLineage = tx.select({sourceAgentId: agentLineages.sourceAgentId})
        .from(agentLineages).where(eq(agentLineages.id, sub.lineageId)).get();
      cursorAgentId = parentLineage?.sourceAgentId ?? null;
    }
    if (cursorAgentId) throw new AgentError("lineage_depth_exceeded", 409);
  }

  acceptInvite(
    accountId: string,
    rawToken: string,
    input: {mode: "create_agent"; agentName: string; idempotencyKey?: string | undefined} | {mode: "attach_agent"; agentId: string},
  ): {agentId: string; subscription: LineageSubscriptionRecord; lineage: LineageRecord} {
    const now = Date.now();
    const {invite, lineage} = this.resolveUsableInvite(rawToken, now);
    const agentStore = new AgentStore(this.db);

    let targetAgentId: string;
    if (input.mode === "create_agent") {
      const created = agentStore.create(accountId, {name: input.agentName}, input.idempotencyKey || `lineage-invite-${invite.id}-${randomUUID()}`);
      targetAgentId = created.id;
      // Seed persona templates into the new Agent's default Shadow if provided.
      const personas = lineage.template.personaTemplates ?? [];
      if (personas.length > 0 && created.defaultShadowId) {
        const memoryStore = new AgentMemoryStore(this.db);
        const ownerUserId = agentStore.ownerUserId(created.id);
        for (const p of personas.slice(0, 5)) {
          if (!p.title?.trim() || !p.description?.trim() || !p.body?.trim()) continue;
          try {
            memoryStore.add(
              {agentId: created.id, kind: "owner", trusted: true, owner: true, userId: ownerUserId, shadowId: created.defaultShadowId},
              {type: "persona", title: p.title, description: p.description, body: p.body, visibility: "shadow"},
            );
          } catch {
            // Skip invalid template entries without aborting agent creation.
          }
        }
      }
    } else {
      agentStore.requireOwner(accountId, input.agentId);
      targetAgentId = input.agentId;
    }

    return this.db.transaction(tx => {
      const existing = tx.select().from(lineageSubscriptions)
        .where(and(eq(lineageSubscriptions.agentId, targetAgentId), inArray(lineageSubscriptions.status, ["active", "pending_approval"])))
        .get();
      if (existing) throw new AgentError("agent_already_subscribed", 409);
      this.assertNoCycle(tx as unknown as DrizzleDB, targetAgentId, lineage);

      // Re-check invite quota inside transaction.
      const currentInvite = tx.select().from(lineageInvites).where(eq(lineageInvites.id, invite.id)).get();
      if (!currentInvite || currentInvite.status !== "active") throw new AgentError("invite_invalid", 404);
      if (currentInvite.maxUses !== null && currentInvite.usedCount >= currentInvite.maxUses) throw new AgentError("invite_exhausted", 409);
      tx.update(lineageInvites).set({usedCount: currentInvite.usedCount + 1}).where(eq(lineageInvites.id, invite.id)).run();

      const status: LineageSubscriptionStatus = currentInvite.requireApproval ? "pending_approval" : "active";
      const sub: LineageSubscriptionRecord = {
        id: `lsub_${randomUUID()}`,
        agentId: targetAgentId,
        lineageId: lineage.id,
        status,
        inviteId: invite.id,
        approvedByAccountId: status === "active" ? invite.createdByAccountId : null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(lineageSubscriptions).values(sub).run();
      return {agentId: targetAgentId, subscription: sub, lineage};
    });
  }

  getActiveSubscription(agentId: string): {subscription: LineageSubscriptionRecord; lineage: LineageRecord; sourceAgentName: string} | null {
    const sub = this.db.select().from(lineageSubscriptions)
      .where(and(eq(lineageSubscriptions.agentId, agentId), inArray(lineageSubscriptions.status, ["active", "pending_approval"])))
      .get();
    if (!sub) return null;
    const lineage = this.getById(sub.lineageId);
    if (!lineage) return null;
    const sourceAgent = this.db.select({name: lunaAgents.name}).from(lunaAgents).where(eq(lunaAgents.id, lineage.sourceAgentId)).get();
    return {subscription: sub, lineage, sourceAgentName: sourceAgent?.name ?? "Unknown"};
  }

  listMembers(lineageId: string) {
    return this.db.select({
      subscriptionId: lineageSubscriptions.id,
      agentId: lineageSubscriptions.agentId,
      agentName: lunaAgents.name,
      ownerAccountId: lunaAgents.ownerAccountId,
      ownerDisplayName: accounts.displayName,
      status: lineageSubscriptions.status,
      createdAt: lineageSubscriptions.createdAt,
      updatedAt: lineageSubscriptions.updatedAt,
    }).from(lineageSubscriptions)
      .innerJoin(lunaAgents, eq(lunaAgents.id, lineageSubscriptions.agentId))
      .innerJoin(accounts, eq(accounts.id, lunaAgents.ownerAccountId))
      .where(and(eq(lineageSubscriptions.lineageId, lineageId), inArray(lineageSubscriptions.status, ["active", "pending_approval"])))
      .orderBy(desc(lineageSubscriptions.createdAt))
      .all();
  }

  approveMember(actorAccountId: string, sourceAgentId: string, subscriptionId: string): LineageSubscriptionRecord {
    const lineage = this.requireByAgent(sourceAgentId);
    this.requireManager(actorAccountId, lineage.id, "reviewer");
    const sub = this.db.select().from(lineageSubscriptions)
      .where(and(eq(lineageSubscriptions.id, subscriptionId), eq(lineageSubscriptions.lineageId, lineage.id))).get();
    if (!sub) throw new AgentError("subscription_not_found", 404);
    if (sub.status !== "pending_approval") throw new AgentError("subscription_not_pending", 409);
    const now = Date.now();
    this.db.update(lineageSubscriptions)
      .set({status: "active", approvedByAccountId: actorAccountId, updatedAt: now})
      .where(eq(lineageSubscriptions.id, sub.id)).run();
    return {...sub, status: "active", approvedByAccountId: actorAccountId, updatedAt: now};
  }

  removeMember(actorAccountId: string, sourceAgentId: string, subscriptionId: string): LineageSubscriptionRecord {
    const lineage = this.requireByAgent(sourceAgentId);
    this.requireManager(actorAccountId, lineage.id, "admin");
    const sub = this.db.select().from(lineageSubscriptions)
      .where(and(eq(lineageSubscriptions.id, subscriptionId), eq(lineageSubscriptions.lineageId, lineage.id))).get();
    if (!sub) throw new AgentError("subscription_not_found", 404);
    return this.terminateSubscription(sub, "revoked");
  }

  leaveSubscription(ownerAccountId: string, agentId: string): LineageSubscriptionRecord {
    new AgentStore(this.db).requireOwner(ownerAccountId, agentId);
    const sub = this.db.select().from(lineageSubscriptions)
      .where(and(eq(lineageSubscriptions.agentId, agentId), inArray(lineageSubscriptions.status, ["active", "pending_approval"])))
      .get();
    if (!sub) throw new AgentError("subscription_not_found", 404);
    return this.terminateSubscription(sub, "left");
  }

  private terminateSubscription(sub: LineageSubscriptionRecord, nextStatus: "left" | "revoked"): LineageSubscriptionRecord {
    const now = Date.now();
    return this.db.transaction(tx => {
      tx.update(lineageSubscriptions).set({status: nextStatus, updatedAt: now}).where(eq(lineageSubscriptions.id, sub.id)).run();
      // Cancel any open contributions from this agent to this lineage.
      tx.update(lineageContributions)
        .set({status: "cancelled", updatedAt: now})
        .where(and(
          eq(lineageContributions.sourceAgentId, sub.agentId),
          eq(lineageContributions.lineageId, sub.lineageId),
          inArray(lineageContributions.status, ["pending_owner", "pending_lineage"]),
        )).run();
      return {...sub, status: nextStatus, updatedAt: now};
    });
  }

  // ── Isolated Lineage Memories ───────────────────────────────────────────────

  publishMemory(
    actorAccountId: string,
    lineageId: string,
    input: {
      type: LineageMemoryType;
      title: string;
      description: string;
      body: string;
      originKind?: LineageMemoryOriginKind | undefined;
      contributorAgentId?: string | null | undefined;
      contributorAccountId?: string | null | undefined;
      contributionId?: string | null | undefined;
      reason?: string | null | undefined;
    },
  ): LineageMemoryRecord {
    const fields = validateMemoryFields(input);
    const now = Date.now();
    return this.db.transaction(tx => {
      const row: LineageMemoryRecord = {
        id: `lmem_${randomUUID()}`,
        lineageId,
        ...fields,
        status: "active",
        revision: 1,
        changeSeq: this.latestSeq(tx) + 1,
        originKind: input.originKind ?? "owner_publish",
        contributorAgentId: input.contributorAgentId ?? null,
        contributorAccountId: input.contributorAccountId ?? actorAccountId,
        approvedByAccountId: actorAccountId,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(lineageMemories).values(row).run();
      indexLineageTerms(tx, row);
      this.recordRevision(tx, row, row.originKind, actorAccountId, now, input.contributionId ?? null, input.reason ?? null);
      return row;
    });
  }

  updateMemory(
    actorAccountId: string,
    lineageId: string,
    memoryId: string,
    input: {
      expectedRevision: number;
      type?: LineageMemoryType | undefined;
      title?: string | undefined;
      description?: string | undefined;
      body?: string | undefined;
      reason?: string | null | undefined;
      changeKind?: LineageMemoryChangeKind | undefined;
      contributionId?: string | null | undefined;
      contributorAgentId?: string | null | undefined;
      contributorAccountId?: string | null | undefined;
    },
  ): LineageMemoryRecord {
    const now = Date.now();
    return this.db.transaction(tx => {
      const current = tx.select().from(lineageMemories)
        .where(and(eq(lineageMemories.id, memoryId), eq(lineageMemories.lineageId, lineageId))).get();
      if (!current) throw new AgentError("memory_not_found", 404);
      if (current.status !== "active") throw new AgentError("memory_not_active", 409);
      if (current.revision !== input.expectedRevision) throw new LineageConflictError("memory_revision_conflict", current.revision);
      const fields = validateMemoryFields({
        type: input.type ?? current.type,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        body: input.body ?? current.body,
      });
      const updated: LineageMemoryRecord = {
        ...current,
        ...fields,
        revision: current.revision + 1,
        changeSeq: this.latestSeq(tx) + 1,
        approvedByAccountId: actorAccountId,
        ...(input.contributorAgentId !== undefined ? {contributorAgentId: input.contributorAgentId} : {}),
        ...(input.contributorAccountId !== undefined ? {contributorAccountId: input.contributorAccountId} : {}),
        updatedAt: now,
      };
      tx.update(lineageMemories).set(updated).where(eq(lineageMemories.id, memoryId)).run();
      indexLineageTerms(tx, updated);
      this.recordRevision(tx, updated, input.changeKind ?? "lineage_edit", actorAccountId, now, input.contributionId ?? null, input.reason ?? null);
      return updated;
    });
  }

  changeMemoryStatus(
    actorAccountId: string,
    lineageId: string,
    memoryId: string,
    expectedRevision: number,
    nextStatus: LineageMemoryStatus,
    reason?: string | null,
  ): LineageMemoryRecord {
    const now = Date.now();
    return this.db.transaction(tx => {
      const current = tx.select().from(lineageMemories)
        .where(and(eq(lineageMemories.id, memoryId), eq(lineageMemories.lineageId, lineageId))).get();
      if (!current) throw new AgentError("memory_not_found", 404);
      if (current.revision !== expectedRevision) throw new LineageConflictError("memory_revision_conflict", current.revision);
      const updated: LineageMemoryRecord = {
        ...current,
        status: nextStatus,
        revision: current.revision + 1,
        changeSeq: this.latestSeq(tx) + 1,
        approvedByAccountId: actorAccountId,
        updatedAt: now,
      };
      tx.update(lineageMemories).set(updated).where(eq(lineageMemories.id, memoryId)).run();
      if (nextStatus === "active") indexLineageTerms(tx, updated);
      else deleteLineageTerms(tx, memoryId);
      const kind: LineageMemoryChangeKind = nextStatus === "deleted" ? "delete" : nextStatus === "archived" ? "archive" : "restore";
      this.recordRevision(tx, updated, kind, actorAccountId, now, null, reason ?? null);
      return updated;
    });
  }

  history(lineageId: string, memoryId: string): LineageMemoryRevisionRecord[] {
    const exists = this.db.select({id: lineageMemories.id}).from(lineageMemories)
      .where(and(eq(lineageMemories.id, memoryId), eq(lineageMemories.lineageId, lineageId))).get();
    if (!exists) throw new AgentError("memory_not_found", 404);
    return this.db.select().from(lineageMemoryRevisions)
      .where(eq(lineageMemoryRevisions.memoryId, memoryId))
      .orderBy(desc(lineageMemoryRevisions.revision)).all();
  }

  pageMemories(
    lineageId: string,
    options: {status?: LineageMemoryStatus | undefined; type?: LineageMemoryType | undefined; query?: string | undefined; limit?: number | undefined; offset?: number | undefined} = {},
  ): {entries: LineageMemoryRecord[]; total: number} {
    const pattern = options.query?.trim() ? `%${options.query.trim().replace(/[\\%_]/g, "\\$&")}%` : undefined;
    const where = and(
      eq(lineageMemories.lineageId, lineageId),
      eq(lineageMemories.status, options.status ?? "active"),
      options.type ? eq(lineageMemories.type, options.type) : undefined,
      pattern ? or(...[lineageMemories.title, lineageMemories.description, lineageMemories.body].map(col => sql`${like(col, pattern)} ESCAPE '\\'`)) : undefined,
    );
    const total = this.db.select({n: sql<number>`count(*)`}).from(lineageMemories).where(where).get()!.n;
    const entries = this.db.select().from(lineageMemories).where(where)
      .orderBy(desc(lineageMemories.updatedAt), lineageMemories.id)
      .limit(options.limit ?? 50).offset(options.offset ?? 0).all();
    return {entries, total};
  }

  private recordRevision(
    tx: Pick<DrizzleDB, "insert">,
    row: LineageMemoryRecord,
    changeKind: LineageMemoryChangeKind,
    accountId: string,
    now: number,
    contributionId: string | null,
    reason: string | null,
  ): void {
    tx.insert(lineageMemoryRevisions).values({
      memoryId: row.id,
      revision: row.revision,
      snapshot: {type: row.type, title: row.title, description: row.description, body: row.body, status: row.status},
      changeKind,
      changedByAccountId: accountId,
      contributionId,
      reason: reason?.trim() || null,
      createdAt: now,
    }).run();
  }

  // ── Local Overrides (Mute / Fork-Override) ──────────────────────────────────

  listOverrides(agentId: string): LineageMemoryOverrideRecord[] {
    return this.db.select().from(lineageMemoryOverrides).where(eq(lineageMemoryOverrides.agentId, agentId)).all();
  }

  setMute(ownerAccountId: string, agentId: string, lineageMemoryId: string): LineageMemoryOverrideRecord {
    new AgentStore(this.db).requireOwner(ownerAccountId, agentId);
    // Verify the memory belongs to the agent's active subscription.
    this.requireReadableMemory(agentId, lineageMemoryId, false);
    const now = Date.now();
    const row: LineageMemoryOverrideRecord = {agentId, lineageMemoryId, mode: "muted", localMemoryId: null, createdAt: now, updatedAt: now};
    this.db.insert(lineageMemoryOverrides).values(row)
      .onConflictDoUpdate({target: [lineageMemoryOverrides.agentId, lineageMemoryOverrides.lineageMemoryId], set: {mode: "muted", localMemoryId: null, updatedAt: now}})
      .run();
    return row;
  }

  overrideToLocal(
    ownerAccountId: string,
    agentId: string,
    lineageMemoryId: string,
    edits?: Partial<{title: string; description: string; body: string}>,
  ): {override: LineageMemoryOverrideRecord; localMemoryId: string} {
    const agentStore = new AgentStore(this.db);
    agentStore.requireOwner(ownerAccountId, agentId);
    const {memory} = this.requireReadableMemory(agentId, lineageMemoryId, false);
    const ownerUserId = agentStore.ownerUserId(agentId);
    const local = new AgentMemoryStore(this.db).add(
      {agentId, kind: "owner", trusted: true, owner: true, userId: ownerUserId, shadowId: null, reason: `内化覆写传承记忆 ${memory.id}`},
      {
        type: memory.type,
        title: edits?.title ?? memory.title,
        description: edits?.description ?? memory.description,
        body: edits?.body ?? memory.body,
        visibility: "agent",
      },
    );
    const now = Date.now();
    const row: LineageMemoryOverrideRecord = {agentId, lineageMemoryId, mode: "overridden", localMemoryId: local.id, createdAt: now, updatedAt: now};
    this.db.insert(lineageMemoryOverrides).values(row)
      .onConflictDoUpdate({target: [lineageMemoryOverrides.agentId, lineageMemoryOverrides.lineageMemoryId], set: {mode: "overridden", localMemoryId: local.id, updatedAt: now}})
      .run();
    return {override: row, localMemoryId: local.id};
  }

  clearOverride(ownerAccountId: string, agentId: string, lineageMemoryId: string): void {
    new AgentStore(this.db).requireOwner(ownerAccountId, agentId);
    this.db.delete(lineageMemoryOverrides)
      .where(and(eq(lineageMemoryOverrides.agentId, agentId), eq(lineageMemoryOverrides.lineageMemoryId, lineageMemoryId)))
      .run();
  }

  // ── Runtime Lineage Chain, Recall & Ancestor Lookup ("追寻祖脉") ─────────────

  /**
   * Resolves the Agent's own outbound lineage (depth 0) and its active subscription ancestry chain (depth 1..maxDepth).
   * Stops immediately on a broken/inactive link or when an ancestor disables `allowAncestorLookup`.
   */
  resolveLineageChain(agentId: string, maxDepth = MAX_ANCESTOR_LOOKUP_DEPTH): {ownLineage: LineageRecord | null; ancestors: LineageChainNode[]} {
    const cappedDepth = Math.max(1, Math.min(maxDepth, MAX_ANCESTOR_LOOKUP_DEPTH));
    const ownLineage = this.db.select().from(agentLineages)
      .where(and(eq(agentLineages.sourceAgentId, agentId), eq(agentLineages.status, "active"))).get() ?? null;
    const ancestors: LineageChainNode[] = [];
    const visitedAgents = new Set<string>([agentId]);
    let cursorAgentId: string = agentId;

    for (let depth = 1; depth <= cappedDepth; depth++) {
      const sub = this.db.select().from(lineageSubscriptions)
        .where(and(eq(lineageSubscriptions.agentId, cursorAgentId), eq(lineageSubscriptions.status, "active"))).get();
      if (!sub) break;
      const lineage = this.db.select().from(agentLineages)
        .where(and(eq(agentLineages.id, sub.lineageId), eq(agentLineages.status, "active"))).get();
      if (!lineage) break;
      if (visitedAgents.has(lineage.sourceAgentId)) break;
      visitedAgents.add(lineage.sourceAgentId);

      // Depth 1 (direct master) is always readable; depth >= 2 requires `allowAncestorLookup = true`.
      const lookupAllowed = depth === 1 ? true : lineage.allowAncestorLookup;
      if (!lookupAllowed) break;

      const sourceAgent = this.db.select({name: lunaAgents.name}).from(lunaAgents).where(eq(lunaAgents.id, lineage.sourceAgentId)).get();
      ancestors.push({
        lineage,
        sourceAgentName: sourceAgent?.name ?? "Unknown",
        depth,
        lookupAllowed,
      });
      cursorAgentId = lineage.sourceAgentId;
    }
    return {ownLineage, ancestors};
  }

  /**
   * Default per-turn recall: strictly single-hop (own active lineage + direct master lineage).
   * Excludes muted/overridden entries and entries already shown in the session.
   */
  recallDirect(
    agentId: string,
    message: string,
    options: {limit: number; exclude?: readonly string[]},
  ): LineageRecallEntry[] {
    if (options.limit <= 0) return [];
    const terms = [...new Set(memoryTerms(message))].slice(0, MATCH_TERM_LIMIT);
    if (terms.length < 2) return [];

    const {ownLineage, ancestors} = this.resolveLineageChain(agentId, 1);
    const targets: Array<{lineageId: string; lineageName: string; depth: number}> = [];
    if (ownLineage) targets.push({lineageId: ownLineage.id, lineageName: ownLineage.name, depth: 0});
    if (ancestors[0]) targets.push({lineageId: ancestors[0].lineage.id, lineageName: ancestors[0].lineage.name, depth: 1});
    if (!targets.length) return [];

    const overriddenIds = new Set(this.listOverrides(agentId).map(o => o.lineageMemoryId));
    const excluded = new Set([...(options.exclude ?? []), ...overriddenIds]);
    return this.ftsSearch(targets, terms, {limit: options.limit, exclude: excluded, minTerms: 2});
  }

  /**
   * Explicit search for Runner `luna memory search`.
   * Without `includeAncestors`, searches own + direct master (depth 0..1).
   * With `includeAncestors`, walks up the ancestry chain (depth 0..maxDepth).
   */
  searchForAgent(
    agentId: string,
    query: string,
    options: {type?: LineageMemoryType; includeAncestors?: boolean; maxDepth?: number; limit?: number} = {},
  ): LineageRecallEntry[] {
    const terms = [...new Set(memoryTerms(query))].slice(0, MATCH_TERM_LIMIT);
    if (!terms.length) return [];
    const depth = options.includeAncestors ? Math.min(options.maxDepth ?? MAX_ANCESTOR_LOOKUP_DEPTH, MAX_ANCESTOR_LOOKUP_DEPTH) : 1;
    const {ownLineage, ancestors} = this.resolveLineageChain(agentId, depth);
    const targets: Array<{lineageId: string; lineageName: string; depth: number}> = [];
    if (ownLineage) targets.push({lineageId: ownLineage.id, lineageName: ownLineage.name, depth: 0});
    for (const node of ancestors) {
      targets.push({lineageId: node.lineage.id, lineageName: node.lineage.name, depth: node.depth});
    }
    if (!targets.length) return [];
    const overriddenIds = new Set(this.listOverrides(agentId).map(o => o.lineageMemoryId));
    return this.ftsSearch(targets, terms, {
      limit: options.limit ?? 10,
      exclude: overriddenIds,
      ...(options.type ? {type: options.type} : {}),
      minTerms: 1,
    });
  }

  /** Verifies and returns one lineage memory readable by `agentId` (own, direct, or reachable ancestor). */
  requireReadableMemory(agentId: string, memoryId: string, allowAncestors = true): LineageRecallEntry {
    const row = this.db.select().from(lineageMemories).where(eq(lineageMemories.id, memoryId)).get();
    if (!row || row.status !== "active") throw new AgentError("memory_not_found", 404);
    const {ownLineage, ancestors} = this.resolveLineageChain(agentId, allowAncestors ? MAX_ANCESTOR_LOOKUP_DEPTH : 1);
    if (ownLineage && ownLineage.id === row.lineageId) {
      return {memory: row, lineageName: ownLineage.name, depth: 0};
    }
    const matched = ancestors.find(a => a.lineage.id === row.lineageId);
    if (!matched) throw new AgentError("memory_not_found", 404);
    return {memory: row, lineageName: matched.lineage.name, depth: matched.depth};
  }

  private ftsSearch(
    targets: ReadonlyArray<{lineageId: string; lineageName: string; depth: number}>,
    terms: readonly string[],
    options: {limit: number; exclude: ReadonlySet<string>; type?: LineageMemoryType; minTerms: number},
  ): LineageRecallEntry[] {
    const targetMap = new Map(targets.map(t => [t.lineageId, t]));
    const lineageIds = targets.map(t => t.lineageId);
    const matchExpr = terms.map(t => `"${t.replace(/"/g, "\"\"")}"`).join(" OR ");
    const candidateLimit = Math.max(options.limit * 4, 40);

    const matchedIds = this.db.all<{memory_id: string; score: number}>(sql`
      SELECT t.memory_id, bm25(lineage_memory_terms, 0.0, 4.0, 2.0, 1.0) AS score
      FROM lineage_memory_terms t
      INNER JOIN lineage_memories m ON m.id = t.memory_id
      WHERE lineage_memory_terms MATCH ${matchExpr}
        AND m.status = 'active'
        AND m.lineage_id IN (${sql.join(lineageIds.map(id => sql`${id}`), sql`, `)})
        ${options.type ? sql`AND m.type = ${options.type}` : sql``}
      ORDER BY score ASC, m.updated_at DESC
      LIMIT ${candidateLimit}
    `);

    if (!matchedIds.length) return [];
    const rows = this.db.select().from(lineageMemories)
      .where(inArray(lineageMemories.id, matchedIds.map(m => m.memory_id))).all();
    const rowById = new Map(rows.map(r => [r.id, r]));

    const results: LineageRecallEntry[] = [];
    for (const hit of matchedIds) {
      if (options.exclude.has(hit.memory_id)) continue;
      const row = rowById.get(hit.memory_id);
      if (!row) continue;
      if (options.minTerms >= 2) {
        const entryTerms = new Set(memoryTerms(`${row.title} ${row.description}`));
        let shared = 0;
        for (const t of terms) {
          if (entryTerms.has(t)) shared++;
          if (shared >= options.minTerms) break;
        }
        if (shared < options.minTerms) continue;
      }
      const meta = targetMap.get(row.lineageId);
      if (!meta) continue;
      results.push({memory: row, lineageName: meta.lineageName, depth: meta.depth});
      if (results.length >= options.limit) break;
    }
    // Prefer shallower depth (own -> direct master -> ancestors) while preserving BM25 order within same depth.
    return results.sort((a, b) => a.depth - b.depth);
  }

  // ── Two-Stage Contributions ("反哺") ────────────────────────────────────────

  createContribution(input: {
    sourceAgentId: string;
    sourceOwnerAccountId: string;
    sourceLocalMemoryId?: string | null;
    originKind: LineageContributionOriginKind;
    batchId?: string | null;
    kind: LineageContributionKind;
    targetLineageMemoryId?: string | null;
    proposedType: LineageMemoryType;
    proposedTitle: string;
    proposedDescription: string;
    proposedBody: string;
    rationale?: string;
    ownerRequestId?: string | null;
  }): LineageContributionRecord {
    if (!LINEAGE_CONTRIBUTION_KINDS.includes(input.kind)) throw new AgentError("invalid_contribution_kind", 400);
    if (!LINEAGE_CONTRIBUTION_ORIGIN_KINDS.includes(input.originKind)) throw new AgentError("invalid_contribution_origin", 400);
    const fields = validateMemoryFields({
      type: input.proposedType,
      title: input.proposedTitle,
      description: input.proposedDescription,
      body: input.proposedBody,
    });

    // Strictly single-hop: can only contribute to the Agent's active direct subscription.
    const activeSub = this.db.select().from(lineageSubscriptions)
      .where(and(eq(lineageSubscriptions.agentId, input.sourceAgentId), eq(lineageSubscriptions.status, "active"))).get();
    if (!activeSub) throw new AgentError("lineage_subscription_required", 409);

    let baseRevision: number | null = null;
    if (input.kind === "update") {
      if (!input.targetLineageMemoryId) throw new AgentError("target_lineage_memory_required", 400);
      const target = this.db.select().from(lineageMemories)
        .where(and(
          eq(lineageMemories.id, input.targetLineageMemoryId),
          eq(lineageMemories.lineageId, activeSub.lineageId),
          eq(lineageMemories.status, "active"),
        )).get();
      if (!target) throw new AgentError("memory_not_found", 404);
      baseRevision = target.revision;
    }

    const now = Date.now();
    // Manual submissions from the Dashboard are already confirmed by the Owner -> go straight to pending_lineage.
    const status: LineageContributionStatus = input.originKind === "manual_dashboard" ? "pending_lineage" : "pending_owner";
    const row: LineageContributionRecord = {
      id: `lcon_${randomUUID()}`,
      lineageId: activeSub.lineageId,
      sourceAgentId: input.sourceAgentId,
      sourceOwnerAccountId: input.sourceOwnerAccountId,
      sourceLocalMemoryId: input.sourceLocalMemoryId ?? null,
      originKind: input.originKind,
      batchId: input.batchId ?? null,
      kind: input.kind,
      targetLineageMemoryId: input.kind === "update" ? (input.targetLineageMemoryId ?? null) : null,
      baseRevision,
      proposedType: fields.type,
      proposedTitle: fields.title,
      proposedDescription: fields.description,
      proposedBody: fields.body,
      rationale: input.rationale?.trim() ?? "",
      status,
      ownerRequestId: input.ownerRequestId ?? null,
      lineageRequestId: null,
      reviewedByAccountId: null,
      reviewComment: null,
      resultLineageMemoryId: null,
      resultRevision: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(lineageContributions).values(row).run();
    return row;
  }

  listAgentContributions(agentId: string, status?: LineageContributionStatus): LineageContributionRecord[] {
    if (status && !LINEAGE_CONTRIBUTION_STATUSES.includes(status)) throw new AgentError("invalid_request", 400);
    return this.db.select().from(lineageContributions)
      .where(and(eq(lineageContributions.sourceAgentId, agentId), status ? eq(lineageContributions.status, status) : undefined))
      .orderBy(desc(lineageContributions.createdAt)).all();
  }

  listLineageContributions(lineageId: string, status?: LineageContributionStatus) {
    if (status && !LINEAGE_CONTRIBUTION_STATUSES.includes(status)) throw new AgentError("invalid_request", 400);
    const rows = this.db.select({
      contribution: lineageContributions,
      sourceAgentName: lunaAgents.name,
      sourceOwnerName: accounts.displayName,
    }).from(lineageContributions)
      .innerJoin(lunaAgents, eq(lunaAgents.id, lineageContributions.sourceAgentId))
      .innerJoin(accounts, eq(accounts.id, lineageContributions.sourceOwnerAccountId))
      .where(and(eq(lineageContributions.lineageId, lineageId), status ? eq(lineageContributions.status, status) : undefined))
      .orderBy(desc(lineageContributions.createdAt)).all();

    const targetIds = [...new Set(rows.map(r => r.contribution.targetLineageMemoryId).filter((id): id is string => id !== null))];
    const targets = new Map(targetIds.length
      ? this.db.select().from(lineageMemories).where(inArray(lineageMemories.id, targetIds)).all().map(m => [m.id, m])
      : []);

    return rows.map(r => ({
      ...r.contribution,
      sourceAgentName: r.sourceAgentName,
      sourceOwnerName: r.sourceOwnerName,
      targetMemory: r.contribution.targetLineageMemoryId ? targets.get(r.contribution.targetLineageMemoryId) ?? null : null,
    }));
  }

  /** Stage 1 approval: disciple Owner reviews/sanitizes and forwards to lineage, or rejects/cancels. */
  ownerDecideContribution(
    ownerAccountId: string,
    agentId: string,
    contributionId: string,
    decision: {
      action: "approve" | "reject" | "cancel";
      proposedType?: LineageMemoryType | undefined;
      proposedTitle?: string | undefined;
      proposedDescription?: string | undefined;
      proposedBody?: string | undefined;
      rationale?: string | undefined;
    },
  ): LineageContributionRecord {
    new AgentStore(this.db).requireOwner(ownerAccountId, agentId);
    const row = this.db.select().from(lineageContributions)
      .where(and(eq(lineageContributions.id, contributionId), eq(lineageContributions.sourceAgentId, agentId))).get();
    if (!row) throw new AgentError("contribution_not_found", 404);
    const now = Date.now();

    if (decision.action === "cancel") {
      if (row.status !== "pending_owner" && row.status !== "pending_lineage") throw new AgentError("contribution_not_pending", 409);
      this.db.update(lineageContributions).set({status: "cancelled", updatedAt: now}).where(eq(lineageContributions.id, row.id)).run();
      return {...row, status: "cancelled", updatedAt: now};
    }

    if (row.status !== "pending_owner") throw new AgentError("contribution_not_pending_owner", 409);
    if (decision.action === "reject") {
      this.db.update(lineageContributions).set({status: "rejected_by_owner", updatedAt: now}).where(eq(lineageContributions.id, row.id)).run();
      return {...row, status: "rejected_by_owner", updatedAt: now};
    }

    const fields = validateMemoryFields({
      type: decision.proposedType ?? row.proposedType,
      title: decision.proposedTitle ?? row.proposedTitle,
      description: decision.proposedDescription ?? row.proposedDescription,
      body: decision.proposedBody ?? row.proposedBody,
    });
    const updated: LineageContributionRecord = {
      ...row,
      proposedType: fields.type,
      proposedTitle: fields.title,
      proposedDescription: fields.description,
      proposedBody: fields.body,
      rationale: decision.rationale !== undefined ? decision.rationale.trim() : row.rationale,
      status: "pending_lineage",
      updatedAt: now,
    };
    this.db.update(lineageContributions).set(updated).where(eq(lineageContributions.id, row.id)).run();
    return updated;
  }

  /** Stage 2 approval: lineage owner or maintainer approves (merging into lineage_memories) or rejects. */
  lineageDecideContribution(
    reviewerAccountId: string,
    lineageId: string,
    contributionId: string,
    decision: {
      action: "approve" | "reject";
      type?: LineageMemoryType | undefined;
      title?: string | undefined;
      description?: string | undefined;
      body?: string | undefined;
      reviewComment?: string | undefined;
      forceOnConflict?: boolean | undefined;
    },
  ): {contribution: LineageContributionRecord; memory?: LineageMemoryRecord} {
    this.requireManager(reviewerAccountId, lineageId, "reviewer");
    const row = this.db.select().from(lineageContributions)
      .where(and(eq(lineageContributions.id, contributionId), eq(lineageContributions.lineageId, lineageId))).get();
    if (!row) throw new AgentError("contribution_not_found", 404);
    if (row.status !== "pending_lineage") throw new AgentError("contribution_not_pending_lineage", 409);
    const now = Date.now();

    if (decision.action === "reject") {
      const updated: LineageContributionRecord = {
        ...row,
        status: "rejected_by_lineage",
        reviewedByAccountId: reviewerAccountId,
        reviewComment: decision.reviewComment?.trim() || null,
        updatedAt: now,
      };
      this.db.update(lineageContributions).set(updated).where(eq(lineageContributions.id, row.id)).run();
      return {contribution: updated};
    }

    const fields = validateMemoryFields({
      type: decision.type ?? row.proposedType,
      title: decision.title ?? row.proposedTitle,
      description: decision.description ?? row.proposedDescription,
      body: decision.body ?? row.proposedBody,
    });

    let mergedMemory: LineageMemoryRecord;
    if (row.kind === "add") {
      mergedMemory = this.publishMemory(reviewerAccountId, lineageId, {
        ...fields,
        originKind: "contribution_approved",
        contributorAgentId: row.sourceAgentId,
        contributorAccountId: row.sourceOwnerAccountId,
        contributionId: row.id,
        reason: decision.reviewComment?.trim() || row.rationale || "审批通过反哺新增",
      });
    } else {
      if (!row.targetLineageMemoryId) throw new AgentError("target_lineage_memory_required", 400);
      const current = this.db.select().from(lineageMemories)
        .where(and(eq(lineageMemories.id, row.targetLineageMemoryId), eq(lineageMemories.lineageId, lineageId))).get();
      if (!current || current.status !== "active") throw new AgentError("memory_not_found", 404);
      if (!decision.forceOnConflict && row.baseRevision !== null && current.revision !== row.baseRevision) {
        throw new LineageConflictError("contribution_revision_conflict", current.revision);
      }
      mergedMemory = this.updateMemory(reviewerAccountId, lineageId, current.id, {
        expectedRevision: current.revision,
        ...fields,
        changeKind: "contribution_approved",
        contributionId: row.id,
        contributorAgentId: row.sourceAgentId,
        contributorAccountId: row.sourceOwnerAccountId,
        reason: decision.reviewComment?.trim() || row.rationale || "审批通过反哺更新",
      });
    }

    const approved: LineageContributionRecord = {
      ...row,
      status: "approved",
      reviewedByAccountId: reviewerAccountId,
      reviewComment: decision.reviewComment?.trim() || null,
      resultLineageMemoryId: mergedMemory.id,
      resultRevision: mergedMemory.revision,
      updatedAt: now,
    };
    this.db.update(lineageContributions).set(approved).where(eq(lineageContributions.id, row.id)).run();
    return {contribution: approved, memory: mergedMemory};
  }
}
