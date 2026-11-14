import type { DrizzleDB } from "@/data";
import { SessionStore } from "@/sessions/session-store";
import { recordShadowBotIdentity } from "@/identity/shadow-bot";
import type { ChannelIdentity, ChannelRef } from "./types";

/** Bind only the self identity belonging to the session's immutable Shadow. */
export function bindSessionBot(db: DrizzleDB, sessionId: string, channel: ChannelRef, identity: ChannelIdentity | undefined): void {
  const store = new SessionStore(db), session = store.getById(sessionId);
  if (!session) throw new Error("Session is unavailable");
  if (channel.type !== "dashboard") {
    store.requireChannelScope(session,channel.id);
    if (identity) store.bindBotUser(sessionId,recordShadowBotIdentity(db,channel.id,identity));
  }
  store.requireReplyUserId(sessionId);
}
