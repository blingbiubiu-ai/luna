import type {
  InboundAddressing,
  InboundChatType,
  InboundMention,
} from "@/sessions/types";
import { textStartsWithLeadingAlias } from "@/sessions/addressing-utils";
import type { ChannelMention } from "@/channels/types";

import {
  renderFeishuMentionsWithKeys,
  toMentionLabel,
} from "./feishu-mention-renderer";

export interface FeishuBotIdentity {
  readonly openId?: string;
  readonly userId?: string;
  readonly unionId?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface FeishuMentionEventItem {
  readonly key: string;
  readonly id: {
    readonly union_id?: string;
    readonly user_id?: string;
    readonly open_id?: string;
  };
  readonly name?: string;
  readonly mentioned_type?: string;
  readonly tenant_key?: string;
}

export function mapFeishuMentions(
  mentions: readonly FeishuMentionEventItem[] | undefined,
): readonly InboundMention[] {
  return (mentions ?? []).map((mention) => ({
    key: mention.key,
    ...(mention.name !== undefined ? { name: mention.name } : {}),
    ...(mention.id.open_id !== undefined ? { openId: mention.id.open_id } : {}),
    ...(mention.id.user_id !== undefined ? { userId: mention.id.user_id } : {}),
    ...(mention.id.union_id !== undefined ? { unionId: mention.id.union_id } : {}),
    ...(mention.tenant_key !== undefined ? { tenantKey: mention.tenant_key } : {}),
    ...(mention.mentioned_type !== undefined
      ? { mentionedType: mention.mentioned_type }
      : {}),
  }));
}

export function resolveFeishuAddressing(input: {
  readonly chatType: InboundChatType;
  readonly text: string;
  readonly mentions: readonly InboundMention[];
  readonly botIdentity?: FeishuBotIdentity;
  readonly groupBotAliases: readonly string[];
}): InboundAddressing {
  if (input.chatType === "p2p") {
    return { addressedToBot: true, reason: "p2p" };
  }
  if (input.chatType !== "group") {
    return { addressedToBot: false, reason: "silent_group" };
  }
  if (mentionsBot(input.mentions, input.botIdentity)) {
    return { addressedToBot: true, reason: "mention" };
  }
  if (textStartsWithConfiguredAlias(input.text, input.groupBotAliases)) {
    return { addressedToBot: true, reason: "alias" };
  }
  return { addressedToBot: false, reason: "silent_group" };
}

/**
 * Feishu text uses provider placeholders such as @_user_1; render them into
 * readable mention labels before the text reaches model-facing prompts.
 */
export function renderFeishuMentionText(input: {
  readonly text: string;
  readonly mentions: readonly InboundMention[];
}): {
  readonly text: string;
  readonly renderedMentionKeys: readonly string[];
} {
  return renderFeishuMentionsWithKeys(
    input.text,
    input.mentions.flatMap(channelMentionFromInboundMention),
  );
}

export function mentionsBot(
  mentions: readonly InboundMention[],
  identity: FeishuBotIdentity | undefined,
): boolean {
  if (identity === undefined) {
    return false;
  }
  return mentions.some(
    (mention) =>
      (identity.openId !== undefined && mention.openId === identity.openId) ||
      (identity.userId !== undefined && mention.userId === identity.userId) ||
      (identity.unionId !== undefined && mention.unionId === identity.unionId),
  );
}

export function textStartsWithConfiguredAlias(
  text: string,
  aliases: readonly string[],
): boolean {
  return textStartsWithLeadingAlias(text, aliases);
}

export function formatFeishuAtTag(userId: string): string {
  return `<at user_id="${escapeFeishuAtAttribute(userId)}"></at>`;
}

export function wrapContentWithFeishuMentions(
  content: string,
  mention:
    | {
        readonly requesterUserId?: string;
        readonly ccSenderUserIds?: readonly string[];
      }
    | undefined,
): string {
  const sanitizedContent = sanitizeRawFeishuAtTags(content);
  if (mention === undefined) {
    return sanitizedContent;
  }

  const requesterPrefix = mention.requesterUserId
    ? `${formatFeishuAtTag(mention.requesterUserId)} `
    : "";
  const ccSenderUserIds = mention.ccSenderUserIds ?? [];
  const ccSuffix =
    ccSenderUserIds.length > 0
      ? `\n\ncc ${ccSenderUserIds.map(formatFeishuAtTag).join(" ")}`
      : "";
  return `${requesterPrefix}${sanitizedContent}${ccSuffix}`;
}

function sanitizeRawFeishuAtTags(content: string): string {
  return content.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, (tag) =>
    escapeFeishuText(tag),
  );
}

function escapeFeishuText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeFeishuAtAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function channelMentionFromInboundMention(
  mention: InboundMention,
): readonly ChannelMention[] {
  if (mention.key.length === 0) {
    return [];
  }
  const externalId = mention.openId ?? mention.userId ?? mention.unionId ?? mention.key;
  const providerIds = compactStringRecord({
    open_id: mention.openId,
    user_id: mention.userId,
    union_id: mention.unionId,
    tenant_key: mention.tenantKey,
  });
  return [
    {
      key: mention.key,
      label: toMentionLabel(mention.name, externalId),
      target: {
        externalId,
        kind: mention.mentionedType === "bot" ? "bot" : "user",
        ...(providerIds !== undefined ? { providerIds } : {}),
      },
    },
  ];
}

function compactStringRecord(
  input: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const entries = Object.entries(input).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && entry[1].length > 0,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
