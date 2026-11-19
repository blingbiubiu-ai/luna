import type { ChannelAdapter, NormalizedInboundMessage } from "@/channels";
import type { DrizzleDB } from "@/data";
import { AgentStore } from "@/agents/agent-store";
import { BotBindingStore } from "@/agents/bot-binding-store";
import { SessionInboxStore } from "@/sessions/session-inbox-store";
import { MessageStore } from "@/sessions/message-store";
import { SessionStore } from "@/sessions/session-store";
import { SessionTimelineStore } from "@/sessions/session-timeline-store";
import { extractSystemCommandMatch } from "@/messaging/gateway/system-command-parser";
import { createLogger } from "@/shared";
import {
  appendInputFromNormalizedInbound,
  artifactizeInboundMessageResources,
  resolveInboundSenderUserId,
} from "@/sessions/inbound/inbound-message-persistence";

const logger = createLogger("work-session-launcher");

const WORK_COMMAND = "#work";

export interface WorkSessionLauncherOptions {
  readonly db: DrizzleDB;
  readonly channel: ChannelAdapter;
  readonly sessionStore: SessionStore;
  readonly messageStore: MessageStore;
  readonly inboxStore: SessionInboxStore;
  readonly schedule: (sessionId: string) => void;
}

/**
 * Handles #work system command: creates a Work Session bound to a Feishu
 * thread and enqueues the requirement text as the first user message.
 */
export class WorkSessionLauncher {
  constructor(private readonly _options: WorkSessionLauncherOptions) {}

  async handleWorkCommand(message: NormalizedInboundMessage): Promise<boolean> {
    const text = message.text.trim();
    const command = extractSystemCommandMatch(
      text,
      message.addressing.addressedToBot,
    );
    if (command?.command !== WORK_COMMAND) {
      return false;
    }

    const requirement = text.slice(command.end).trim();
    if (requirement.length === 0) {
      await this._options.channel.send(message, {
        replyMode: message.surface.kind === "p2p" ? "direct_message" : "channel_message",
        content: "请在 #work 后面描述你的需求，例如：#work 帮我实现一个登录页面",
        targetMessageId: message.id,
        idempotencyKey: `work-command:${message.channel.id}:${message.id}:empty`,
      });
      return true;
    }

    const db = this._options.db;
    const binding = new BotBindingStore(db).requireActive(message.channel.id);
    const requester = resolveInboundSenderUserId({db, agentId: binding.agentId, message});
    new AgentStore(db).requireAccess(requester, binding.agentId);

    const rootSession = this._options.sessionStore.resolveByChannelSurface({
      channelType: message.channel.type,
      channelId: message.channel.id,
      groupId: message.surface.externalId,
      kind: "main",
    });

    const session = this._options.sessionStore.createWorkSession({
      channelType: message.channel.type,
      channelId: message.channel.id,
      groupId: message.surface.externalId,
      threadId: message.id,
      rootMessageId: message.id,
    });

    const durableMessage = artifactizeInboundMessageResources({
      db: this._options.db,
      sessionId: session.id,
      message,
    });
    const messageResult = this._options.messageStore.appendOnce(
      appendInputFromNormalizedInbound({
        db: this._options.db,
        sessionId: rootSession.id,
        message: durableMessage,
      }),
    );
    const workEntry = new SessionTimelineStore(this._options.db).appendReference({
      sessionId: session.id,
      messageId: messageResult.row.id,
    });

    const enqueueResult = this._options.inboxStore.enqueueOnce({
      sessionId: session.id,
      entryId: workEntry.id,
      message: messageResult.row,
    });
    if (enqueueResult.created || enqueueResult.requeued) {
      this._options.schedule(session.id);
    }

    logger.info(
      { sessionId: session.id, threadKey: message.id },
      "Created work session and enqueued requirement",
    );

    return true;
  }
}
