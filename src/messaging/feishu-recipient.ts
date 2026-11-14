import { and, eq, isNull, like } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { channelConfigs, channelIdentities, channelUserBindings, identityObservations, userIdentityLinks, users } from "@/data/schema";
import { config } from "@/shared";
import { GatewayError } from "@/server/gateway-error";

export type FeishuRecipientIdType = "open_id" | "user_id" | "union_id";

/** Resolve only evidence observed by the selected application for an active human. */
export function feishuRecipientClaims(db: DrizzleDB, channelId: string, idType: FeishuRecipientIdType, target: { id: string } | { userId: string }) {
  const channel = db.select().from(channelConfigs).where(eq(channelConfigs.id, channelId)).get();
  if (channel?.type !== "feishu" || !channel.enabled) return [];
  const developers = idType === "union_id" ? config.messaging.feishu_developers : undefined;
  const developerId = developers && Object.hasOwn(developers, channel.appId) ? developers[channel.appId] : undefined;
  if (idType === "union_id" && !developerId) return [];
  const scope = idType === "open_id" ? eq(userIdentityLinks.identityScope, `app:${channel.appId}`)
    : idType === "union_id" ? eq(userIdentityLinks.identityScope, `developer:${developerId}`)
    : like(userIdentityLinks.identityScope, "tenant:_%");
  return db.selectDistinct({ claimId: userIdentityLinks.id, userId: users.id, id: userIdentityLinks.identityValue })
    .from(userIdentityLinks)
    .innerJoin(identityObservations, eq(identityObservations.claimId, userIdentityLinks.id))
    .innerJoin(channelIdentities, eq(channelIdentities.id, identityObservations.channelIdentityId))
    .innerJoin(channelUserBindings, and(eq(channelUserBindings.channelIdentityId, channelIdentities.id), eq(channelUserBindings.userId, userIdentityLinks.userId)))
    .innerJoin(users, eq(users.id, userIdentityLinks.userId))
    .where(and(eq(channelIdentities.channelType, "feishu"), eq(channelIdentities.channelId, channelId), eq(channelIdentities.identityKind, "user"),
      eq(identityObservations.confidence, "verified"), eq(userIdentityLinks.identityNamespace, "feishu"), eq(userIdentityLinks.identityKind, idType), scope,
      eq(users.kind, "human"), eq(users.status, "active"), isNull(users.mergedIntoUserId),
      "id" in target ? eq(userIdentityLinks.identityValue, target.id) : eq(users.id, target.userId))).all();
}

export function requireFeishuRecipientClaim(db: DrizzleDB, channelId: string, idType: FeishuRecipientIdType, id: string) {
  const claims = feishuRecipientClaims(db, channelId, idType, { id });
  if (claims.length !== 1) throw new GatewayError("recipient_unresolved", "Resolve this recipient under the current Feishu application before sending", 409);
  return claims[0]!;
}
