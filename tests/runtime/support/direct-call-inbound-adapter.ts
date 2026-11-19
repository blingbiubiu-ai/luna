import { feishuIdentityMetadata, type FeishuIdentityScope } from "@/identity/feishu-identity-scopes";
import type {
  ChannelIdentity,
  ChannelMention,
  NormalizedInboundMessage,
} from "@/channels";
import type { InboundChannelMessage } from "@/sessions/types";

/**
 * Direct-call test adapter only.
 *
 * Primary channel ingress, SessionInboundRouter, Main Runner, and TaskEngine contracts use
 * NormalizedInboundMessage. This adapter keeps test fixtures isolated while
 * normalizing InboundChannelMessage inputs at the edge.
 */
export function normalizedInboundFromDirectCallForTest(
  message: InboundChannelMessage,
  identityScope: FeishuIdentityScope = {environment: message.channelType === "lark" ? "lark" : "feishu", appId: `test:${message.channelId}`},
): NormalizedInboundMessage {
  const channel = {
    type: message.channelType,
    id: message.channelId,
  };
  const mentions = (message.mentions ?? []).flatMap((mention) =>
    channelMentionFromDirectCall(channel.type, mention, identityScope),
  );
  const surfaceKind = directCallSurfaceKind(message);
  const senderProviderIds = compactStringRecord({
    open_id:
      message.senderProfile?.openId ??
      providerScopedSenderId(channel.type, message.senderUserId),
    user_id: message.senderProfile?.userId,
    union_id: message.senderProfile?.unionId,
    tenant_key: message.senderProfile?.tenantKey,
  });
  return {
    id: message.id,
    channel,
    surface: {
      externalId:
        message.chatProfile?.externalChatId ?? message.groupId ?? message.channelId,
      kind: surfaceKind,
      ...(message.chatProfile?.displayName ?? message.chatProfile?.name
        ? {
            displayName:
              message.chatProfile?.displayName ?? message.chatProfile?.name,
          }
        : {}),
      ...(message.chatProfile?.avatarUrl !== undefined
        ? { avatarUrl: message.chatProfile.avatarUrl }
        : {}),
      ...optionalRecord(
        "providerIds",
        compactStringRecord({ tenant_key: message.chatProfile?.tenantKey }),
      ),
      ...optionalRecord(
        "rawProfile",
        message.chatProfile?.rawProfile ?? message.chatProfile,
      ),
    },
    ...(message.threadId !== undefined
      ? {
          thread: {
            externalId: message.threadId,
            ...(message.rootMessageId !== undefined
              ? { rootMessageExternalId: message.rootMessageId }
              : {}),
            ...(message.parentMessageId !== undefined
              ? { parentMessageExternalId: message.parentMessageId }
              : {}),
          },
        }
      : {}),
    sender: {
      externalId: message.senderProfile?.externalUserId ?? message.senderUserId,
      kind: normalizedIdentityKind(message.senderProfile?.userType),
      ...(message.senderProfile?.displayName ?? message.senderProfile?.name
        ? {
            displayName:
              message.senderProfile?.displayName ?? message.senderProfile?.name,
          }
        : {}),
      ...(message.senderProfile?.avatarUrl !== undefined
        ? { avatarUrl: message.senderProfile.avatarUrl }
        : {}),
      ...optionalRecord("providerIds", senderProviderIds),
      ...channelIdentityMetadataForDirectCall(channel.type, senderProviderIds, identityScope),
      ...optionalRecord(
        "rawProfile",
        message.senderProfile?.rawProfile ?? message.senderProfile,
      ),
    },
    text: message.text,
    mentions,
    addressing:
      message.addressing ??
      (surfaceKind === "group"
        ? { addressedToBot: true, reason: "mention" }
        : { addressedToBot: true, reason: "p2p" }),
    rawPayload: message.rawPayload ?? message,
  };
}

export function isNormalizedInboundMessage(
  message: unknown,
): message is NormalizedInboundMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "channel" in message &&
    "surface" in message &&
    "sender" in message
  );
}

function directCallSurfaceKind(
  message: InboundChannelMessage,
  identityScope: FeishuIdentityScope = {environment: message.channelType === "lark" ? "lark" : "feishu", appId: `test:${message.channelId}`},
): NormalizedInboundMessage["surface"]["kind"] {
  if (message.chatProfile?.chatType !== undefined) {
    return normalizedSurfaceKind(message.chatProfile.chatType);
  }
  if (message.chatType === "p2p" || message.chatType === "group") {
    return message.chatType;
  }
  return message.groupId !== undefined ? "group" : "unknown";
}

function channelMentionFromDirectCall(
  channelType: string,
  mention: NonNullable<InboundChannelMessage["mentions"]>[number],
  identityScope: FeishuIdentityScope,
): readonly ChannelMention[] {
  const externalId =
    nonEmptyString(mention.openId) ??
    nonEmptyString(mention.userId) ??
    nonEmptyString(mention.unionId);
  if (externalId === undefined) {
    return [];
  }
  const label =
    mention.name === undefined || mention.name.length === 0
      ? mention.key
      : mention.name.startsWith("@")
        ? mention.name
        : `@${mention.name}`;
  const providerIds = compactStringRecord({
    open_id: mention.openId,
    user_id: mention.userId,
    union_id: mention.unionId,
    tenant_key: mention.tenantKey,
  });
  const target: ChannelIdentity = {
    externalId,
    kind:
      mention.mentionedType === "bot"
        ? "bot"
        : mention.mentionedType === "user"
          ? "user"
          : "unknown",
    ...(mention.name !== undefined ? { displayName: mention.name } : {}),
    ...optionalRecord("providerIds", providerIds),
    ...channelIdentityMetadataForDirectCall(channelType, providerIds, identityScope),
    rawProfile: mention,
  };
  return [{ key: mention.key, label, target, rawMention: mention }];
}

function normalizedIdentityKind(
  value: string | undefined,
): NormalizedInboundMessage["sender"]["kind"] {
  return value === "bot" || value === "system" || value === "unknown"
    ? value
    : "user";
}

function normalizedSurfaceKind(
  value: string | undefined,
): NormalizedInboundMessage["surface"]["kind"] {
  return value === "p2p" ||
    value === "group" ||
    value === "channel" ||
    value === "thread" ||
    value === "webhook" ||
    value === "ticket"
    ? value
    : "unknown";
}

function compactStringRecord(
  input: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const entries = Object.entries(input).filter(
    (entry): entry is [string, string] => nonEmptyString(entry[1]) !== undefined,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function optionalRecord<T>(
  key: string,
  value: T | undefined,
): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function providerScopedSenderId(
  channelType: string,
  senderUserId: string,
): string | undefined {
  return channelType === "feishu" || channelType === "lark"
    ? senderUserId
    : undefined;
}

function channelIdentityMetadataForDirectCall(
  channelType: string,
  providerIds: Record<string, string> | undefined,
  identityScope: FeishuIdentityScope,
) {
  if (channelType !== "feishu" && channelType !== "lark") return {};
  return feishuIdentityMetadata({...identityScope, ...(providerIds?.tenant_key ? {tenantKey: providerIds.tenant_key} : {})}, providerIds ?? {});
}
