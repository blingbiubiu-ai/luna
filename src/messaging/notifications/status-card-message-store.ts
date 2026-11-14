import { SessionStore } from "@/sessions/session-store";
import type { NormalizedInboundMessage } from "@/channels";
import type { DrizzleDB } from "@/data";
import { MessageStore } from "@/sessions/message-store";
import type { TaskSubscription } from "@/tasks/types";
import type { OutboundChannelOperation } from "@/work/types";

export function persistTaskStatusCardMessage(input: {
  readonly db: DrizzleDB;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskRunId?: string;
  readonly runIndex?: number;
  readonly notificationId?: string;
  readonly inbound: NormalizedInboundMessage;
  readonly subscription: TaskSubscription;
  readonly taskTitle: string;
  readonly taskSummary: string | null;
  readonly taskStatus: string;
  readonly outbound?: OutboundChannelOperation;
  readonly channelMessageKey?: string;
  readonly content?: string;
}): void {
  const providerMessageId =
    input.outbound?.replyMode === "update_status_card" &&
      input.outbound.targetMessageId !== undefined
      ? input.outbound.targetMessageId
      : input.outbound?.id ?? input.channelMessageKey;
  if (providerMessageId === undefined) {
    return;
  }
  const content =
    input.outbound?.content ??
    input.content ??
    input.taskSummary ??
    input.taskTitle;
  const steps = input.outbound?.statusCardSteps ?? [];
  const botUserId = new SessionStore(input.db).requireReplyUserId(input.sessionId);
  new MessageStore(input.db).appendOrUpdateOnce({
    sessionId: input.sessionId,
    channelMessageKey: providerMessageId,
    role: "assistant",
    channel: input.inbound.channel,
    surface: input.inbound.surface,
    senderUserId: botUserId,
    content: [{
      type: "card",
      cardKind: "status_card",
      presentationKind: "status_card",
      title: input.taskTitle,
      text: content,
      ...(steps.length > 0 ? { steps } : {}),
      payload: {
        style: input.outbound?.statusCardStyle ?? "card",
        taskId: input.taskId,
        subscriptionId: input.subscription.id,
        status: input.taskStatus,
        ...(input.taskRunId !== undefined ? { taskRunId: input.taskRunId } : {}),
        ...(input.runIndex !== undefined ? { runIndex: input.runIndex } : {}),
        ...(input.notificationId !== undefined
          ? { notificationId: input.notificationId }
          : {}),
        ...(input.outbound?.statusCardState !== undefined
          ? { state: input.outbound.statusCardState }
          : {}),
      },
    }],
    contentKind: "card",
    presentationKind: "status_card",
    providerMessageType: input.outbound?.statusCardStyle === "native" ? "message_cot" : "interactive",
    rawPayload: {
      origin: "status_card",
      sourceTaskId: input.taskId,
      subscriptionId: input.subscription.id,
      status: input.taskStatus,
      title: input.taskTitle,
      ...(input.taskSummary !== null ? { summary: input.taskSummary } : {}),
      ...(input.taskRunId !== undefined ? { taskRunId: input.taskRunId } : {}),
      ...(input.runIndex !== undefined ? { runIndex: input.runIndex } : {}),
      ...(input.notificationId !== undefined
        ? { notificationId: input.notificationId }
        : {}),
      ...(steps.length > 0 ? { statusCardSteps: steps } : {}),
      ...(input.outbound?.statusCardState !== undefined
        ? { statusCardState: input.outbound.statusCardState }
        : {}),
      ...(input.outbound !== undefined ? { outbound: input.outbound } : {}),
    },
  });
}
