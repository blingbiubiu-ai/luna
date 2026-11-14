import type { MessageRow, MessageStore } from "@/sessions/message-store";
import type { SessionConfig } from "@/shared";

import type { ActivationContextMessage } from "./types";

export function selectActivationContext(input: {
  readonly messageStore: MessageStore;
  readonly sessionId: string;
  readonly activationMessageRow: MessageRow;
  readonly config: Pick<
    SessionConfig,
    | "activation_context_window_ms"
    | "activation_context_max_messages"
    | "activation_context_max_chars"
    | "activation_context_recent_unprocessed_messages"
  >;
  readonly minimumRecentMessages?: number;
}): ActivationContextMessage[] {
  const windowMs = input.config.activation_context_window_ms;
  const maxMessages = input.config.activation_context_max_messages;
  const maxChars = input.config.activation_context_max_chars;
  const recentUnprocessedMessages =
    input.config.activation_context_recent_unprocessed_messages;
  const minRecentMessages = input.minimumRecentMessages ?? 0;
  if (
    maxMessages === 0 ||
    maxChars === 0 ||
    (windowMs === 0 && recentUnprocessedMessages === 0)
  ) {
    return [];
  }

  const priorRows =
    windowMs === 0
      ? []
      : input.messageStore.listRecentUserMessagesBefore({
          sessionId: input.sessionId,
          beforeCreatedAt: input.activationMessageRow.created_at,
          sinceCreatedAt: input.activationMessageRow.created_at - windowMs,
        });
  const skippedRows = input.messageStore.listRecentSkippedUserMessagesBefore({
    sessionId: input.sessionId,
    beforeCreatedAt: input.activationMessageRow.created_at,
    limit: recentUnprocessedMessages,
  });
  const fallbackRows =
    minRecentMessages > 0 &&
      mergeMessageRows(priorRows, skippedRows).length < minRecentMessages
      ? input.messageStore.listLatestUserMessagesBefore({
          sessionId: input.sessionId,
          beforeCreatedAt: input.activationMessageRow.created_at,
          limit: minRecentMessages,
          excludeMessagesAlreadySentToRunner: true,
        })
      : [];
  const candidateRows = mergeMessageRows(priorRows, skippedRows, fallbackRows);

  const selected: ActivationContextMessage[] = [];
  let selectedChars = 0;
  for (const row of [...candidateRows].reverse()) {
    if (selected.length >= maxMessages) {
      break;
    }

    const text = textFromMessageRow(row);
    if (text.length === 0) {
      continue;
    }
    if (selectedChars + text.length > maxChars) {
      break;
    }

    selected.push(toActivationContextMessage(row, text));
    selectedChars += text.length;
  }

  return selected.reverse();
}

function mergeMessageRows(
  ...groups: readonly (readonly MessageRow[])[]
): MessageRow[] {
  const byId = new Map<string, MessageRow>();
  for (const group of groups) {
    for (const row of group) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((left, right) => {
    const createdAtDiff = left.created_at - right.created_at;
    return createdAtDiff === 0 ? left.id.localeCompare(right.id) : createdAtDiff;
  });
}

function toActivationContextMessage(
  row: MessageRow,
  text: string,
): ActivationContextMessage {
  return {
    messageId: row.id,
    ...(row.channel_message_key !== null
      ? { channelMessageKey: row.channel_message_key }
      : {}),
    ...(row.sender_user_id !== null ? { senderUserId: row.sender_user_id } : {}),
    createdAt: row.created_at,
    text,
  };
}

function textFromMessageRow(row: MessageRow): string {
  const content = row.content_json;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!isRecord(item) || item.type !== "text") {
        return "";
      }
      return typeof item.text === "string" ? item.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
