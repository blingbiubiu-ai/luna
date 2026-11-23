import { and, eq } from "drizzle-orm";
import { ensureShadowHeartbeatSession } from "@/agents/shadow-heartbeat";
import type { DrizzleDB } from "@/data";
import {
  channelIdentities,
  channelSurfaces,
  channelUserBindings,
  directRecipients,
  messages,
  sessionTimelineEntries,
  sessions,
  shadowBotBindings,
  userIdentityLinks,
  users,
} from "@/data/schema";
import { ownerUserId } from "@/identity/account-store";
import { GatewayError } from "@/server/gateway-error";
import { SessionStore } from "@/sessions/session-store";
import { resolveMessageTarget } from "./delivery-target";
import { feishuRecipientClaims, type FeishuRecipientIdType } from "./feishu-recipient";

export type ParsedLunaAddress =
  | { readonly kind: "self" }
  | { readonly kind: "current" }
  | { readonly kind: "owner" }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "group"; readonly groupId: string };

export interface LunaAddressScope {
  readonly agentId: string;
  readonly shadowId: string;
  readonly currentSessionId?: string | undefined;
}

export interface ResolvedLunaAddress {
  readonly address: string;
  readonly kind: Exclude<ParsedLunaAddress["kind"], "owner">;
  readonly sessionId: string;
  readonly targetUserId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly chatId?: string | undefined;
}

export function parseLunaAddress(raw: string): ParsedLunaAddress {
  const trimmed = raw.trim();
  if (trimmed === "self") return { kind: "self" };
  if (trimmed === "current") return { kind: "current" };
  if (trimmed === "owner") return { kind: "owner" };
  if (trimmed.startsWith("user:")) {
    const userId = trimmed.slice("user:".length).trim();
    if (!userId) throw new GatewayError("invalid_address", "Empty user address", 400);
    return { kind: "user", userId };
  }
  if (trimmed.startsWith("session:")) {
    const sessionId = trimmed.slice("session:".length).trim();
    if (!sessionId) throw new GatewayError("invalid_address", "Empty session address", 400);
    return { kind: "session", sessionId };
  }
  if (trimmed.startsWith("group:")) {
    const groupId = trimmed.slice("group:".length).trim();
    if (!groupId) throw new GatewayError("invalid_address", "Empty group address", 400);
    return { kind: "group", groupId };
  }
  throw new GatewayError(
    "invalid_address",
    "Address must be 'self', 'current', 'owner', 'user:<id>', 'session:<id>', or 'group:<id>'",
    400,
  );
}

export function activeShadowChannelId(
  db: DrizzleDB,
  shadowId: string,
): string | undefined {
  return db
    .select({ channelId: shadowBotBindings.channelConfigId })
    .from(shadowBotBindings)
    .where(
      and(
        eq(shadowBotBindings.shadowId, shadowId),
        eq(shadowBotBindings.status, "active"),
      ),
    )
    .get()?.channelId;
}

export function resolveLunaAddress(
  db: DrizzleDB,
  scope: LunaAddressScope,
  rawAddress: string,
  options: {
    readonly create?: boolean | undefined;
    readonly allowLocalFallback?: boolean | undefined;
  } = {},
): ResolvedLunaAddress {
  const create = options.create ?? true;
  const parsed = parseLunaAddress(rawAddress);

  if (parsed.kind === "self") {
    const sessionId = ensureShadowHeartbeatSession(db, scope.shadowId);
    return { address: "self", kind: "self", sessionId };
  }

  if (parsed.kind === "current") {
    if (!scope.currentSessionId) {
      throw new GatewayError("missing_session", "No current session in scope", 400);
    }
    const row = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, scope.currentSessionId))
      .get();
    if (
      !row ||
      row.status !== "active" ||
      row.agent_id !== scope.agentId ||
      row.shadow_id !== scope.shadowId
    ) {
      throw new GatewayError("session_unavailable", "Current session is unavailable", 404);
    }
    return {
      address: `session:${row.id}`,
      kind: "current",
      sessionId: row.id,
      ...(row.channel_type !== "dashboard" ? { channelId: row.channel_id } : {}),
      ...(row.group_id ? { chatId: row.group_id } : {}),
    };
  }

  if (parsed.kind === "session") {
    const row = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, parsed.sessionId))
      .get();
    if (!row || row.status !== "active") {
      throw new GatewayError("session_not_found", "Session not found", 404);
    }
    if (row.agent_id !== scope.agentId || row.shadow_id !== scope.shadowId) {
      throw new GatewayError(
        "session_forbidden",
        "Session belongs to another Agent or Shadow",
        403,
      );
    }
    return {
      address: `session:${row.id}`,
      kind: "session",
      sessionId: row.id,
      ...(row.channel_type !== "dashboard" ? { channelId: row.channel_id } : {}),
      ...(row.group_id ? { chatId: row.group_id } : {}),
    };
  }

  if (parsed.kind === "group") {
    const channelId = activeShadowChannelId(db, scope.shadowId);
    if (!channelId) {
      throw new GatewayError(
        "channel_unavailable",
        "Shadow has no active external channel binding",
        409,
      );
    }
    const surface = db
      .select()
      .from(channelSurfaces)
      .where(
        and(
          eq(channelSurfaces.channelId, channelId),
          eq(channelSurfaces.surfaceKind, "group"),
        ),
      )
      .all()
      .find(
        row => row.id === parsed.groupId || row.externalId === parsed.groupId,
      );
    if (!surface) {
      throw new GatewayError("group_not_found", "Group not found in Shadow directory", 404);
    }
    const sessionId = resolveMessageTarget(
      db,
      { kind: "surface", channelId: surface.channelId, surfaceId: surface.externalId },
      undefined,
      create,
    );
    return {
      address: `group:${surface.id}`,
      kind: "group",
      sessionId,
      channelId: surface.channelId,
      chatId: surface.externalId,
    };
  }

  // `owner` or `user:<userId>`
  const targetUserId =
    parsed.kind === "owner" ? ownerUserId(db, scope.agentId) : parsed.userId;
  const user = db
    .select()
    .from(users)
    .where(and(eq(users.id, targetUserId), eq(users.agentId, scope.agentId)))
    .get();
  if (!user || user.status !== "active") {
    throw new GatewayError("user_not_found", "User not found in Agent directory", 404);
  }

  const channelId = activeShadowChannelId(db, scope.shadowId);
  // Look for an existing p2p session of THIS Shadow with this user first.
  const directRows = db
    .select({ sessionId: directRecipients.sessionId, channelId: sessions.channel_id })
    .from(directRecipients)
    .innerJoin(sessions, eq(sessions.id, directRecipients.sessionId))
    .innerJoin(userIdentityLinks, eq(userIdentityLinks.id, directRecipients.claimId))
    .where(
      and(
        eq(userIdentityLinks.userId, targetUserId),
        eq(sessions.shadow_id, scope.shadowId),
        eq(sessions.status, "active"),
        channelId ? eq(sessions.channel_id, channelId) : undefined,
      ),
    )
    .all();

  const observedP2p = db
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(
      channelSurfaces,
      and(
        eq(channelSurfaces.channelId, sessions.channel_id),
        eq(channelSurfaces.externalId, sessions.group_id),
      ),
    )
    .innerJoin(sessionTimelineEntries, eq(sessionTimelineEntries.sessionId, sessions.id))
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .where(
      and(
        eq(sessions.shadow_id, scope.shadowId),
        eq(sessions.status, "active"),
        eq(channelSurfaces.surfaceKind, "p2p"),
        eq(sessionTimelineEntries.entryKind, "message"),
        eq(messages.senderUserId, targetUserId),
        channelId ? eq(sessions.channel_id, channelId) : undefined,
      ),
    )
    .all()
    .filter(r => !r.session.thread_key);

  const candidateIds = [
    ...new Set([
      ...observedP2p.map(r => r.session.id),
      ...directRows.map(r => r.sessionId),
    ]),
  ];
  if (candidateIds.length === 1) {
    const resolved = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, candidateIds[0]!))
      .get()!;
    return {
      address: `user:${targetUserId}`,
      kind: "user",
      sessionId: resolved.id,
      targetUserId,
      channelId: resolved.channel_id,
      ...(resolved.group_id ? { chatId: resolved.group_id } : {}),
    };
  }
  if (candidateIds.length > 1) {
    throw new GatewayError(
      "ambiguous_target",
      "Multiple private conversations exist for this user; use session:<id>",
      409,
    );
  }

  if (create && channelId) {
    const claims = feishuRecipientClaims(db, channelId, "open_id", {
      userId: targetUserId,
    });
    if (claims.length === 1) {
      const sessionId = resolveMessageTarget(
        db,
        {
          kind: "feishu_user",
          channelId,
          idType: "open_id",
          id: claims[0]!.id,
        },
        undefined,
        true,
      );
      return {
        address: `user:${targetUserId}`,
        kind: "user",
        sessionId,
        targetUserId,
        channelId,
      };
    }
  }

  if (options.allowLocalFallback) {
    const existingLocal = db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.agent_id, scope.agentId),
          eq(sessions.shadow_id, scope.shadowId),
          eq(sessions.channel_type, "dashboard"),
          eq(sessions.kind, "main"),
          eq(sessions.status, "active"),
          eq(sessions.created_by_user_id, targetUserId),
          eq(sessions.title, "审批与通知"),
        ),
      )
      .get();
    if (existingLocal) {
      return {
        address: `user:${targetUserId}`,
        kind: "user",
        sessionId: existingLocal.id,
        targetUserId,
      };
    }
    const created = new SessionStore(db).createLocalSession(targetUserId, {
      agentId: scope.agentId,
      shadowId: scope.shadowId,
    });
    db.update(sessions)
      .set({ title: "审批与通知", updated_at: Date.now() })
      .where(eq(sessions.id, created.id))
      .run();
    return {
      address: `user:${targetUserId}`,
      kind: "user",
      sessionId: created.id,
      targetUserId,
    };
  }

  throw new GatewayError(
    "user_surface_unavailable",
    "No private conversation or verified channel recipient claim available for this user",
    409,
  );
}

/**
 * Resolves `user:<luna-user-id>` entries into provider IDs for `groups create / invite`.
 */
export function resolveFeishuMemberProviderIds(
  db: DrizzleDB,
  channelId: string,
  idType: FeishuRecipientIdType,
  members: readonly string[],
): string[] {
  return members.map(entry => {
    const trimmed = entry.trim();
    if (!trimmed.startsWith("user:")) return trimmed;
    const userId = trimmed.slice("user:".length).trim();
    const claims = feishuRecipientClaims(db, channelId, idType, { userId });
    if (claims.length === 1) {
      return claims[0]!.id;
    }
    if (claims.length > 1) {
      throw new GatewayError(
        "recipient_unresolved",
        `Cannot resolve unique ${idType} for user:${userId} on channel ${channelId}`,
        409,
      );
    }
    const bindings = db
      .select({ providerIdsJson: channelIdentities.providerIdsJson })
      .from(channelUserBindings)
      .innerJoin(
        channelIdentities,
        eq(channelIdentities.id, channelUserBindings.channelIdentityId),
      )
      .where(
        and(
          eq(channelUserBindings.userId, userId),
          eq(channelIdentities.channelId, channelId),
        ),
      )
      .all();
    const candidates = [
      ...new Set(
        bindings
          .map(row => {
            try {
              const parsed = JSON.parse(row.providerIdsJson ?? "{}") as Record<string, unknown>;
              return typeof parsed[idType] === "string" ? parsed[idType].trim() : "";
            } catch {
              return "";
            }
          })
          .filter(Boolean),
      ),
    ];
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    throw new GatewayError(
      "recipient_unresolved",
      `Cannot resolve unique ${idType} for user:${userId} on channel ${channelId}`,
      409,
    );
  });
}
