import type { ChannelAdapter, NormalizedInboundMessage } from "@/channels";
import { ChannelDirectoryStore } from "@/channels/directory-store";
import type { DrizzleDB } from "@/data";
import {
  canonicalUserIdForRequestedIdentity,
  requestedIdentityFromInbound,
} from "@/identity/requested-identity";
import {
  AccessTokenService,
} from "@/server/auth/access-token-service";
import { WorkSessionLauncher } from "@/work/work-session-launcher";
import { SessionStore } from "@/sessions/session-store";
import { MessageStore } from "@/sessions/message-store";
import { SessionInboxStore } from "@/sessions/session-inbox-store";
import { resolveLunaAccessTokenSigningSecret } from "@/server/auth";
import { extractSystemCommand } from "./system-command-parser";

const CHANNEL_AUTH_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface InboundCommandRouterOptions {
  readonly db: DrizzleDB;
  readonly channel: ChannelAdapter;
  readonly schedule?: (sessionId: string) => void;
}

/**
 * Handles system commands before messages enter Luna sessions or runners.
 */
export class InboundCommandRouter {
  private readonly _directory: ChannelDirectoryStore;

  constructor(private readonly _options: InboundCommandRouterOptions) {
    this._directory = new ChannelDirectoryStore(_options.db);
  }

  async handle(message: NormalizedInboundMessage): Promise<boolean> {
    const text = message.text.trim();
    const command = extractSystemCommand(text, message.addressing.addressedToBot);
    if (command === undefined) {
      return false;
    }
    if (command === "#steer") {
      return false;
    }
    if (message.surface.kind !== "p2p" && !message.addressing.addressedToBot) {
      return true;
    }
    if (command === "#auth") {
      await this._handleAuth(message);
      return true;
    }
    if (command === "#work") {
      const launcher = new WorkSessionLauncher({
        db: this._options.db,
        channel: this._options.channel,
        sessionStore: new SessionStore(this._options.db),
        messageStore: new MessageStore(this._options.db),
        inboxStore: new SessionInboxStore(this._options.db),
        schedule: (id) => this._options.schedule?.(id),
      });
      return launcher.handleWorkCommand(message);
    }
    await this._options.channel.send(message, {
      replyMode: message.surface.kind === "p2p" ? "direct_message" : "channel_message",
      content: `Unknown system command: ${command ?? "#"}`,
      targetMessageId: message.id,
      idempotencyKey: `system-command:${message.channel.id}:${message.id}:unknown`,
    });
    return true;
  }

  private async _handleAuth(message: NormalizedInboundMessage): Promise<void> {
    if (message.surface.kind !== "p2p") {
      await this._options.channel.send(message, {
        replyMode: "channel_message",
        content: "Please send #auth in a private chat with this bot.",
        targetMessageId: message.id,
        idempotencyKey: `system-command:${message.channel.id}:${message.id}:auth:group-rejected`,
      });
      return;
    }

    const signingSecret = resolveLunaAccessTokenSigningSecret();
    if (signingSecret === null) {
      await this._options.channel.send(message, {
        replyMode: "direct_message",
        content: "Auth is not configured on this Luna service.",
        targetMessageId: message.id,
        idempotencyKey: `system-command:${message.channel.id}:${message.id}:auth:not-configured`,
      });
      return;
    }

    const channelIdentity = this._directory.upsertIdentity({
      channel: message.channel,
      identity: message.sender,
    });
    const userId = canonicalUserIdForRequestedIdentity(
      this._options.db,
      requestedIdentityFromInbound(message),
    );
    if (userId === undefined) {
      await this._options.channel.send(message, {
        replyMode: "direct_message",
        content: "Could not resolve your Luna user from this chat identity.",
        targetMessageId: message.id,
        idempotencyKey: `system-command:${message.channel.id}:${message.id}:auth:user-not-found`,
      });
      return;
    }

    const issued = new AccessTokenService({
      db: this._options.db,
      signingSecret,
    }).issueChannelAuthToken({
      userId,
      channelType: message.channel.type,
      channelId: message.channel.id,
      channelIdentityId: channelIdentity.id,
      purpose: "cli_login",
      ttlMs: CHANNEL_AUTH_TOKEN_TTL_MS,
      now: Date.now(),
      metadata: {
        sourceMessageId: message.id,
        sourceSurfaceId: message.surface.externalId,
      },
    });

    await this._options.channel.send(message, {
      replyMode: "direct_message",
      content: [
        "One-time login token:",
        "",
        issued.token,
        "",
        "Paste it into the Luna CLI authorization page. It expires in 10 minutes and can be used only once.",
      ].join("\n"),
      targetMessageId: message.id,
      idempotencyKey: `system-command:${message.channel.id}:${message.id}:auth:issued`,
    });
  }
}
