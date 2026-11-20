import { and, eq, gt, sql } from "drizzle-orm";

import { AgentSettingsStore } from "@/agents/agent-settings-store";
import { resolveChannelSurfaceKind } from "@/dashboard-api/session-display-title";
import type { DrizzleDB } from "@/data";
import { channelSurfaces, chatListening, sessions, sessionTurns } from "@/data/schema";

/** The chat a session belongs to, as far as listening is concerned. */
export type ListeningChat = { readonly agent_id: string; readonly shadow_id: string; readonly group_id: string | null };

/** Reason of a turn that gives the Runner overheard group messages nobody addressed to the Agent. */
export const AMBIENT_TURN_REASON = "ambient";

/**
 * Per Shadow and group chat: whether the Shadow listens without being addressed, and its run of silent
 * listening turns. A chat without its own switch follows the Agent's `listening.defaultEnabled`.
 */
export class ChatListeningStore {
  constructor(private readonly db: DrizzleDB) {}

  enabled(chat: ListeningChat): boolean {
    if (!chat.group_id) return false;
    return this.row(chat.shadow_id, chat.group_id)?.enabled
      ?? new AgentSettingsStore(this.db).get(chat.agent_id).listening.defaultEnabled;
  }

  /** `null` goes back to the Agent default. */
  set(shadowId: string, chatId: string, enabled: boolean | null, userId: string | null): void {
    const now = Date.now();
    this.db.insert(chatListening).values({ shadowId, chatId, enabled, silentStreak: 0, updatedByUserId: userId, updatedAt: now })
      .onConflictDoUpdate({ target: [chatListening.shadowId, chatListening.chatId], set: { enabled, silentStreak: 0, updatedByUserId: userId, updatedAt: now } }).run();
  }

  silentStreak(shadowId: string, chatId: string): number {
    return this.row(shadowId, chatId)?.silentStreak ?? 0;
  }

  /** A listening turn that ended without a reply lengthens the wait before the next; a reply, or being addressed, resets it. */
  recordSilence(shadowId: string, chatId: string): void {
    const now = Date.now();
    this.db.insert(chatListening).values({ shadowId, chatId, enabled: null, silentStreak: 1, updatedByUserId: null, updatedAt: now })
      .onConflictDoUpdate({ target: [chatListening.shadowId, chatListening.chatId], set: { silentStreak: sql`${chatListening.silentStreak} + 1`, updatedAt: now } }).run();
  }

  resetSilence(shadowId: string, chatId: string): void {
    this.db.update(chatListening).set({ silentStreak: 0, updatedAt: Date.now() })
      .where(and(eq(chatListening.shadowId, shadowId), eq(chatListening.chatId, chatId), gt(chatListening.silentStreak, 0))).run();
  }

  /** When the listening turns of the last hour in this chat started, oldest first; topic threads count with their chat. */
  recentTurnStarts(shadowId: string, chatId: string, since: number): number[] {
    return this.db.select({ at: sessionTurns.started_at }).from(sessionTurns)
      .innerJoin(sessions, eq(sessions.id, sessionTurns.session_id))
      .where(and(eq(sessions.shadow_id, shadowId), eq(sessions.group_id, chatId),
        eq(sessionTurns.reason, AMBIENT_TURN_REASON), gt(sessionTurns.started_at, since)))
      .orderBy(sessionTurns.started_at).all().map(row => row.at);
  }

  /**
   * Listening for the group chat a session is a Main conversation of, for the Agent owner's session page.
   * Undefined when the session has none: a private chat, a Work or Dashboard session, or another Agent's.
   */
  forSession(agentId: string, sessionId: string): { shadowId: string; chatId: string; listening: boolean } | undefined {
    const session = this.db.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.agent_id, agentId))).get();
    if (!session?.group_id || session.kind !== "main") return undefined;
    const surface = this.db.select().from(channelSurfaces)
      .where(and(eq(channelSurfaces.channelId, session.channel_id), eq(channelSurfaces.externalId, session.group_id))).get();
    if (!surface || resolveChannelSurfaceKind(surface) !== "group") return undefined;
    return { shadowId: session.shadow_id, chatId: session.group_id, listening: this.enabled(session) };
  }

  private row(shadowId: string, chatId: string) {
    return this.db.select().from(chatListening).where(and(eq(chatListening.shadowId, shadowId), eq(chatListening.chatId, chatId))).get();
  }
}
