import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  accounts,
  agentShadows, channelAuthTokens, channelConfigs, channelIdentities, channelUserBindings, identityObservations,
  shadowBotBindings, userIdentityLinks, users,
} from "@/data/schema";
import { AgentError, AgentStore } from "@/agents/agent-store";
import { hashAccessToken } from "@/server/auth/access-token-service";
import { uuid } from "@/shared";
import { cleanDisplayName } from "./display-name";
import { LOCAL_ACCOUNT_NAME } from "@/server/auth";

/** One-time link tokens are valid this long. */
export const ACCOUNT_LINK_TTL_MS = 10 * 60 * 1000;

/** Who a link token would link, shown to the owner before it takes effect. */
export interface AccountLinkPreview {
  readonly userId: string;
  readonly channelIdentityId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly shadowName: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

/** A channel identity the owner's user holds in this Agent. */
export interface LinkedChannelIdentity {
  readonly channelIdentityId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

type Db = DrizzleDB;

/**
 * Links a channel identity to the Agent owner. The person proves they hold the
 * chat identity by asking a Shadow bot for a token (`#link`) and proves they
 * hold the account by redeeming it signed in as the owner; the owner sees whose
 * identity it is before confirming. The sender's user is merged into the
 * owner's user of the same Agent. Nothing crosses Agents.
 */
export class AccountLinkService {
  constructor(private readonly db: Db) {}

  /** Called by `#link` with the sender already resolved to a user of the bot's Agent. */
  issue(input: { userId: string; channelType: string; channelId: string; channelIdentityId: string; now?: number }): string {
    const now = input.now ?? Date.now();
    const user = this.db.select().from(users).where(eq(users.id, input.userId)).get();
    if (user?.kind !== "human" || user.status === "merged") throw new AgentError("account_link_sender_invalid", 409);
    const token = randomToken();
    this.db.insert(channelAuthTokens).values({
      id: uuid(), tokenHash: hashAccessToken(token), userId: user.id, channelType: input.channelType, channelId: input.channelId,
      channelIdentityId: input.channelIdentityId, purpose: "account_link", issuedAt: now, expiresAt: now + ACCOUNT_LINK_TTL_MS,
      consumedAt: null, createdAt: now, metadataJson: null,
    }).run();
    return token;
  }

  preview(accountId: string, agentId: string, token: string, now = Date.now()): AccountLinkPreview {
    return this.check(this.db, accountId, agentId, token, now).preview;
  }

  /** Consumes the token and merges the sender into the owner's user. */
  link(accountId: string, agentId: string, token: string, now = Date.now()): AccountLinkPreview {
    return this.db.transaction(tx => {
      const db = tx as unknown as Db;
      const { proofId, preview, ownerUserId } = this.check(db, accountId, agentId, token, now);
      const consumed = db.update(channelAuthTokens).set({ consumedAt: now })
        .where(and(eq(channelAuthTokens.id, proofId), isNull(channelAuthTokens.consumedAt))).returning({ id: channelAuthTokens.id }).get();
      if (!consumed) throw new AgentError("account_link_token_invalid", 409);
      if (preview.userId !== ownerUserId) mergeUser(db, agentId, preview.userId, ownerUserId, now);
      adoptChatProfile(db, accountId, ownerUserId, preview, now);
      return preview;
    });
  }

  list(accountId: string, agentId: string): LinkedChannelIdentity[] {
    const agents = new AgentStore(this.db);
    agents.requireOwner(accountId, agentId);
    return this.db.select({ identity: channelIdentities, channelName: channelConfigs.name }).from(channelUserBindings)
      .innerJoin(channelIdentities, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
      .innerJoin(channelConfigs, eq(channelConfigs.id, channelIdentities.channelId))
      .where(and(eq(channelUserBindings.userId, agents.ownerUserId(agentId)), eq(channelConfigs.agentId, agentId))).all()
      .map(({ identity, channelName }) => ({ channelIdentityId: identity.id, channelId: identity.channelId, channelName,
        displayName: identity.displayName, avatarUrl: identity.avatarUrl }));
  }

  /**
   * Moves a channel identity, and the evidence only it observed, from the owner
   * to a new user of the Agent. What happened while linked stays with the owner.
   */
  unlink(accountId: string, agentId: string, channelIdentityId: string, now = Date.now()): void {
    this.db.transaction(tx => {
      const db = tx as unknown as Db;
      const agents = new AgentStore(db);
      agents.requireOwner(accountId, agentId);
      const ownerUserId = agents.ownerUserId(agentId);
      const identity = db.select({ identity: channelIdentities }).from(channelUserBindings)
        .innerJoin(channelIdentities, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
        .innerJoin(channelConfigs, eq(channelConfigs.id, channelIdentities.channelId))
        .where(and(eq(channelUserBindings.channelIdentityId, channelIdentityId), eq(channelUserBindings.userId, ownerUserId),
          eq(channelConfigs.agentId, agentId))).get()?.identity;
      if (!identity) throw new AgentError("account_link_not_found", 404);
      const claimIds = db.select({ id: identityObservations.claimId }).from(identityObservations)
        .where(eq(identityObservations.channelIdentityId, identity.id)).all().map(row => row.id);
      // Evidence also seen through another of the owner's identities would tie the two together again.
      const shared = claimIds.length ? db.select({ id: identityObservations.channelIdentityId }).from(identityObservations)
        .innerJoin(channelUserBindings, eq(channelUserBindings.channelIdentityId, identityObservations.channelIdentityId))
        .where(and(inArray(identityObservations.claimId, claimIds), ne(identityObservations.channelIdentityId, identity.id),
          eq(channelUserBindings.userId, ownerUserId))).get() : undefined;
      if (shared) throw new AgentError("account_link_shared_evidence", 409);
      const userId = uuid(), timestamp = String(now);
      db.insert(users).values({ id: userId, agentId, kind: "human", displayName: identity.displayName ?? identity.externalId,
        avatarUrl: identity.avatarUrl, status: "active", profileSource: "channel", createdAt: timestamp, updatedAt: timestamp }).run();
      db.update(channelUserBindings).set({ userId }).where(eq(channelUserBindings.channelIdentityId, identity.id)).run();
      if (claimIds.length) db.update(userIdentityLinks).set({ userId, isPrimary: false, updatedAt: timestamp })
        .where(and(inArray(userIdentityLinks.id, claimIds), eq(userIdentityLinks.userId, ownerUserId))).run();
    });
  }

  private check(db: Db, accountId: string, agentId: string, token: string, now: number) {
    const agents = new AgentStore(db);
    agents.requireOwner(accountId, agentId);
    const ownerUserId = agents.ownerUserId(agentId);
    const proof = db.select().from(channelAuthTokens).where(eq(channelAuthTokens.tokenHash, hashAccessToken(token.trim()))).get();
    if (!proof || proof.purpose !== "account_link" || proof.consumedAt !== null || !proof.channelIdentityId) throw new AgentError("account_link_token_invalid", 409);
    if (now >= proof.expiresAt) throw new AgentError("account_link_token_expired", 409);
    const channel = db.select().from(channelConfigs).where(eq(channelConfigs.id, proof.channelId)).get();
    if (!channel || channel.agentId !== agentId || proof.channelType === "dashboard") throw new AgentError("account_link_channel_mismatch", 409);
    const sender = db.select().from(users).where(eq(users.id, proof.userId)).get();
    if (!sender || sender.agentId !== agentId || sender.kind !== "human" || sender.status === "merged"
      || (sender.accountId !== null && sender.id !== ownerUserId)) throw new AgentError("account_link_sender_invalid", 409);
    const identity = db.select().from(channelIdentities).where(eq(channelIdentities.id, proof.channelIdentityId)).get();
    if (!identity) throw new AgentError("account_link_token_invalid", 409);
    const shadowName = db.select({ name: agentShadows.name }).from(shadowBotBindings)
      .innerJoin(agentShadows, eq(agentShadows.id, shadowBotBindings.shadowId))
      .where(and(eq(shadowBotBindings.channelConfigId, channel.id), eq(shadowBotBindings.status, "active"))).get()?.name ?? null;
    return {
      proofId: proof.id, ownerUserId,
      preview: { userId: sender.id, channelIdentityId: identity.id, channelId: channel.id, channelName: channel.name, shadowName,
        displayName: identity.displayName ?? sender.displayName, avatarUrl: identity.avatarUrl ?? sender.avatarUrl },
    };
  }
}

/**
 * The owner is known in the Agent by the linked chat identity's name and
 * avatar, unless the owner renamed themselves there; it also replaces the
 * account's placeholder name. A name someone chose is never overwritten.
 */
function adoptChatProfile(db: Db, accountId: string, ownerUserId: string, preview: AccountLinkPreview, now: number): void {
  const name = cleanDisplayName(preview.displayName);
  if (!name) return;
  const owner = db.select().from(users).where(eq(users.id, ownerUserId)).get();
  if (owner && owner.profileSource !== "manual") {
    db.update(users).set({ displayName: name, avatarUrl: preview.avatarUrl ?? owner.avatarUrl, profileSource: "channel", updatedAt: String(now) })
      .where(eq(users.id, ownerUserId)).run();
  }
  db.update(accounts).set({ displayName: name, ...(preview.avatarUrl ? { avatarUrl: preview.avatarUrl } : {}), updatedAt: now })
    .where(and(eq(accounts.id, accountId), eq(accounts.displayName, LOCAL_ACCOUNT_NAME))).run();
}

/**
 * Moves everything a user of the Agent is into `targetId`: chat identities,
 * evidence, and the references that decide what they may do and see. Records
 * of finished work (invocations, commands, audits) keep the old id, which now
 * names the merged user.
 */
function mergeUser(db: Db, agentId: string, sourceId: string, targetId: string, now: number): void {
  const timestamp = String(now);
  db.update(channelUserBindings).set({ userId: targetId }).where(eq(channelUserBindings.userId, sourceId)).run();
  db.update(userIdentityLinks).set({ userId: targetId, isPrimary: false, updatedAt: timestamp })
    .where(and(eq(userIdentityLinks.userId, sourceId), eq(userIdentityLinks.agentId, agentId))).run();
  db.run(sql`UPDATE messages SET sender_user_id = ${targetId} WHERE sender_user_id = ${sourceId} AND agent_id = ${agentId} AND deleted_at IS NULL`);
  db.run(sql`UPDATE sessions SET created_by_user_id = ${targetId} WHERE created_by_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE tasks SET creator_user_id = ${targetId} WHERE creator_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE OR IGNORE task_participants SET user_id = ${targetId} WHERE user_id = ${sourceId}`);
  db.run(sql`DELETE FROM task_participants WHERE user_id = ${sourceId}`);
  db.run(sql`UPDATE session_schedules SET actor_user_id = ${targetId} WHERE actor_user_id = ${sourceId}`);
  db.run(sql`UPDATE agent_memories SET subject_user_id = ${targetId} WHERE subject_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE agent_memories SET origin_user_id = ${targetId} WHERE origin_user_id = ${sourceId} AND agent_id = ${agentId}`);
  db.run(sql`UPDATE agent_memories SET participants_json = (
      SELECT json_group_array(DISTINCT CASE WHEN value = ${sourceId} THEN ${targetId} ELSE value END) FROM json_each(agent_memories.participants_json))
    WHERE agent_id = ${agentId} AND EXISTS (SELECT 1 FROM json_each(agent_memories.participants_json) WHERE value = ${sourceId})`);
  db.run(sql`UPDATE OR IGNORE group_memberships SET user_id = ${targetId} WHERE user_id = ${sourceId}`);
  db.run(sql`DELETE FROM group_memberships WHERE user_id = ${sourceId}`);
  db.run(sql`UPDATE OR IGNORE authorization_rules SET subject_id = ${targetId}
    WHERE scope_type = 'agent' AND agent_id = ${agentId} AND subject_type = 'user' AND subject_id = ${sourceId}`);
  db.run(sql`DELETE FROM authorization_rules WHERE scope_type = 'agent' AND agent_id = ${agentId} AND subject_type = 'user' AND subject_id = ${sourceId}`);
  db.update(users).set({ status: "merged", mergedIntoUserId: targetId, updatedAt: timestamp }).where(eq(users.id, sourceId)).run();
}

function randomToken(): string {
  return crypto.getRandomValues(new Uint8Array(24)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");
}
