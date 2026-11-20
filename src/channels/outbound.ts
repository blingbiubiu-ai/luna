import type { ReplyDocument } from "@luna/runner-protocol/reply";
import type { ChannelIdentity, NormalizedInboundMessage } from "@/channels";

/**
 * Represents Workflow Type values used by work context routing.
 */
export type WorkflowType =
  | "general_chat"
  | "question"
  | "task"
  | "approval"
  | "handoff";
/**
 * Describes the Task Candidate contract used by work context routing.
 */
export interface TaskCandidate {
  readonly taskId: string;
  readonly title: string;
  readonly type: Exclude<WorkflowType, "general_chat">;
  readonly confidence: number;
  readonly reason: string;
}

/**
 * Represents Route Decision values used by work context routing.
 */
export type RouteDecision =
  | {
      readonly kind: "ephemeral";
      readonly workflow: "general_chat" | "question";
    }
  | {
      readonly kind: "persistent_task";
      readonly workflow: Exclude<WorkflowType, "general_chat">;
      readonly confidence: number;
      readonly reason: string;
      readonly taskId?: string;
    }
  | {
      readonly kind: "needs_confirmation";
      readonly candidates: readonly TaskCandidate[];
      readonly reason: string;
    };

/**
 * Represents Reply Mode values used by work context routing.
 */
export type ReplyMode =
  | "channel_message"
  | "reply_in_thread"
  | "update_status_card"
  | "direct_message";

/**
 * Describes the Task Result Card Operation contract used by work context routing.
 */
export interface TaskResultCardOperation {
  readonly taskId: string;
  readonly title?: string;
  readonly summary?: string;
  readonly status?: string;
}

export type StatusCardStyle = "card" | "native";
export interface NativeProgressEntry {
  readonly id: string;
  readonly text: string;
  readonly toolName?: string;
  readonly toolTitle?: string;
  readonly toolCallId?: string;
  readonly toolPhase?: "start" | "result";
}

export interface StatusCardOperation {
  readonly taskId: string;
  readonly title?: string;
  readonly summary?: string;
  readonly status?: string;
  readonly hideHeader?: boolean;
}

/**
 * Describes the Batch Summary Card Operation contract used by batched session turns.
 */
export interface BatchSummaryCardOperation {
  readonly title: string;
  readonly timeRangeLabel?: string;
  readonly backgroundTasks?: readonly string[];
}

export interface OutboundMentionMetadata {
  readonly requesterUserId?: string;
  readonly ccSenderUserIds?: readonly string[];
}

/**
 * Describes the Outbound Channel Operation contract used by work context routing.
 */
export interface OutboundChannelOperation {
  readonly reply?: ReplyDocument;
  readonly resolvedSessionId?: string;
  readonly deliveredSurfaceId?: string;
  readonly id: string;
  readonly replyMode: ReplyMode;
  readonly channelId: string;
  readonly sender?: ChannelIdentity;
  readonly targetMessageId?: string;
  /** Provider id of a message in the same chat that this message quotes as a reply, without opening a topic thread. */
  readonly quoteMessageId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
  readonly idempotencyKey?: string;
  readonly statusCardStyle?: StatusCardStyle;
  readonly nativeProgress?: readonly NativeProgressEntry[];
  readonly statusCardState?: "active" | "terminal";
  readonly statusCardSteps?: readonly string[];
  readonly statusCard?: StatusCardOperation;
  readonly taskResultCard?: TaskResultCardOperation;
  readonly batchSummaryCard?: BatchSummaryCardOperation;
  readonly mention?: OutboundMentionMetadata;
  /** Addresses in the sending channel, in reply mention block order. */
  readonly inlineMentions?: readonly string[];
  readonly assetBasePath?: string;
  readonly content: string;
}

/**
 * Describes the Work Reply Channel contract used by work context routing.
 */
export interface DeliveryTarget {
  readonly recipient?: { readonly idType: "open_id" | "user_id" | "union_id"; readonly id: string };
  readonly channelId: string;
  readonly surfaceId: string;
  readonly threadId?: string;
  readonly rootMessageId?: string;
}

export interface GroupCreationInput {
  readonly name: string;
  readonly idType: "open_id" | "user_id" | "union_id";
  readonly memberIds: readonly string[];
  readonly requestId: string;
}
export interface GroupInvitationResult {
  readonly acceptedMemberIds: readonly string[];
  readonly invalidMemberIds: readonly string[];
  readonly notExistedMemberIds: readonly string[];
  readonly pendingApprovalMemberIds: readonly string[];
}
export interface ReplyChannel {
  /** Adapter self identity, available before delivery; normalized at ingress. */
  getSessionSurface?(sessionId: string): import("@/channels").ChannelSurface;
  getBotIdentity?(): ChannelIdentity | undefined;
  inviteGroupMembers?(input: Omit<GroupCreationInput, "name"> & { readonly chatId: string }): Promise<GroupInvitationResult>;
  lookupGroup?(chatId: string): Promise<import("@/channels").ChannelSurface>;
  listGroupBots?(groupId: string): Promise<readonly ChannelIdentity[]>;
  isBotInGroup?(groupId: string): Promise<boolean>;
  createGroup?(input: GroupCreationInput): Promise<import("@/channels").ChannelSurface>;
  lookupUser?(idType: "open_id" | "user_id" | "union_id", id: string): Promise<ChannelIdentity>;
  sendTo?(target: DeliveryTarget, operation: Omit<OutboundChannelOperation, "id" | "channelId">): Promise<OutboundChannelOperation>;

  beginProcessing?(inbound: NormalizedInboundMessage): Promise<void>;

  send(
    inbound: NormalizedInboundMessage,
    operation: Omit<OutboundChannelOperation, "id" | "channelId">,
  ): Promise<OutboundChannelOperation>;

  completeProcessing?(inbound: NormalizedInboundMessage): Promise<void>;
}
