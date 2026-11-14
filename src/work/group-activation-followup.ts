import type { MessageRow, MessageStore } from "@/sessions/message-store";
import type { SessionTimelineEventStore } from "@/sessions/session-timeline-event-store";
import type { NormalizedInboundMessage } from "@/channels";
import type { InboundAddressing } from "@/sessions/types";
import type { SessionConfig } from "@/shared";

const explicitActivationReasons = new Set<InboundAddressing["reason"]>([
  "mention",
  "reply_to_bot",
  "alias",
]);

const acceptedActivationReasons = new Set<InboundAddressing["reason"]>([
  "mention",
  "reply_to_bot",
  "alias",
  "activation_followup",
]);

export interface GroupActivationFollowupAccepted {
  readonly addressedToBot: true;
  readonly reason: "activation_followup";
  readonly sessionSourceMessageId: string;
  readonly followupCount: number;
}

export interface GroupActivationFollowupRejected {
  readonly addressedToBot: false;
  readonly reason: "silent_group";
  readonly rejectReason:
    | "disabled"
    | "not_group"
    | "already_addressed"
    | "empty_text"
    | "no_session"
    | "expired"
    | "max_followups"
    | "sender_not_allowed"
    | "interrupted"
    | "focus_shifted";
}

export type GroupActivationFollowupDecision =
  | GroupActivationFollowupAccepted
  | GroupActivationFollowupRejected;

export function decideGroupActivationFollowup(input: {
  readonly messageStore: MessageStore;
  readonly sessionTimelineEventStore: SessionTimelineEventStore;
  readonly sessionId: string;
  readonly candidateRow: MessageRow;
  readonly message: NormalizedInboundMessage;
  readonly config: Pick<
    SessionConfig,
    | "group_activation_followup_window_ms"
    | "group_activation_followup_senders"
    | "group_activation_followup_max_messages"
    | "group_activation_followup_recent_messages"
    | "group_activation_followup_interrupt_on_other_user"
  >;
}): GroupActivationFollowupDecision {
  if (input.config.group_activation_followup_window_ms <= 0) {
    return reject("disabled");
  }
  if (input.message.surface.kind !== "group") {
    return reject("not_group");
  }
  if (input.message.addressing?.addressedToBot === true) {
    return reject("already_addressed");
  }
  if (input.message.text.trim().length === 0) {
    return reject("empty_text");
  }
  const windowRows = input.messageStore.listMessagesBefore({
    sessionId: input.sessionId,
    beforeCreatedAt: input.candidateRow.created_at,
    sinceCreatedAt:
      input.candidateRow.created_at -
      input.config.group_activation_followup_window_ms,
  });
  const recentUserRows = input.messageStore.listLatestUserMessagesBefore({
    sessionId: input.sessionId,
    beforeCreatedAt: input.candidateRow.created_at,
    limit: input.config.group_activation_followup_recent_messages,
  });
  const candidateUserRows = mergeMessageRows(
    windowRows.filter((row) => row.role === "user"),
    recentUserRows,
  );
  const latestAccepted = latestAcceptedUserRow(candidateUserRows);
  if (latestAccepted === undefined) {
    return reject("no_session");
  }

  const acceptedInTimeWindow =
    input.candidateRow.created_at <=
    latestAccepted.created_at + input.config.group_activation_followup_window_ms;
  const acceptedInRecentMessages = isWithinRecentUserMessages({
    recentUserRows,
    latestAccepted,
    recentMessages: input.config.group_activation_followup_recent_messages,
  });
  if (!acceptedInTimeWindow && !acceptedInRecentMessages) {
    return reject("expired");
  }
  const acceptedViaRecentFallback =
    !acceptedInTimeWindow && acceptedInRecentMessages;

  const priorRows = input.messageStore.listMessagesBefore({
    sessionId: input.sessionId,
    beforeCreatedAt: input.candidateRow.created_at,
  });
  const priorUserRows = priorRows.filter((row) => row.role === "user");
  const latestAcceptedIndex = priorUserRows.findIndex(
    (row) => row.id === latestAccepted.id,
  );
  const anchor = priorUserRows
    .slice(0, latestAcceptedIndex + 1)
    .reverse()
    .find((row) => explicitActivationReasons.has(addressingReason(row)));
  if (anchor === undefined || anchor.sender_user_id === null) {
    return reject("no_session");
  }

  if (
    input.sessionTimelineEventStore.hasFollowupInterruptedSinceAnchor({
      sessionId: input.sessionId,
      anchorMessageId: anchor.id,
      beforeCreatedAt: input.candidateRow.created_at,
    })
  ) {
    return reject("focus_shifted");
  }

  const rowsSinceAnchor = priorUserRows.slice(
    priorUserRows.findIndex((row) => row.id === anchor.id) + 1,
  );
  const followupCount = rowsSinceAnchor.filter(
    (row) => addressingReason(row) === "activation_followup",
  ).length;
  if (followupCount >= input.config.group_activation_followup_max_messages) {
    return reject("max_followups");
  }

  const allowedSenderIds = new Set<string>([anchor.sender_user_id]);
  if (
    input.config.group_activation_followup_senders ===
    "requester_and_reporters"
  ) {
    for (const senderUserId of reporterSenderIdsSinceAnchor(priorRows, anchor)) {
      allowedSenderIds.add(senderUserId);
    }
  }

  if (
    input.config.group_activation_followup_interrupt_on_other_user &&
    acceptedViaRecentFallback &&
    hasDisallowedUserMessage(rowsSinceAnchor, allowedSenderIds)
  ) {
    return reject("interrupted");
  }

  if (
    input.candidateRow.sender_user_id === null ||
    !allowedSenderIds.has(input.candidateRow.sender_user_id)
  ) {
    return reject("sender_not_allowed");
  }

  return {
    addressedToBot: true,
    reason: "activation_followup",
    sessionSourceMessageId: anchor.channel_message_key ?? anchor.id,
    followupCount,
  };
}

function latestAcceptedUserRow(
  priorUserRows: readonly MessageRow[],
): MessageRow | undefined {
  return [...priorUserRows]
    .reverse()
    .find((row) => acceptedActivationReasons.has(addressingReason(row)));
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

function isWithinRecentUserMessages(input: {
  readonly recentUserRows: readonly MessageRow[];
  readonly latestAccepted: MessageRow;
  readonly recentMessages: number;
}): boolean {
  if (input.recentMessages === 0) {
    return false;
  }
  return input.recentUserRows
    .slice(-input.recentMessages)
    .some((row) => row.id === input.latestAccepted.id);
}

function hasDisallowedUserMessage(
  rows: readonly MessageRow[],
  allowedSenderIds: ReadonlySet<string>,
): boolean {
  return rows.some(
    (row) =>
      row.sender_user_id === null || !allowedSenderIds.has(row.sender_user_id),
  );
}

function reject(
  rejectReason: GroupActivationFollowupRejected["rejectReason"],
): GroupActivationFollowupRejected {
  return { addressedToBot: false, reason: "silent_group", rejectReason };
}

function addressingReason(row: MessageRow): InboundAddressing["reason"] {
  const rawPayload = asRecord(row.raw_payload_json);
  const addressing = asRecord(rawPayload?.addressing);
  const reason = addressing?.reason;
  return isAddressingReason(reason) ? reason : "silent_group";
}

function reporterSenderIdsSinceAnchor(
  priorRows: readonly MessageRow[],
  anchor: MessageRow,
): string[] {
  const reporterIds: string[] = [];
  const anchorIndex = priorRows.findIndex((row) => row.id === anchor.id);
  for (const row of priorRows.slice(anchorIndex + 1)) {
    const ccSenderUserIds = assistantCcSenderUserIds(row);
    if (ccSenderUserIds === undefined) {
      continue;
    }
    for (const senderUserId of ccSenderUserIds) {
      if (typeof senderUserId === "string" && !reporterIds.includes(senderUserId)) {
        reporterIds.push(senderUserId);
      }
    }
  }
  return reporterIds;
}

function assistantCcSenderUserIds(row: MessageRow): readonly unknown[] | undefined {
  if (row.role !== "assistant") {
    return undefined;
  }
  const rawPayload = asRecord(row.raw_payload_json);
  const mention = asRecord(rawPayload?.mention);
  const mentionCanonical = asRecord(rawPayload?.mentionCanonical);
  if (
    rawPayload?.addressingReason !== "mention" &&
    rawPayload?.addressingReason !== "reply_to_bot" &&
    rawPayload?.addressingReason !== "alias" &&
    rawPayload?.addressingReason !== "activation_followup"
  ) {
    return undefined;
  }
  const ccSenderUserIds = mentionCanonical?.ccSenderUserIds ?? mention?.ccSenderUserIds;
  return Array.isArray(ccSenderUserIds) ? ccSenderUserIds : undefined;
}

function isAddressingReason(value: unknown): value is InboundAddressing["reason"] {
  return (
    value === "p2p" ||
    value === "mention" ||
    value === "reply_to_bot" ||
    value === "alias" ||
    value === "activation_followup" ||
    value === "silent_group"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
