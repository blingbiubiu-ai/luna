import type { FeishuIdentityScope } from "@/identity/feishu-identity-scopes";
import type {
  ChannelMention,
  ChannelRef,
  NormalizedInboundMessage,
} from "@/channels/types";
import { textStartsWithLeadingAlias } from "@/sessions/addressing-utils";
import type { InboundAddressing } from "@/sessions/types";

import type { FeishuMentionEventItem } from "./mentions";
import {
  feishuMentionLabel,
  resolveFeishuMentionTarget,
  resolveFeishuSenderIdentity,
  resolveFeishuSurface,
  type FeishuBotStableIdentity,
  type FeishuSenderIdentityInput,
} from "./feishu-identity-resolver";
import { renderFeishuMentions } from "./feishu-mention-renderer";

export interface FeishuRawMessageEvent {
  readonly message_id: string;
  readonly root_id?: string;
  readonly parent_id?: string;
  readonly thread_id?: string;
  readonly upper_message_id?: string;
  readonly message_position?: string;
  readonly thread_message_position?: string;
  readonly chat_id: string;
  readonly chat_type?: string;
  readonly message_type?: string;
  readonly content: string;
  readonly mentions?: readonly FeishuMentionEventItem[];
  readonly sender?: FeishuSenderIdentityInput;
}

export interface FeishuNormalizerOptions {
  readonly identityScope: FeishuIdentityScope;
  readonly channel: ChannelRef;
  readonly botIdentity?: FeishuBotStableIdentity;
  readonly groupBotAliases?: readonly string[];
}

export function createFeishuNormalizer(options: FeishuNormalizerOptions) {
  return {
    normalizeMessageEvent(event: FeishuRawMessageEvent): NormalizedInboundMessage {
      const rawText = extractFeishuTextContent(event);
      const sender = resolveFeishuSenderIdentity({
        identityScope: options.identityScope,
        sender: event.sender,
        messageId: event.message_id,
      });
      const surface = resolveFeishuSurface({
        chatId: event.chat_id,
        ...(event.chat_type !== undefined ? { chatType: event.chat_type } : {}),
        ...(event.sender?.tenant_key !== undefined
          ? { tenantKey: event.sender.tenant_key }
          : {}),
      });
      const mentions = (event.mentions ?? []).map(
        (mention): ChannelMention => {
          const target = resolveFeishuMentionTarget({
            identityScope: options.identityScope,
            mention,
            ...(options.botIdentity !== undefined
              ? { botIdentity: options.botIdentity }
              : {}),
          });
          return {
            key: mention.key,
            label: feishuMentionLabel(mention),
            target,
            rawMention: mention,
          };
        },
      );
      const text = renderFeishuMentions(rawText, mentions);

      return {
        id: event.message_id,
        channel: options.channel,
        surface,
        ...(event.thread_id !== undefined
          ? {
              thread: {
                externalId: event.thread_id,
                ...(event.root_id ?? event.parent_id
                  ? { rootMessageExternalId: event.root_id ?? event.parent_id }
                  : {}),
                ...(event.parent_id !== undefined
                  ? { parentMessageExternalId: event.parent_id }
                  : {}),
              },
            }
          : {}),
        sender,
        text,
        mentions,
        addressing: computeFeishuAddressing({
          mentions,
          rawText,
          surfaceKind: surface.kind,
          groupBotAliases: options.groupBotAliases ?? [],
        }),
        rawPayload: event,
      } satisfies NormalizedInboundMessage;
    },
  };
}

export function computeFeishuAddressing(input: {
  readonly mentions: readonly ChannelMention[];
  readonly rawText: string;
  readonly surfaceKind: string;
  readonly groupBotAliases: readonly string[];
}): InboundAddressing {
  if (input.surfaceKind === "p2p") {
    return { addressedToBot: true, reason: "p2p" };
  }
  if (input.surfaceKind !== "group") {
    return { addressedToBot: false, reason: "silent_group" };
  }
  if (input.mentions.some((mention) => mention.target.kind === "bot")) {
    return { addressedToBot: true, reason: "mention" };
  }
  if (textStartsWithLeadingAlias(input.rawText, input.groupBotAliases)) {
    return { addressedToBot: true, reason: "alias" };
  }
  return { addressedToBot: false, reason: "silent_group" };
}

function extractFeishuTextContent(event: FeishuRawMessageEvent): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch (err) {
    throw new Error(
      `Message ${event.message_id} has invalid Feishu text content: malformed JSON`,
      { cause: err },
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("text" in parsed) ||
    typeof (parsed as { readonly text: unknown }).text !== "string"
  ) {
    throw new Error(
      `Message ${event.message_id} has invalid Feishu text content: expected string text field`,
    );
  }
  return (parsed as { readonly text: string }).text;
}
