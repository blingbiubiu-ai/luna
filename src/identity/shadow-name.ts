import { and, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { agentShadows, channelConfigs, shadowBotBindings, users } from "@/data/schema";
import { cleanDisplayName } from "./display-name";

/**
 * A bot-bound Shadow is called what its bot is called in the chat, unless the
 * owner named it: a named Shadow's user has profile source `manual`, and
 * clearing the name in the Dashboard makes it follow the bot again. Called
 * whenever a message shows the bot's current name: its own profile at start,
 * the bot as a sender, or an `@` of it.
 */
export function followShadowBotName(db: Pick<DrizzleDB, "select" | "update">, replyUserId: string, rawName: string | null | undefined): void {
  const name = cleanDisplayName(rawName);
  if (!name || name.length > 100) return;
  followChannelBotName(db, replyUserId, name);
  const user = db.select().from(users).where(eq(users.id, replyUserId)).get();
  if (user?.kind !== "shadow" || user.profileSource === "manual") return;
  const shadow = db.select().from(agentShadows).where(eq(agentShadows.replyUserId, replyUserId)).get();
  if (!shadow || shadow.status === "deleted" || (shadow.name === name && user.displayName === name && user.profileSource === "channel")) return;
  const now = Date.now();
  db.update(agentShadows).set({ name, updatedAt: now }).where(eq(agentShadows.id, shadow.id)).run();
  db.update(users).set({ displayName: name, profileSource: "channel", updatedAt: new Date(now).toISOString() }).where(eq(users.id, replyUserId)).run();
}

/**
 * A channel is called what its bot is called in the chat, whatever the Shadow
 * is named: the channel name labels the bot connection, not the Shadow.
 */
function followChannelBotName(db: Pick<DrizzleDB, "select" | "update">, replyUserId: string, name: string): void {
  const channel = db.select({ id: channelConfigs.id, name: channelConfigs.name }).from(agentShadows)
    .innerJoin(shadowBotBindings, and(eq(shadowBotBindings.shadowId, agentShadows.id), eq(shadowBotBindings.status, "active")))
    .innerJoin(channelConfigs, eq(channelConfigs.id, shadowBotBindings.channelConfigId))
    .where(eq(agentShadows.replyUserId, replyUserId)).get();
  if (!channel || channel.name === name) return;
  db.update(channelConfigs).set({ name, updatedAt: Date.now() }).where(eq(channelConfigs.id, channel.id)).run();
}

/**
 * A bot-bound Shadow's user shows its bot's avatar. The owner cannot set a Shadow avatar, so
 * unlike the name it always follows the bot. Called with the bot's own verified profile.
 */
export function followShadowBotAvatar(db: Pick<DrizzleDB, "select" | "update">, replyUserId: string, avatarUrl: string | null | undefined): void {
  const url = avatarUrl?.trim();
  if (!url || !/^https?:\/\//.test(url) || url.length > 2048) return;
  const user = db.select().from(users).where(eq(users.id, replyUserId)).get();
  if (user?.kind !== "shadow" || user.avatarUrl === url) return;
  db.update(users).set({ avatarUrl: url, updatedAt: new Date().toISOString() }).where(eq(users.id, replyUserId)).run();
}
