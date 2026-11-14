import type { FeishuIdentityScope } from "@/identity/feishu-identity-scopes";
import type { ChannelRef, NormalizedInboundMessage } from "@/channels/types";
import { ChannelBindingGuard } from "@/channels/channel-binding-guard";
import { normalizedRootMessageExternalId } from "@/channels/normalized-inbound";
import type { DrizzleDB } from "@/data";
import { ChannelMessageMarkerStore } from "@/messaging/channel-message-marker-store";
import { SessionStore } from "@/sessions/session-store";
import { createLogger, type Logger } from "@/shared";

import {
  computeFeishuAddressing,
  createFeishuNormalizer,
} from "../../extensions/channels/feishu/messaging/feishu-normalizer";
import { extractFeishuInteractiveMarkdown } from "../../extensions/channels/feishu/messaging/interactive-card-content";
import {
  resolveFeishuSenderIdentity,
  resolveFeishuSurface,
} from "../../extensions/channels/feishu/messaging/feishu-identity-resolver";
import type {
  FeishuHistoryMessageMentionRecord,
  FeishuHistoryMessageRecord,
} from "../../extensions/channels/feishu/messaging/types";

import { appendBackfillMessage } from "./group-join-backfill-persistence";

const GROUP_JOIN_BACKFILL_MARKER_TYPE = "group_join_backfill";
const DEFAULT_HISTORY_PAGE_SIZE = 30;
const logger = createLogger("group-join-backfill");

export interface GroupJoinBackfillEvent {
  readonly eventId: string;
  readonly channelId: string;
  readonly channelType: "feishu";
  readonly chatId: string;
  readonly tenantKey?: string;
  readonly operatorOpenId?: string;
  readonly occurredAt: number;
}

export class GroupJoinBackfillService {
  constructor(
    private readonly _options: {
      readonly db: DrizzleDB;
      readonly identityScope: FeishuIdentityScope;
      readonly historyPageSize?: number;
      readonly listChatHistory?: (input: {
        readonly chatId: string;
        readonly pageSize: number;
      }) => Promise<{
        readonly items: readonly FeishuHistoryMessageRecord[];
        readonly hasMore: boolean;
      }>;
      readonly listThreadHistory?: (input: {
        readonly threadId: string;
        readonly pageSize: number;
      }) => Promise<{
        readonly items: readonly FeishuHistoryMessageRecord[];
        readonly hasMore: boolean;
      }>;
      readonly enrichMessage?: (input: {
        readonly event: GroupJoinBackfillEvent;
        readonly historyMessage: FeishuHistoryMessageRecord;
        readonly normalizedMessage: NormalizedInboundMessage;
      }) => Promise<NormalizedInboundMessage>;
      readonly appendBackfill?: typeof appendBackfillMessage;
      readonly now?: () => number;
      readonly logger?: Logger;
    },
  ) {}

  async backfillOnBotAddedToGroup(input: GroupJoinBackfillEvent): Promise<{
    importedCount: number;
    skippedCount: number;
  }> {
    const binding = new ChannelBindingGuard(this._options.db, {id: input.channelId, type: input.channelType});
    if (this._alreadyProcessed(input)) {
      this._logger.info(
        {
          channel_id: input.channelId,
          chat_id: input.chatId,
          event_id: input.eventId,
        },
        "Skipping Feishu group join backfill for already-processed event",
      );
      return { importedCount: 0, skippedCount: 0 };
    }

    const sessionStore = new SessionStore(this._options.db);
    const rootSession = sessionStore.resolveByChannelSurface({
      channelType: input.channelType,
      channelId: input.channelId,
      groupId: input.chatId,
    });
    const pageSize = this._options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
    this._logger.info(
      {
        channel_id: input.channelId,
        chat_id: input.chatId,
        event_id: input.eventId,
        session_id: rootSession.id,
        page_size: pageSize,
      },
      "Starting Feishu group join history backfill",
    );
    const history = await this._listHistory({
      chatId: input.chatId,
      pageSize,
    });
    binding.assertCurrent();
    this._logger.info(
      {
        channel_id: input.channelId,
        chat_id: input.chatId,
        event_id: input.eventId,
        session_id: rootSession.id,
        fetched_count: history.items.length,
        has_more: history.hasMore,
      },
      "Fetched Feishu group history for backfill",
    );
    const importedAt = (this._options.now ?? Date.now)();

    let importedCount = 0;
    let skippedCount = 0;
    const importedThreadIds = new Set<string>();
    for (const item of [...history.items].reverse()) {
      const normalized = normalizeFeishuHistoryMessage({
        identityScope: this._options.identityScope,
        channel: { type: input.channelType, id: input.channelId },
        event: item,
      });
      if (normalized === null) {
        skippedCount += 1;
        continue;
      }
      if (normalized.thread?.externalId !== undefined) {
        importedThreadIds.add(normalized.thread.externalId);
        continue;
      }
      const enriched = this._options.enrichMessage === undefined
        ? normalized
        : await this._options.enrichMessage({
            event: input,
            historyMessage: item,
            normalizedMessage: normalized,
          });
      binding.assertCurrent(enriched.channel);
      const targetSession = resolveBackfillSession({
        sessionStore,
        event: input,
        message: enriched,
        rootSessionId: rootSession.id,
      });
      const result = (this._options.appendBackfill ?? appendBackfillMessage)({
        db: this._options.db,
        sessionId: targetSession.id,
        message: enriched,
        joinEventId: input.eventId,
        importedAt,
        occurredAt: parseTimestamp(item.create_time) ?? input.occurredAt,
      });
      if (result.created) {
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }

    for (const threadId of importedThreadIds) {
      binding.assertCurrent();
      const threadHistory = await this._listThreadHistory({
        threadId,
        pageSize,
      });
      binding.assertCurrent();
      for (const item of [...threadHistory.items].reverse()) {
        const normalized = normalizeFeishuHistoryMessage({
        identityScope: this._options.identityScope,
          channel: { type: input.channelType, id: input.channelId },
          event: item,
        });
        if (normalized === null) {
          skippedCount += 1;
          continue;
        }
        const enriched = this._options.enrichMessage === undefined
          ? normalized
          : await this._options.enrichMessage({
              event: input,
              historyMessage: item,
              normalizedMessage: normalized,
            });
        binding.assertCurrent(enriched.channel);
        const targetSession = resolveBackfillSession({
          sessionStore,
          event: input,
          message: enriched,
          rootSessionId: rootSession.id,
        });
        const result = (this._options.appendBackfill ?? appendBackfillMessage)({
          db: this._options.db,
          sessionId: targetSession.id,
          message: enriched,
          joinEventId: input.eventId,
          importedAt,
          occurredAt: parseTimestamp(item.create_time) ?? input.occurredAt,
        });
        if (result.created) {
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
    }

    this._recordProcessed(input);
    this._logger.info(
      {
        channel_id: input.channelId,
        chat_id: input.chatId,
        event_id: input.eventId,
        session_id: rootSession.id,
        imported_count: importedCount,
        skipped_count: skippedCount,
        fetched_count: history.items.length,
        has_more: history.hasMore,
      },
      "Completed Feishu group join history backfill",
    );
    return { importedCount, skippedCount };
  }

  private _alreadyProcessed(input: GroupJoinBackfillEvent): boolean {
    const marker = new ChannelMessageMarkerStore(this._options.db).find({
      channelType: input.channelType,
      channelId: input.channelId,
      messageId: input.chatId,
      markerType: GROUP_JOIN_BACKFILL_MARKER_TYPE,
    });
    return marker?.providerMarkerId === input.eventId;
  }

  private _recordProcessed(input: GroupJoinBackfillEvent): void {
    new ChannelMessageMarkerStore(this._options.db).upsert({
      channelType: input.channelType,
      channelId: input.channelId,
      messageId: input.chatId,
      markerType: GROUP_JOIN_BACKFILL_MARKER_TYPE,
      providerMarkerId: input.eventId,
      providerPayloadJson: {
        occurredAt: input.occurredAt,
        ...(input.operatorOpenId !== undefined
          ? { operatorOpenId: input.operatorOpenId }
          : {}),
        ...(input.tenantKey !== undefined ? { tenantKey: input.tenantKey } : {}),
      },
    });
  }

  private async _listHistory(input: {
    readonly chatId: string;
    readonly pageSize: number;
  }): Promise<{
    readonly items: readonly FeishuHistoryMessageRecord[];
    readonly hasMore: boolean;
  }> {
    if (this._options.listChatHistory === undefined) {
      throw new Error("GroupJoinBackfillService requires listChatHistory");
    }
    return this._options.listChatHistory(input);
  }

  private async _listThreadHistory(input: {
    readonly threadId: string;
    readonly pageSize: number;
  }): Promise<{
    readonly items: readonly FeishuHistoryMessageRecord[];
    readonly hasMore: boolean;
  }> {
    if (this._options.listThreadHistory === undefined) {
      return { items: [], hasMore: false };
    }
    return this._options.listThreadHistory(input);
  }

  private get _logger(): Logger {
    return this._options.logger ?? logger;
  }
}

function resolveBackfillSession(input: {
  readonly sessionStore: SessionStore;
  readonly event: GroupJoinBackfillEvent;
  readonly message: NormalizedInboundMessage;
  readonly rootSessionId: string;
}) {
  if (input.message.thread?.externalId === undefined) {
    return input.sessionStore.getById(input.rootSessionId) ??
      input.sessionStore.resolveByChannelSurface({
        channelType: input.event.channelType,
        channelId: input.event.channelId,
        groupId: input.event.chatId,
      });
  }

  const rootMessageId = normalizedRootMessageExternalId(input.message);
  return input.sessionStore.resolveByChannelSurface({
    channelType: input.event.channelType,
    channelId: input.event.channelId,
    groupId: input.event.chatId,
    threadId: input.message.thread.externalId,
    ...(rootMessageId !== undefined ? { rootMessageId } : {}),
    ...(input.message.thread.parentMessageExternalId !== undefined
      ? { parentMessageId: input.message.thread.parentMessageExternalId }
      : {}),
  });
}

export function normalizeFeishuHistoryMessage(input: {
  readonly channel: ChannelRef;
    readonly identityScope: FeishuIdentityScope;
  readonly event: FeishuHistoryMessageRecord;
}): NormalizedInboundMessage | null {
  if (
    input.event.deleted === true ||
    !isNonEmptyString(input.event.message_id) ||
    !isNonEmptyString(input.event.chat_id) ||
    !isNonEmptyString(input.event.body?.content) ||
    !isNonEmptyString(input.event.sender?.id) ||
    !isSupportedHistorySenderType(input.event.sender?.sender_type)
  ) {
    return null;
  }

  const senderId = feishuIdRecord(input.event.sender.id, input.event.sender.id_type);
  if (senderId === null) {
    return null;
  }

  try {
    if (input.event.msg_type === "text") {
      return normalizeFeishuHistoryTextMessage(input, senderId);
    }
    if (input.event.msg_type === "interactive") {
      return normalizeFeishuHistoryInteractiveMessage(input, senderId);
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeFeishuHistoryTextMessage(
  input: {
    readonly channel: ChannelRef;
    readonly identityScope: FeishuIdentityScope;
    readonly event: FeishuHistoryMessageRecord;
  },
  senderId: {
    readonly union_id?: string;
    readonly user_id?: string;
    readonly open_id?: string;
    readonly app_id?: string;
  },
): NormalizedInboundMessage {
  return createFeishuNormalizer({
    identityScope: input.identityScope,
    channel: input.channel,
    }).normalizeMessageEvent({
      message_id: input.event.message_id!,
      ...(historyRootMessageId(input.event) !== undefined
        ? { root_id: historyRootMessageId(input.event)! }
        : {}),
      ...(isNonEmptyString(input.event.parent_id)
        ? { parent_id: input.event.parent_id }
      : {}),
      ...(isNonEmptyString(input.event.thread_id)
        ? { thread_id: input.event.thread_id }
        : {}),
      ...(isNonEmptyString(input.event.upper_message_id)
        ? { upper_message_id: input.event.upper_message_id }
        : {}),
      ...(isNonEmptyString(input.event.message_position)
        ? { message_position: input.event.message_position }
        : {}),
      ...(isNonEmptyString(input.event.thread_message_position)
        ? { thread_message_position: input.event.thread_message_position }
        : {}),
      chat_id: input.event.chat_id!,
      chat_type: "group",
      ...(isNonEmptyString(input.event.msg_type)
        ? { message_type: input.event.msg_type }
        : {}),
      content: input.event.body!.content!,
      sender: {
      sender_id: senderId,
      ...(isNonEmptyString(input.event.sender!.sender_type)
        ? { sender_type: input.event.sender!.sender_type }
        : {}),
      ...(isNonEmptyString(input.event.sender!.tenant_key)
        ? { tenant_key: input.event.sender!.tenant_key }
        : {}),
      ...(isNonEmptyString(input.event.sender!.sender_name)
        ? {
            name: input.event.sender!.sender_name,
            display_name: input.event.sender!.sender_name,
          }
        : {}),
    },
      mentions: (input.event.mentions ?? [])
      .map(historyMentionToEventMention)
      .filter((mention): mention is NonNullable<typeof mention> => mention !== null),
  });
}

function normalizeFeishuHistoryInteractiveMessage(
  input: {
    readonly channel: ChannelRef;
    readonly identityScope: FeishuIdentityScope;
    readonly event: FeishuHistoryMessageRecord;
  },
  senderId: {
    readonly union_id?: string;
    readonly user_id?: string;
    readonly open_id?: string;
    readonly app_id?: string;
  },
): NormalizedInboundMessage | null {
  const text = extractFeishuInteractiveMarkdown(input.event.body?.content);
  if (!isNonEmptyString(text)) {
    return null;
  }
  const sender = resolveFeishuSenderIdentity({
    identityScope: input.identityScope,
    sender: {
      sender_id: senderId,
      ...(isNonEmptyString(input.event.sender?.sender_type)
        ? { sender_type: input.event.sender?.sender_type }
        : {}),
      ...(isNonEmptyString(input.event.sender?.tenant_key)
        ? { tenant_key: input.event.sender?.tenant_key }
        : {}),
      ...(isNonEmptyString(input.event.sender?.sender_name)
        ? {
            name: input.event.sender?.sender_name,
            display_name: input.event.sender?.sender_name,
          }
        : {}),
    },
    messageId: input.event.message_id!,
  });
  const surface = resolveFeishuSurface({
    chatId: input.event.chat_id!,
    chatType: "group",
    ...(isNonEmptyString(input.event.sender?.tenant_key)
      ? { tenantKey: input.event.sender?.tenant_key }
      : {}),
  });
  return {
    id: input.event.message_id!,
    channel: input.channel,
    surface,
    ...(isNonEmptyString(input.event.thread_id)
      ? {
          thread: {
            externalId: input.event.thread_id,
            ...(historyRootMessageId(input.event) !== undefined
              ? { rootMessageExternalId: historyRootMessageId(input.event)! }
              : {}),
            ...(isNonEmptyString(input.event.parent_id)
              ? { parentMessageExternalId: input.event.parent_id }
              : {}),
          },
        }
      : isNonEmptyString(input.event.root_id) || isNonEmptyString(input.event.parent_id)
        ? {
            thread: {
              externalId: input.event.root_id ?? input.event.parent_id!,
              ...(isNonEmptyString(input.event.root_id)
                ? { rootMessageExternalId: input.event.root_id }
                : {}),
              ...(isNonEmptyString(input.event.parent_id)
                ? { parentMessageExternalId: input.event.parent_id }
                : {}),
            },
          }
        : {}),
    sender,
    text,
    mentions: [],
    addressing: computeFeishuAddressing({
      mentions: [],
      rawText: text,
      surfaceKind: surface.kind,
      groupBotAliases: [],
    }),
    contentKind: "card",
    presentationKind: "provider_rich_card",
    providerMessageType: "interactive",
    presentation: {
      kind: "rich_markdown_card",
    },
    rawPayload: {
      message_id: input.event.message_id,
      ...(historyRootMessageId(input.event) !== undefined
        ? { root_id: historyRootMessageId(input.event)! }
        : {}),
      ...(isNonEmptyString(input.event.parent_id)
        ? { parent_id: input.event.parent_id }
        : {}),
      ...(isNonEmptyString(input.event.thread_id)
        ? { thread_id: input.event.thread_id }
        : {}),
      ...(isNonEmptyString(input.event.upper_message_id)
        ? { upper_message_id: input.event.upper_message_id }
        : {}),
      ...(isNonEmptyString(input.event.message_position)
        ? { message_position: input.event.message_position }
        : {}),
      ...(isNonEmptyString(input.event.thread_message_position)
        ? { thread_message_position: input.event.thread_message_position }
        : {}),
      chat_id: input.event.chat_id,
      chat_type: "group",
      message_type: input.event.msg_type,
      content: input.event.body?.content,
      sender: {
        sender_id: senderId,
        sender_type: input.event.sender?.sender_type,
        ...(isNonEmptyString(input.event.sender?.tenant_key)
          ? { tenant_key: input.event.sender?.tenant_key }
          : {}),
      },
      mentions: [],
    },
  };
}

function historyRootMessageId(
  event: FeishuHistoryMessageRecord,
): string | undefined {
  if (isNonEmptyString(event.root_id)) {
    return event.root_id;
  }
  if (
    isNonEmptyString(event.thread_id) &&
    event.thread_message_position === "-1" &&
    isNonEmptyString(event.message_id)
  ) {
    return event.message_id;
  }
  return undefined;
}

function historyMentionToEventMention(
  mention: FeishuHistoryMessageMentionRecord,
):
  | {
      readonly key: string;
      readonly id: {
        readonly union_id?: string;
        readonly user_id?: string;
        readonly open_id?: string;
      };
      readonly name?: string;
      readonly tenant_key?: string;
    }
  | null {
  if (!isNonEmptyString(mention.key) || !isNonEmptyString(mention.id)) {
    return null;
  }
  const mappedId = feishuIdRecord(mention.id, mention.id_type);
  if (mappedId === null) {
    return null;
  }
  return {
    key: mention.key,
    id: mappedId,
    ...(isNonEmptyString(mention.name) ? { name: mention.name } : {}),
    ...(isNonEmptyString(mention.tenant_key)
      ? { tenant_key: mention.tenant_key }
      : {}),
  };
}

function feishuIdRecord(
  id: string,
  idType: string | undefined,
):
  | {
      readonly union_id?: string;
      readonly user_id?: string;
      readonly open_id?: string;
      readonly app_id?: string;
    }
  | null {
  switch (idType) {
    case "open_id":
      return { open_id: id };
    case "user_id":
      return { user_id: id };
    case "union_id":
      return { union_id: id };
    case "app_id":
      return { app_id: id };
    default:
      return null;
  }
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSupportedHistorySenderType(
  value: string | undefined,
): value is "user" | "bot" | "app" {
  return value === "user" || value === "bot" || value === "app";
}
