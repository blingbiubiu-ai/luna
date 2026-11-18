import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";

import type { ChannelIdentity, ChannelRef } from "@/channels";
import { trustedChannelIdentityProfile } from "@/channels/identity-profile-trust";
import type { DrizzleDB } from "@/data";
import { channelConfigs, channelUserBindings, identityObservations, userIdentityLinks, users, type UserKind } from "@/data/schema";
import { cleanDisplayName, usableDisplayName } from "./display-name";
import { followShadowBotName } from "./shadow-name";
import { createLogger, uuid } from "@/shared";

export type { UserKind } from "@/data/schema";
export type IdentityConfidence = "verified" | "inferred" | "manual";

export interface IdentityClaim {
  readonly namespace: string;
  readonly kind: string;
  readonly value: string;
  readonly scope: string;
  readonly confidence: IdentityConfidence;
}

export interface MaterializedUser {
  readonly id: string;
  readonly kind: UserKind;
  readonly displayName: string;
}

type UserRow = typeof users.$inferSelect;
const identityLogger = createLogger("identity-directory");

class IdentityConflictError extends Error {
  constructor(reason: string) {
    super(`identity_conflict: ${reason}`);
  }
}

export class IdentityDirectory {
  constructor(private readonly _db: DrizzleDB) {}

  /** Bind a verified adapter self-identity to its current Shadow reply user. */
  bindBotIdentityToUser(channelIdentityId: string, userId: string): void {
    this._db.transaction(tx => {
      const directory = new IdentityDirectory(tx as unknown as DrizzleDB);
      const binding = tx.select().from(channelUserBindings)
        .where(eq(channelUserBindings.channelIdentityId, channelIdentityId)).get();
      const previous = binding && tx.select().from(users).where(eq(users.id, binding.userId)).get();
      const target = tx.select().from(users).where(eq(users.id, userId)).get();
      if (target?.kind !== "shadow" || !previous || previous.agentId !== target.agentId || !["bot", "shadow"].includes(previous.kind)) {
        throw new Error("bot_identity_conflict");
      }
      if (previous.id === userId) return;

      const now = String(Date.now());
      for (const observation of tx.select().from(identityObservations)
        .where(eq(identityObservations.channelIdentityId, channelIdentityId)).all()) {
        const sharedClaim = tx.select().from(identityObservations).where(and(
          eq(identityObservations.claimId, observation.claimId),
          ne(identityObservations.channelIdentityId, channelIdentityId),
        )).get();
        if (sharedClaim) throw new Error("bot_identity_claim_conflict");
        tx.update(userIdentityLinks).set({ userId, updatedAt: now })
          .where(eq(userIdentityLinks.id, observation.claimId)).run();
      }
      tx.update(channelUserBindings).set({ userId })
        .where(eq(channelUserBindings.channelIdentityId, channelIdentityId)).run();

      if (previous.kind === "bot" && !previous.mergedIntoUserId &&
        !tx.select().from(channelUserBindings).where(eq(channelUserBindings.userId, previous.id)).get() &&
        !tx.select().from(userIdentityLinks).where(eq(userIdentityLinks.userId, previous.id)).get()) {
        tx.update(users).set({ status: "merged", mergedIntoUserId: userId, updatedAt: now })
          .where(eq(users.id, previous.id)).run();
      }
      directory.ensureSinglePrimaryLink(previous.id);
      directory.ensureSinglePrimaryLink(userId);
    });
  }

  materializeChannelIdentity(input: {
    readonly channel: ChannelRef;
    readonly channelIdentityId: string;
    readonly identity: ChannelIdentity;
    readonly authenticatedUserId?: string | undefined;
    readonly agentId?: string;
  }): MaterializedUser | null {
    const userKind = inferUserKindForChannelIdentity(input.identity);
    if (userKind === null) {
      return null;
    }
    const trustedProfile = trustedChannelIdentityProfile(input.identity);
    const agentId = input.agentId ?? this.agentIdForChannel(input.channel, input.authenticatedUserId);

    const claims = identityClaimsForChannelIdentity(
      input.channel,
      input.identity,
    );
    let user: MaterializedUser;
    try {
      user = this.materializeIdentityClaims({
        agentId,
        kind: userKind,
        displayName: trustedProfile.displayName ?? input.identity.externalId,
        ...(trustedProfile.avatarUrl === undefined
          ? {}
          : { avatarUrl: trustedProfile.avatarUrl }),
        channelIdentityId: input.channelIdentityId,
        authenticatedUserId: input.authenticatedUserId,
        claims,
      });
    } catch (error) {
      if (error instanceof IdentityConflictError) {
        identityLogger.warn({
          code: "identity_conflict",
          channel_id: input.channel.id,
          channel_type: input.channel.type,
          external_id_hash: createHash("sha256").update(input.identity.externalId).digest("hex"),
          reason: error.message,
          claim_kinds: [...new Set(claims.map(claim => claim.kind))],
        }, "Channel identity association rejected");
      }
      throw error;
    }
    this.applyMentionDisplayName(input.channelIdentityId, input.identity.displayName);
    const refreshed = this._db.select().from(users).where(eq(users.id, user.id)).get()!;
    return { ...user, displayName: refreshed.displayName };
  }

  /**
   * The Agent a channel belongs to: a configured channel belongs to one Agent;
   * the Dashboard channel is shared, so its identity names the user it is.
   */
  agentIdForChannel(channel: ChannelRef, authenticatedUserId?: string): string {
    if (authenticatedUserId !== undefined) {
      const user = this._db.select({ agentId: users.agentId }).from(users).where(eq(users.id, authenticatedUserId)).get();
      if (!user) throw new IdentityConflictError("authenticated user is unknown");
      return user.agentId;
    }
    const config = this._db.select({ agentId: channelConfigs.agentId }).from(channelConfigs).where(eq(channelConfigs.id, channel.id)).get();
    if (!config) throw new Error(`channel_agent_unknown: ${channel.type}:${channel.id}`);
    return config.agentId;
  }

  /**
   * The name an `@` shows. A bot's label is its current name and its Shadow
   * follows it. For a person it fills in a missing name only, since their own
   * profile, which comes with their messages, is authoritative. A name set in
   * Luna (Dashboard, manual) is kept.
   */
  applyMentionDisplayName(channelIdentityId: string, label: string | undefined): void {
    const user = this.resolveUserByChannelIdentityId(channelIdentityId);
    if (user?.kind === "shadow") return followShadowBotName(this._db, user.id, label?.trim().replace(/^@\s*/, ""));
    if (!user || (user.profileSource !== "channel" && user.profileSource !== "mention")) return;
    const links = this._db.select().from(userIdentityLinks).where(eq(userIdentityLinks.userId, user.id)).all();
    const ids = new Set([user.id, ...links.map(link => link.identityValue)]);
    const name = usableDisplayName(cleanDisplayName(label), ids);
    // A person's own profile name outranks an @ label, which may be a group nickname; the label only fills a missing name.
    if (!name || (user.profileSource === "channel" && usableDisplayName(user.displayName, ids))) return;
    if (name === user.displayName && user.profileSource === "mention") return;
    this._db.update(users).set({ displayName: name, profileSource: "mention", updatedAt: String(Date.now()) }).where(eq(users.id, user.id)).run();
  }

  /** Resolves or creates the user of `agentId` that this evidence names; evidence never crosses Agents. */
  materializeIdentityClaims(input: {
    readonly agentId: string;
    readonly kind: UserKind;
    readonly displayName: string;
    readonly avatarUrl?: string;
    readonly channelIdentityId?: string;
    readonly claims: readonly IdentityClaim[];
    readonly authenticatedUserId?: string | undefined;
  }): MaterializedUser {
    for (const claim of input.claims) validateIdentityClaim(claim);
    return this._db.transaction(tx => {
      const directory = new IdentityDirectory(tx as unknown as DrizzleDB);
      let existingUser = directory.resolveUserForMaterialization(input);
      if (input.authenticatedUserId !== undefined) {
        const authenticated = tx.select().from(users).where(eq(users.id, input.authenticatedUserId)).get();
        if (authenticated?.status !== "active" || authenticated.agentId !== input.agentId || (existingUser && existingUser.id !== authenticated.id)) {
          throw new IdentityConflictError("authenticated user differs from channel identity");
        }
        existingUser = authenticated;
      }
      if (existingUser && existingUser.kind !== input.kind && !(existingUser.kind === "shadow" && input.kind === "bot")) {
        throw new IdentityConflictError("identity kind differs from canonical user");
      }
      // Someone removed from the Agent's list is back once they write again; a blocked user stays blocked.
      if (existingUser?.status === "removed") {
        tx.update(users).set({ status: "active", updatedAt: String(Date.now()) }).where(eq(users.id, existingUser.id)).run();
        existingUser = { ...existingUser, status: "active" };
      }
      const user = directory.refreshChannelProfile(
        existingUser ??
          directory.createUser({
            agentId: input.agentId,
            kind: input.kind,
            displayName: input.displayName,
            ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
          }),
        {
          kind: input.kind,
          displayName: input.displayName,
          ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
        },
      );
      directory.ensureLinks({
        agentId: input.agentId,
        userId: user.id,
        ...(input.channelIdentityId === undefined
          ? {}
          : { channelIdentityId: input.channelIdentityId }),
        claims: input.claims,
      });

      return {
        id: user.id,
        kind: user.kind,
        displayName: user.displayName,
      };
    });
  }

  /** The user of `agentId` that verified evidence names, whatever their status; undefined when unknown. */
  resolveUserIdForIdentity(agentId: string, claim: {
    readonly namespace: string;
    readonly kind: string;
    readonly value: string;
    readonly scope: string;
  }): string | undefined {
    const link = this.findLinkByClaim(agentId, {
      ...claim,
      confidence: "verified",
    });
    return link === undefined ? undefined : this.current(link.userId)?.id;
  }

  /** A user as it stands now: a merged user is followed to the user it became. */
  private current(userId: string): UserRow | undefined {
    let user = this._db.select().from(users).where(eq(users.id, userId)).get();
    for (let hops = 0; user?.status === "merged" && user.mergedIntoUserId && hops < 8; hops++) {
      user = this._db.select().from(users).where(eq(users.id, user.mergedIntoUserId)).get();
    }
    return user?.status === "merged" ? undefined : user;
  }

  private resolveUserForMaterialization(input: {
    readonly agentId: string;
    readonly channelIdentityId?: string;
    readonly claims: readonly IdentityClaim[];
  }): UserRow | null {
    const channelUser =
      input.channelIdentityId === undefined
        ? null
        : this.resolveUserByChannelIdentityId(input.channelIdentityId);
    if (channelUser !== null && channelUser.agentId !== input.agentId) {
      throw new IdentityConflictError("channel identity belongs to another Agent");
    }
    const claimUser = this.resolveUserByClaims(input.agentId, input.claims);
    if (
      channelUser !== null &&
      claimUser !== null &&
      channelUser.id !== claimUser.id
    ) {
      throw new IdentityConflictError("channel identity and claims resolve to different users");
    }
    return channelUser ?? claimUser;
  }

  private resolveUserByChannelIdentityId(
    channelIdentityId: string,
  ): UserRow | null {
    const usersById = new Map<string, UserRow>();
    const links = this._db
      .select()
      .from(channelUserBindings)
      .where(eq(channelUserBindings.channelIdentityId, channelIdentityId))
      .all();
    for (const link of links) {
      const user = this.current(link.userId);
      if (user !== undefined) {
        usersById.set(user.id, user);
      }
    }
    if (usersById.size > 1) {
      throw new Error(
        "Conflicting channel identity links resolve to multiple users",
      );
    }
    return usersById.values().next().value ?? null;
  }

  private resolveUserByClaims(agentId: string, claims: readonly IdentityClaim[]): UserRow | null {
    const usersById = new Map<string, UserRow>();
    for (const claim of claims) {
      const link = this.findLinkByClaim(agentId, claim);
      if (link === undefined) {
        continue;
      }
      const user = this.current(link.userId);
      if (user !== undefined) {
        usersById.set(user.id, user);
      }
    }
    if (usersById.size > 1) {
      throw new Error("Conflicting identity claims resolve to multiple users");
    }
    return usersById.values().next().value ?? null;
  }

  private createUser(input: {
    readonly agentId: string;
    readonly kind: UserKind;
    readonly displayName: string;
    readonly avatarUrl?: string;
  }): UserRow {
    const now = String(Date.now());
    const id = uuid();
    this._db
      .insert(users)
      .values({
        id,
        agentId: input.agentId,
        kind: input.kind,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        status: "active",
        mergedIntoUserId: null,
        profileSource: "channel",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = this._db.select().from(users).where(eq(users.id, id)).get();
    if (row === undefined) {
      throw new Error(`User was not persisted: ${id}`);
    }
    return row;
  }

  private ensureLinks(input: {
    readonly agentId: string;
    readonly userId: string;
    readonly channelIdentityId?: string;
    readonly claims: readonly IdentityClaim[];
  }): void {
    const now = String(Date.now());
    if (input.channelIdentityId) {
      const existing = this._db.select().from(channelUserBindings)
        .where(eq(channelUserBindings.channelIdentityId, input.channelIdentityId)).get();
      if (existing && existing.userId !== input.userId) throw new IdentityConflictError("channel identity already bound");
      this._db.insert(channelUserBindings).values({channelIdentityId: input.channelIdentityId,
        userId: input.userId, createdAt: Date.now()}).onConflictDoNothing().run();
    }
    const existingPrimary = this._db
      .select()
      .from(userIdentityLinks)
      .where(
        and(
          eq(userIdentityLinks.userId, input.userId),
          eq(userIdentityLinks.isPrimary, true),
        ),
      )
      .get();

    input.claims.forEach((claim, index) => {
      const existingLink = this.findLinkByClaim(input.agentId, claim);
      if (existingLink !== undefined && existingLink.userId !== input.userId) {
        throw new Error("Identity claim already belongs to a different user");
      }
      if (existingLink !== undefined) {
        const updates: Partial<typeof userIdentityLinks.$inferInsert> = {};
        if (existingLink.confidence === "inferred" && claim.confidence !== "inferred") {
          updates.confidence = claim.confidence;
        }
        if (Object.keys(updates).length > 0) {
          this._db
            .update(userIdentityLinks)
            .set({ ...updates, updatedAt: now })
            .where(eq(userIdentityLinks.id, existingLink.id))
            .run();
        }
        return;
      }
      this._db
        .insert(userIdentityLinks)
        .values({
          id: makeStableRowId("user_identity_link", JSON.stringify([input.agentId, identityClaimKey(claim)])),
          agentId: input.agentId,
          userId: input.userId,
          identityNamespace: claim.namespace,
          identityKind: claim.kind,
          identityValue: claim.value,
          identityScope: claim.scope,
          confidence: claim.confidence,
          isPrimary: existingPrimary === undefined && index === 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    this.ensureSinglePrimaryLink(input.userId);
    for (const claim of input.claims) {
      this.observeClaim(this.findLinkByClaim(input.agentId, claim)!.id, input.channelIdentityId ?? null, claim.confidence);
    }
  }

  private observeClaim(claimId: string, channelIdentityId: string | null, confidence: IdentityConfidence): void {
    if (!channelIdentityId) return;
    const previous = this._db.select().from(identityObservations).where(and(
      eq(identityObservations.claimId, claimId), eq(identityObservations.channelIdentityId, channelIdentityId))).get();
    const effective = previous?.confidence === "verified" || previous?.confidence === "manual" ? previous.confidence : confidence;
    this._db.insert(identityObservations).values({claimId, channelIdentityId, confidence: effective, observedAt: Date.now()})
      .onConflictDoUpdate({target: [identityObservations.claimId, identityObservations.channelIdentityId],
        set: {confidence: effective, observedAt: Date.now()}}).run();
  }

  private findLinkByClaim(agentId: string, claim: IdentityClaim):
    | typeof userIdentityLinks.$inferSelect
    | undefined {
    return this._db
      .select()
      .from(userIdentityLinks)
      .where(
        and(
          eq(userIdentityLinks.agentId, agentId),
          eq(userIdentityLinks.identityNamespace, claim.namespace),
          eq(userIdentityLinks.identityKind, claim.kind),
          eq(userIdentityLinks.identityValue, claim.value),
          eq(userIdentityLinks.identityScope, claim.scope),
        ),
      )
      .get();
  }

  private refreshChannelProfile(
    user: UserRow,
    input: {
      readonly kind?: UserKind;
      readonly displayName?: string;
      readonly avatarUrl?: string;
    },
  ): UserRow {
    if (user.kind === "shadow") {
      // A Shadow's own bot, seen as a sender or through its profile, carries the bot's current name.
      followShadowBotName(this._db, user.id, input.displayName);
      return this._db.select().from(users).where(eq(users.id, user.id)).get() ?? user;
    }
    if (user.kind === "system" || (user.profileSource !== "channel" && user.profileSource !== "mention")) {
      return user;
    }
    const updates: Partial<typeof users.$inferInsert> = {};
    if (input.kind !== undefined && input.kind !== user.kind) {
      updates.kind = input.kind;
    }
    const displayName = cleanDisplayName(input.displayName);
    if (
      displayName !== undefined &&
      usableDisplayName(displayName, new Set(this._db.select().from(userIdentityLinks).where(eq(userIdentityLinks.userId, user.id)).all().map(link => link.identityValue))) &&
      (displayName !== user.displayName || user.profileSource === "mention")
    ) {
      updates.displayName = displayName;
      updates.profileSource = "channel";
    }
    if (input.avatarUrl !== undefined && input.avatarUrl !== user.avatarUrl) {
      updates.avatarUrl = input.avatarUrl;
    }
    if (Object.keys(updates).length === 0) {
      return user;
    }
    this._db
      .update(users)
      .set({ ...updates, updatedAt: String(Date.now()) })
      .where(eq(users.id, user.id))
      .run();
    const refreshed = this._db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .get();
    if (refreshed === undefined) {
      throw new Error(`User not found after profile refresh: ${user.id}`);
    }
    return refreshed;
  }

  private ensureSinglePrimaryLink(userId: string): void {
    const links = this._db
      .select()
      .from(userIdentityLinks)
      .where(eq(userIdentityLinks.userId, userId))
      .all()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const fallbackPrimaryLink = links[0];
    if (fallbackPrimaryLink === undefined) {
      return;
    }
    const primaryLinks = links.filter((link) => link.isPrimary);
    const primaryLink =
      primaryLinks.length === 1 ? primaryLinks[0]! : fallbackPrimaryLink;
    if (
      primaryLinks.length === 1 &&
      links.every((link) => link.isPrimary === (link.id === primaryLink.id))
    ) {
      return;
    }
    const now = String(Date.now());
    for (const link of links) {
      const shouldBePrimary = link.id === primaryLink.id;
      if (link.isPrimary === shouldBePrimary) {
        continue;
      }
      this._db
        .update(userIdentityLinks)
        .set({ isPrimary: shouldBePrimary, updatedAt: now })
        .where(eq(userIdentityLinks.id, link.id))
        .run();
    }
  }

}

export function identityClaimsForChannelIdentity(
  channel: ChannelRef,
  identity: ChannelIdentity,
): IdentityClaim[] {
  if (identity.identityClaims !== undefined && identity.identityClaims.length > 0) {
    return compactClaims(
      identity.identityClaims.map((claim) => ({
        namespace: claim.namespace,
        kind: claim.kind,
        value: claim.value,
        scope: claim.scope ?? "",
        confidence: claim.confidence ?? "verified",
      })),
    );
  }
  return compactClaims([
    {
      namespace: channel.type,
      kind: "external_id",
      value: identity.externalId,
      scope: `channel:${channel.id}`,
      confidence: "inferred",
    },
  ]);
}

export function inferUserKindForChannelIdentity(
  identity: Pick<ChannelIdentity, "kind" | "rawProfile">,
): UserKind | null {
  if (identity.kind === "bot" || mentionedTypeFromRawProfile(identity.rawProfile) === "bot") {
    return "bot";
  }
  if (identity.kind === "system" || mentionedTypeFromRawProfile(identity.rawProfile) === "system") {
    return "system";
  }
  if (identity.kind === "user") {
    return "human";
  }
  return null;
}

function mentionedTypeFromRawProfile(rawProfile: unknown): string | undefined {
  if (
    typeof rawProfile !== "object" ||
    rawProfile === null ||
    Array.isArray(rawProfile) ||
    typeof (rawProfile as { mentioned_type?: unknown }).mentioned_type !== "string"
  ) {
    return undefined;
  }
  return (rawProfile as { mentioned_type: string }).mentioned_type;
}

function compactClaims(
  claims: readonly (IdentityClaim | null)[],
): IdentityClaim[] {
  return claims.filter(
    (claim): claim is IdentityClaim =>
      claim !== null && claim.value.trim().length > 0,
  );
}

function identityClaimKey(claim: IdentityClaim): string {
  return JSON.stringify([claim.namespace, claim.kind, claim.value, claim.scope]);
}

function makeStableRowId(prefix: string, stableKey: string): string {
  return `${prefix}_${createHash("sha256").update(stableKey).digest("hex")}`;
}


/** Reject provider evidence that lacks the namespace required for canonical matching. */
function validateIdentityClaim(claim: IdentityClaim): void {
  if (!claim.namespace.trim() || !claim.kind.trim() || !claim.value.trim()) throw new Error("identity_claim_invalid");
  if (claim.namespace !== "feishu" && claim.namespace !== "lark") return;
  const prefix = ({open_id: "app:", user_id: "tenant:", union_id: "developer:", external_id: "channel:"} as Record<string, string>)[claim.kind];
  if (!prefix || !claim.scope.startsWith(prefix) || claim.scope.length === prefix.length) {
    throw new Error("identity_scope_required");
  }
}
