import { feishuIdentityMetadata, type FeishuIdentityScope } from "@/identity/feishu-identity-scopes";
import type {
  ChannelIdentity,
  ChannelIdentityKind,
  ChannelSurface,
  ChannelSurfaceKind,
} from "@/channels/types";

import type { FeishuMentionEventItem } from "./mentions";
import { toMentionLabel } from "./feishu-mention-renderer";

export interface FeishuSenderIdentityInput {
  readonly sender_id?: {
    readonly app_id?: string;
    readonly union_id?: string;
    readonly user_id?: string;
    readonly open_id?: string;
  };
  readonly sender_type?: string;
  readonly tenant_key?: string;
  readonly name?: string;
  readonly display_name?: string;
  readonly nickname?: string;
  readonly avatar_url?: string;
  readonly avatar?: Record<string, unknown>;
}

export interface FeishuBotStableIdentity {
  readonly externalId?: string;
  readonly kind?: ChannelIdentityKind;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly providerIds?: Record<string, string>;
}

export function resolveFeishuSenderIdentity(input: {
  readonly identityScope: FeishuIdentityScope;
  readonly sender: FeishuSenderIdentityInput | undefined;
  readonly messageId: string;
}): ChannelIdentity {
  const sender = input.sender;
  const ids = sender?.sender_id;
  const externalId =
    nonEmptyString(ids?.open_id) ??
    nonEmptyString(ids?.user_id) ??
    nonEmptyString(ids?.union_id) ??
    nonEmptyString(ids?.app_id);
  if (externalId === undefined) {
    throw new Error(
      `Message ${input.messageId}: Feishu sender is missing stable id`,
    );
  }
  const providerIds = compactStringRecord({
    open_id: ids?.open_id,
    user_id: ids?.user_id,
    union_id: ids?.union_id,
    app_id: ids?.app_id,
    tenant_key: sender?.tenant_key,
  });
  const displayName = senderDisplayName(sender);
  const avatarUrl = senderAvatarUrl(sender);
  return {
    externalId,
    kind: sender?.sender_type === "bot" || sender?.sender_type === "app"
      ? "bot"
      : "user",
    ...(displayName !== undefined ? { displayName } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(providerIds !== undefined ? { providerIds } : {}),
    ...feishuIdentityMetadata({...input.identityScope, ...(providerIds?.tenant_key ? {tenantKey: providerIds.tenant_key} : {})}, providerIds ?? {}),
    rawProfile: sender,
  };
}

export function resolveFeishuSurface(input: {
  readonly chatId: string;
  readonly chatType?: string;
  readonly tenantKey?: string;
}): ChannelSurface {
  const providerIds = compactStringRecord({ tenant_key: input.tenantKey });
  return {
    externalId: input.chatId,
    kind: feishuSurfaceKind(input.chatType),
    ...(providerIds !== undefined ? { providerIds } : {}),
    rawProfile: {
      chat_id: input.chatId,
      ...(input.chatType !== undefined ? { chat_type: input.chatType } : {}),
      ...(input.tenantKey !== undefined ? { tenant_key: input.tenantKey } : {}),
    },
  };
}

export function resolveFeishuMentionTarget(input: {
  readonly identityScope: FeishuIdentityScope;
  readonly mention: FeishuMentionEventItem;
  readonly botIdentity?: FeishuBotStableIdentity;
}): ChannelIdentity {
  const ids = input.mention.id;
  const externalId =
    nonEmptyString(ids.open_id) ??
    nonEmptyString(ids.user_id) ??
    nonEmptyString(ids.union_id) ??
    input.mention.key;
  const providerIds = compactStringRecord({
    open_id: ids.open_id,
    user_id: ids.user_id,
    union_id: ids.union_id,
    tenant_key: input.mention.tenant_key,
  });
  const isBot = isFeishuBotStableIdMatch({
    externalId,
    ...(providerIds !== undefined ? { providerIds } : {}),
    ...(input.botIdentity !== undefined ? { botIdentity: input.botIdentity } : {}),
  });
  const kind = isBot ? "bot" : "user";
  const displayName = displayNameFromMention(input.mention);
  return {
    externalId,
    kind,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(isBot && input.botIdentity?.avatarUrl !== undefined
      ? { avatarUrl: input.botIdentity.avatarUrl }
      : {}),
    ...(providerIds !== undefined ? { providerIds } : {}),
    ...feishuIdentityMetadata({...input.identityScope, ...(providerIds?.tenant_key ? {tenantKey: providerIds.tenant_key} : {})}, providerIds ?? {}),
    rawProfile: input.mention,
  };
}

export function feishuMentionLabel(mention: FeishuMentionEventItem): string {
  const externalId =
    nonEmptyString(mention.id.open_id) ??
    nonEmptyString(mention.id.user_id) ??
    nonEmptyString(mention.id.union_id) ??
    mention.key;
  return toMentionLabel(mention.name, externalId);
}

export function isFeishuBotStableIdMatch(input: {
  readonly externalId: string;
  readonly providerIds?: Record<string, string>;
  readonly botIdentity?: FeishuBotStableIdentity;
}): boolean {
  const botIdentity = input.botIdentity;
  if (botIdentity === undefined) {
    return false;
  }
  const botIds = new Set(
    [
      botIdentity.externalId,
      botIdentity.providerIds?.open_id,
      botIdentity.providerIds?.user_id,
      botIdentity.providerIds?.union_id,
    ].filter((value): value is string => nonEmptyString(value) !== undefined),
  );
  if (botIds.size === 0) {
    return false;
  }
  return (
    botIds.has(input.externalId) ||
    Object.values(input.providerIds ?? {}).some((value) => botIds.has(value))
  );
}

function feishuSurfaceKind(chatType: string | undefined): ChannelSurfaceKind {
  if (chatType === "group" || chatType === "p2p") {
    return chatType;
  }
  return "unknown";
}

function displayNameFromMention(
  mention: FeishuMentionEventItem,
): string | undefined {
  const name = mention.name?.trim();
  return name === undefined || name.length === 0 ? undefined : name;
}

function senderDisplayName(
  sender: FeishuSenderIdentityInput | undefined,
): string | undefined {
  return nonEmptyString(sender?.display_name) ??
    nonEmptyString(sender?.name) ??
    nonEmptyString(sender?.nickname);
}

function senderAvatarUrl(
  sender: FeishuSenderIdentityInput | undefined,
): string | undefined {
  const avatar = sender?.avatar;
  return nonEmptyString(sender?.avatar_url) ??
    nonEmptyString(typeof avatar?.avatar_72 === "string" ? avatar.avatar_72 : undefined) ??
    nonEmptyString(typeof avatar?.avatar_240 === "string" ? avatar.avatar_240 : undefined) ??
    nonEmptyString(
      typeof avatar?.avatar_origin === "string" ? avatar.avatar_origin : undefined,
    );
}

function compactStringRecord(
  input: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const entries = Object.entries(input).filter(
    (entry): entry is [string, string] => nonEmptyString(entry[1]) !== undefined,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
