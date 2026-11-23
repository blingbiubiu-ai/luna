import { scopeFeishuIdentity, type FeishuIdentityScope } from "@/identity/feishu-identity-scopes";
import {OrdinaryProgress} from "./ordinary-progress";
import { NativeTaskProgress } from "./native-task-progress";
import { createHash } from "node:crypto";
import { ProviderDeliveryRejected } from "@/messaging/provider-delivery-error";
import fs from "node:fs";
import nodePath from "node:path";

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import EventEmitter from "eventemitter3";
import { imageSizeFromFile } from "image-size/fromFile";

import type { Logger, TextMessageContent } from "@/shared";
import { parseArtifactRef } from "@luna/service-client/artifact-ref";
import { ArtifactRegistry } from "@/artifacts/artifact-registry";
import type { DrizzleDB } from "@/data";
import { ChannelMessageMarkerStore } from "@/messaging/channel-message-marker-store";
import {
  PlatformSettingsStore,
  resolveArtifactSignedUrlTtlMs,
  resolvePublicBaseUrl,
} from "@/platform/platform-settings-store";
import { signedArtifactPreviewUrl } from "@/server/artifact-content-url";
import type {
  ChannelChatProfileSnapshot,
  MessageContentBlock,
  InboundChatType,
  MessageContentKind,
  MessagePresentationKind,
  ChannelUserProfileSnapshot,
} from "@/sessions/types";
import type {
  ChannelAdapter,
  ChannelAdapterRuntimeStatus,
  ChannelCardAction,
  ChannelCardActionResult,
  ChannelInboundRuntimeStatus,
  ChannelIdentity,
  ChannelMention,
  ChannelSurface,
  NormalizedInboundMessage,
} from "@/channels/types";
import { normalizedRootMessageExternalId } from "@/channels/normalized-inbound";
import {
  config,
  createLogger,
  uuid,
  type AssistantMessage,
  type MessageChannel,
  type MessageChannelEventTypes,
  type UserMessage,
} from "@/shared";
import type { DeliveryTarget, OutboundChannelOperation, ReplyChannel } from "@/channels/outbound";
import { GroupJoinBackfillService, type GroupJoinBackfillEvent } from "@/sessions/inbound/group-join-backfill";

import {
  type FeishuMentionEventItem,
  type FeishuBotIdentity,
  wrapContentWithFeishuMentions,
} from "./mentions";
import { createFeishuNormalizer } from "./feishu-normalizer";
import {
  feishuMentionLabel,
  resolveFeishuMentionTarget,
  resolveFeishuSenderIdentity,
} from "./feishu-identity-resolver";
import { renderFeishuMentions } from "./feishu-mention-renderer";
import { replyMarkdown } from "@luna/runner-protocol/reply";
import { formatFeishuAtTag } from "./mentions";
import { extractFeishuInteractiveMarkdown } from "./interactive-card-content";
import { extractFeishuStructuredCardMarkdown } from "./structured-card-content";
import {
  renderBatchSummaryCard,
  renderTaskResultCard,
  renderStatusCard,
  renderMessageCard,
  splitMarkdownByTables,
} from "./message-renderer";
import type { MessageReceiveEventData } from "./types";
import type {
  FeishuBotAddedToGroupEventData,
  FeishuHistoryMessageRecord,
} from "./types";
import {
  convertPostToMarkdownAndMessageContentBlocks,
} from "./utils";

interface ParsedFeishuMessageContent extends TextMessageContent {
  readonly contentBlocks?: readonly MessageContentBlock[];
  readonly mentions?: readonly ChannelMention[];
  readonly relatedIdentities?: readonly ChannelIdentity[];
  readonly presentation?: NormalizedInboundMessage["presentation"];
  readonly contentKind: MessageContentKind;
  readonly presentationKind: MessagePresentationKind;
  readonly providerMessageType: string;
}

interface FeishuChatHumanMemberSnapshot {
  readonly memberOpenIds: ReadonlySet<string>;
  readonly complete: boolean;
}

function _isFeishuBadRequestError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as {
    status?: number;
    code?: number | string;
    response?: {
      status?: number;
      data?: {
        code?: number | string;
        msg?: string;
      };
    };
  };

  return (
    candidate.status === 400 ||
    candidate.code === 400 ||
    candidate.response?.status === 400 ||
    candidate.response?.data?.code === 400
  );
}

function _isFeishuNoUserAuthorityError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as {
    code?: number | string;
    response?: {
      data?: {
        code?: number | string;
      };
    };
  };

  return (
    candidate.code === 41050 ||
    candidate.code === "41050" ||
    candidate.response?.data?.code === 41050 ||
    candidate.response?.data?.code === "41050"
  );
}

function isTransientFeishuUploadError(err: unknown): boolean {
  const candidate = err as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: { readonly message?: unknown; readonly code?: unknown };
  };
  const details = [
    candidate?.message,
    candidate?.code,
    candidate?.cause?.message,
    candidate?.cause?.code,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET/i
    .test(details);
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function _feishuErrorLogDetails(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object") {
    return { message: String(err) };
  }

  const candidate = err as {
    message?: string;
    status?: number;
    code?: number | string;
    response?: {
      status?: number;
      data?: {
        code?: number | string;
        msg?: string;
        message?: string;
      };
    };
  };
  const status = candidate.response?.status ?? candidate.status;
  const code = candidate.response?.data?.code ?? candidate.code;
  const message = firstString(
    candidate.response?.data?.msg,
    candidate.response?.data?.message,
    candidate.message,
  );
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && value.length > 0
  );
}

function optionalNumber<K extends string>(
  key: K,
  value: unknown,
): Record<K, number> | Record<string, never> {
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as Record<K, number>)
    : {};
}

function maxOptionalNumber(...values: readonly unknown[]): number | undefined {
  const numbers = values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value)
  );
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

function normalizeFeishuInboundState(value: unknown): FeishuInboundConnectionState {
  switch (value) {
    case "idle":
    case "connecting":
    case "connected":
    case "reconnecting":
    case "failed":
      return value;
    default:
      return "unknown";
  }
}

function effectiveFeishuInboundState(
  runtimeState: FeishuInboundConnectionState,
  sdkState: FeishuInboundConnectionState,
): FeishuInboundConnectionState {
  if (runtimeState === "failed" || sdkState === "failed") {
    return "failed";
  }
  if (runtimeState === "reconnecting" || sdkState === "reconnecting") {
    return "reconnecting";
  }
  if (runtimeState === "connecting" || sdkState === "connecting") {
    return "connecting";
  }
  if (runtimeState === "connected" || sdkState === "connected") {
    return "connected";
  }
  if (runtimeState === "idle" || sdkState === "idle") {
    return "idle";
  }
  return "unknown";
}

function withoutInboundError(
  status: ChannelInboundRuntimeStatus,
): ChannelInboundRuntimeStatus {
  const { lastErrorAt: _lastErrorAt, lastError: _lastError, ...rest } = status;
  return rest;
}

function randomFeishuProcessingReactionType(): string {
  const index = Math.floor(
    Math.random() * FEISHU_PROCESSING_REACTION_TYPES.length,
  );
  return FEISHU_PROCESSING_REACTION_TYPES[index] ?? "OneSecond";
}

function botDisplayName(bot: FeishuBotInfo): string | undefined {
  return firstString(bot.app_name, bot.name);
}

/**
 * Executes is Feishu Message Withdrawn Error logic for Feishu message transport.
 */
export function isFeishuMessageWithdrawnError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as {
    response?: {
      data?: {
        code?: number | string;
        msg?: string;
      };
    };
  };

  return (
    candidate.response?.data?.code === 230011 ||
    candidate.response?.data?.msg === "The message was withdrawn."
  );
}

interface FeishuBotInfoResponse {
  readonly bot?: FeishuBotInfo;
  readonly data?: {
    readonly bot?: FeishuBotInfo;
  };
}

interface FeishuBotInfo {
  readonly open_id?: string;
  readonly user_id?: string;
  readonly union_id?: string;
  readonly app_name?: string;
  readonly name?: string;
  readonly avatar_url?: string;
  readonly avatar?: Record<string, unknown>;
}

interface FeishuApplicationInfoResponse {
  readonly app?: FeishuApplicationInfo;
  readonly application?: FeishuApplicationInfo;
  readonly data?: {
    readonly app?: FeishuApplicationInfo;
    readonly application?: FeishuApplicationInfo;
  };
}

interface FeishuApplicationInfo {
  readonly app_id?: string;
  readonly name?: string;
  readonly app_name?: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly avatar_url?: string;
  readonly icon_url?: string;
  readonly logo_url?: string;
  readonly image_url?: string;
  readonly avatar?: Record<string, unknown>;
}

interface FeishuWsConnectionStatus {
  readonly state?: unknown;
  readonly lastConnectTime?: unknown;
  readonly nextConnectTime?: unknown;
  readonly reconnectAttempts?: unknown;
}

type FeishuInboundConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "unknown";

const PROCESSING_MARKER_TYPE = "processing";
const FEISHU_PROCESSING_REACTION_TYPES = [
  "OneSecond",
  "Typing",
  "OnIt",
  "THINKING",
  "StatusFlashOfInspiration",
] as const;

export interface FeishuMessageChannelOptions {
  readonly chatId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly developerId?: string | (() => string | undefined);
  readonly db?: DrizzleDB;
  readonly botOpenId?: string;
  readonly botUserId?: string;
  readonly botUnionId?: string;
  /** Names that address the bot in a group; a function is read for every message, so a changed setting applies at once. */
  readonly groupBotAliases?: readonly string[] | (() => readonly string[]);
}

/** Message channel implementation for Feishu (Lark) chat platform. */
export class FeishuMessageChannel
  extends EventEmitter<MessageChannelEventTypes>
  implements MessageChannel, ChannelAdapter, ReplyChannel
{
  readonly type = "feishu";

  private _inboundClient: WSClient;
  private _client: Client;
  private _failedCardUpdateMessages = new Set<string>();
  private _providerIdempotencyRegistry = new Map<string, OutboundChannelOperation>();
  private _processingReactionIds = new Map<string, string>();
  private _lunaInboundHandler:
    | ((message: NormalizedInboundMessage) => Promise<void>)
    | undefined;
  private _lunaCardActionHandler:
    | ((action: ChannelCardAction) => Promise<ChannelCardActionResult | undefined>)
    | undefined;
  private _resolvedBotIdentity: FeishuBotIdentity | undefined;
  private _userProfileCache = new Map<string, ChannelUserProfileSnapshot | undefined>();
  private _userProfileExpiresAt = new Map<string, number>();
  private _mentionProfileExpiresAt = new Map<string, number>();
  private _chatProfileCache = new Map<string, ChannelChatProfileSnapshot | undefined>();
  private _mentionProfileCache = new Map<string, ChannelUserProfileSnapshot | null>();
  private _chatHumanMemberCache = new Map<
    string,
    Promise<FeishuChatHumanMemberSnapshot | undefined> | FeishuChatHumanMemberSnapshot | undefined
  >();
  private _groupJoinBackfill:
    | Pick<GroupJoinBackfillService, "backfillOnBotAddedToGroup">
    | undefined;
  private _logger: Logger;

  private get _identityScope(): FeishuIdentityScope {
    const developerId = typeof this.config.developerId === "function"
      ? this.config.developerId()
      : this.config.developerId;
    return {
      environment: "feishu",
      appId: this.config.appId,
      ...(developerId ? { developerId } : {}),
    };
  }

  private get _maxVisibleSteps(): number {
    return this.config.db
      ? new PlatformSettingsStore(this.config.db).get().messaging.maxVisibleSteps
      : 32;
  }
  private _inboundRuntimeStatus: ChannelInboundRuntimeStatus = {
    state: "idle",
  };

  /**
   * Create a Feishu message channel.
   * @param config - Feishu app credentials (defaults to env vars).
   */
  constructor(
    readonly id: string,
    readonly config: FeishuMessageChannelOptions,
  ) {
    super();
    this.id = id;
    if (!config.appId || !config.appSecret) {
      throw new Error("Feishu app ID and secret are required");
    }
    this._logger = createLogger("feishu-message-channel");
    this._inboundClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      onReady: () => this._markInboundConnected(),
      onReconnecting: () => this._markInboundReconnecting(),
      onReconnected: () => this._markInboundConnected(),
      onError: (err) => this._markInboundFailed(err),
    });
    this._client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    if (this.config.db !== undefined) {
      this._groupJoinBackfill = new GroupJoinBackfillService({
        identityScope: () => this._identityScope,
        db: this.config.db,
        logger: this._logger,
        historyPageSize: 30,
        listChatHistory: async ({ chatId, pageSize }) => {
          const response = await this._client.im.v1.message.list({
            params: {
              container_id_type: "chat",
              container_id: chatId,
              sort_type: "ByCreateTimeDesc",
              page_size: pageSize,
            },
          });
          return {
            hasMore: response.data?.has_more ?? false,
            items: (response.data?.items ?? []) as FeishuHistoryMessageRecord[],
          };
        },
        listThreadHistory: async ({ threadId, pageSize }) => {
          const response = await this._client.im.v1.message.list({
            params: {
              container_id_type: "thread",
              container_id: threadId,
              sort_type: "ByCreateTimeDesc",
              page_size: pageSize,
            },
          });
          return {
            hasMore: response.data?.has_more ?? false,
            items: (response.data?.items ?? []) as FeishuHistoryMessageRecord[],
          };
        },
        enrichMessage: async ({ historyMessage, normalizedMessage }) =>
          this._enrichHistoryBackfillMessage({
            historyMessage,
            normalizedMessage,
          }),
      });
    }
  }

  getBotIdentity(): ChannelIdentity | undefined {
    const identity = this._getBotIdentity();
    return identity === undefined ? undefined : this._channelIdentityFromBotIdentity(identity);
  }

  /** Start listening for inbound messages via WebSocket. */
  async start() {
    await this._resolveBotIdentity();
    this._inboundRuntimeStatus = {
      ...this._inboundRuntimeStatus,
      state: "connecting",
    };
    await this._inboundClient.start({
      eventDispatcher: new EventDispatcher({}).register({
        "im.message.receive_v1": this._handleMessageReceive,
        "im.message.recalled_v1": this._handleMessageRecall,
        "im.chat.member.bot.added_v1": this._handleBotAddedToGroup,
        "card.action.trigger": this._handleCardActionTrigger,
      } as never),
    });
  }

  /** Stop listening for inbound messages and close the WebSocket client. */
  async stop(): Promise<void> {
    this._inboundClient.close({ force: true });
    this._inboundRuntimeStatus = {
      state: "idle",
    };
  }

  getStatus(): ChannelAdapterRuntimeStatus {
    const connection = (
      this._inboundClient as unknown as {
        getConnectionStatus?: () => FeishuWsConnectionStatus;
      }
    ).getConnectionStatus?.();
    const sdkState = normalizeFeishuInboundState(connection?.state);
    const runtimeState = normalizeFeishuInboundState(this._inboundRuntimeStatus.state);
    const state = effectiveFeishuInboundState(runtimeState, sdkState);
    const reconnectAttempts = maxOptionalNumber(
      this._inboundRuntimeStatus.reconnectAttempts,
      connection?.reconnectAttempts,
    );
    return {
      inbound: {
        ...this._inboundRuntimeStatus,
        state,
        ...optionalNumber("lastConnectAt", connection?.lastConnectTime),
        ...optionalNumber("nextConnectAt", connection?.nextConnectTime),
        ...optionalNumber("reconnectAttempts", reconnectAttempts),
      },
    };
  }

  async subscribeInbound(
    handler: (message: NormalizedInboundMessage) => Promise<void>,
  ): Promise<void> {
    if (this._lunaInboundHandler) {
      throw new Error(`Inbound handler already registered for channel "${this.id}".`);
    }
    this._lunaInboundHandler = handler;
  }

  async subscribeCardActions(
    handler: (action: ChannelCardAction) => Promise<ChannelCardActionResult | undefined>,
  ): Promise<void> {
    this._lunaCardActionHandler = handler;
  }

  private _handleCardActionTrigger = async (rawEvent: unknown): Promise<Record<string, unknown>> => {
    this._markInboundConnected();
    if (!this._lunaCardActionHandler || !rawEvent || typeof rawEvent !== "object") {
      return {};
    }
    const event = rawEvent as {
      operator?: { open_id?: string; user_id?: string; union_id?: string };
      action?: { value?: unknown };
      context?: { open_message_id?: string; open_chat_id?: string };
      open_message_id?: string;
      open_chat_id?: string;
    };
    const openId = event.operator?.open_id;
    const userId = event.operator?.user_id;
    const unionId = event.operator?.union_id;
    const externalId = openId ?? userId ?? unionId ?? "unknown";
    const providerIds = Object.fromEntries(
      Object.entries({ open_id: openId, user_id: userId, union_id: unionId }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
    const operatorIdentity = scopeFeishuIdentity(
      { externalId, kind: "user", providerIds },
      this._identityScope,
    );
    const rawValue = event.action?.value;
    const actionValue: Record<string, unknown> =
      rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
        ? (rawValue as Record<string, unknown>)
        : typeof rawValue === "string"
          ? (() => {
              try {
                const parsed = JSON.parse(rawValue);
                return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : { value: rawValue };
              } catch {
                return { value: rawValue };
              }
            })()
          : {};
    const providerMessageId = event.context?.open_message_id ?? event.open_message_id;
    const chatId = event.context?.open_chat_id ?? event.open_chat_id;

    try {
      const result = await this._lunaCardActionHandler({
        channel: { id: this.id, type: "feishu" },
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(chatId ? { chatId } : {}),
        actionValue,
        operatorIdentity,
      });
      if (!result) return {};
      const response: Record<string, unknown> = {};
      if (result.toast) {
        response.toast = result.toast;
      }
      if (result.settledCard || result.updatedMarkdown) {
        const markdownText = result.settledCard
          ? result.settledCard.bodyMarkdown
          : result.updatedMarkdown!;
        const updatedCard = await renderMessageCard(
          [{ type: "text", text: markdownText }],
          {
            streaming: false,
            uploadImage: async () => {
              throw new Error("Image upload is unused in plain markdown card updates");
            },
          },
        );
        updatedCard.config!.streaming_mode = false;
        if (result.settledCard) {
          const { options, selectedOption, actorLabel, isNegative } =
            result.settledCard;
          updatedCard.config!.width_mode = "compact";
          updatedCard.header = {
            icon: {
              tag: "standard_icon",
              token: isNegative ? "close_outlined" : "yes_outlined",
              color: isNegative ? "grey" : "green",
            },
            title: {
              tag: "plain_text",
              content: result.updatedTitle ?? (isNegative ? "已跳过" : "已确认"),
            },
            template: isNegative ? "grey" : "green",
          };
          updatedCard.body.elements.push({ tag: "hr", margin: "8px 0 4px 0" });
          updatedCard.body.elements.push({
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "small",
            margin: "4px 0 0 0",
            columns: options.map(opt => {
              const isSelected = opt === selectedOption;
              return {
                tag: "column" as const,
                width: "auto" as const,
                elements: [
                  {
                    tag: "button" as const,
                    text: {
                      tag: "plain_text" as const,
                      content: isSelected ? `✓ ${opt}` : opt,
                    },
                    type: isSelected
                      ? isNegative
                        ? ("default" as const)
                        : ("primary_filled" as const)
                      : ("default" as const),
                    disabled: true,
                  },
                ],
              };
            }),
          });
          updatedCard.body.elements.push({
            tag: "div",
            margin: "6px 0 0 0",
            text: {
              tag: "plain_text",
              text_color: "grey",
              text_size: "notation",
              content: `已由 ${actorLabel} 选择「${selectedOption}」`,
            },
          });
        } else if (result.updatedTitle) {
          updatedCard.header = {
            title: { tag: "plain_text", content: result.updatedTitle },
            template: "green",
          };
        }
        response.card = { type: "raw", data: updatedCard };
        if (providerMessageId) {
          void this._client.im.message
            .patch({
              path: { message_id: providerMessageId },
              data: { content: JSON.stringify(updatedCard) },
            })
            .catch(err => {
              this._logger.warn(
                { err, providerMessageId },
                "Fallback patch after card callback failed",
              );
            });
        }
      }
      return response;
    } catch (error) {
      this._logger.error({ error }, "Failed to process Feishu card action trigger");
      return {
        toast: { type: "error", content: "处理卡片操作失败，请稍后重试。" },
      };
    }
  };

  private _markInboundConnected(): void {
    this._inboundRuntimeStatus = {
      ...withoutInboundError(this._inboundRuntimeStatus),
      state: "connected",
      lastConnectAt: Date.now(),
      reconnectAttempts: 0,
    };
  }

  private _markInboundReconnecting(): void {
    this._inboundRuntimeStatus = {
      ...this._inboundRuntimeStatus,
      state: "reconnecting",
      reconnectAttempts: Math.max(
        this._inboundRuntimeStatus.reconnectAttempts ?? 0,
        1,
      ),
    };
  }

  private _markInboundFailed(err: Error): void {
    this._inboundRuntimeStatus = {
      ...this._inboundRuntimeStatus,
      state: "failed",
      lastErrorAt: Date.now(),
      lastError: err.message,
    };
  }

  async completeProcessing(inbound: NormalizedInboundMessage): Promise<void> {
    if (shouldSkipProcessingReaction(inbound)) {
      return;
    }
    await this._clearProcessingReaction(inbound.id);
  }

  async beginProcessing(inbound: NormalizedInboundMessage): Promise<void> {
    if (shouldSkipProcessingReaction(inbound)) {
      return;
    }
    await this._markProcessing(inbound.id);
  }

  async inviteGroupMembers(input: Omit<import("@/channels/outbound").GroupCreationInput, "name"> & { readonly chatId: string }): Promise<import("@/channels/outbound").GroupInvitationResult> {
    const response = await this._client.im.chatMembers.create({ path: { chat_id: input.chatId }, params: { member_id_type: input.idType, succeed_type: 1 }, data: { id_list: [...input.memberIds] } });
    if (response.code) throw new ProviderDeliveryRejected(`Feishu rejected group invitation (${response.code})`);
    if (!response.data) throw new Error("Feishu invitation receipt is incomplete");
    const invalidMemberIds = response.data.invalid_id_list ?? [], notExistedMemberIds = response.data.not_existed_id_list ?? [], pendingApprovalMemberIds = response.data.pending_approval_id_list ?? [];
    const unconfirmed = new Set([...invalidMemberIds, ...notExistedMemberIds, ...pendingApprovalMemberIds]);
    return { acceptedMemberIds: input.memberIds.filter(id => !unconfirmed.has(id)), invalidMemberIds, notExistedMemberIds, pendingApprovalMemberIds };
  }

  async lookupGroup(chatId: string): Promise<ChannelSurface> {
    const response = await this._client.im.chat.get({ path: { chat_id: chatId } });
    if (response.code || response.data?.chat_mode !== "group") throw new Error("Feishu group lookup failed or conversation is not a group");
    return { externalId: chatId, kind: "group", ...(response.data.name ? { displayName: response.data.name } : {}) };
  }

  async listGroupBots(chatId: string): Promise<ChannelIdentity[]> {
    // Feishu returns bot IDs as seen by the application making this request.
    const response = await this._client.request<{
      code?: number;
      data?: { items?: { bot_id?: string; bot_name?: string }[] };
    }>({ url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/bots`, method: "GET" });
    if (response.code !== 0 || !Array.isArray(response.data?.items)) throw new Error("Feishu group bot lookup failed");
    return response.data.items.flatMap(({ bot_id, bot_name }) =>
      typeof bot_id === "string" && /^ou_[\w-]+$/.test(bot_id) && typeof bot_name === "string" && bot_name.trim()
        ? [scopeFeishuIdentity({ externalId: bot_id, kind: "bot", displayName: bot_name, providerIds: { open_id: bot_id } }, this._identityScope)]
        : []);
  }

  async isBotInGroup(chatId: string): Promise<boolean> {
    const response = await this._client.im.chatMembers.isInChat({ path: { chat_id: chatId } });
    return response.code === 0 && response.data?.is_in_chat === true;
  }

  async createGroup(input: import("@/channels/outbound").GroupCreationInput): Promise<ChannelSurface> {
    const response = await this._client.im.chat.create({ params: { user_id_type: input.idType, uuid: input.requestId },
      data: { name: input.name, user_id_list: [...input.memberIds], chat_mode: "group", chat_type: "private", group_message_type: "chat", external: false } });
    if (response.code) throw new ProviderDeliveryRejected(`Feishu rejected group creation (${response.code})`);
    if (!response.data?.chat_id) throw new Error("Feishu group creation receipt is incomplete");
    return { externalId: response.data.chat_id, kind: "group", displayName: response.data.name ?? input.name };
  }

  async lookupUser(idType: "open_id" | "user_id" | "union_id", id: string): Promise<ChannelIdentity> {
    const result = await this._client.contact.user.get({ path: { user_id: id }, params: { user_id_type: idType } });
    const user = result.data?.user;
    if (result.code || !user) throw new Error(`Feishu user lookup failed (${result.code ?? "missing_user"})`);
    const providerIds = Object.fromEntries(Object.entries({ open_id: user.open_id, user_id: user.user_id, union_id: user.union_id }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return scopeFeishuIdentity({ externalId: user.open_id ?? id, kind: "user", ...(user.name ? { displayName: user.name } : {}), providerIds }, this._identityScope);
  }

  private _progressPresentation?: OrdinaryProgress;
  private _prepareProgress(operation: Omit<OutboundChannelOperation,"id"|"channelId">) {
    this._progressPresentation ??= new OrdinaryProgress(this.config.db,this.id);
    return this._progressPresentation.prepare(operation,this._maxVisibleSteps);
  }
  async sendTo(target: DeliveryTarget, operation: Omit<OutboundChannelOperation,"id"|"channelId">): Promise<OutboundChannelOperation> {
    if(operation.statusCardStyle === "native" || operation.replyMode === "update_status_card") {
      const inbound: NormalizedInboundMessage = {id: target.rootMessageId ?? operation.targetMessageId ?? "", channel: {id: target.channelId, type: "feishu"},
        surface: {externalId: target.surfaceId, kind: target.threadId ? "thread" : "group"},
        ...(target.threadId ? {thread: {externalId: target.threadId, rootMessageExternalId: target.rootMessageId!}} : {}),
        sender: {externalId: "luna", kind: "bot"}, text: "", mentions: [], addressing: {addressedToBot: false, reason: "silent_group"}};
      return this.send(inbound, operation);
    }
    const prepared=this._prepareProgress(operation);
    return this._progressPresentation!.remember(await this._sendTo(target,prepared));
  }
  private async _sendTo(target: DeliveryTarget, operation: Omit<OutboundChannelOperation, "id" | "channelId">): Promise<OutboundChannelOperation> {
    if (target.threadId) {
      if (!target.rootMessageId) throw new Error("Thread delivery requires a root message");
      return this._replyLunaMessage({id:target.rootMessageId,channel:{id:target.channelId,type:"feishu"},surface:{externalId:target.surfaceId,kind:"thread"},thread:{externalId:target.threadId,rootMessageExternalId:target.rootMessageId},sender:{externalId:"luna",kind:"bot"},text:"",mentions:[],addressing:{addressedToBot:false,reason:"silent_group"}},operation);
    }
    const payload = await this._replyPayload(operation);
    const uuid = operation.idempotencyKey ? {uuid: operation.idempotencyKey.length <= 50 ? operation.idempotencyKey : createHash("sha256").update(operation.idempotencyKey).digest("base64url")} : {};
    if (operation.quoteMessageId && !target.recipient) {
      // A quote reply stays in the chat. When the quoted message is gone, the reply is sent as an ordinary message below.
      const quoted = await this._client.im.message.reply({path: {message_id: operation.quoteMessageId}, data: {...payload, reply_in_thread: false, ...uuid}});
      if (!quoted.code && quoted.data?.message_id)
        return {...operation, id: quoted.data.message_id, channelId: target.channelId, ...(quoted.data.chat_id ? {deliveredSurfaceId: quoted.data.chat_id} : {}), sender: this._outboundSender()};
    }
    const {data,code}=await this._client.im.message.create({params:{receive_id_type:target.recipient?.idType ?? "chat_id"},data:{receive_id:target.recipient?.id ?? target.surfaceId,...payload,...(operation.idempotencyKey?{uuid:operation.idempotencyKey.length <= 50 ? operation.idempotencyKey : createHash("sha256").update(operation.idempotencyKey).digest("base64url")}:{})}});
    if(code) throw new ProviderDeliveryRejected(`Feishu rejected message (${code})`);
    if(!data?.message_id || (target.recipient && !data.chat_id))throw new Error("Feishu delivery receipt is incomplete");
    return {...operation,id:data.message_id,channelId:target.channelId,...(data.chat_id ? { deliveredSurfaceId: data.chat_id } : {}),sender:this._outboundSender()};
  }

  async send(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation> {
    if (operation.idempotencyKey !== undefined) {
      const existing = this._providerIdempotencyRegistry.get(
        operation.idempotencyKey,
      );
      if (existing) {
        await this._clearProcessingReaction(inbound.id);
        return existing;
      }
    }

    operation=this._prepareProgress(operation);

    try {
      const outbound = operation.statusCardStyle === "native"
        ? await this._sendNativeProgress(inbound, operation)
        : operation.replyMode === "update_status_card"
          ? await this._patchLunaMessage(inbound, operation)
          : operation.replyMode === "channel_message"
            ? await this._createLunaChannelMessage(inbound, operation)
            : await this._replyLunaMessage(inbound, operation);

      if (outbound.idempotencyKey !== undefined) {
        const cached =
          outbound.replyMode === "update_status_card"
            ? (() => {
                const { nativeProgress: _np, progressUpdate: _pu, ...rest } = outbound;
                return rest;
              })()
            : outbound;
        this._providerIdempotencyRegistry.set(outbound.idempotencyKey, cached);
        if (this._providerIdempotencyRegistry.size > 256) {
          const oldest = this._providerIdempotencyRegistry.keys().next().value;
          if (oldest !== undefined) {
            this._providerIdempotencyRegistry.delete(oldest);
          }
        }
      }
      return this._progressPresentation!.remember(outbound);
    } finally {
      await this._clearProcessingReaction(inbound.id);
    }
  }

  private async _sendNativeProgress(inbound: NormalizedInboundMessage, operation: Omit<OutboundChannelOperation, "id" | "channelId">): Promise<OutboundChannelOperation> {
    if (!this.config.db) throw new Error("Native task progress requires durable storage");
    return new NativeTaskProgress(this.config.db, this.id, request => this._client.request({...request, timeout: 15000})).send(inbound, operation);
  }

  /** Reply to a message in a Feishu chat thread. */
  async replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    { streaming = true }: { streaming?: boolean } = {},
  ): Promise<AssistantMessage> {
    const startedAt = Date.now();
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
      maxVisibleSteps: this._maxVisibleSteps,
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    const { data: replyMessage } = await this._client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    });
    if (!replyMessage) {
      throw new Error("Failed to reply message");
    }

    const { thread_id: threadId } = replyMessage;
    const sessionId = message.session_id;
    this._mapThreadToSession(threadId!, sessionId);

    await this._sendRemainingChunks(replyMessage.message_id!, remainingChunks);

    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = replyMessage.message_id!;

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(
          assistantMessage.id,
          lastText.text,
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    const log = streaming ? this._logger.debug : this._logger.info;
    log.call(
      this._logger,
      {
        session_id: sessionId,
        message_id: assistantMessage.id,
        reply_to_message_id: messageId,
        streaming,
        remaining_chunk_count: remainingChunks.length,
        duration_ms: durationMs,
      },
      streaming ? "Feishu streaming reply sent" : "Feishu reply sent",
    );

    return assistantMessage;
  }

  async postMessage(
    message: Omit<AssistantMessage, "id">,
  ): Promise<AssistantMessage> {
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      false,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming: false,
      uploadImage: this.uploadImage.bind(this),
      maxVisibleSteps: this._maxVisibleSteps,
    });
    this._logOutboundMessage(message.session_id, message.content);
    const { data } = await this._client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: this.config.chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (!data) {
      throw new Error("Failed to post message");
    }
    const { message_id: messageId } = data;
    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = messageId!;

    await this._sendRemainingChunks(assistantMessage.id, remainingChunks);

    const lastText = message.content.filter((c) => c.type === "text").pop();
    if (lastText?.type === "text") {
      await this._sendLocalFileAttachments(assistantMessage.id, lastText.text);
    }

    const emojis = [
      "思考中",
      "送你小红花",
      "送心",
      "灵光一现",
      "辛勤营业",
      "挥手",
    ];
    const { data: replyData } = await this._client.im.message.reply({
      path: {
        message_id: assistantMessage.id,
      },
      data: {
        content: JSON.stringify({
          type: "text",
          text: `[${emojis[Math.floor(Math.random() * emojis.length)]}] Reply here to continue the session`,
        }),
        msg_type: "text",
        reply_in_thread: true,
      },
    });
    if (replyData) {
      const { thread_id: threadId } = replyData;
      const sessionId = message.session_id;
      this._mapThreadToSession(threadId!, sessionId);
    }
    return assistantMessage;
  }

  /** Update the content of an existing Feishu message. */
  async updateMessageContent(
    message: AssistantMessage,
    { streaming = true }: { streaming?: boolean } = {},
  ): Promise<void> {
    if (this._failedCardUpdateMessages.has(message.id)) {
      return;
    }

    const startedAt = Date.now();
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
      maxVisibleSteps: this._maxVisibleSteps,
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    try {
      await this._client.im.message.patch({
        path: {
          message_id: message.id,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      if (_isFeishuBadRequestError(err)) {
        this._failedCardUpdateMessages.add(message.id);
        this._logger.warn(
          { err, message_id: message.id, session_id: message.session_id },
          "Feishu card update failed with 400; sending fallback reply",
        );
        await this._replyUpdateFailureMessage(message.id);
        return;
      }
      throw err;
    }

    await this._sendRemainingChunks(message.id, remainingChunks);

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(message.id, lastText.text);
      }
    }

    const durationMs = Date.now() - startedAt;
    const log = streaming ? this._logger.debug : this._logger.info;
    log.call(
      this._logger,
      {
        session_id: message.session_id,
        message_id: message.id,
        streaming,
        remaining_chunk_count: remainingChunks.length,
        duration_ms: durationMs,
      },
      streaming
        ? "Feishu message content updated"
        : "Feishu final message content updated",
    );
  }

  /**
   * Uploads an image to Feishu. Returns the key of the uploaded image.
   * @param path - The path to the image to upload.
   * @returns The key of the uploaded image.
   */
  async uploadImage(path: string): Promise<string> {
    const absPath = nodePath.isAbsolute(path)
      ? path
      : nodePath.join(config.paths.home, path);
    const file = fs.readFileSync(absPath);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this._logger.info(`Uploading image ${absPath}`);
        const res = await this._client.im.v1.image.create({
          data: {
            image_type: "message",
            image: file,
          },
        });
        this._logger.info(
          `Uploaded image ${absPath} -> ${res?.image_key || "failed"}`,
        );
        if (res?.image_key) {
          return res.image_key;
        }
        throw new Error("Failed to upload image");
      } catch (err) {
        if (attempt === maxAttempts || !isTransientFeishuUploadError(err)) {
          throw err;
        }
        this._logger.warn(
          { err, image_path: absPath, attempt, max_attempts: maxAttempts },
          "Transient Feishu image upload failure; retrying",
        );
        await waitForRetry(attempt * 100);
      }
    }
    throw new Error("Failed to upload image");
  }

  /**
   * Uploads a file to Feishu. Returns the key of the uploaded file.
   * @param filePath - The path to the file relative to the home directory.
   * @returns The key of the uploaded file.
   */
  async uploadFile(filePath: string): Promise<string> {
    const absPath = nodePath.join(config.paths.home, filePath);
    const file = fs.createReadStream(absPath);
    const fileName = nodePath.basename(absPath);
    const ext = nodePath.extname(absPath).slice(1).toLowerCase();
    const fileTypeMap: Record<
      string,
      "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"
    > = {
      opus: "opus",
      mp4: "mp4",
      pdf: "pdf",
      doc: "doc",
      docx: "doc",
      xls: "xls",
      xlsx: "xls",
      ppt: "ppt",
      pptx: "ppt",
    };
    const fileType = fileTypeMap[ext] ?? "stream";
    this._logger.info(`Uploading file ${absPath} (type: ${fileType})`);
    const res = await this._client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file,
      },
    });
    this._logger.info(
      `Uploaded file ${absPath} -> ${res?.file_key || "failed"}`,
    );
    if (res?.file_key) {
      return res.file_key;
    } else {
      throw new Error("Failed to upload file");
    }
  }

  /**
   * Downloads an image or a file from a message.
   * @param messageId - The ID of the message to download the resource from.
   * @param file_key - The key of the file to download.
   * @param file_name - The name of the file to download. If not provided, the file name will be inferred from the file key.
   * @returns The path to the downloaded file.
   */
  async downloadMessageResource(
    messageId: string,
    file_key: string,
    file_name?: string,
  ): Promise<string> {
    const { writeFile, headers } = await this._client.im.v1.messageResource.get(
      {
        path: {
          message_id: messageId,
          file_key,
        },
        params: {
          type: "file",
        },
      },
    );
    const metadata = JSON.parse(
      headers.get("inner_file_data_meta") as string,
    ) as {
      FileName: string;
      Mime: string;
    };
    const isImage = metadata.Mime.startsWith("image/");
    let dir = config.paths.uploads;
    if (isImage) {
      dir = nodePath.join(dir, "images");
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let filename: string;
    if (file_name) {
      filename = file_name;
    } else {
      filename = metadata.FileName === "image" ? file_key : metadata.FileName;
      if (metadata.Mime.startsWith("image/")) {
        filename += "." + metadata.Mime.split("/")[1];
      } else if (metadata.Mime === "audio/octet-stream") {
        filename += ".ogg";
      } else {
        filename += `.${metadata.Mime.split("/")[1]}`;
      }
    }
    const extname = nodePath.extname(filename);
    filename = filename.substring(0, filename.length - extname.length);
    if (fs.existsSync(nodePath.join(dir, filename + extname))) {
      let i = 1;
      while (fs.existsSync(nodePath.join(dir, filename + `-${i}` + extname))) {
        i++;
      }
      filename += `-${i}`;
    }
    filename += extname;
    await writeFile(nodePath.join(dir, filename));
    return nodePath.relative(config.paths.home, nodePath.join(dir, filename));
  }

  /**
   * Prepare message content for sending, splitting if necessary due to table limits.
   * @param content - Original message content.
   * @param streaming - Whether the message is being streamed (skip splitting if true).
   * @returns First chunk content and remaining chunks to send as follow-ups.
   */
  private _prepareMessageContent(
    content: AssistantMessage["content"],
    streaming: boolean,
  ): {
    firstMessageContent: AssistantMessage["content"];
    remainingChunks: string[];
  } {
    const lastTextContent = content.findLast((c) => c.type === "text");
    const markdownChunks = lastTextContent
      ? splitMarkdownByTables(lastTextContent.text)
      : [];
    const needsSplit = !streaming && markdownChunks.length > 1;

    const firstMessageContent = needsSplit
      ? (content.map((c) =>
          c.type === "text" ? { ...c, text: markdownChunks[0] } : c,
        ) as AssistantMessage["content"])
      : content;

    const remainingChunks = needsSplit ? markdownChunks.slice(1) : [];

    return { firstMessageContent, remainingChunks };
  }

  /**
   * Send remaining markdown chunks as follow-up reply session messages.
   * @param messageId - The message ID to reply to.
   * @param chunks - Array of markdown strings to send.
   */
  private async _sendRemainingChunks(
    messageId: string,
    chunks: string[],
  ): Promise<void> {
    for (const chunkText of chunks) {
      const chunkCard = await renderMessageCard(
        [{ type: "text", text: chunkText }],
        {
          streaming: false,
          uploadImage: this.uploadImage.bind(this),
          maxVisibleSteps: this._maxVisibleSteps,
        },
      );
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(chunkCard),
          reply_in_thread: true,
        },
      });
    }
  }

  /** Extract local file paths from markdown link syntax [text](path) in text. */
  private _extractLocalFilePaths(text: string): string[] {
    const linkRegex = /(?<!!)\[.*?\]\(([^)]+)\)/g;
    const paths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(text)) !== null) {
      const filePath = match[1];
      if (
        filePath &&
        !filePath.includes("://") &&
        fs.existsSync(nodePath.join(config.paths.home, filePath))
      ) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  /** Upload local files referenced in text and send them as Feishu file message replies. */
  private async _sendLocalFileAttachments(
    messageId: string,
    text: string,
  ): Promise<void> {
    const filePaths = this._extractLocalFilePaths(text);
    const seen = new Set<string>();
    for (const filePath of filePaths) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      try {
        const fileKey = await this.uploadFile(filePath);
        await this._client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "file",
            content: JSON.stringify({ file_key: fileKey }),
            reply_in_thread: true,
          },
        });
        this._logger.info(`Sent file ${filePath} as Feishu attachment`);
      } catch (err) {
        this._logger.warn(
          { err },
          `Failed to send file attachment: ${filePath}`,
        );
      }
    }
  }

  private async _replyUpdateFailureMessage(messageId: string): Promise<void> {
    try {
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "text",
          content: JSON.stringify({
            text: "抱歉，这条消息更新失败了，请稍后重试。",
          }),
          reply_in_thread: true,
        },
      });
    } catch (err) {
      this._logger.warn(
        { err, message_id: messageId },
        "Failed to send fallback reply after Feishu card update error",
      );
    }
  }

  private _logOutboundMessage(
    sessionId: string,
    content: AssistantMessage["content"],
  ) {
    const lastText = content.filter((item) => item.type === "text").pop();
    const finalText = lastText?.type === "text" ? lastText.text : null;
    this._logger.info(
      {
        session_id: sessionId,
        final_text: finalText,
        final_text_length: finalText?.length ?? 0,
      },
      "Final Feishu outbound content",
    );
  }

  private _logInboundMessage(args: {
    sessionId: string;
    messageId: string;
    threadId?: string;
    messageType: string;
    chatId: string;
    senderOpenId?: string;
    content: TextMessageContent;
  }) {
    this._logger.info(
      {
        session_id: args.sessionId,
        message_id: args.messageId,
        thread_id: args.threadId,
        message_type: args.messageType,
        chat_id: args.chatId,
        sender_open_id: args.senderOpenId,
        final_text: args.content.text,
        final_text_length: args.content.text.length,
      },
      "Final Feishu inbound content",
    );
  }

  private _handleMessageReceive = async ({
    sender,
    message: receivedMessage,
  }: MessageReceiveEventData) => {
    this._markInboundConnected();
    const { message_id: messageId, thread_id: threadId } = receivedMessage;
    const session_id = this._resolveSessionId(threadId);
    const parsedContent = await this._parseMessageContent(
      messageId,
      receivedMessage.message_type,
      receivedMessage.content,
    );
    const botIdentity = this._getBotIdentity();
    const baseNormalizedInbound = createFeishuNormalizer({
      identityScope: this._identityScope,
      channel: { type: this.type, id: this.id },
      ...(botIdentity !== undefined
        ? { botIdentity: this._channelIdentityFromBotIdentity(botIdentity) }
        : {}),
      groupBotAliases: this._groupBotAliases(),
    }).normalizeMessageEvent({
      ...receivedMessage,
      sender,
      content: JSON.stringify({ text: parsedContent.text }),
    });
    const parsedMentions = parsedContent.mentions ?? [];
    const parsedRelatedIdentities = parsedContent.relatedIdentities ?? [];
    const normalizedMentions = mergeChannelMentions(
      baseNormalizedInbound.mentions,
      parsedMentions,
    );
    const normalizedRelatedIdentities = mergeChannelIdentities(
      baseNormalizedInbound.relatedIdentities ?? [],
      parsedRelatedIdentities,
    );
    const normalizedText = renderFeishuMentions(
      baseNormalizedInbound.text,
      parsedMentions,
    );
    const normalizedInbound: NormalizedInboundMessage = {
      ...baseNormalizedInbound,
      text: normalizedText,
      ...(parsedContent.contentBlocks !== undefined
        ? { contentBlocks: parsedContent.contentBlocks }
        : {}),
      mentions: normalizedMentions,
      ...(normalizedRelatedIdentities.length > 0
        ? { relatedIdentities: normalizedRelatedIdentities }
        : {}),
      contentKind: parsedContent.contentKind,
      presentationKind: parsedContent.presentationKind,
      providerMessageType: parsedContent.providerMessageType,
      ...(parsedContent.presentation !== undefined
        ? { presentation: parsedContent.presentation }
        : {}),
    };
    const semanticText = normalizedInbound.text;
    const normalizedContent: TextMessageContent = {
      ...parsedContent,
      text: semanticText,
    };
    this._logInboundMessage({
      sessionId: session_id,
      messageId,
      messageType: receivedMessage.message_type,
      chatId: receivedMessage.chat_id,
      content: normalizedContent,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(sender.sender_id?.open_id !== undefined
        ? { senderOpenId: sender.sender_id.open_id }
        : {}),
    });
    const userMessage: UserMessage = {
      id: messageId,
      session_id,
      role: "user",
      channel_id: this.id,
      content: [normalizedContent],
    };
    this.emit("message:inbound", userMessage);
    const chatType =
      receivedMessage.chat_type === "p2p"
        ? "p2p"
        : receivedMessage.chat_type === "group"
          ? "group"
          : "unknown";
    const directorySnapshots = await this._resolveInboundDirectorySnapshots({
      sender,
      message: receivedMessage,
      chatType,
    });
    const enrichedNormalizedInbound = enrichNormalizedInboundWithDirectory({
      normalizedInbound,
      directorySnapshots,
      sender,
      receivedMessage,
    });
    const enrichedMentionsInbound = await this._enrichMentionTargetsInMessage({
      message: enrichedNormalizedInbound,
      ...(directorySnapshots.chatProfile !== undefined
        ? { chatProfile: directorySnapshots.chatProfile }
        : {}),
    });
    if (!this._lunaInboundHandler) {
      await this._clearProcessingReaction(messageId);
      return;
    }
    try {
      await this._lunaInboundHandler(enrichedMentionsInbound);
    } catch (err) {
      await this._clearProcessingReaction(messageId);
      throw err;
    }
  };

  private _channelIdentityFromBotIdentity(
    identity: FeishuBotIdentity,
  ): ChannelIdentity {
    const externalId =
      identity.openId ?? identity.userId ?? identity.unionId ?? "unknown";
    return scopeFeishuIdentity({
      externalId,
      kind: "bot",
      ...(identity.displayName !== undefined
        ? { displayName: identity.displayName }
        : {}),
      ...(identity.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
      providerIds: {
        ...(identity.openId !== undefined ? { open_id: identity.openId } : {}),
        ...(identity.userId !== undefined ? { user_id: identity.userId } : {}),
        ...(identity.unionId !== undefined ? { union_id: identity.unionId } : {}),
      },
    }, this._identityScope);
  }

  private async _resolveInboundDirectorySnapshots(args: {
    readonly sender: MessageReceiveEventData["sender"];
    readonly message: MessageReceiveEventData["message"];
    readonly chatType: InboundChatType;
  }): Promise<{
    readonly senderProfile?: ChannelUserProfileSnapshot;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  }> {
    const senderProfile = await this._resolveFeishuUserProfile(args.sender);
    const chatProfile = await this._resolveFeishuChatProfile(
      args.message.chat_id,
      args.chatType,
      args.sender.tenant_key,
    );
    return {
      ...(senderProfile !== undefined ? { senderProfile } : {}),
      ...(chatProfile !== undefined ? { chatProfile } : {}),
    };
  }

  private async _enrichHistoryBackfillMessage(input: {
    readonly historyMessage: FeishuHistoryMessageRecord;
    readonly normalizedMessage: NormalizedInboundMessage;
  }): Promise<NormalizedInboundMessage> {
    const sender = historySenderToEventSender(input.historyMessage.sender);
    const senderProfile = sender === undefined
      ? undefined
      : await this._resolveFeishuUserProfile(sender);
    const tenantKey =
      sender?.tenant_key ?? input.historyMessage.sender?.tenant_key;
    const chatProfile = await this._resolveFeishuChatProfile(
      input.historyMessage.chat_id ?? input.normalizedMessage.surface.externalId,
      "group",
      tenantKey,
    );
    return this._enrichMentionTargetsInMessage({
      message: {
        ...input.normalizedMessage,
        sender: enrichSenderIdentity(
          input.normalizedMessage.sender,
          senderProfile,
        ),
        surface: enrichChannelSurface(
          input.normalizedMessage.surface,
          chatProfile,
        ),
      },
      ...(chatProfile !== undefined ? { chatProfile } : {}),
    });
  }

  private async _enrichMentionTargetsInMessage(input: {
    readonly message: NormalizedInboundMessage;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  }): Promise<NormalizedInboundMessage> {
    if (input.message.mentions.length === 0) {
      return this._scopeInboundIdentities(input.message);
    }
    const mentions = await Promise.all(
      input.message.mentions.map((mention) =>
        this._enrichMentionTarget({
          mention,
          chatId: input.message.surface.externalId,
          ...(input.chatProfile !== undefined ? { chatProfile: input.chatProfile } : {}),
        })
      ),
    );
    const changed = mentions.some((mention, index) => mention !== input.message.mentions[index]);
    return this._scopeInboundIdentities(changed ? { ...input.message, mentions } : input.message);
  }

  private _scopeInboundIdentities(message: NormalizedInboundMessage): NormalizedInboundMessage {
    const scope = (identity: ChannelIdentity) => scopeFeishuIdentity(identity, this._identityScope);
    return {...message, sender: scope(message.sender),
      mentions: message.mentions.map(mention => ({...mention, target: scope(mention.target)})),
      ...(message.relatedIdentities ? {relatedIdentities: message.relatedIdentities.map(scope)} : {})};
  }

  private async _enrichMentionTarget(input: {
    readonly mention: ChannelMention;
    readonly chatId: string;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  }): Promise<ChannelMention> {
    if (input.mention.target.kind !== "user") {
      return input.mention;
    }
    const profile = await this._resolveFeishuMentionProfile({
      target: input.mention.target,
      chatId: input.chatId,
      ...(input.chatProfile !== undefined ? { chatProfile: input.chatProfile } : {}),
    });
    if (profile === undefined) {
      return input.mention;
    }
    const providerIds = compactStringRecord({
      open_id: profile.openId,
      user_id: profile.userId,
      union_id: profile.unionId,
      tenant_key: profile.tenantKey,
      ...input.mention.target.providerIds,
    });
    const target: ChannelIdentity = {
      ...input.mention.target,
      externalId: profile.externalUserId ?? input.mention.target.externalId,
      kind: normalizeIdentityKind(profile.userType, input.mention.target.kind),
      ...(profile.displayName ?? profile.name
        ? { displayName: profile.displayName ?? profile.name }
        : {}),
      ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
      ...(providerIds !== undefined ? { providerIds } : {}),
      rawProfile: profile.rawProfile ?? input.mention.target.rawProfile,
    };
    return {
      ...input.mention,
      target,
    };
  }

  private async _resolveFeishuMentionProfile(input: {
    readonly target: ChannelIdentity;
    readonly chatId: string;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  }): Promise<ChannelUserProfileSnapshot | undefined> {
    const providerIds = input.target.providerIds ?? {};
    const externalUserId =
      firstString(
        providerIds.open_id,
        providerIds.user_id,
        providerIds.union_id,
        input.target.externalId,
      );
    if (externalUserId === undefined) {
      return undefined;
    }
    const cacheKey = `${input.chatId}\u0000${externalUserId}`;
    const cached = this._mentionProfileCache.get(cacheKey);
    if ((cached !== undefined || this._mentionProfileCache.has(cacheKey)) && Date.now() < (this._mentionProfileExpiresAt.get(cacheKey) ?? 0)) {
      return cached ?? undefined;
    }

    const lookup = await this._lookupFeishuMentionProfile({
      target: input.target,
      externalUserId,
      chatId: input.chatId,
      ...(input.chatProfile !== undefined ? { chatProfile: input.chatProfile } : {}),
    });
    this._mentionProfileCache.set(cacheKey, lookup ?? null);
    this._mentionProfileExpiresAt.set(cacheKey, Date.now() + (lookup ? 60 * 60_000 : 5 * 60_000));
    return lookup;
  }

  private async _lookupFeishuMentionProfile(input: {
    readonly target: ChannelIdentity;
    readonly externalUserId: string;
    readonly chatId: string;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  }): Promise<ChannelUserProfileSnapshot | undefined> {
    const providerIds = input.target.providerIds ?? {};
    const userId = firstString(
      providerIds.open_id,
      providerIds.user_id,
      providerIds.union_id,
      input.externalUserId,
    );
    if (userId === undefined) {
      return undefined;
    }
    const userIdType =
      providerIds.open_id !== undefined
        ? "open_id"
        : providerIds.user_id !== undefined
          ? "user_id"
          : "union_id";
    try {
      const contactClient = this._client as unknown as {
        readonly contact?: {
          readonly v3?: {
            readonly user?: {
              readonly get?: (args: {
                readonly path: { readonly user_id: string };
                readonly params: { readonly user_id_type: string };
              }) => Promise<unknown>;
            };
          };
        };
      };
      const response = await contactClient.contact?.v3?.user?.get?.({
        path: { user_id: userId },
        params: { user_id_type: userIdType },
      });
      const mapped = this._mapFeishuUserProfile(response, {
        sender_id: {
          ...(providerIds.open_id !== undefined ? { open_id: providerIds.open_id } : {}),
          ...(providerIds.user_id !== undefined ? { user_id: providerIds.user_id } : {}),
          ...(providerIds.union_id !== undefined ? { union_id: providerIds.union_id } : {}),
        },
        sender_type: "user",
        ...(providerIds.tenant_key !== undefined
          ? { tenant_key: providerIds.tenant_key }
          : {}),
        ...(input.target.displayName !== undefined
          ? {
              display_name: input.target.displayName,
              name: input.target.displayName,
            }
          : {}),
      });
      if (mapped !== undefined) {
        return mapped;
      }
    } catch (err) {
      if (!_isFeishuNoUserAuthorityError(err) && !_isFeishuBadRequestError(err)) {
        this._logger.warn(
          {
            ..._feishuErrorLogDetails(err),
            channel_id: this.id,
            external_user_id: input.externalUserId,
          },
          "Failed to resolve Feishu mention target profile",
        );
      }
    }

    return this._inferBotMentionProfile(input);
  }

  private async _inferBotMentionProfile(input: {
    readonly target: ChannelIdentity;
    readonly externalUserId: string;
    readonly chatId: string;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  }): Promise<ChannelUserProfileSnapshot | undefined> {
    const openId = input.target.providerIds?.open_id;
    if (openId === undefined) {
      return undefined;
    }
    const isInChat = await this._isFeishuMemberInChat({
      chatId: input.chatId,
      memberId: openId,
      memberIdType: "open_id",
    });
    if (isInChat !== true) {
      return undefined;
    }
    const visibleHumans = await this._listVisibleHumanMembers(
      input.chatId,
      input.chatProfile,
    );
    if (
      visibleHumans === undefined ||
      visibleHumans.complete !== true ||
      visibleHumans.memberOpenIds.has(openId)
    ) {
      return undefined;
    }
    return {
      externalUserId: input.externalUserId,
      userType: "bot",
      openId,
      ...(input.target.providerIds?.user_id !== undefined
        ? { userId: input.target.providerIds.user_id }
        : {}),
      ...(input.target.providerIds?.union_id !== undefined
        ? { unionId: input.target.providerIds.union_id }
        : {}),
      ...(input.target.displayName !== undefined
        ? { displayName: input.target.displayName, name: input.target.displayName }
        : {}),
      ...(input.target.providerIds?.tenant_key !== undefined
        ? { tenantKey: input.target.providerIds.tenant_key }
        : {}),
      rawProfile: withMentionedType(input.target.rawProfile, "bot"),
    };
  }

  private async _isFeishuMemberInChat(input: {
    readonly chatId: string;
    readonly memberId: string;
    readonly memberIdType: "open_id" | "user_id" | "union_id";
  }): Promise<boolean | undefined> {
    try {
      const requestClient = this._client as unknown as {
        readonly request?: <T = unknown>(args: {
          readonly url: string;
          readonly method: "GET";
        }) => Promise<T>;
      };
      const params = new URLSearchParams({
        member_id: input.memberId,
        member_id_type: input.memberIdType,
      });
      const response = await requestClient.request?.<{
        readonly data?: { readonly is_in_chat?: boolean };
      }>({
        url:
          `/open-apis/im/v1/chats/${encodeURIComponent(input.chatId)}/members/is_in_chat?${params.toString()}`,
        method: "GET",
      });
      return response?.data?.is_in_chat;
    } catch (err) {
      this._logger.warn(
        {
          ..._feishuErrorLogDetails(err),
          channel_id: this.id,
          chat_id: input.chatId,
          member_id: input.memberId,
          member_id_type: input.memberIdType,
        },
        "Failed to determine whether Feishu mention target is in chat",
      );
      return undefined;
    }
  }

  private async _listVisibleHumanMembers(
    chatId: string,
    chatProfile: ChannelChatProfileSnapshot | undefined,
  ): Promise<FeishuChatHumanMemberSnapshot | undefined> {
    const cached = this._chatHumanMemberCache.get(chatId);
    if (cached !== undefined || this._chatHumanMemberCache.has(chatId)) {
      return cached instanceof Promise ? await cached : cached;
    }
    const pending = this._fetchVisibleHumanMembers(chatId, chatProfile);
    this._chatHumanMemberCache.set(chatId, pending);
    const resolved = await pending;
    this._chatHumanMemberCache.set(chatId, resolved);
    return resolved;
  }

  private async _fetchVisibleHumanMembers(
    chatId: string,
    chatProfile: ChannelChatProfileSnapshot | undefined,
  ): Promise<FeishuChatHumanMemberSnapshot | undefined> {
    try {
      const requestClient = this._client as unknown as {
        readonly request?: <T = unknown>(args: {
          readonly url: string;
          readonly method: "GET";
        }) => Promise<T>;
      };
      const memberOpenIds = new Set<string>();
      let pageToken: string | undefined;
      let hasMore = false;
      do {
        const params = new URLSearchParams({
          member_id_type: "open_id",
          page_size: "100",
          ...(pageToken !== undefined ? { page_token: pageToken } : {}),
        });
      const response = await requestClient.request?.<{
        readonly data?: {
            readonly items?: ReadonlyArray<Record<string, unknown>>;
            readonly has_more?: boolean;
            readonly page_token?: string;
          };
        }>({
          url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${params.toString()}`,
          method: "GET",
        });
        const items = response?.data?.items ?? [];
        for (const item of items) {
          const memberOpenId = stringField(item, "member_id");
          if (memberOpenId !== undefined) {
            memberOpenIds.add(memberOpenId);
          }
        }
        hasMore = response?.data?.has_more === true;
        pageToken = firstString(response?.data?.page_token);
      } while (hasMore && pageToken !== undefined);

      const expectedHumanCount = chatHumanCount(chatProfile);
      return {
        memberOpenIds,
        complete: expectedHumanCount === undefined || memberOpenIds.size >= expectedHumanCount,
      };
    } catch (err) {
      this._logger.warn(
        {
          ..._feishuErrorLogDetails(err),
          channel_id: this.id,
          chat_id: chatId,
        },
        "Failed to list Feishu chat members for mention enrichment",
      );
      return undefined;
    }
  }

  private async _resolveFeishuUserProfile(
    sender: MessageReceiveEventData["sender"],
  ): Promise<ChannelUserProfileSnapshot | undefined> {
    const senderId = sender.sender_id;
    const externalUserId =
      senderId?.open_id ?? senderId?.user_id ?? senderId?.union_id;
    const appId = senderId?.app_id;
    if (
      externalUserId === undefined &&
      appId !== undefined &&
      (sender.sender_type === "app" || sender.sender_type === "bot")
    ) {
      return this._resolveFeishuAppProfile(sender, appId);
    }
    if (externalUserId === undefined) {
      return undefined;
    }
    const cached = this._userProfileCache.get(externalUserId);
    if ((cached !== undefined || this._userProfileCache.has(externalUserId)) && Date.now() < (this._userProfileExpiresAt.get(externalUserId) ?? 0)) {
      return cached;
    }

    const userId = externalUserId;
    const userIdType =
      senderId?.open_id !== undefined
        ? "open_id"
        : senderId?.user_id !== undefined
          ? "user_id"
          : "union_id";
    let profile: ChannelUserProfileSnapshot | undefined;
    try {
      const contactClient = this._client as unknown as {
        readonly contact?: {
          readonly v3?: {
            readonly user?: {
              readonly get?: (args: {
                readonly path: { readonly user_id: string };
                readonly params: { readonly user_id_type: string };
              }) => Promise<unknown>;
            };
          };
        };
      };
      const response = await contactClient.contact?.v3?.user?.get?.({
        path: { user_id: userId },
        params: { user_id_type: userIdType },
      });
      profile = this._mapFeishuUserProfile(response, sender);
    } catch (err) {
      this._logger.warn(
        {
          ...(_isFeishuBadRequestError(err)
            ? _feishuErrorLogDetails(err)
            : { err }),
          channel_id: this.id,
          external_user_id: externalUserId,
        },
        "Failed to resolve Feishu user profile; falling back to event sender identity",
      );
    }

    const resolvedProfile = profile !== undefined;
    if (profile === undefined) {
      const displayName = senderProfileDisplayName(sender);
      const avatarUrl = senderProfileAvatarUrl(sender);
      profile = {
        externalUserId,
        ...(senderId?.open_id !== undefined ? { openId: senderId.open_id } : {}),
        ...(senderId?.user_id !== undefined ? { userId: senderId.user_id } : {}),
        ...(senderId?.union_id !== undefined ? { unionId: senderId.union_id } : {}),
        ...(sender.name !== undefined ? { name: sender.name } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(sender.tenant_key !== undefined ? { tenantKey: sender.tenant_key } : {}),
        rawProfile: sender,
      };
    }
    this._userProfileCache.set(externalUserId, profile);
    this._userProfileExpiresAt.set(externalUserId, Date.now() + (resolvedProfile ? 60 * 60_000 : 5 * 60_000));
    return profile;
  }

  private async _resolveFeishuAppProfile(
    sender: MessageReceiveEventData["sender"],
    appId: string,
  ): Promise<ChannelUserProfileSnapshot | undefined> {
    const cached = this._userProfileCache.get(appId);
    if (cached !== undefined || this._userProfileCache.has(appId)) {
      return cached;
    }

    let profile: ChannelUserProfileSnapshot | undefined;
    const botIdentity = appId === this.config.appId ? this._getBotIdentity() : undefined;
    if (botIdentity !== undefined) {
      profile = {
        externalUserId: appId,
        userType: "bot",
        appId,
        ...(botIdentity.openId !== undefined ? { openId: botIdentity.openId } : {}),
        ...(botIdentity.userId !== undefined ? { userId: botIdentity.userId } : {}),
        ...(botIdentity.unionId !== undefined ? { unionId: botIdentity.unionId } : {}),
        ...(botIdentity.displayName !== undefined
          ? { displayName: botIdentity.displayName, name: botIdentity.displayName }
          : {}),
        ...(botIdentity.avatarUrl !== undefined ? { avatarUrl: botIdentity.avatarUrl } : {}),
        ...(sender.tenant_key !== undefined ? { tenantKey: sender.tenant_key } : {}),
        rawProfile: sender,
      };
    }

    if (profile === undefined) {
      try {
        const requestClient = this._client as unknown as {
          readonly request?: <T = unknown>(args: {
            readonly url: string;
            readonly method: "GET";
          }) => Promise<T>;
        };
        const response = await requestClient.request?.<FeishuApplicationInfoResponse>({
          url: `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`,
          method: "GET",
        });
        profile = this._mapFeishuAppProfile(response, sender, appId);
      } catch (err) {
        this._logger.warn(
          {
            ...(_isFeishuBadRequestError(err)
              ? _feishuErrorLogDetails(err)
              : { err }),
            channel_id: this.id,
            app_id: appId,
          },
          "Failed to resolve Feishu app profile; falling back to event sender identity",
        );
      }
    }

    const resolvedProfile = profile !== undefined;
    if (profile === undefined) {
      const displayName = senderProfileDisplayName(sender);
      const avatarUrl = senderProfileAvatarUrl(sender);
      profile = {
        externalUserId: appId,
        userType: "bot",
        appId,
        ...(sender.name !== undefined ? { name: sender.name } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(sender.tenant_key !== undefined ? { tenantKey: sender.tenant_key } : {}),
        rawProfile: sender,
      };
    }

    this._userProfileCache.set(appId, profile);
    return profile;
  }

  private _mapFeishuUserProfile(
    response: unknown,
    sender: MessageReceiveEventData["sender"],
  ): ChannelUserProfileSnapshot | undefined {
    const senderId = sender.sender_id;
    const externalUserId =
      senderId?.open_id ?? senderId?.user_id ?? senderId?.union_id;
    if (externalUserId === undefined) {
      return undefined;
    }
    if (typeof response !== "object" || response === null) {
      return undefined;
    }
    const responseRecord = response as {
      readonly data?: {
        readonly user?: Record<string, unknown>;
      };
      readonly user?: Record<string, unknown>;
    };
    const user = responseRecord.data?.user ?? responseRecord.user;
    if (user === undefined) {
      return undefined;
    }
    const avatar = user.avatar as Record<string, unknown> | undefined;
    const name = firstString(user.name, user.en_name, user.nickname, sender.name);
    const displayName = firstString(
      user.display_name,
      user.name,
      user.en_name,
      user.nickname,
      sender.display_name,
      sender.name,
      sender.nickname,
    );
    const openId = firstString(user.open_id, senderId?.open_id);
    const userId = firstString(user.user_id, senderId?.user_id);
    const unionId = firstString(user.union_id, senderId?.union_id);
    const avatarUrl = firstString(
      user.avatar_url,
      avatar?.avatar_72,
      avatar?.avatar_240,
      avatar?.avatar_origin,
      senderProfileAvatarUrl(sender),
    );
    const tenantKey = firstString(user.tenant_key, sender.tenant_key);
    return {
      externalUserId,
      ...(openId !== undefined ? { openId } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(unionId !== undefined ? { unionId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(tenantKey !== undefined ? { tenantKey } : {}),
      rawProfile: user,
    };
  }

  private _mapFeishuAppProfile(
    response: unknown,
    sender: MessageReceiveEventData["sender"],
    appId: string,
  ): ChannelUserProfileSnapshot | undefined {
    if (typeof response !== "object" || response === null) {
      return undefined;
    }
    const responseRecord = response as FeishuApplicationInfoResponse;
    const app =
      responseRecord.data?.app ??
      responseRecord.data?.application ??
      responseRecord.app ??
      responseRecord.application;
    if (app === undefined) {
      return undefined;
    }
    const avatarUrl = firstString(
      app.avatar_url,
      app.icon_url,
      app.logo_url,
      app.image_url,
      typeof app.avatar?.avatar_72 === "string" ? app.avatar.avatar_72 : undefined,
      typeof app.avatar?.avatar_240 === "string" ? app.avatar.avatar_240 : undefined,
      typeof app.avatar?.avatar_origin === "string" ? app.avatar.avatar_origin : undefined,
      senderProfileAvatarUrl(sender),
    );
    const name = firstString(
      app.app_name,
      app.name,
      app.display_name,
      sender.name,
    );
    const displayName = firstString(
      app.display_name,
      app.app_name,
      app.name,
      sender.display_name,
      sender.name,
    );
    return {
      externalUserId: appId,
      userType: "bot",
      appId: firstString(app.app_id, appId) ?? appId,
      ...(name !== undefined ? { name } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(sender.tenant_key !== undefined ? { tenantKey: sender.tenant_key } : {}),
      rawProfile: app,
    };
  }

  private async _resolveFeishuChatProfile(
    chatId: string,
    chatType: InboundChatType,
    tenantKey: string | undefined,
  ): Promise<ChannelChatProfileSnapshot> {
    const cached = this._chatProfileCache.get(chatId);
    if (cached !== undefined || this._chatProfileCache.has(chatId)) {
      return cached ?? {
        externalChatId: chatId,
        ...(chatType !== undefined ? { chatType } : {}),
        ...(tenantKey !== undefined ? { tenantKey } : {}),
      };
    }

    let profile: ChannelChatProfileSnapshot | undefined;
    try {
      const imClient = this._client as unknown as {
        readonly im?: {
          readonly v1?: {
            readonly chat?: {
              readonly get?: (args: {
                readonly path: { readonly chat_id: string };
              }) => Promise<unknown>;
            };
          };
        };
      };
      const response = await imClient.im?.v1?.chat?.get?.({
        path: { chat_id: chatId },
      });
      profile = this._mapFeishuChatProfile(response, chatId, chatType, tenantKey);
    } catch (err) {
      this._logger.warn(
        { err, channel_id: this.id, external_chat_id: chatId },
        "Failed to resolve Feishu chat profile; falling back to event chat identity",
      );
    }

    profile ??= {
      externalChatId: chatId,
      ...(chatType !== undefined ? { chatType } : {}),
      ...(tenantKey !== undefined ? { tenantKey } : {}),
    };
    this._chatProfileCache.set(chatId, profile);
    return profile;
  }

  private _mapFeishuChatProfile(
    response: unknown,
    chatId: string,
    chatType: InboundChatType,
    tenantKey: string | undefined,
  ): ChannelChatProfileSnapshot | undefined {
    if (typeof response !== "object" || response === null) {
      return undefined;
    }
    const responseRecord = response as {
      readonly data?: Record<string, unknown> & {
        readonly chat?: Record<string, unknown>;
      };
      readonly chat?: Record<string, unknown>;
    };
    const chat = responseRecord.data?.chat ?? responseRecord.chat ?? responseRecord.data;
    if (chat === undefined) {
      return undefined;
    }
    const name = firstString(chat.name, chat.i18n_names);
    const displayName = firstString(chat.name, chat.description);
    const chatMode = firstString(chat.chat_mode);
    const normalizedMode =
      chatMode === "p2p"
        ? "p2p"
        : chatMode === "group" || chatMode === "topic"
          ? "group"
          : undefined;
    const rawChatType = firstString(chat.chat_type);
    const normalizedChatType =
      rawChatType === "p2p" || rawChatType === "group" ? rawChatType : undefined;
    const profileChatType = normalizedMode ?? normalizedChatType ?? chatType;
    const avatarUrl = firstString(chat.avatar, chat.avatar_url);
    const profileTenantKey = firstString(chat.tenant_key, tenantKey);
    return {
      externalChatId: chatId,
      ...(name !== undefined ? { name } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(profileChatType !== undefined ? { chatType: profileChatType } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(profileTenantKey !== undefined ? { tenantKey: profileTenantKey } : {}),
      rawProfile: chat,
    };
  }

  private async _resolveBotIdentity(): Promise<void> {
    if (this._getConfiguredBotIdentity()?.displayName !== undefined) {
      return;
    }
    try {
      const response = await this._client.request<FeishuBotInfoResponse>({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      const bot = response.bot ?? response.data?.bot;
      if (bot?.open_id === undefined) {
        this._logger.warn(
          { channel_id: this.id },
          "Feishu bot identity response missing open_id; group mentions require configured bot_open_id",
        );
        return;
      }
      const avatarUrl = firstString(
        bot.avatar_url,
        bot.avatar?.avatar_72,
        bot.avatar?.avatar_240,
        bot.avatar?.avatar_origin,
      );
      const displayName = botDisplayName(bot);
      this._resolvedBotIdentity = {
        openId: bot.open_id,
        ...(bot.user_id !== undefined ? { userId: bot.user_id } : {}),
        ...(bot.union_id !== undefined ? { unionId: bot.union_id } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      };
      this._logger.info(
        { channel_id: this.id, bot_open_id: bot.open_id },
        "resolved Feishu bot identity for group activation",
      );
    } catch (err) {
      this._logger.warn(
        { channel_id: this.id, err },
        "failed to resolve Feishu bot identity; group mentions require configured bot_open_id",
      );
    }
  }

  /**
   * A configured bot id is authoritative; the profile Feishu reports at start
   * fills in the name and avatar when it names the same bot, so a rename in
   * Feishu reaches Luna on the next start.
   */
  private _getBotIdentity(): FeishuBotIdentity | undefined {
    const configured = this._getConfiguredBotIdentity(), resolved = this._resolvedBotIdentity;
    if (configured === undefined) return resolved;
    if (resolved === undefined || configured.displayName !== undefined
      || (configured.openId !== undefined && configured.openId !== resolved.openId)) return configured;
    return {
      ...configured,
      ...(resolved.displayName !== undefined ? { displayName: resolved.displayName } : {}),
      ...(resolved.avatarUrl !== undefined ? { avatarUrl: resolved.avatarUrl } : {}),
    };
  }

  private _getConfiguredBotIdentity(): FeishuBotIdentity | undefined {
    const displayName = this._configuredBotDisplayName();
    const identity: FeishuBotIdentity = {
      ...(this.config.botOpenId !== undefined
        ? { openId: this.config.botOpenId }
        : {}),
      ...(this.config.botUserId !== undefined
        ? { userId: this.config.botUserId }
        : {}),
      ...(this.config.botUnionId !== undefined
        ? { unionId: this.config.botUnionId }
        : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    };
    return identity.openId !== undefined ||
      identity.userId !== undefined ||
      identity.unionId !== undefined
      ? identity
      : undefined;
  }

  private _outboundSender(): ChannelIdentity {
    const botIdentity = this._getBotIdentity();
    if (botIdentity === undefined) {
      const displayName = this._configuredBotDisplayName();
      return {
        externalId: "luna-bot",
        kind: "bot",
        ...(displayName !== undefined ? { displayName } : {}),
      };
    }
    return this._channelIdentityFromBotIdentity(botIdentity);
  }

  private _configuredBotDisplayName(): string | undefined {
    return firstString(...this._groupBotAliases());
  }

  private _groupBotAliases(): readonly string[] {
    const aliases = this.config.groupBotAliases;
    return typeof aliases === "function" ? aliases() : aliases ?? [];
  }

  private async _markProcessing(messageId: string): Promise<void> {
    try {
      const reactionType = randomFeishuProcessingReactionType();
      const response = await this._client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: reactionType } },
      });
      const reactionId = response.data?.reaction_id;
      if (reactionId) {
        this._processingReactionIds.set(messageId, reactionId);
        this._persistProcessingMarker(messageId, reactionId, reactionType);
      }
    } catch (err) {
      this._logger.warn({ err, message_id: messageId }, "Failed to add Feishu processing reaction");
    }
  }

  private async _clearProcessingReaction(messageId: string): Promise<void> {
    const reactionId = this._processingReactionIds.get(messageId) ??
      this._findPersistedProcessingMarker(messageId);
    if (!reactionId) {
      return;
    }
    try {
      await this._client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      this._processingReactionIds.delete(messageId);
      this._deletePersistedProcessingMarker(messageId);
    } catch (err) {
      this._logger.warn({ err, message_id: messageId }, "Failed to clear Feishu processing reaction");
    }
  }

  private _persistProcessingMarker(
    messageId: string,
    reactionId: string,
    reactionType: string,
  ): void {
    this._markerStore()?.upsert({
      channelType: this.type,
      channelId: this.id,
      messageId,
      markerType: PROCESSING_MARKER_TYPE,
      providerMarkerId: reactionId,
      providerPayloadJson: { reactionType },
    });
  }

  private _findPersistedProcessingMarker(
    messageId: string,
  ): string | undefined {
    return this._markerStore()?.find({
      channelType: this.type,
      channelId: this.id,
      messageId,
      markerType: PROCESSING_MARKER_TYPE,
    })?.providerMarkerId;
  }

  private _deletePersistedProcessingMarker(messageId: string): void {
    this._markerStore()?.delete({
      channelType: this.type,
      channelId: this.id,
      messageId,
      markerType: PROCESSING_MARKER_TYPE,
    });
  }

  private _markerStore(): ChannelMessageMarkerStore | undefined {
    return this.config.db === undefined
      ? undefined
      : new ChannelMessageMarkerStore(this.config.db);
  }

  private _handleMessageRecall = async (data: {
    message_id?: string;
    chat_id?: string;
    recall_time?: string;
    recall_type?: string;
  }) => {
    if (!data.message_id) return;
    this._logger.info({ message_id: data.message_id }, "message recalled");
    this.emit("message:recalled", data.message_id, this.id);
  };

  private _handleBotAddedToGroup = async (data: FeishuBotAddedToGroupEventData) => {
    this._markInboundConnected();
    const event = botAddedToGroupEvent(data, this.id);
    if (event === null) {
      this._logger.warn(
        {
          channel_id: this.id,
          raw_event_id: data.event_id,
          raw_chat_id: data.chat_id,
          raw_operator_open_id: data.operator_id?.open_id,
        },
        "Ignoring Feishu bot-added event because required fields are missing",
      );
      return;
    }
    this._logger.info(
      {
        channel_id: this.id,
        chat_id: event.chatId,
        event_id: event.eventId,
        operator_open_id: event.operatorOpenId,
        tenant_key: event.tenantKey,
        occurred_at: event.occurredAt,
      },
      "Received Feishu bot-added event",
    );
    if (this._groupJoinBackfill === undefined) {
      this._logger.warn(
        {
          channel_id: this.id,
          chat_id: event.chatId,
          event_id: event.eventId,
        },
        "Skipping Feishu group join backfill because database support is unavailable",
      );
      return;
    }
    try {
      const result = await this._groupJoinBackfill.backfillOnBotAddedToGroup(event);
      this._logger.info(
        {
          channel_id: this.id,
          chat_id: event.chatId,
          event_id: event.eventId,
          imported_count: result.importedCount,
          skipped_count: result.skippedCount,
        },
        "Feishu bot-added backfill finished",
      );
    } catch (err) {
      this._logger.warn(
        {
          channel_id: this.id,
          chat_id: event.chatId,
          event_id: event.eventId,
          ..._feishuErrorLogDetails(err),
        },
        "Failed to backfill Feishu group history after bot join",
      );
    }
  };

  private _threadIdToSessionId = new Map<string, string>();

  /**
   * Map a thread to a runtime session in memory.
   * TODO(Task 2): migrate this to Session/WorkContext persistence.
   */
  private _mapThreadToSession(threadId: string, sessionId: string) {
    this._threadIdToSessionId.set(threadId, sessionId);
  }

  /** Resolve a session ID from a thread ID, falling back to a new runtime ID. */
  private _resolveSessionId(threadId: string | undefined): string {
    if (threadId && this._threadIdToSessionId.has(threadId)) {
      return this._threadIdToSessionId.get(threadId)!;
    }
    return uuid();
  }

  private async _parseMessageContent(
    messageId: string,
    type: string,
    content: unknown,
    resourceMessageId = messageId,
  ): Promise<ParsedFeishuMessageContent> {
    if (type === "text") {
      const parsed = parseFeishuContentRecord(content);
      if (parsed.record !== null && typeof parsed.record.text === "string") {
        const nestedCardMarkdown = extractFeishuStructuredCardMarkdown(
          parsed.record.text,
        );
        if (nestedCardMarkdown !== null) {
          return {
            type: "text",
            text: nestedCardMarkdown,
            contentKind: "card",
            presentationKind: "provider_rich_card",
            providerMessageType: "text",
            presentation: {
              kind: "rich_markdown_card",
            },
          };
        }
        return {
          type: "text",
          text: parsed.record.text,
          contentKind: "text",
          presentationKind: "plain",
          providerMessageType: "text",
        };
      }

      const cardMarkdown = extractFeishuStructuredCardMarkdown(
        parsed.record ?? content,
      );
      if (cardMarkdown !== null) {
        return {
          type: "text",
          text: cardMarkdown,
          contentKind: "card",
          presentationKind: "provider_rich_card",
          providerMessageType: "text",
          presentation: {
            kind: "rich_markdown_card",
          },
        };
      }

      if (parsed.error !== null) {
        throw new Error(
          `Message ${messageId} has invalid Feishu text content: malformed JSON`,
          { cause: parsed.error },
        );
      }
      throw new Error(
        `Message ${messageId} has invalid Feishu text content: expected string text field`,
      );
    }

    if (type === "merge_forward") {
      return await this._parseMergeForwardContent(messageId);
    }

    const parsed = parseFeishuContentRecord(content);
    if (parsed.record === null) {
      throw new Error(
        `Message ${messageId} has invalid Feishu ${type} content: malformed JSON`,
        ...(parsed.error !== null ? [{ cause: parsed.error }] : []),
      );
    }
    const json = parsed.record;
    if (type === "post") {
      const post = selectFeishuPostPayload(json);
      const converted = await convertPostToMarkdownAndMessageContentBlocks(
        post,
        this.downloadMessageResource.bind(this, resourceMessageId),
      );
      const contentBlocks = await Promise.all(
        converted.contentBlocks.map(async (block) =>
          block.type === "image" && block.url
            ? { ...block, ...await readDownloadedImageDimensions(block.url) }
            : block,
        ),
      );
      const hasStructuredMedia = contentBlocks.some(
        (block) => block.type === "image" || block.type === "file",
      );
      return {
        type: "text",
        text: converted.markdown,
        ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
        contentKind: postHasMedia(post) ? "mixed" : "rich_text",
        presentationKind: hasStructuredMedia ? "image_gallery" : "rich_markdown",
        providerMessageType: "post",
      };
    } else if (type === "image") {
      const file_key = json.image_key as string;
      let path: string;
      try {
        path = await this.downloadMessageResource(resourceMessageId, file_key);
      } catch (err) {
        this._logger.warn(
          { err, message_id: messageId, resource_message_id: resourceMessageId, file_key },
          "Failed to download Feishu image resource",
        );
        return {
          type: "text",
          text: "[图片消息：资源暂时无法下载]",
          contentKind: "image",
          presentationKind: "image_gallery",
          providerMessageType: "image",
        };
      }
      return {
        type: "text",
        text: `![user_uploaded_image](${path})`,
        contentBlocks: [{
          type: "image",
          fileId: file_key,
          url: path,
          alt: "user_uploaded_image",
          source: { provider: "feishu", imageKey: file_key },
          ...await readDownloadedImageDimensions(path),
        }],
        contentKind: "image",
        presentationKind: "image_gallery",
        providerMessageType: "image",
      };
    } else if (type === "file") {
      const file_key = json.file_key as string;
      const file_name = json.file_name as string;
      let path: string;
      try {
        path = await this.downloadMessageResource(
          resourceMessageId,
          file_key,
          file_name,
        );
      } catch (err) {
        this._logger.warn(
          {
            err,
            message_id: messageId,
            resource_message_id: resourceMessageId,
            file_key,
            file_name,
          },
          "Failed to download Feishu file resource",
        );
        return {
          type: "text",
          text: file_name
            ? `文件消息：${file_name}（资源暂时无法下载）`
            : "文件消息：资源暂时无法下载",
          contentKind: "file",
          presentationKind: "file_attachment",
          providerMessageType: "file",
        };
      }
      return {
        type: "text",
        text: `A new file message uploaded to \`${path}\``,
        contentKind: "file",
        presentationKind: "file_attachment",
        providerMessageType: "file",
      };
    } else if (type === "interactive") {
      const markdown = extractFeishuInteractiveMarkdown(json);
      return {
        type: "text",
        text: markdown ?? "Unsupported interactive message",
        contentKind: "card",
        presentationKind: "provider_rich_card",
        providerMessageType: "interactive",
        ...(markdown !== null
          ? {
              presentation: {
                kind: "rich_markdown_card",
              },
            }
          : {}),
      };
    } else {
      this._logger.error(`Unsupported message type: ${type}`);
      return {
        type: "text",
        text: "Unsupported message type" + type,
        contentKind: "unknown",
        presentationKind: "unknown",
        providerMessageType: type,
      };
    }
  }

  private async _parseMergeForwardContent(
    messageId: string,
  ): Promise<ParsedFeishuMessageContent> {
    const items = await this._fetchMergeForwardItems(messageId);
    const childrenByParent = buildMergeForwardChildrenMap(items, messageId);
    const parsed = await this._parseMergeForwardChildren({
      rootMessageId: messageId,
      parentMessageId: messageId,
      childrenByParent,
    });

    const text = parsed.parts.length > 0
      ? parsed.parts.join("\n\n")
      : "合并转发消息（未读取到可展示内容）";
    return {
      type: "text",
      text,
      ...(parsed.mentions.length > 0 ? { mentions: parsed.mentions } : {}),
      ...(parsed.relatedIdentities.length > 0
        ? { relatedIdentities: parsed.relatedIdentities }
        : {}),
      contentKind: "card",
      presentationKind: "provider_rich_card",
      providerMessageType: "merge_forward",
      presentation: {
        kind: "rich_markdown_card",
      },
    };
  }

  private async _fetchMergeForwardItems(
    messageId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    try {
      const response = await this._client.im.v1.message.get({
        path: { message_id: messageId },
      });
      const items = readPath(response, ["data", "items"]);
      return Array.isArray(items) ? items.filter(isRecord) : [];
    } catch (err) {
      this._logger.warn(
        { err, message_id: messageId },
        "Failed to fetch Feishu merge-forward message items",
      );
      return [];
    }
  }

  private async _mergeForwardSenderIdentity(
    item: Record<string, unknown>,
    messageId: string,
    identityHints: ReadonlyMap<string, ChannelIdentity>,
  ): Promise<ChannelIdentity | undefined> {
    const sender = mergeForwardSenderInput(item);
    if (sender === undefined) {
      return undefined;
    }
    const currentAppSenderIdentity = this._currentAppSenderIdentity(sender);
    if (currentAppSenderIdentity !== undefined) {
      return currentAppSenderIdentity;
    }
    const baseIdentity = resolveFeishuSenderIdentity({
      identityScope: this._identityScope,
      sender,
      messageId,
    });
    if (baseIdentity.kind !== "user") {
      return baseIdentity;
    }

    const profile = await this._resolveFeishuUserProfile(sender);
    const resolvedIdentity = profile === undefined
      ? baseIdentity
      : enrichSenderIdentity(baseIdentity, profile);
    return applyIdentityHint(resolvedIdentity, identityHints);
  }

  private _currentAppSenderIdentity(
    sender: MessageReceiveEventData["sender"],
  ): ChannelIdentity | undefined {
    const appId = sender.sender_id?.app_id;
    if (sender.sender_type !== "app" || appId !== this.config.appId) {
      return undefined;
    }

    const botIdentity = this._getBotIdentity();
    if (botIdentity === undefined) {
      return {
        externalId: appId,
        kind: "bot",
        providerIds: {
          app_id: appId,
          ...(sender.tenant_key !== undefined ? { tenant_key: sender.tenant_key } : {}),
        },
        rawProfile: sender,
      };
    }

    const identity = this._channelIdentityFromBotIdentity(botIdentity);
    return {
      ...identity,
      providerIds: {
        ...identity.providerIds,
        app_id: appId,
        ...(sender.tenant_key !== undefined ? { tenant_key: sender.tenant_key } : {}),
      },
      rawProfile: sender,
    };
  }

  private _mergeForwardMentions(
    item: Record<string, unknown>,
    messageId: string,
  ): readonly ChannelMention[] {
    const mentions = readPath(item, ["mentions"]);
    if (!Array.isArray(mentions)) {
      return [];
    }
    const botIdentity = this._getBotIdentity();
    const botChannelIdentity = botIdentity === undefined
      ? undefined
      : this._channelIdentityFromBotIdentity(botIdentity);

    return mentions.flatMap((mention): ChannelMention[] => {
      const eventItem = mergeForwardMentionEventItem(mention, messageId);
      if (eventItem === undefined) {
        return [];
      }
      const target = resolveFeishuMentionTarget({
      identityScope: this._identityScope,
        mention: eventItem,
        ...(botChannelIdentity !== undefined
          ? { botIdentity: botChannelIdentity }
          : {}),
      });
      return [
        {
          key: eventItem.key,
          label: feishuMentionLabel(eventItem),
          target,
          rawMention: {
            source: mention,
            source_message_id: messageId,
          },
        },
      ];
    });
  }

  private _mergeForwardIdentityHints(
    items: readonly Record<string, unknown>[],
  ): ReadonlyMap<string, ChannelIdentity> {
    const hints = new Map<string, ChannelIdentity>();
    for (const item of items) {
      const messageId = stringField(item, "message_id") ?? "";
      const mentions = this._mergeForwardMentions(item, messageId);
      for (const mention of mentions) {
        if (mention.target.displayName === undefined) {
          continue;
        }
        for (const id of stableIdentityIds(mention.target)) {
          if (!hints.has(id)) {
            hints.set(id, mention.target);
          }
        }
      }
    }
    return hints;
  }

  private async _parseMergeForwardChildren(input: {
    readonly rootMessageId: string;
    readonly parentMessageId: string;
    readonly childrenByParent: Map<string, readonly Record<string, unknown>[]>;
  }): Promise<{
    readonly parts: readonly string[];
    readonly mentions: readonly ChannelMention[];
    readonly relatedIdentities: readonly ChannelIdentity[];
  }> {
    const childItems = (input.childrenByParent.get(input.parentMessageId) ?? [])
      .slice(0, 50);
    const identityHints = this._mergeForwardIdentityHints(childItems);
    const parts: string[] = [];
    const mentions: ChannelMention[] = [];
    const relatedIdentities: ChannelIdentity[] = [];

    for (const item of childItems) {
      const childMessageId = stringField(item, "message_id") ?? input.rootMessageId;
      const childType = stringField(item, "msg_type") ?? "text";
      const childIdentity = await this._mergeForwardSenderIdentity(
        item,
        childMessageId,
        identityHints,
      );
      if (childIdentity !== undefined) {
        relatedIdentities.push(childIdentity);
      }
      const childSenderMention = childIdentity === undefined
        ? undefined
        : mergeForwardSenderMention(childMessageId, childIdentity);
      const childMentions = this._mergeForwardMentions(item, childMessageId);
      mentions.push(...childMentions);
      let parsed: ParsedFeishuMessageContent;
      try {
        if (childType === "merge_forward") {
          const nested = await this._parseMergeForwardChildren({
            rootMessageId: input.rootMessageId,
            parentMessageId: childMessageId,
            childrenByParent: input.childrenByParent,
          });
          mentions.push(...nested.mentions);
          relatedIdentities.push(...nested.relatedIdentities);
          if (nested.parts.length === 0) {
            continue;
          }
          parsed = {
            type: "text",
            text: nested.parts.join("\n\n"),
            contentKind: "card",
            presentationKind: "provider_rich_card",
            providerMessageType: "merge_forward",
            presentation: {
              kind: "rich_markdown_card",
            },
          };
        } else {
          parsed = await this._parseMessageContent(
            childMessageId,
            childType,
            messageItemContent(item),
            input.rootMessageId,
          );
          if (childMentions.length > 0) {
            parsed = {
              ...parsed,
              text: contextualizeMergeForwardMentionKeys(
                parsed.text,
                childMentions,
              ),
            };
          }
          if (childSenderMention !== undefined && parsed.text.trim().length > 0) {
            parsed = {
              ...parsed,
              text: `${childSenderMention.key}\n${parsed.text}`,
              mentions: mergeChannelMentions(
                [childSenderMention],
                parsed.mentions,
              ),
            };
          }
        }
      } catch (err) {
        this._logger.warn(
          {
            err,
            message_id: input.rootMessageId,
            child_message_id: childMessageId,
          },
          "Skipped unparsable Feishu merge-forward child message",
        );
        continue;
      }
      mentions.push(...parsed.mentions ?? []);
      relatedIdentities.push(...parsed.relatedIdentities ?? []);
      if (parsed.text.trim().length > 0) {
        parts.push(parsed.text.trim());
      }
    }

    return {
      parts,
      mentions: mergeChannelMentions(mentions),
      relatedIdentities: mergeChannelIdentities(relatedIdentities),
    };
  }

  private async _replyLunaMessage(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation> {
    const replyTarget =
      operation.targetMessageId === inbound.thread?.externalId
        ? inbound.id
        : operation.targetMessageId ?? inbound.id;
    if (operation.reply) {
      const payload = await this._replyPayload(operation);
      const { data, code } = await this._client.im.message.reply({ path: { message_id: replyTarget },
        data: { ...payload, reply_in_thread: true, ...(operation.idempotencyKey ? { uuid: createHash("sha256").update(operation.idempotencyKey).digest("base64url") } : {}) } });
      if (code) throw new ProviderDeliveryRejected(`Feishu rejected reply (${code})`);
      if (!data?.message_id) throw new Error("Feishu reply receipt is incomplete");
      return this._withReplyThreadMetadata(inbound, operation, data, data.message_id);
    }

    if (operation.taskResultCard !== undefined) {
      const card = await renderTaskResultCard(
        {
          ...operation.taskResultCard,
          content: this._operationContent(operation),
        },
        this._imageRenderOptions(operation),
      );
      const { data } = await this._client.im.message.reply({
        path: {
          message_id: replyTarget,
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });
      const messageId = data?.message_id;
      if (!messageId) {
        throw new Error("Failed to send Feishu Luna task result card");
      }
      return this._withReplyThreadMetadata(inbound, operation, data, messageId);
    }

    if (operation.batchSummaryCard !== undefined) {
      const { card, remainingChunks } = await this._renderBatchSummaryCard(
        operation,
      );
      const { data } = await this._client.im.message.reply({
        path: {
          message_id: replyTarget,
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });
      const messageId = data?.message_id;
      if (!messageId) {
        throw new Error("Failed to send Feishu Luna batch summary card");
      }
      await this._sendRemainingChunks(messageId, remainingChunks);
      return this._withReplyThreadMetadata(inbound, operation, data, messageId);
    }

    if (!this._isStatusCardOperation(operation)) {
      if (this._operationHasMarkdownImage(operation)) {
        const { data } = await this._client.im.message.reply({
          path: {
            message_id: replyTarget,
          },
          data: {
            msg_type: "post",
            content: await this._renderPostContentWithImages(
              this._operationContent(operation),
              operation.assetBasePath,
            ),
            reply_in_thread: true,
          },
        });
        const messageId = data?.message_id;
        if (!messageId) {
          throw new Error("Failed to send Feishu Luna thread reply");
        }
        return this._withReplyThreadMetadata(inbound, operation, data, messageId);
      }
      const { data } = await this._client.im.message.reply({
        path: {
          message_id: replyTarget,
        },
        data: {
          msg_type: "post",
          content: markdownPostContent(this._operationContent(operation)),
          reply_in_thread: true,
        },
      });
      const messageId = data?.message_id;
      if (!messageId) {
        throw new Error("Failed to send Feishu Luna thread reply");
      }
      return this._withReplyThreadMetadata(inbound, operation, data, messageId);
    }

    const card = await this._renderStatusOrMessageCard(operation);
    const { data } = await this._client.im.message.reply({
      path: {
        message_id: replyTarget,
      },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    });
    const messageId = data?.message_id;
    if (!messageId) {
      throw new Error("Failed to send Feishu Luna thread reply");
    }
    return this._withReplyThreadMetadata(inbound, operation, data, messageId);
  }

  private _withReplyThreadMetadata(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
    data: { readonly thread_id?: string | undefined } | undefined,
    messageId: string,
  ): OutboundChannelOperation {
    const targetMessageId = operation.targetMessageId ?? inbound.id;
    const rootMessageId =
      normalizedRootMessageExternalId(inbound) ??
      (targetMessageId !== inbound.thread?.externalId ? targetMessageId : undefined);
    return {
      ...operation,
      id: messageId,
      channelId: inbound.channel.id,
      sender: this._outboundSender(),
      ...(data?.thread_id !== undefined ? { threadId: data.thread_id } : {}),
      ...(rootMessageId !== undefined ? { rootMessageId } : {}),
    };
  }

  private async _renderStatusOrMessageCard(
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ) {
    if (
      operation.statusCard !== undefined ||
      this._isStatusCardOperation(operation)
    ) {
      return await renderStatusCard(
        {
          ...(operation.statusCard ?? { hideHeader: true }),
          ...(operation.statusCardState !== undefined
            ? { state: operation.statusCardState }
            : {}),
          content: this._operationContent(operation),
          steps: operation.statusCardSteps ?? [],
        },
        this._imageRenderOptions(operation),
      );
    }

    return await renderMessageCard([{
      type: "text",
      text: this._operationContent(operation),
    }], {
      streaming: false,
      ...this._imageRenderOptions(operation),
    });
  }

  private _isStatusCardOperation(
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): boolean {
    return (
      operation.statusCard !== undefined ||
      operation.statusCardState !== undefined ||
      (operation.statusCardSteps?.length ?? 0) > 0
    );
  }

  private async _createLunaChannelMessage(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation> {
    if (operation.reply) return this.sendTo({ channelId: this.id, surfaceId: inbound.surface.externalId }, operation);
    const batchCard = operation.batchSummaryCard
      ? await this._renderBatchSummaryCard(operation)
      : undefined;
    const statusCard =
      !batchCard && this._isStatusCardOperation(operation)
        ? await this._renderStatusOrMessageCard(operation)
        : undefined;
    const content = batchCard
      ? JSON.stringify(batchCard.card)
      : statusCard
        ? JSON.stringify(statusCard)
        : this._operationHasMarkdownImage(operation)
          ? await this._renderPostContentWithImages(
              this._operationContent(operation),
              operation.assetBasePath,
            )
          : markdownPostContent(this._operationContent(operation));
    const msgType = operation.batchSummaryCard
      ? "interactive"
      : statusCard
        ? "interactive"
        : "post";
    const replyTargetMessageId =
      testInjectReplyTargetMessageId(inbound) ??
      operation.targetMessageId ??
      inbound.id;
    this._logger.info(
      {
        reply_mode: operation.replyMode,
        target_message_id: replyTargetMessageId,
        msg_type: msgType,
        has_markdown_image: this._operationHasMarkdownImage(operation),
        content_preview: this._operationContent(operation).slice(0, 160),
      },
      "Sending Feishu channel reply",
    );
    const { data } = await this._client.im.message.reply({
      path: {
        message_id: replyTargetMessageId,
      },
      data: {
        msg_type: msgType,
        content,
      },
    });
    const messageId = data?.message_id;
    if (!messageId) {
      throw new Error("Failed to send Feishu Luna channel reply");
    }
    if (batchCard) {
      await this._sendRemainingChunks(messageId, batchCard.remainingChunks);
    }
    return {
      ...operation,
      id: messageId,
      channelId: inbound.channel.id,
      sender: this._outboundSender(),
    };
  }

  private async _patchLunaMessage(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation> {
    const targetMessageId = operation.targetMessageId;
    if (!targetMessageId) {
      throw new Error("Feishu status card update requires targetMessageId.");
    }
    let card;
    try {
      card = await this._renderStatusOrMessageCard(operation);
    } catch (err) {
      if (!isTransientFeishuUploadError(err)) {
        throw err;
      }
      this._logger.warn(
        { err, message_id: targetMessageId },
        "Feishu status card image upload retries exhausted; updating without inline images",
      );
      card = await this._renderStatusOrMessageCard({
        ...operation,
        content: withoutInlineMarkdownImages(operation.content),
      });
    }
    await this._client.im.message.patch({
      path: {
        message_id: targetMessageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
    return {
      ...operation,
      id: targetMessageId,
      channelId: inbound.channel.id,
      sender: this._outboundSender(),
    };
  }

  private async _replyPayload(operation: Omit<OutboundChannelOperation, "id" | "channelId">): Promise<{ msg_type: string; content: string }> {
    const reply = operation.reply;
    if (reply) {
      if (reply.content.some(block => block.type === "mention")) {
        const addresses = operation.inlineMentions ?? [];
        let index = 0;
        let markdown = "";
        let text = "";
        const flushText = () => {
          markdown += this._signOutboundArtifactLinks(text.replace(/<(?=\/?at\b)/gi, "&lt;"));
          text = "";
        };
        for (const block of reply.content) {
          if (block.type === "mention") {
            const user_id = addresses[index++];
            if (!user_id) throw new ProviderDeliveryRejected("Inline mention address is missing");
            flushText();
            markdown += formatFeishuAtTag(user_id);
          } else if (block.type === "image") {
            const path = this._resolveArtifactImagePath(block.artifactRef);
            if (!path) throw new ProviderDeliveryRejected(`Image artifact is unavailable: ${block.artifactRef}`);
            flushText();
            markdown += `![image](${await this.uploadImage(path)})`;
          } else {
            text += block.type === "text" ? block.text : replyMarkdown({ ...reply, content: [block], title: undefined });
          }
        }
        flushText();
        return { msg_type: "post", content: JSON.stringify({ zh_cn: { title: reply.title ?? "", content: [[{ tag: "md", text: markdown }]] } }) };
      }
      // Resolve every declared image before sending. Missing images must not
      // become a successful, text-only reply.
      for (const block of reply.content) {
        if (block.type === "image" && !this._resolveArtifactImagePath(block.artifactRef))
          throw new ProviderDeliveryRejected(`Image artifact is unavailable: ${block.artifactRef}`);
      }
      if (reply.presentation === "card") {
        const hasActions = reply.content.some(b => b.type === "actions");
        const contentWithoutActions = hasActions
          ? reply.content.filter(b => b.type !== "actions")
          : reply.content;
        const bodyText =
          contentWithoutActions.length > 0
            ? this._signOutboundArtifactLinks(
                replyMarkdown({
                  ...reply,
                  ...(reply.title ? { title: undefined } : {}),
                  content: contentWithoutActions,
                }),
              )
            : this._operationContent(operation);
        const card = await renderMessageCard(
          [{ type: "text", text: bodyText }],
          { streaming: false, ...this._imageRenderOptions(operation) },
        );
        card.config!.streaming_mode = false;
        if (hasActions) {
          card.config!.width_mode = "compact";
        }
        if (reply.title) {
          card.header = hasActions
            ? {
                icon: {
                  tag: "standard_icon",
                  token: "bell_outlined",
                  color: "blue",
                },
                title: { tag: "plain_text", content: reply.title },
                template: "wathet",
              }
            : {
                title: { tag: "plain_text", content: reply.title },
                template: reply.template === "result" ? "blue" : "indigo",
              };
        }
        for (const block of reply.content) {
          if (block.type !== "actions") continue;
          card.body.elements.push({ tag: "hr", margin: "8px 0 4px 0" });
          card.body.elements.push({
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "small",
            margin: "4px 0 0 0",
            columns: block.options.map((option, idx) => ({
              tag: "column" as const,
              width: "auto" as const,
              elements: [
                {
                  tag: "button" as const,
                  text: { tag: "plain_text" as const, content: option },
                  type:
                    idx === 0
                      ? ("primary_filled" as const)
                      : /^(婉拒|拒绝|驳回|decline|reject)$/i.test(option.trim())
                        ? ("danger" as const)
                        : ("default" as const),
                  behaviors: [
                    {
                      type: "callback" as const,
                      value: { requestId: block.requestId, option },
                    },
                  ],
                },
              ],
            })),
          });
        }
        return { msg_type: "interactive", content: JSON.stringify(card) };
      }
      const only = reply.content[0];
      if (reply.content.length === 1 && only?.type === "image" && !reply.title) {
        const image_key = await this.uploadImage(this._resolveArtifactImagePath(only.artifactRef)!);
        return { msg_type: "image", content: JSON.stringify({ image_key }) };
      }
    }
    if (this._operationHasMarkdownImage(operation)) return { msg_type: "post",
      content: await this._renderPostContentWithImages(this._operationContent(operation), operation.assetBasePath) };
    return { msg_type: "post", content: markdownPostContent(this._operationContent(operation)) };
  }

  private _operationContent(
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): string {
    return this._signOutboundArtifactLinks(
      wrapContentWithFeishuMentions(operation.content, operation.mention),
    );
  }

  private _signOutboundArtifactLinks(text: string): string {
    if (this.config.db === undefined || !text.includes("artifact:")) {
      return text;
    }

    const imageRefs: string[] = [];
    const imagePlaceholderPrefix = "__LUNA_FEISHU_ARTIFACT_IMAGE_";
    const protectedText = text.replace(
      /!\[[^\]]*\]\(artifact:[^)]+\)/g,
      (match) => {
        const index = imageRefs.push(match) - 1;
        return `${imagePlaceholderPrefix}${index}__`;
      },
    );
    const registry = new ArtifactRegistry(this.config.db);
    const artifactLink = (artifactId: string): {
      readonly label: string;
      readonly url: string;
    } | undefined => {
      const artifact = registry.getActive(artifactId);
      if (artifact === undefined) {
        return undefined;
      }
      return {
        label: artifact.name || artifact.id,
        url: this._publicArtifactPreviewUrl(artifact.id),
      };
    };

    const linked = protectedText
      .replace(
        /\[([^\]]+)\]\((artifact:([A-Za-z0-9._:-]+))\)/g,
        (match, label: string, _ref: string, artifactId: string) => {
          const link = artifactLink(artifactId);
          return link === undefined ? match : `[${label}](${link.url})`;
        },
      )
      .replace(
        /`artifact:([A-Za-z0-9._:-]+)`/g,
        (match, artifactId: string) => {
          const link = artifactLink(artifactId);
          return link === undefined ? match : `[${link.label}](${link.url})`;
        },
      )
      .replace(
        /artifact:([A-Za-z0-9._:-]+)/g,
        (match, artifactId: string) => {
          const link = artifactLink(artifactId);
          return link === undefined ? match : `[${link.label}](${link.url})`;
        },
      );

    return linked.replace(
      new RegExp(`${imagePlaceholderPrefix}(\\d+)__`, "g"),
      (match, index: string) => imageRefs[Number(index)] ?? match,
    );
  }

  private _publicArtifactPreviewUrl(artifactId: string): string {
    const path = signedArtifactPreviewUrl({
      artifactId,
      now: Date.now(),
      ttlMs: resolveArtifactSignedUrlTtlMs(this.config.db),
    });
    const publicUrl = resolvePublicBaseUrl(this.config.db);
    if (!publicUrl) {
      return path;
    }
    return new URL(path, publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`)
      .toString();
  }

  private async _renderBatchSummaryCard(
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<{
    card: Awaited<ReturnType<typeof renderBatchSummaryCard>>;
    remainingChunks: string[];
  }> {
    if (operation.batchSummaryCard === undefined) {
      throw new Error("Batch summary card operation metadata is required.");
    }
    const replyChunks = splitMarkdownByTables(this._operationContent(operation));
    const card = await renderBatchSummaryCard(
      {
        ...operation.batchSummaryCard,
        reply: replyChunks[0] ?? "",
      },
      this._imageRenderOptions(operation),
    );
    return {
      card,
      remainingChunks: replyChunks.slice(1),
    };
  }

  private _imageRenderOptions(
    operation: Pick<OutboundChannelOperation, "assetBasePath">,
  ): {
    uploadImage: (path: string) => Promise<string>;
    resolveImagePath: (imagePath: string) => string | undefined;
    maxVisibleSteps: number;
  } {
    return {
      uploadImage: this.uploadImage.bind(this),
      resolveImagePath: (imagePath: string) =>
        this._resolveOutboundImagePath(imagePath, operation.assetBasePath),
      maxVisibleSteps: this._maxVisibleSteps,
    };
  }

  private _resolveOutboundImagePath(
    imagePath: string,
    assetBasePath: string | undefined,
  ): string | undefined {
    const artifactPath = this._resolveArtifactImagePath(imagePath);
    if (artifactPath !== undefined) {
      return artifactPath;
    }
    const candidates: string[] = [];
    if (assetBasePath !== undefined && !nodePath.isAbsolute(imagePath)) {
      candidates.push(nodePath.resolve(assetBasePath, imagePath));
    }
    candidates.push(
      nodePath.isAbsolute(imagePath)
        ? nodePath.resolve(imagePath)
        : nodePath.resolve(config.paths.home, imagePath),
    );
    return candidates.find((path) => {
      return (
        fs.existsSync(path) &&
        (isPathContainedBy(path, config.paths.workspace) ||
          (assetBasePath !== undefined && isPathContainedBy(path, assetBasePath)))
      );
    });
  }

  private _resolveArtifactImagePath(imagePath: string): string | undefined {
    const artifactId = parseArtifactRef(imagePath);
    if (artifactId === undefined || this.config.db === undefined) {
      return undefined;
    }
    const artifact = new ArtifactRegistry(this.config.db).getActive(artifactId);
    if (
      artifact === undefined ||
      artifact.storage_backend !== "local" ||
      !fs.existsSync(artifact.storage_key)
    ) {
      return undefined;
    }
    return artifact.storage_key;
  }

  private _operationHasMarkdownImage(
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): boolean {
    return /!\[[^\]]*\]\([^)]+\)/.test(this._operationContent(operation));
  }

  private async _renderPostContentWithImages(
    text: string,
    assetBasePath: string | undefined,
  ): Promise<string> {
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const paragraphs: FeishuPostParagraph[] = [];
    let cursor = 0;

    const appendText = (value: string) => {
      const normalized = value.trim();
      if (normalized === "") {
        return;
      }
      paragraphs.push([{ tag: "md", text: normalized }]);
    };

    for (const match of text.matchAll(imageRegex)) {
      const rawMatch = match[0];
      const imagePath = match[2] ?? "";
      const index = match.index ?? 0;
      appendText(text.slice(cursor, index));
      cursor = index + rawMatch.length;

      if (imagePath === "" || imagePath.includes("://")) {
        continue;
      }

      const resolvedPath = this._resolveOutboundImagePath(
        imagePath,
        assetBasePath,
      );
      if (resolvedPath === undefined) {
        continue;
      }
      const imageKey = await this.uploadImage(resolvedPath);
      paragraphs.push([{ tag: "img", image_key: imageKey }]);
    }

    appendText(text.slice(cursor));

    return JSON.stringify({
      zh_cn: {
        content: paragraphs,
      },
    });
  }
}

type FeishuPostParagraph = Array<
  | { readonly tag: "md"; readonly text: string }
  | { readonly tag: "img"; readonly image_key: string }
>;

function isPathContainedBy(path: string, root: string): boolean {
  const relativePath = nodePath.relative(nodePath.resolve(root), nodePath.resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !nodePath.isAbsolute(relativePath));
}

function withoutInlineMarkdownImages(text: string): string {
  return text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt: string, target: string) =>
      alt.trim().length > 0 ? `[${alt}](${target})` : `图片：${target}`,
  );
}

function enrichNormalizedInboundWithDirectory(input: {
  readonly normalizedInbound: NormalizedInboundMessage;
  readonly directorySnapshots: {
    readonly senderProfile?: ChannelUserProfileSnapshot;
    readonly chatProfile?: ChannelChatProfileSnapshot;
  };
  readonly sender: MessageReceiveEventData["sender"];
  readonly receivedMessage: MessageReceiveEventData["message"];
}): NormalizedInboundMessage {
  const sender = enrichSenderIdentity(
    input.normalizedInbound.sender,
    input.directorySnapshots.senderProfile,
  );
  const surface = enrichChannelSurface(
    input.normalizedInbound.surface,
    input.directorySnapshots.chatProfile,
  );
  return {
    ...input.normalizedInbound,
    sender,
    surface,
    rawPayload: {
      sender: input.sender,
      message: input.receivedMessage,
      normalized: input.normalizedInbound,
    },
  };
}

function enrichSenderIdentity(
  identity: ChannelIdentity,
  profile: ChannelUserProfileSnapshot | undefined,
): ChannelIdentity {
  if (profile === undefined) {
    return identity;
  }
  const providerIds = compactStringRecord({
    app_id: profile.appId,
    open_id: profile.openId,
    user_id: profile.userId,
    union_id: profile.unionId,
    tenant_key: profile.tenantKey,
    ...identity.providerIds,
  });
  return {
    ...identity,
    externalId: profile.externalUserId ?? identity.externalId,
    kind: normalizeIdentityKind(profile.userType, identity.kind),
    ...(profile.displayName ?? profile.name
      ? { displayName: profile.displayName ?? profile.name }
      : {}),
    ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
    ...(providerIds !== undefined ? { providerIds } : {}),
    rawProfile: profile.rawProfile ?? identity.rawProfile,
  };
}

function enrichChannelSurface(
  surface: ChannelSurface,
  profile: ChannelChatProfileSnapshot | undefined,
): ChannelSurface {
  if (profile === undefined) {
    return surface;
  }
  const providerIds = compactStringRecord({
    tenant_key: profile.tenantKey,
    ...surface.providerIds,
  });
  return {
    ...surface,
    externalId: profile.externalChatId ?? surface.externalId,
    kind: normalizeSurfaceKind(profile.chatType, surface.kind),
    ...(profile.displayName ?? profile.name
      ? { displayName: profile.displayName ?? profile.name }
      : {}),
    ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
    ...(providerIds !== undefined ? { providerIds } : {}),
    rawProfile: profile.rawProfile ?? surface.rawProfile,
  };
}

function normalizeIdentityKind(
  value: string | undefined,
  fallback: ChannelIdentity["kind"],
): ChannelIdentity["kind"] {
  return value === "bot" || value === "system" || value === "unknown"
    ? value
    : value === "user"
      ? "user"
      : fallback;
}

function normalizeSurfaceKind(
  value: string | undefined,
  fallback: ChannelSurface["kind"],
): ChannelSurface["kind"] {
  return value === "p2p" ||
    value === "group" ||
    value === "channel" ||
    value === "thread" ||
    value === "webhook" ||
    value === "ticket"
    ? value
    : fallback;
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

function mergeChannelMentions(
  ...groups: readonly (readonly ChannelMention[] | undefined)[]
): ChannelMention[] {
  const merged = new Map<string, ChannelMention>();
  for (const mention of groups.flatMap((group) => group ?? [])) {
    const key = `${mention.key}\u0000${mention.target.externalId}`;
    if (!merged.has(key)) {
      merged.set(key, mention);
    }
  }
  return [...merged.values()];
}

function chatHumanCount(
  profile: ChannelChatProfileSnapshot | undefined,
): number | undefined {
  const rawCount = readPath(profile?.rawProfile, ["user_count"]);
  if (typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount >= 0) {
    return rawCount;
  }
  if (typeof rawCount === "string" && /^\d+$/.test(rawCount)) {
    return Number.parseInt(rawCount, 10);
  }
  return undefined;
}

function mergeChannelIdentities(
  ...groups: readonly (readonly ChannelIdentity[] | undefined)[]
): ChannelIdentity[] {
  const merged = new Map<string, ChannelIdentity>();
  for (const identity of groups.flatMap((group) => group ?? [])) {
    const key = `${identity.kind}\u0000${identity.externalId}`;
    const existing = merged.get(key);
    merged.set(key, existing === undefined
      ? identity
      : {
          ...existing,
          ...identity,
          providerIds: {
            ...existing.providerIds,
            ...identity.providerIds,
          },
          rawProfile: identity.rawProfile ?? existing.rawProfile,
        });
  }
  return [...merged.values()];
}

function applyIdentityHint(
  identity: ChannelIdentity,
  hints: ReadonlyMap<string, ChannelIdentity>,
): ChannelIdentity {
  const hint = stableIdentityIds(identity)
    .map((id) => hints.get(id))
    .find((candidate): candidate is ChannelIdentity => candidate !== undefined);
  if (hint === undefined) {
    return identity;
  }
  return {
    ...identity,
    ...(identity.displayName !== undefined
      ? {}
      : hint.displayName !== undefined
        ? { displayName: hint.displayName }
        : {}),
    ...(identity.avatarUrl !== undefined
      ? {}
      : hint.avatarUrl !== undefined
        ? { avatarUrl: hint.avatarUrl }
        : {}),
    providerIds: {
      ...hint.providerIds,
      ...identity.providerIds,
    },
    rawProfile: identity.rawProfile ?? hint.rawProfile,
  };
}

function stableIdentityIds(identity: ChannelIdentity): string[] {
  return [
    identity.externalId,
    ...Object.values(identity.providerIds ?? {}),
  ].filter(
    (value, index, values) =>
      value.length > 0 && values.indexOf(value) === index,
  );
}

function contextualizeMergeForwardMentionKeys(
  text: string,
  mentions: readonly ChannelMention[],
): string {
  let rendered = text;
  for (const mention of mentions) {
    const rawKey = rawMergeForwardMentionKey(mention.rawMention);
    if (rawKey === undefined || rawKey === mention.key) {
      continue;
    }
    rendered = rendered.split(rawKey).join(mention.key);
  }
  return rendered;
}

function withMentionedType(
  rawProfile: unknown,
  mentionedType: "bot" | "system",
): unknown {
  if (
    typeof rawProfile !== "object" ||
    rawProfile === null ||
    Array.isArray(rawProfile)
  ) {
    return { mentioned_type: mentionedType };
  }
  return {
    ...(rawProfile as Record<string, unknown>),
    mentioned_type: mentionedType,
  };
}

function mergeForwardSenderMention(
  messageId: string,
  identity: ChannelIdentity,
): ChannelMention {
  return {
    key: `${messageId}:@sender`,
    label: mentionLabelFromIdentity(identity),
    target: identity,
    rawMention: {
      source: "merge_forward_sender",
      source_message_id: messageId,
      external_id: identity.externalId,
    },
  };
}

function mentionLabelFromIdentity(identity: ChannelIdentity): string {
  const display = identity.displayName?.trim() || identity.externalId;
  return display.startsWith("@") ? display : `@${display}`;
}

function senderProfileDisplayName(
  sender: MessageReceiveEventData["sender"],
): string | undefined {
  return firstString(sender.display_name, sender.name, sender.nickname);
}

function senderProfileAvatarUrl(
  sender: MessageReceiveEventData["sender"],
): string | undefined {
  const avatar = sender.avatar;
  return firstString(
    sender.avatar_url,
    typeof avatar?.avatar_72 === "string" ? avatar.avatar_72 : undefined,
    typeof avatar?.avatar_240 === "string" ? avatar.avatar_240 : undefined,
    typeof avatar?.avatar_origin === "string" ? avatar.avatar_origin : undefined,
  );
}

function historySenderToEventSender(
  sender: FeishuHistoryMessageRecord["sender"] | undefined,
): MessageReceiveEventData["sender"] | undefined {
  if (sender?.id === undefined || sender.id.length === 0) {
    return undefined;
  }
  const senderId = sender.id_type === "user_id"
    ? { user_id: sender.id }
    : sender.id_type === "union_id"
      ? { union_id: sender.id }
      : sender.id_type === "app_id"
        ? { app_id: sender.id }
        : { open_id: sender.id };
  return {
    sender_id: senderId,
    sender_type: sender.sender_type ?? "user",
    ...(sender.tenant_key !== undefined ? { tenant_key: sender.tenant_key } : {}),
    ...(sender.sender_name !== undefined ? { name: sender.sender_name } : {}),
    ...(sender.sender_name !== undefined
      ? { display_name: sender.sender_name }
      : {}),
  };
}

function rawMergeForwardMentionKey(rawMention: unknown): string | undefined {
  const record = isRecord(rawMention) ? rawMention : undefined;
  const source = isRecord(record?.source) ? record.source : undefined;
  return stringField(source ?? {}, "key");
}

function mergeForwardSenderInput(
  item: Record<string, unknown>,
): MessageReceiveEventData["sender"] | undefined {
  const sender = readPath(item, ["sender"]);
  if (!isRecord(sender)) {
    return undefined;
  }
  const senderId = stringField(sender, "id");
  if (senderId === undefined) {
    return undefined;
  }
  const idType = stringField(sender, "id_type") ?? "open_id";
  const senderIdRecord = idType === "user_id"
    ? { user_id: senderId }
    : idType === "union_id"
      ? { union_id: senderId }
      : idType === "app_id" || stringField(sender, "sender_type") === "app"
        ? { app_id: senderId }
        : { open_id: senderId };
  const tenantKey = stringField(sender, "tenant_key");
  const name = firstString(
    stringField(sender, "name"),
    stringField(sender, "sender_name"),
    stringField(sender, "username"),
  );
  const displayName = firstString(
    stringField(sender, "display_name"),
    stringField(sender, "displayName"),
    name,
  );
  const nickname = stringField(sender, "nickname");
  const avatarUrl = firstString(
    stringField(sender, "avatar_url"),
    stringField(sender, "avatarUrl"),
    stringField(sender, "avatar"),
  );
  const avatar = readPath(sender, ["avatar"]);
  return {
    sender_id: senderIdRecord,
    sender_type: stringField(sender, "sender_type") ?? "user",
    ...(tenantKey !== undefined ? { tenant_key: tenantKey } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(displayName !== undefined ? { display_name: displayName } : {}),
    ...(nickname !== undefined ? { nickname } : {}),
    ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {}),
    ...(isRecord(avatar) ? { avatar } : {}),
  };
}

function mergeForwardMentionEventItem(
  mention: unknown,
  messageId: string,
): FeishuMentionEventItem | undefined {
  if (!isRecord(mention)) {
    return undefined;
  }
  const key = stringField(mention, "key");
  if (key === undefined) {
    return undefined;
  }
  const id = mergeForwardMentionIds(mention);
  if (id === undefined) {
    return undefined;
  }
  const name = stringField(mention, "name");
  const mentionedType = stringField(mention, "mentioned_type");
  const tenantKey = stringField(mention, "tenant_key");
  return {
    key: `${messageId}:${key}`,
    id,
    ...(name !== undefined ? { name } : {}),
    ...(mentionedType !== undefined ? { mentioned_type: mentionedType } : {}),
    ...(tenantKey !== undefined ? { tenant_key: tenantKey } : {}),
  };
}

function mergeForwardMentionIds(
  mention: Record<string, unknown>,
): FeishuMentionEventItem["id"] | undefined {
  const nestedId = readPath(mention, ["id"]);
  if (isRecord(nestedId)) {
    return compactStringRecord({
      open_id: stringField(nestedId, "open_id"),
      user_id: stringField(nestedId, "user_id"),
      union_id: stringField(nestedId, "union_id"),
    });
  }
  const id = stringField(mention, "id");
  if (id === undefined) {
    return undefined;
  }
  const idType = stringField(mention, "id_type") ?? "open_id";
  return idType === "user_id"
    ? { user_id: id }
    : idType === "union_id"
      ? { union_id: id }
      : { open_id: id };
}

function messageItemContent(item: Record<string, unknown>): unknown {
  const bodyContent = readPath(item, ["body", "content"]);
  if (bodyContent !== undefined) {
    return bodyContent;
  }
  return item.content ?? "{}";
}

function buildMergeForwardChildrenMap(
  items: readonly Record<string, unknown>[],
  rootMessageId: string,
): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const messageId = stringField(item, "message_id");
    const parentId = stringField(item, "upper_message_id") ?? rootMessageId;
    if (messageId === rootMessageId && stringField(item, "upper_message_id") === undefined) {
      continue;
    }
    const children = map.get(parentId) ?? [];
    children.push(item);
    map.set(parentId, children);
  }
  for (const children of map.values()) {
    children.sort((left, right) =>
      numberField(left, "create_time") - numberField(right, "create_time")
    );
  }
  return map;
}

function readPath(
  value: unknown,
  path: readonly string[],
): unknown | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  const parsed = Number(typeof field === "string" || typeof field === "number"
    ? field
    : 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFeishuContentRecord(content: unknown): {
  readonly record: Record<string, unknown> | null;
  readonly error: Error | null;
} {
  if (isRecord(content)) {
    return { record: content, error: null };
  }
  if (typeof content !== "string") {
    return { record: null, error: null };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return {
      record: isRecord(parsed) ? parsed : null,
      error: null,
    };
  } catch (err) {
    return {
      record: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function selectFeishuPostPayload(
  content: Record<string, unknown>,
): Record<string, unknown> {
  if (Array.isArray(content.content)) {
    return content;
  }
  for (const localeKey of ["zh_cn", "en_us", "ja_jp"]) {
    const localized = content[localeKey];
    if (isRecord(localized) && Array.isArray(localized.content)) {
      return localized;
    }
  }
  for (const value of Object.values(content)) {
    if (isRecord(value) && Array.isArray(value.content)) {
      return value;
    }
  }
  return content;
}

function postHasMedia(post: Record<string, unknown>): boolean {
  const content = post.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((paragraph) =>
    Array.isArray(paragraph) &&
    paragraph.some((item) =>
      isRecord(item) && (item.tag === "img" || item.tag === "media")
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function botAddedToGroupEvent(
  data: FeishuBotAddedToGroupEventData,
  channelId: string,
): GroupJoinBackfillEvent | null {
  if (
    typeof data.event_id !== "string" ||
    data.event_id.length === 0 ||
    typeof data.chat_id !== "string" ||
    data.chat_id.length === 0
  ) {
    return null;
  }
  const occurredAt = parseOptionalTimestamp(data.create_time) ?? Date.now();
  return {
    eventId: data.event_id,
    channelType: "feishu",
    channelId,
    chatId: data.chat_id,
    occurredAt,
    ...(typeof data.tenant_key === "string" && data.tenant_key.length > 0
      ? { tenantKey: data.tenant_key }
      : {}),
    ...(typeof data.operator_id?.open_id === "string" &&
    data.operator_id.open_id.length > 0
      ? { operatorOpenId: data.operator_id.open_id }
      : {}),
  };
}

function parseOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function testInjectControls(
  inbound: NormalizedInboundMessage,
): Record<string, unknown> | undefined {
  const rawPayload = isRecord(inbound.rawPayload) ? inbound.rawPayload : undefined;
  const controls = rawPayload?.lunaTestInject;
  return isRecord(controls) ? controls : undefined;
}

function shouldSkipProcessingReaction(inbound: NormalizedInboundMessage): boolean {
  return testInjectControls(inbound)?.skipProcessingReaction === true;
}

function testInjectReplyTargetMessageId(
  inbound: NormalizedInboundMessage,
): string | undefined {
  const controls = testInjectControls(inbound);
  return controls === undefined ? undefined : stringField(controls, "replyTargetMessageId");
}


async function readDownloadedImageDimensions(path: string): Promise<{
  width?: number;
  height?: number;
}> {
  try {
    const { width, height, orientation } = await imageSizeFromFile(
      nodePath.join(config.paths.home, path),
    );
    if (!(width > 0 && height > 0)) return {};
    // EXIF orientations 5–8 transpose the stored pixel axes.
    return orientation !== undefined && orientation >= 5 && orientation <= 8
      ? { width: height, height: width }
      : { width, height };
  } catch {
    // A missing or unsupported image can still be represented by its reference.
    return {};
  }
}

/**
 * Replies go out as a rich-text post with one `md` element: Feishu renders its Markdown (bold,
 * lists, code, links, @ mentions), while a `text` message would show the asterisks and backticks.
 */
export function markdownPostContent(markdown: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: markdown }]] } });
}
