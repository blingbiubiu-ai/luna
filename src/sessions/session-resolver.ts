import { SessionStore, type SessionRow } from "./session-store";
import type { NormalizedInboundMessage } from "@/channels";
import { normalizedRootMessageExternalId } from "@/channels/normalized-inbound";

/**
 * Resolves Session Resolver responsibilities in session persistence.
 */
export class SessionResolver {
  constructor(private readonly _sessionStore: SessionStore) {}

  resolveFromNormalizedInbound(message: NormalizedInboundMessage): SessionRow {
    if (message.targetSessionId) {
      const session = this._sessionStore.getById(message.targetSessionId);
      if (!session || session.status !== "active") throw new Error("Session is unavailable");
      if(message.channel.type!=="dashboard")this._sessionStore.requireChannelScope(session,message.channel.id);
      this._sessionStore.requireReplyUserId(session.id);
      return session;
    }
    this._sessionStore.bindInboundDirectRecipient(message);
    const rootMessageId = normalizedRootMessageExternalId(message);
    return this._sessionStore.resolveByChannelSurface({
      channelType: message.channel.type,
      channelId: message.channel.id,
      groupId: message.surface.externalId,
      ...(message.thread?.externalId !== undefined
        ? { threadId: message.thread.externalId }
        : {}),
      ...(rootMessageId !== undefined ? { rootMessageId } : {}),
      ...(message.thread?.parentMessageExternalId !== undefined
        ? { parentMessageId: message.thread.parentMessageExternalId }
        : {}),
    });
  }
}
