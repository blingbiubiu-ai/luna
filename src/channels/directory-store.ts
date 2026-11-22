import { and, eq, sql } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { channelIdentities, channelSurfaces, channelUserBindings } from "@/data/schema";
import { IdentityDirectory } from "@/identity/identity-directory";
import { uuid } from "@/shared";

import { trustedChannelIdentityProfile } from "./identity-profile-trust";
import type {
  ChannelIdentity,
  ChannelIdentityKind,
  ChannelMention,
  ChannelRef,
  ChannelSurface,
  ChannelSurfaceKind,
} from "./types";

type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
type ChannelSurfaceRow = typeof channelSurfaces.$inferSelect;
type PersistedChannelIdentity = ChannelIdentity & { id: string };
type PersistedChannelSurface = ChannelSurface & { id: string };

/**
 * Persists provider-neutral channel identity and surface snapshots.
 */
export class ChannelDirectoryStore {
  constructor(private readonly _db: DrizzleDB) {}

  /**
   * `agentId` names the Agent the identity is seen in; a configured channel
   * implies it, the shared Dashboard channel needs it.
   */
  upsertIdentity(input: {
    channel: ChannelRef;
    identity: ChannelIdentity;
    agentId?: string;
  }): PersistedChannelIdentity {
    // Directory upserts make identity profile changes visible across messages.
    return this._db.transaction(tx => upsertChannelIdentity(tx as unknown as DrizzleDB, input.channel, input.identity, undefined, input.agentId));
  }

  /** Called with an authenticated Luna user, before processing their messages. */
  ensureAuthenticatedIdentity(channel: ChannelRef, identity: ChannelIdentity, userId: string): void {
    const existing = this._db.select({ userId: channelUserBindings.userId })
      .from(channelIdentities)
      .innerJoin(channelUserBindings, eq(channelIdentities.id, channelUserBindings.channelIdentityId))
      .where(and(eq(channelIdentities.channelType, channel.type),
        eq(channelIdentities.channelId, channel.id), eq(channelIdentities.externalId, identity.externalId)))
      .get();
    if (existing?.userId === userId) return;

    this._db.transaction(tx => upsertChannelIdentity(tx as unknown as DrizzleDB, channel, identity, userId));
  }

  upsertSurface(input: {
    channel: ChannelRef;
    surface: ChannelSurface;
  }): PersistedChannelSurface {
    // Surfaces are stored independently from Luna sessions.
    return upsertChannelSurface(this._db, input.channel, input.surface);
  }

  ensureMentionTarget(input: {
    channel: ChannelRef;
    mention: ChannelMention;
    agentId?: string;
  }): PersistedChannelIdentity {
    if (input.mention.target.kind === "bot") {
      const now = String(Date.now());
      return channelIdentityFromRow(
        upsertChannelIdentitySync(
          this._db,
          input.channel,
          input.mention.target,
          now,
        ),
      );
    }
    return this.upsertIdentity({
      channel: input.channel,
      identity: input.mention.target,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    });
  }
}

function upsertChannelIdentity(
  db: DrizzleDB,
  channel: ChannelRef,
  identity: ChannelIdentity,
  authenticatedUserId?: string,
  agentId?: string,
): PersistedChannelIdentity {
  const now = String(Date.now());
  const row = upsertChannelIdentitySync(db, channel, identity, now);
  const persistedIdentity = channelIdentityFromRow(row);
  new IdentityDirectory(db).materializeChannelIdentity({
    channel,
    channelIdentityId: row.id,
    identity,
    authenticatedUserId,
    ...(agentId === undefined ? {} : { agentId }),
  });
  return persistedIdentity;
}

function upsertChannelIdentitySync(
  db: DrizzleDB,
  channel: ChannelRef,
  identity: ChannelIdentity,
  now: string,
): ChannelIdentityRow {
  const trustedProfile = trustedChannelIdentityProfile(identity);
  const persistedIdentity = {
    ...identity,
    ...(trustedProfile.displayName !== undefined
      ? { displayName: trustedProfile.displayName }
      : {}),
    ...(trustedProfile.avatarUrl !== undefined
      ? { avatarUrl: trustedProfile.avatarUrl }
      : {}),
  };
  const profileUpdatedAt = hasIdentityProfileUpdate(persistedIdentity) ? now : null;
  const values = {
    channelType: channel.type,
    channelId: channel.id,
    externalId: identity.externalId,
    identityKind: identity.kind,
    displayName: trustedProfile.displayName ?? null,
    avatarUrl: trustedProfile.avatarUrl ?? null,
    providerIdsJson: stringifyJson(identity.providerIds),
    rawProfileJson: stringifyJson(identity.rawProfile),
    lastSeenAt: now,
    profileUpdatedAt,
    updatedAt: now,
  };
  db.insert(channelIdentities)
    .values({
      id: uuid(),
      ...values,
      firstSeenAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        channelIdentities.channelType,
        channelIdentities.channelId,
        channelIdentities.externalId,
      ],
      set: {
        identityKind: sql`excluded.identity_kind`,
        displayName: sql`coalesce(excluded.display_name, ${channelIdentities.displayName})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${channelIdentities.avatarUrl})`,
        providerIdsJson: sql`coalesce(excluded.provider_ids_json, ${channelIdentities.providerIdsJson})`,
        rawProfileJson: sql`coalesce(excluded.raw_profile_json, ${channelIdentities.rawProfileJson})`,
        lastSeenAt: now,
        profileUpdatedAt: sql`coalesce(excluded.profile_updated_at, ${channelIdentities.profileUpdatedAt})`,
        updatedAt: now,
      },
    })
    .run();
  return requireIdentityRow(db, channel, identity.externalId);
}

export function resolveRawProfileSurfaceKind(
  rawProfile: unknown,
): "p2p" | "group" | null {
  let record: Record<string, unknown> | null = null;
  if (typeof rawProfile === "string") {
    try {
      const parsed = JSON.parse(rawProfile) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else if (
    rawProfile !== null &&
    typeof rawProfile === "object" &&
    !Array.isArray(rawProfile)
  ) {
    record = rawProfile as Record<string, unknown>;
  }
  if (record === null) {
    return null;
  }

  for (const mode of [record.chat_mode, record.chatMode]) {
    if (mode === "p2p") return "p2p";
    if (mode === "group" || mode === "topic") return "group";
  }
  for (const chatType of [record.chat_type, record.chatType]) {
    if (chatType === "p2p") return "p2p";
    if (chatType === "group") return "group";
  }
  return null;
}

export function resolvePersistedSurfaceKind(row: {
  readonly surfaceKind: string;
  readonly rawProfileJson: string | null;
}): string {
  return resolveRawProfileSurfaceKind(row.rawProfileJson) ?? row.surfaceKind;
}

export function lookupChannelSurfaceKind(
  db: DrizzleDB | undefined,
  channel: { readonly type?: string; readonly id: string },
  externalId: string | null | undefined,
): ChannelSurfaceKind | undefined {
  if (!db || !externalId) {
    return undefined;
  }
  const row = db
    .select({
      surfaceKind: channelSurfaces.surfaceKind,
      rawProfileJson: channelSurfaces.rawProfileJson,
    })
    .from(channelSurfaces)
    .where(
      channel.type !== undefined
        ? and(
            eq(channelSurfaces.channelType, channel.type),
            eq(channelSurfaces.channelId, channel.id),
            eq(channelSurfaces.externalId, externalId),
          )
        : and(
            eq(channelSurfaces.channelId, channel.id),
            eq(channelSurfaces.externalId, externalId),
          ),
    )
    .get();
  if (!row) {
    return undefined;
  }
  return normalizeSurfaceKind(resolvePersistedSurfaceKind(row));
}

export function isGroupChannelSurface(
  db: DrizzleDB,
  channelId: string,
  externalId: string | null | undefined,
  channelType?: string,
): boolean {
  return (
    lookupChannelSurfaceKind(
      db,
      channelType !== undefined ? { type: channelType, id: channelId } : { id: channelId },
      externalId,
    ) === "group"
  );
}

function upsertChannelSurface(
  db: DrizzleDB,
  channel: ChannelRef,
  surface: ChannelSurface,
): PersistedChannelSurface {
  const now = String(Date.now());
  const row = upsertChannelSurfaceSync(db, channel, surface, now);
  return channelSurfaceFromRow(row);
}

function upsertChannelSurfaceSync(
  db: DrizzleDB,
  channel: ChannelRef,
  surface: ChannelSurface,
  now: string,
): ChannelSurfaceRow {
  const profileUpdatedAt = hasSurfaceProfileUpdate(surface) ? now : null;
  const incomingProfileKind = resolveRawProfileSurfaceKind(surface.rawProfile);
  const existing = findSurfaceRow(db, channel, surface.externalId);
  const existingProfileKind = existing
    ? resolveRawProfileSurfaceKind(existing.rawProfileJson)
    : null;
  const existingEffectiveKind = existing
    ? normalizeSurfaceKind(resolvePersistedSurfaceKind(existing))
    : undefined;

  let resolvedKind: ChannelSurfaceKind = incomingProfileKind ?? surface.kind;
  if (incomingProfileKind === null && existing !== undefined) {
    if (existingProfileKind !== null) {
      resolvedKind = existingProfileKind;
    } else if (resolvedKind === "unknown" && existingEffectiveKind !== "unknown") {
      resolvedKind = existingEffectiveKind!;
    } else if (
      surface.rawProfile === undefined &&
      existingEffectiveKind === "p2p" &&
      resolvedKind === "group"
    ) {
      resolvedKind = "p2p";
    }
  }

  const values = {
    channelType: channel.type,
    channelId: channel.id,
    externalId: surface.externalId,
    surfaceKind: resolvedKind,
    displayName: surface.displayName ?? null,
    avatarUrl: surface.avatarUrl ?? null,
    providerIdsJson: stringifyJson(surface.providerIds),
    rawProfileJson: stringifyJson(surface.rawProfile),
    lastSeenAt: now,
    profileUpdatedAt,
    updatedAt: now,
  };
  db.insert(channelSurfaces)
    .values({
      id: uuid(),
      ...values,
      firstSeenAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        channelSurfaces.channelType,
        channelSurfaces.channelId,
        channelSurfaces.externalId,
      ],
      set: {
        surfaceKind: resolvedKind,
        displayName: sql`coalesce(excluded.display_name, ${channelSurfaces.displayName})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${channelSurfaces.avatarUrl})`,
        providerIdsJson: sql`coalesce(excluded.provider_ids_json, ${channelSurfaces.providerIdsJson})`,
        rawProfileJson: sql`coalesce(excluded.raw_profile_json, ${channelSurfaces.rawProfileJson})`,
        lastSeenAt: now,
        profileUpdatedAt: sql`coalesce(excluded.profile_updated_at, ${channelSurfaces.profileUpdatedAt})`,
        updatedAt: now,
      },
    })
    .run();
  return requireSurfaceRow(db, channel, surface.externalId);
}

function findIdentityRow(
  db: DrizzleDB,
  channel: ChannelRef,
  externalId: string,
): ChannelIdentityRow | undefined {
  return db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channelType, channel.type),
        eq(channelIdentities.channelId, channel.id),
        eq(channelIdentities.externalId, externalId),
      ),
    )
    .get();
}

function requireIdentityRow(
  db: DrizzleDB,
  channel: ChannelRef,
  externalId: string,
): ChannelIdentityRow {
  const row = findIdentityRow(db, channel, externalId);
  if (row === undefined) {
    throw new Error(`Channel identity was not persisted: ${externalId}`);
  }
  return row;
}

function findSurfaceRow(
  db: DrizzleDB,
  channel: ChannelRef,
  externalId: string,
): ChannelSurfaceRow | undefined {
  return db
    .select()
    .from(channelSurfaces)
    .where(
      and(
        eq(channelSurfaces.channelType, channel.type),
        eq(channelSurfaces.channelId, channel.id),
        eq(channelSurfaces.externalId, externalId),
      ),
    )
    .get();
}

function requireSurfaceRow(
  db: DrizzleDB,
  channel: ChannelRef,
  externalId: string,
): ChannelSurfaceRow {
  const row = findSurfaceRow(db, channel, externalId);
  if (row === undefined) {
    throw new Error(`Channel surface was not persisted: ${externalId}`);
  }
  return row;
}

function channelIdentityFromRow(row: ChannelIdentityRow): PersistedChannelIdentity {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: normalizeIdentityKind(row.identityKind),
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    ...(row.avatarUrl !== null ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.providerIdsJson !== null
      ? { providerIds: parseJsonRecord(row.providerIdsJson) }
      : {}),
    ...(row.rawProfileJson !== null
      ? { rawProfile: parseJsonValue(row.rawProfileJson) }
      : {}),
  };
}

function channelSurfaceFromRow(row: ChannelSurfaceRow): PersistedChannelSurface {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: normalizeSurfaceKind(resolvePersistedSurfaceKind(row)),
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    ...(row.avatarUrl !== null ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.providerIdsJson !== null
      ? { providerIds: parseJsonRecord(row.providerIdsJson) }
      : {}),
    ...(row.rawProfileJson !== null
      ? { rawProfile: parseJsonValue(row.rawProfileJson) }
      : {}),
  };
}

function normalizeIdentityKind(value: string | undefined): ChannelIdentityKind {
  return value === "bot" || value === "system" || value === "unknown"
    ? value
    : "user";
}

function normalizeSurfaceKind(value: string | undefined): ChannelSurfaceKind {
  return value === "p2p" ||
    value === "group" ||
    value === "channel" ||
    value === "thread" ||
    value === "webhook" ||
    value === "ticket"
    ? value
    : "unknown";
}

function hasIdentityProfileUpdate(identity: ChannelIdentity): boolean {
  return (
    identity.displayName !== undefined ||
    identity.avatarUrl !== undefined ||
    identity.providerIds !== undefined ||
    identity.rawProfile !== undefined
  );
}

function hasSurfaceProfileUpdate(surface: ChannelSurface): boolean {
  return (
    surface.displayName !== undefined ||
    surface.avatarUrl !== undefined ||
    surface.providerIds !== undefined ||
    surface.rawProfile !== undefined
  );
}

function stringifyJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJsonRecord(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseJsonValue(value: string): unknown {
  return JSON.parse(value);
}
