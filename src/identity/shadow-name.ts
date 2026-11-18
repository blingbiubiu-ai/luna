import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { agentShadows, users } from "@/data/schema";
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
  const user = db.select().from(users).where(eq(users.id, replyUserId)).get();
  if (user?.kind !== "shadow" || user.profileSource === "manual") return;
  const shadow = db.select().from(agentShadows).where(eq(agentShadows.replyUserId, replyUserId)).get();
  if (!shadow || shadow.status === "deleted" || (shadow.name === name && user.displayName === name && user.profileSource === "channel")) return;
  const now = Date.now();
  db.update(agentShadows).set({ name, updatedAt: now }).where(eq(agentShadows.id, shadow.id)).run();
  db.update(users).set({ displayName: name, profileSource: "channel", updatedAt: new Date(now).toISOString() }).where(eq(users.id, replyUserId)).run();
}
