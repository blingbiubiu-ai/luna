import { feishuIdentityMetadata } from "@/identity/feishu-identity-scopes";
import type { ChannelAdapter, NormalizedInboundMessage } from "@/channels";
import { normalizedRootMessageExternalId } from "@/channels";
import type { OutboundChannelOperation, ReplyMode } from "@/channels/outbound";

/**
 * Represents Fake Feishu Provider Idempotency Registry values used by test messaging channel.
 */
export type FakeFeishuProviderIdempotencyRegistry = Map<
  string,
  OutboundChannelOperation
>;

/**
 * Configuration options for messaging channel fake feishu channel behavior in test.
 */
export interface FakeFeishuChannelOptions {
  readonly providerIdempotencyRegistry?: FakeFeishuProviderIdempotencyRegistry;
  readonly type?: string;
}

/**
 * Implements an in-memory Feishu channel for tests.
 */
export class FakeFeishuChannel implements ChannelAdapter {
  readonly type: string;
  readonly outbound: OutboundChannelOperation[] = [];

  private readonly _inbound: NormalizedInboundMessage[];
  private readonly _providerIdempotencyRegistry: FakeFeishuProviderIdempotencyRegistry;
  private _inboundHandler:
    | ((message: NormalizedInboundMessage) => Promise<void>)
    | undefined;
  private _nextOutboundSequence = 1;

  constructor(
    readonly id: string,
    inbound: readonly NormalizedInboundMessage[] = [],
    options: FakeFeishuChannelOptions = {},
  ) {
    this.type = options.type ?? "feishu";
    this._inbound = [...inbound];
    this._providerIdempotencyRegistry =
      options.providerIdempotencyRegistry ?? new Map();
  }

  getBotIdentity() {
    return { externalId: "luna-bot", kind: "bot" as const, displayName: "Luna",
      ...fakeFeishuBotIdentityMetadata(this.type, this.id, "luna-bot") };
  }

  async subscribeInbound(
    handler: (message: NormalizedInboundMessage) => Promise<void>,
  ): Promise<void> {
    if (this._inboundHandler) {
      throw new Error(
        `Inbound handler already registered for channel "${this.id}".`,
      );
    }
    this._inboundHandler = handler;
  }

  async start(): Promise<void> {
    for (const message of this._inbound) {
      await this.deliver(message);
    }
  }

  async emitNormalizedInbound(
    message: NormalizedInboundMessage,
  ): Promise<void> {
    await this.deliver(message);
  }

  async deliver(message: NormalizedInboundMessage): Promise<void> {
    await this._inboundHandler?.(message);
  }

  async beginProcessing(_inbound: NormalizedInboundMessage): Promise<void> {}

  async completeProcessing(_inbound: NormalizedInboundMessage): Promise<void> {}

  async send(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation> {
    if (operation.idempotencyKey !== undefined) {
      const existing = this._providerIdempotencyRegistry.get(
        operation.idempotencyKey,
      );
      if (existing) {
        return existing;
      }
    }

    const targetMessageId = operation.targetMessageId ?? inbound.id;
    const rootMessageId =
      normalizedRootMessageExternalId(inbound) ??
      (targetMessageId !== inbound.thread?.externalId ? targetMessageId : undefined);
    const outbound: OutboundChannelOperation = {
      ...operation,
      id: `fake-feishu-outbound-${inbound.id}-${this._nextOutboundSequence++}`,
      channelId: inbound.channel.id,
      sender: {
        externalId: "luna-bot",
        kind: "bot",
        displayName: "Luna",
        ...fakeFeishuBotIdentityMetadata(this.type, this.id, "luna-bot"),
      },
      ...(operation.replyMode === "reply_in_thread"
        ? {
            threadId: inbound.thread?.externalId ?? `fake-thread-${targetMessageId}`,
            ...(rootMessageId !== undefined ? { rootMessageId } : {}),
          }
        : {}),
    };
    if (outbound.idempotencyKey !== undefined) {
      this._providerIdempotencyRegistry.set(outbound.idempotencyKey, outbound);
    }
    this.outbound.push(outbound);
    return outbound;
  }

  supports(replyMode: ReplyMode): boolean {
    return [
      "channel_message",
      "reply_in_thread",
      "update_status_card",
      "direct_message",
    ].includes(replyMode);
  }
}

function fakeFeishuBotIdentityMetadata(
  channelType: string,
  channelId: string,
  openId: string,
): Record<string, unknown> {
  if (channelType !== "feishu" && channelType !== "lark") {
    return {};
  }
  return {
    providerIds: { open_id: openId },
    ...feishuIdentityMetadata({environment: channelType, appId: `test:${channelId}`}, {open_id: openId}),
  };
}
