import { and, eq } from "drizzle-orm";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import type { ChannelIdentity, ChannelRef } from "@/channels/types";
import type { DrizzleDB } from "@/data";
import { agentShadows, channelConfigs, channelIdentities, channelUserBindings, shadowBotBindings } from "@/data/schema";
import { IdentityDirectory } from "@/identity/identity-directory";
import type { ReplyChannel } from "@/channels/outbound";

export function recipientSearchText(value: string): string {
  return value.normalize("NFC").replace(/\p{Cf}/gu, "").trim().toLocaleLowerCase();
}

/** Group roster rows carry the observer's address. Bind a configured bot only
 * when its verified name is unique on both sides and it confirms membership. */
export async function resolveGroupBotBindings(
  db: DrizzleDB,
  channel: ChannelRef,
  agentId: string,
  groupId: string,
  roster: readonly ChannelIdentity[],
  matches: readonly ChannelIdentity[],
  channelFor: (id: string) => ReplyChannel | undefined,
) {
  const configured = db.select({
    channelId: channelConfigs.id, appId: channelConfigs.appId, bot: channelConfigs.botIdentity,
    bindingId: shadowBotBindings.id, userId: agentShadows.replyUserId,
  }).from(shadowBotBindings)
    .innerJoin(channelConfigs, eq(channelConfigs.id, shadowBotBindings.channelConfigId))
    .innerJoin(agentShadows, eq(agentShadows.id, shadowBotBindings.shadowId))
    .where(and(eq(shadowBotBindings.agentId, agentId), eq(shadowBotBindings.status, "active"),
      eq(agentShadows.status, "active"), eq(channelConfigs.type, channel.type), eq(channelConfigs.enabled, true))).all();
  return Promise.all(matches.map(async identity => {
    const name = recipientSearchText(identity.displayName ?? "");
    const candidates = configured.filter(row => recipientSearchText(row.bot?.displayName ?? "") === name);
    const candidate = candidates[0];
    if (!name || candidates.length !== 1 || !candidate ||
      roster.filter(row => recipientSearchText(row.displayName ?? "") === name).length !== 1) return { identity };
    if (candidate.channelId === channel.id) {
      return candidate.bot?.externalId === identity.externalId ? { identity, candidate } : { identity };
    }
    const member = await channelFor(candidate.channelId)?.isBotInGroup?.(groupId).catch(() => false);
    return member ? { identity, candidate } : { identity };
  }));
}

export function recordGroupBotIdentities(
  db: DrizzleDB,
  channel: ChannelRef,
  resolved: Awaited<ReturnType<typeof resolveGroupBotBindings>>,
): void {
  db.transaction(tx => {
    const storeDb = tx as unknown as DrizzleDB;
    const directory = new ChannelDirectoryStore(storeDb);
    const identities = new IdentityDirectory(storeDb);
    for (const { identity, candidate } of resolved) {
      const persisted = directory.upsertIdentity({ channel, identity });
      if (!candidate || !tx.select().from(shadowBotBindings)
        .innerJoin(channelConfigs, eq(channelConfigs.id, shadowBotBindings.channelConfigId))
        .innerJoin(agentShadows, eq(agentShadows.id, shadowBotBindings.shadowId))
        .where(and(eq(shadowBotBindings.id, candidate.bindingId), eq(shadowBotBindings.status, "active"),
          eq(agentShadows.status, "active"), eq(channelConfigs.enabled, true))).get()) continue;
      const bind = (identityId: string) => {
        const owner = tx.select().from(channelUserBindings).where(eq(channelUserBindings.channelIdentityId, identityId)).get();
        // A verified identity already owned by another Shadow needs explicit resolution.
        if (!owner || (owner.userId !== candidate.userId && configuredShadowUser(owner.userId))) return;
        identities.bindBotIdentityToUser(identityId, candidate.userId);
      };
      const configuredShadowUser = (userId: string) => Boolean(
        tx.select({ id: agentShadows.id }).from(agentShadows).where(eq(agentShadows.replyUserId, userId)).get(),
      );
      bind(persisted.id);
      // App-addressed sender events may already have created a separate bot row.
      const appIdentity = tx.select().from(channelIdentities).where(and(eq(channelIdentities.channelId, channel.id),
        eq(channelIdentities.identityKind, "bot"), eq(channelIdentities.externalId, candidate.appId))).get();
      if (appIdentity) bind(appIdentity.id);
    }
  });
}
