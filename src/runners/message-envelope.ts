import type { NormalizedInboundMessage } from "@/channels/types";
import type { MessageRow } from "@/sessions/message-store";
import type { MessageContentBlock } from "@/sessions/types";
import { renderMessageBlocksForRunner } from "@/main-runner/context-builder";

export interface RunnerMessageEnvelope {
  readonly index?: number;
  readonly messageId: string;
  readonly channelMessageKey: string | null;
  readonly role: "user" | "assistant";
  readonly senderUserId: string | null;
  readonly sender: {
    readonly id: string;
    readonly externalId: string;
    readonly kind: string;
    readonly displayName: string;
  };
  readonly contentKind?: string;
  readonly presentationKind?: string;
  readonly text: string;
  readonly createdAt: number;
}

export function runnerMessageEnvelopeFromRow(input: {
  readonly row: MessageRow;
  readonly index?: number;
  readonly rawMessage?: NormalizedInboundMessage;
  readonly fallback?: NormalizedInboundFallback;
  readonly transformText?: (text: string, row: MessageRow) => string;
}): RunnerMessageEnvelope {
  const rawMessage = input.rawMessage ??
    normalizedInboundFromMessageRow(input.row, input.fallback);
  const text = input.transformText?.(textFromMessageRow(input.row), input.row) ??
    textFromMessageRow(input.row);
  return {
    ...(input.index !== undefined ? { index: input.index } : {}),
    messageId: input.row.id,
    channelMessageKey: input.row.channel_message_key,
    role: input.row.role === "assistant" ? "assistant" : "user",
    senderUserId: input.row.sender_user_id,
    sender: senderSummary(rawMessage),
    ...(input.row.contentKind !== undefined
      ? { contentKind: input.row.contentKind }
      : {}),
    ...(input.row.presentationKind !== undefined
      ? { presentationKind: input.row.presentationKind }
      : {}),
    text,
    createdAt: input.row.created_at,
  };
}

export interface NormalizedInboundFallback {
  readonly channel?: NormalizedInboundMessage["channel"];
  readonly surface?: NormalizedInboundMessage["surface"];
  readonly thread?: NormalizedInboundMessage["thread"];
}

export function normalizedInboundFromMessageRow(
  row: MessageRow,
  fallback: NormalizedInboundFallback = {},
): NormalizedInboundMessage {
  if (isNormalizedInboundMessage(row.raw_payload_json)) {
    return {
      ...row.raw_payload_json,
      ...(row.raw_payload_json.thread === undefined && fallback.thread !== undefined
        ? { thread: fallback.thread }
        : {}),
      text: textFromMessageRow(row),
    };
  }
  if (
    isRecord(row.raw_payload_json) &&
    isNormalizedInboundMessage(row.raw_payload_json.normalized)
  ) {
    return {
      ...row.raw_payload_json.normalized,
      ...(row.raw_payload_json.normalized.thread === undefined &&
        fallback.thread !== undefined
        ? { thread: fallback.thread }
        : {}),
      text: textFromMessageRow(row),
    };
  }

  return {
    id: row.channel_message_key ?? row.id,
    channel: fallback.channel ??
      { type: row.channelType ?? "unknown", id: row.channelId ?? "unknown" },
    surface: fallback.surface ?? { externalId: "unknown", kind: "unknown" },
    ...(fallback.thread !== undefined ? { thread: fallback.thread } : {}),
    sender: {
      externalId: row.sender_user_id ?? "unknown",
      kind: "unknown",
    },
    text: textFromMessageRow(row),
    mentions: [],
    addressing: { addressedToBot: true, reason: "p2p" },
    rawPayload: rawPayloadFromMessageRow(row.raw_payload_json),
  };
}

export function senderSummary(message: NormalizedInboundMessage): {
  readonly id: string;
  readonly externalId: string;
  readonly kind: string;
  readonly displayName: string;
} {
  return {
    id: message.sender.externalId,
    externalId: message.sender.externalId,
    kind: message.sender.kind,
    displayName: message.sender.displayName ?? message.sender.externalId,
  };
}

export function textFromMessageRow(row: MessageRow): string {
  return textFromContentBlocks(row.content_json);
}

export function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return renderMessageBlocksForRunner(content as readonly MessageContentBlock[]);
}

function isNormalizedInboundMessage(value: unknown): value is NormalizedInboundMessage {
  if (!isRecord(value)) {
    return false;
  }
  const channel = value.channel;
  const surface = value.surface;
  const sender = value.sender;
  return (
    typeof value.id === "string" &&
    isRecord(channel) &&
    typeof channel.type === "string" &&
    typeof channel.id === "string" &&
    isRecord(surface) &&
    typeof surface.externalId === "string" &&
    typeof surface.kind === "string" &&
    isRecord(sender) &&
    typeof sender.externalId === "string" &&
    typeof sender.kind === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.mentions)
  );
}

function rawPayloadFromMessageRow(rawPayloadJson: unknown): unknown {
  if (isRecord(rawPayloadJson) && "rawPayload" in rawPayloadJson) {
    return rawPayloadJson.rawPayload ?? {};
  }
  return rawPayloadJson ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
