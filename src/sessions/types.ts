import type {
  ChannelIdentity,
  ChannelMention,
  ChannelRef,
  ChannelSurface,
  NormalizedInboundMessage,
} from "../channels/types";

/**
 * Represents Session Channel Type values used by session persistence.
 */
export type SessionChannelType = string;

/**
 * Represents Session Message Role values used by session persistence.
 */
export type SessionMessageRole = "user" | "assistant";

/**
 * Represents persisted message visibility/kind values.
 */
export type SessionMessageKind = "user_message" | "assistant_message" | "internal";

export type MessageIngestMode = "realtime" | "history_backfill";

export interface MessageIngestMetadata {
  readonly mode: MessageIngestMode;
  readonly source: "channel_inbound" | "group_join_backfill";
  readonly importedAt?: number;
  readonly joinEventId?: string;
}

export type MessageContentKind =
  | "text"
  | "rich_text"
  | "image"
  | "file"
  | "mixed"
  | "card"
  | "unknown";

export type MessagePresentationKind =
  | "plain"
  | "rich_markdown"
  | "image_gallery"
  | "file_attachment"
  | "status_card"
  | "task_result_card"
  | "provider_rich_card"
  | "unknown";

/**
 * Describes the Text Message Content contract used by session persistence.
 */
export interface TextMessageContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageMessageContent {
  readonly type: "image";
  readonly fileId?: string;
  readonly url?: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly source?: unknown;
}

export interface FileMessageContent {
  readonly type: "file";
  readonly fileId?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly source?: unknown;
}

export interface LinkMessageContent {
  readonly type: "link";
  readonly url: string;
  readonly text?: string;
  readonly title?: string;
}

export interface MentionMessageContent {
  readonly type: "mention";
  readonly key: string;
  readonly label: string;
  readonly targetIdentityId?: string;
  readonly targetExternalId?: string;
  readonly targetKind?: string;
}

export interface CardMessageContent {
  readonly type: "card";
  readonly cardKind?: string;
  readonly presentationKind?: MessagePresentationKind;
  readonly title?: string;
  readonly text?: string;
  readonly payload?: unknown;
}

export type MessageContentBlock =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent
  | LinkMessageContent
  | MentionMessageContent
  | CardMessageContent;

/**
 * Represents Session Message Content values used by session persistence.
 */
export type SessionMessageContent = MessageContentBlock;

export interface NormalizedMessageContent {
  readonly text: string;
}

export type InboundChatType = "p2p" | "group" | "unknown";


export interface ChannelUserProfileSnapshot {
  readonly externalUserId?: string;
  readonly userType?: string;
  readonly appId?: string;
  readonly openId?: string;
  readonly userId?: string;
  readonly unionId?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly tenantKey?: string;
  readonly rawProfile?: unknown;
}

export interface ChannelChatProfileSnapshot {
  readonly externalChatId?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly chatType?: string;
  readonly avatarUrl?: string;
  readonly tenantKey?: string;
  readonly rawProfile?: unknown;
}

export interface InboundMention {
  readonly key: string;
  readonly name?: string;
  readonly openId?: string;
  readonly userId?: string;
  readonly unionId?: string;
  readonly tenantKey?: string;
  readonly mentionedType?: string;
}

export interface InboundAddressing {
  readonly addressedToBot: boolean;
  readonly reason:
    | "p2p"
    | "mention"
    | "reply_to_bot"
    | "alias"
    | "activation_followup"
    | "silent_group";
}

/**
 * Describes the Inbound Channel Message contract used by session persistence.
 */
export interface InboundChannelMessage {
  readonly id: string;
  readonly channelType: SessionChannelType;
  readonly channelId: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly parentMessageId?: string;
  readonly senderUserId: string;
  readonly text: string;
  readonly chatType?: InboundChatType;
  readonly mentions?: readonly InboundMention[] | undefined;
  readonly addressing?: InboundAddressing;
  readonly senderProfile?: ChannelUserProfileSnapshot;
  readonly chatProfile?: ChannelChatProfileSnapshot;
  readonly rawPayload?: unknown;
}

/**
 * Input contract for persistence resolve session surface operations in session.
 */
export interface ResolveSessionSurfaceInput {
  readonly channelType: SessionChannelType;
  readonly channelId: string;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly parentMessageId?: string;
  readonly createThreadLaunchContext?: boolean;
  readonly kind?: "main" | "work";
}

/**
 * Input contract for persistence append message operations in session.
 */
export interface AppendMessageInput {
  readonly sessionId: string;
  readonly channelMessageKey?: string;
  readonly senderUserId?: string;
  readonly role: SessionMessageRole;
  readonly messageKind?: SessionMessageKind;
  readonly content: NormalizedMessageContent | readonly SessionMessageContent[];
  readonly ingestMetadata?: MessageIngestMetadata;
  readonly channel?: ChannelRef;
  readonly surface?: ChannelSurface;
  readonly sender?: ChannelIdentity;
  readonly relatedIdentities?: readonly ChannelIdentity[];
  readonly rawPayload?: unknown;
  readonly mentions?: readonly ChannelMention[] | undefined;
  readonly inbound?: NormalizedInboundMessage;
  readonly contentKind?: MessageContentKind;
  readonly presentationKind?: MessagePresentationKind;
  readonly providerMessageType?: string | null;
  readonly createdAt?: number;
}
