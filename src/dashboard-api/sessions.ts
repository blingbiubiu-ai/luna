import type { DeletedTaskReference } from "./deleted-task-references";
import { type ContextPackItemRow, type TaskSourceContextItem } from "@/context";
import { channelIdentities, channelSurfaces, messageMentions, messages, sessionTimelineEvents, sessionRunnerAttempts, sessionTimelineEntries, sessionTurnEntries, sessionTurns, sessions, taskSubscriptions, tasks, channelUserBindings, users } from "@/data/schema";

import {
  buildDashboardContextBundle,
  type DashboardContextBundleRows,
  type DashboardContextPack,
  type DashboardContextPackItem,
  type DashboardRunnerContextSeedRecord,
} from "./context-packs";
import {
  type AgentIdentity,
  type DashboardCanonicalUser,
  resolveMessageSender,
  toAgentIdentity,
  toDashboardCanonicalUser,
} from "./identity";
import {
  type DashboardArtifactSigner,
  signDashboardArtifactReferencesInValue,
} from "./local-paths";
import {
  directRecipientForSession,
  type DirectRecipientRow,
  p2pCanonicalUserForSession,
  p2pUserForSession,
  resolveChannelSurfaceKind,
  resolveSessionDisplayTitle,
  type UserIdentityLinkRow,
} from "./session-display-title";

export type ChannelSurfaceRow = typeof channelSurfaces.$inferSelect;
export type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ChannelUserBindingRow = typeof channelUserBindings.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageMentionRow = typeof messageMentions.$inferSelect;
export type SessionTimelineEntryRow = typeof sessionTimelineEntries.$inferSelect;
export type SessionTimelineEventRow = typeof sessionTimelineEvents.$inferSelect;
export type SessionTurnEntryRow = typeof sessionTurnEntries.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskSubscriptionRow = typeof taskSubscriptions.$inferSelect;
export type SessionTurnRow = typeof sessionTurns.$inferSelect;
export type SessionRunnerAttemptRow = typeof sessionRunnerAttempts.$inferSelect;

export type { AgentIdentity } from "./identity";
export type {
  DashboardContextBundleRows,
  DashboardContextPack,
  DashboardContextPackItem,
  DashboardRunnerContextSeedRecord,
} from "./context-packs";

/**
 * Describes the Session Task Badge contract used by HTTP route DTO.
 */
export interface SessionTaskBadge {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: string | null;
}

export interface DashboardSurface {
  readonly id: string;
  readonly externalId: string;
  readonly kind: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly memberCount?: number | null;
}

export type SessionAttentionState = "run" | "wait" | "fail" | "idle";

export interface DashboardParentSessionSummary {
  readonly id: string;
  readonly displayTitle: string;
  readonly avatarUrl: string | null;
  readonly memberCount: number | null;
}

export interface DashboardSessionMessageQuote {
  readonly messageId: string | null;
  readonly senderName: string | null;
  readonly preview: string;
}

export interface DashboardSessionMessageMention {
  readonly key: string;
  readonly label: string;
  readonly targetIdentityId: string | null;
  readonly targetIdentity: AgentIdentity | null;
  readonly targetUserId: string | null;
  readonly targetUser: DashboardCanonicalUser | null;
  readonly targetExternalId: string;
  readonly targetKind: string;
}

export interface DashboardSessionMessageIngest {
  readonly mode: "realtime" | "history_backfill";
  readonly source: string;
  readonly importedAt: number | null;
  readonly joinEventId: string | null;
}

export interface DashboardSessionMessageThread {
  readonly threadId: string | null;
  readonly rootMessageExternalId: string | null;
  readonly parentMessageExternalId: string | null;
  readonly hasReplies: boolean;
}

export interface DashboardSessionContextMessage {
  readonly id: string;
  readonly entryId: string;
  readonly entryKind: string;
  readonly session_id: string;
  readonly sessionId: string;
  readonly channel_message_key: string | null;
  readonly channelMessageKey: string | null;
  readonly senderUserId: string;
  readonly senderUser: DashboardCanonicalUser;
  readonly role: string;
  readonly contentKind: string;
  readonly presentationKind: string;
  readonly providerMessageType: string | null;
  readonly content: unknown;
  readonly created_at: number;
  readonly createdAt: number;
}

/**
 * Describes optional Dashboard-only presentation semantics for messages.
 */
export interface DashboardSessionMessagePresentationTask {
  readonly status?: string;
  readonly id: string;
  readonly title: string;
}

export interface DashboardSessionRunnerAttempt {
  readonly id: string;
  readonly attemptKind: string;
  readonly attemptIndex: number;
  readonly status: string;
  readonly runnerType: string;
  readonly runnerSessionId: string | null;
  readonly inputPrompt: string;
  readonly rawOutput: string | null;
  readonly rawOutputTruncated: boolean;
  readonly parsedActionJson: unknown;
  readonly parseErrorJson: unknown;
  readonly repairSourceAttemptId: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
}

export type DashboardSessionMessagePresentation =
  | {
      readonly kind: "task_final_answer";
      readonly task: DashboardSessionMessagePresentationTask | null;
    }
  | {
      readonly kind: "status_card";
      readonly task: DashboardSessionMessagePresentationTask | null;
      readonly status: string | null;
      readonly title: string | null;
      readonly text: string | null;
    }
  | {
      readonly kind: "rich_markdown_card";
    };

export interface DashboardSession {
  readonly status?: string;
  readonly kind?: string;
  readonly shadowId?: string;
  readonly shadowName?: string | null;
  readonly bindingStatus: "active" | "retired" | null;
  readonly id: string;
  readonly channel_type: string;
  readonly channelType: string;
  readonly channel_id: string;
  readonly group_id: string | null;
  readonly thread_id: string | null;
  readonly root_message_id: string | null;
  readonly parent_session_id: string | null;
  readonly parentSessionId: string | null;
  readonly parentSession?: DashboardParentSessionSummary | null;
  readonly title: string | null;
  readonly display_title: string;
  readonly displayTitle: string;
  readonly avatarUrl?: string | null;
  readonly listening?: boolean | null;
  readonly attentionState?: SessionAttentionState;
  readonly surface: DashboardSurface | null;
  readonly message_count: number;
  readonly thread_anchor_preview: string | null;
  readonly threadAnchorPreview: string | null;
  readonly latest_message_preview: string | null;
  readonly latestMessagePreview: string | null;
  readonly latestSenderUserId: string | null;
  readonly latestSenderUser: DashboardCanonicalUser | null;
  readonly latest_message_at: number | null;
  readonly latestMessageAt: number | null;
  readonly linked_tasks: readonly SessionTaskBadge[];
  readonly linkedTasks: readonly SessionTaskBadge[];
  readonly contextPacks: readonly DashboardContextPack<DashboardSessionContextMessage>[];
  readonly launchContextPacks: readonly DashboardContextPack<DashboardSessionContextMessage>[];
  readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * Describes the Dashboard Session Message contract used by HTTP route DTO.
 */
export interface DashboardSessionMessage {
  readonly id: string;
  readonly entryId: string;
  readonly entryKind: string;
  readonly session_id: string;
  readonly owning_session_id: string;
  readonly channel_message_key: string | null;
  readonly senderUserId: string;
  readonly senderUser: DashboardCanonicalUser;
  readonly role: string;
  readonly contentKind: string;
  readonly presentationKind: string;
  readonly providerMessageType: string | null;
  readonly content: unknown;
  readonly mentions: readonly DashboardSessionMessageMention[];
  readonly ingest?: DashboardSessionMessageIngest;
  readonly thread?: DashboardSessionMessageThread;
  readonly replyQuote?: DashboardSessionMessageQuote;
  readonly turnRoles: readonly string[];
  readonly turnStatus: string | null;
  readonly turnReason: string | null;
  readonly projection?: {
    readonly session_id: string;
    readonly source_session_id: string;
    readonly relation: string;
  };
  readonly presentation?: DashboardSessionMessagePresentation;
  readonly linked_tasks: readonly SessionTaskBadge[];
  readonly linkedTasks: readonly SessionTaskBadge[];
  readonly created_at: number;
}

export type DashboardMessageProjection = {
  readonly entry: SessionTimelineEntryRow;
  readonly row: MessageRow;
};

/**
 * Describes the Dashboard Session Turn debug contract used by HTTP route DTO.
 */
export interface DashboardSessionTurn {
  readonly id: string;
  readonly status: string;
  readonly reason: string;
  readonly materializedPrompt: string | null;
  readonly runnerAttempts: readonly DashboardSessionRunnerAttempt[];
  readonly entryIds: readonly string[];
  readonly entryRoles: readonly string[];
  readonly messageIds: readonly string[];
  readonly latestMessageId: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly error: string | null;
}

export interface DashboardSessionTimelineTurn extends DashboardSessionTurn {
  readonly messageCount: number;
  readonly visibleMessageCount: number;
}

export interface DashboardSessionConversationControlEvent {
  readonly id: string;
  readonly entryId: string;
  readonly eventType: "conversation_control";
  readonly controlKind: "followup_interrupted" | "outbound_throttled" | "outbound_deferred";
  readonly reasonKind:
    | "focus_shifted"
    | "duplicate_content"
    | "session_hourly_limit"
    | "recipient_daily_limit"
    | "quiet_hours";
  readonly summary: string;
  readonly sourceMessageId: string;
  readonly anchorMessageId: string;
  readonly sessionSourceMessageId: string;
  readonly turnId: string;
  readonly createdAt: number;
}

export type DashboardSessionTimelineItem =
  | {
      readonly type: "message";
      readonly message: DashboardSessionMessage;
    }
  | {
      readonly type: "turn";
      readonly turn: DashboardSessionTimelineTurn;
      readonly messages: readonly DashboardSessionMessage[];
    }
  | {
      readonly type: "event";
      readonly event: DashboardSessionConversationControlEvent;
    };


function contextItemMessageProjection(
  item: ContextPackItemRow,
  rows: readonly DashboardMessageProjection[],
): DashboardMessageProjection | undefined {
  const entryId = item.sourceEntryId ??
    (item.itemKind === "timeline_entry" ? item.itemId : null);
  if (entryId !== null) {
    const byEntry = rows.find((row) => row.entry.id === entryId);
    if (byEntry !== undefined) {
      return byEntry;
    }
  }
  const messageId = item.sourceMessageId ??
    (item.itemKind === "message" ? item.itemId : null);
  if (messageId === null) {
    return undefined;
  }
  return rows.find((row) =>
    row.row.id === messageId &&
    (item.sourceSessionId === null || row.entry.sessionId === item.sourceSessionId)
  ) ?? rows.find((row) => row.row.id === messageId);
}

function toDashboardSessionContextMessage(
  projection: DashboardMessageProjection,
  input: {
    readonly identityRows: readonly ChannelIdentityRow[];
    readonly userRows: readonly UserRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
    readonly sessionRows: readonly SessionRow[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardSessionContextMessage {
  const sender = messageSenderForRow(projection.row, input);
  return signDashboardArtifactReferencesInValue({
    id: projection.row.id,
    entryId: projection.entry.id,
    entryKind: projection.entry.entryKind,
    session_id: projection.entry.sessionId,
    sessionId: projection.entry.sessionId,
    channel_message_key: projection.row.externalMessageId,
    channelMessageKey: projection.row.externalMessageId,
    senderUserId: sender.senderUserId,
    senderUser: sender.senderUser,
    role: projection.row.role,
    contentKind: projection.row.contentKind,
    presentationKind: projection.row.presentationKind,
    providerMessageType: projection.row.providerMessageType,
    content: projection.row.contentJson,
    created_at: projection.row.occurredAt,
    createdAt: projection.row.occurredAt,
  }, { artifactSigner: input.artifactSigner });
}


function isLaunchContextPackKind(kind: string): boolean {
  return kind === "session_launch" || kind === "thread_launch" || kind === "group_launch";
}

export function toDashboardSession(
  row: SessionRow,
  input: {
    readonly bindingStatus: DashboardSession["bindingStatus"];
    readonly shadowName?: string | null;
    readonly listening?: boolean | null;
    readonly hasPendingWork?: boolean;
    readonly hasClarification?: boolean;
    readonly latestTurnFailed?: boolean;
    readonly sessionRows: readonly SessionRow[];
    readonly timelineRows: readonly DashboardMessageProjection[];
    readonly surfaceRows: readonly ChannelSurfaceRow[];
    readonly identityRows: readonly ChannelIdentityRow[];
    readonly userRows: readonly UserRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
    readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
    readonly userIdentityLinkRows?: readonly UserIdentityLinkRow[] | undefined;
    readonly taskRows: readonly TaskRow[];
    readonly deletedTaskRefs?: readonly DeletedTaskReference[];
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly subscriptionRows: readonly TaskSubscriptionRow[];
    readonly contextBundleRows: DashboardContextBundleRows;
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardSession {
  const linkedTasks = taskBadgesForSession(row.id, input);
  const surface = channelSurfaceForSession(row, input.surfaceRows, input.directRecipientRows);
  const displayTitleMessages = input.timelineRows.map((item) =>
    toDisplayTitleMessage(item, input.identityRows),
  );
  const displayTitle = resolveSessionDisplayTitle({
    row,
    surfaceRows: input.surfaceRows,
    messageRows: displayTitleMessages,
    identityRows: input.identityRows,
    directRecipientRows: input.directRecipientRows,
    userIdentityLinkRows: input.userIdentityLinkRows,
    userRows: input.userRows,
  });
  const avatarUrl = sessionAvatarUrlForRow(row, {
    surface,
    displayTitleMessages,
    identityRows: input.identityRows,
    channelUserBindingRows: input.channelUserBindingRows,
    userRows: input.userRows,
    directRecipientRows: input.directRecipientRows,
    userIdentityLinkRows: input.userIdentityLinkRows,
  });
  const parentRow = row.parent_session_id === null
    ? undefined
    : input.sessionRows.find((candidate) => candidate.id === row.parent_session_id);
  const parentSurface = parentRow === undefined
    ? null
    : channelSurfaceForSession(parentRow, input.surfaceRows, input.directRecipientRows);
  const parentSession: DashboardParentSessionSummary | null = parentRow === undefined
    ? null
    : {
        id: parentRow.id,
        displayTitle: resolveSessionDisplayTitle({
          row: parentRow,
          surfaceRows: input.surfaceRows,
          messageRows: displayTitleMessages,
          identityRows: input.identityRows,
          directRecipientRows: input.directRecipientRows,
          userIdentityLinkRows: input.userIdentityLinkRows,
          userRows: input.userRows,
        }),
        avatarUrl: parentSurface?.avatarUrl ?? null,
        memberCount: parentSurface?.memberCount ?? null,
      };
  const attentionState = sessionAttentionStateForRow(row.id, {
    hasPendingWork: input.hasPendingWork ?? false,
    hasClarification: input.hasClarification ?? false,
    latestTurnFailed: input.latestTurnFailed ?? false,
    taskRows: input.taskRows,
    sourceContextItems: input.sourceContextItems,
    subscriptionRows: input.subscriptionRows,
  });
  const latestMessage = latestDashboardMessageProjection(row.id, input);
  const latestMessagePreview = latestMessage === undefined
    ? null
    : previewMessageContent(
        latestMessage.row.contentJson,
        { artifactSigner: input.artifactSigner },
      );
  const threadAnchorPreview = threadAnchorPreviewForSession(row, {
    timelineRows: input.timelineRows,
    artifactSigner: input.artifactSigner,
  });
  const latestSender = latestMessage === undefined
    ? null
    : messageSenderForRow(latestMessage.row, {
      userRows: input.userRows,
    });
  const latestMessageAt = latestMessage?.row.occurredAt ?? null;
  const contextBundle = buildDashboardContextBundle(
    "session",
    row.id,
    input.contextBundleRows,
    (item) => {
      const projection = contextItemMessageProjection(item, input.timelineRows);
      return projection === undefined
        ? null
        : toDashboardSessionContextMessage(projection, {
            identityRows: input.identityRows,
            userRows: input.userRows,
            channelUserBindingRows: input.channelUserBindingRows,
            sessionRows: input.sessionRows,
            artifactSigner: input.artifactSigner,
          });
    },
    {
      metadataForPack: (pack) => signDashboardArtifactReferencesInValue(
        pack.metadataJson ?? null,
        { artifactSigner: input.artifactSigner },
      ),
      metadataForItem: (item) => signDashboardArtifactReferencesInValue(
        item.metadataJson ?? null,
        { artifactSigner: input.artifactSigner },
      ),
      previewContextMessage: (message) =>
        previewMessageContent(message.content, {
          artifactSigner: input.artifactSigner,
        }),
    },
  );
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    shadowId: row.shadow_id,
    shadowName: input.shadowName ?? null,
    bindingStatus: input.bindingStatus,
    channel_type: row.channel_type,
    channelType: row.channel_type,
    channel_id: row.channel_id,
    group_id: row.group_id,
    thread_id: row.thread_key,
    root_message_id: row.root_message_key,
    parent_session_id: row.parent_session_id,
    parentSessionId: row.parent_session_id,
    parentSession,
    title: row.title,
    display_title: displayTitle,
    displayTitle,
    avatarUrl,
    listening: input.listening ?? null,
    attentionState,
    surface,
    message_count: input.timelineRows.filter(
      (item) => item.entry.sessionId === row.id && !isInternalMessage(item.row),
    ).length,
    thread_anchor_preview: threadAnchorPreview,
    threadAnchorPreview,
    latest_message_preview: latestMessagePreview,
    latestMessagePreview: latestMessagePreview,
    latestSenderUserId: latestSender?.senderUserId ?? null,
    latestSenderUser: latestSender?.senderUser ?? null,
    latest_message_at: latestMessageAt,
    latestMessageAt: latestMessageAt,
    linked_tasks: linkedTasks,
    linkedTasks,
    contextPacks: contextBundle.contextPacks,
    launchContextPacks: contextBundle.contextPacks.filter((pack) =>
      isLaunchContextPackKind(pack.kind)
    ),
    seedRecords: contextBundle.seedRecords,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function channelSurfaceForSession(
  row: SessionRow,
  surfaceRows: readonly ChannelSurfaceRow[],
  directRecipientRows?: readonly DirectRecipientRow[],
): DashboardSurface | null {
  if (row.group_id !== null) {
    const surface = surfaceRows.find(
      (candidate) =>
        candidate.channelType === row.channel_type &&
        candidate.channelId === row.channel_id &&
        candidate.externalId === row.group_id,
    );
    if (surface !== undefined) {
      return toDashboardSurface(surface);
    }
  }
  const direct = directRecipientForSession(row, directRecipientRows);
  if (direct !== null && row.channel_type !== "dashboard") {
    return {
      id: `direct:${direct.id}`,
      externalId: direct.surfaceId ?? direct.recipientId,
      kind: "p2p",
      displayName: null,
      avatarUrl: null,
      memberCount: null,
    };
  }
  return null;
}

function toDashboardSurface(row: ChannelSurfaceRow): DashboardSurface {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: resolveChannelSurfaceKind(row),
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    memberCount: surfaceMemberCount(row.rawProfileJson),
  };
}

function surfaceMemberCount(rawProfileJson: string | null): number | null {
  if (rawProfileJson === null) {
    return null;
  }
  const parsed = parseJsonOrString(rawProfileJson);
  if (!isRecord(parsed)) {
    return null;
  }
  const userCount = positiveIntOrNull(parsed.user_count ?? parsed.userCount);
  const botCount = positiveIntOrNull(parsed.bot_count ?? parsed.botCount);
  if (userCount !== null) {
    return userCount + (botCount ?? 0);
  }
  return positiveIntOrNull(parsed.member_count ?? parsed.memberCount);
}

function positiveIntOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function sessionAvatarUrlForRow(
  row: SessionRow,
  input: {
    readonly surface: DashboardSurface | null;
    readonly displayTitleMessages: ReturnType<typeof toDisplayTitleMessage>[];
    readonly identityRows: readonly ChannelIdentityRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
    readonly userRows: readonly UserRow[];
    readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
    readonly userIdentityLinkRows?: readonly UserIdentityLinkRow[] | undefined;
  },
): string | null {
  if (row.channel_type === "dashboard") {
    return null;
  }
  if (input.surface?.kind === "group") {
    return input.surface.avatarUrl;
  }
  if (input.surface?.kind === "p2p") {
    const peerIdentity = p2pUserForSession({
      row,
      messageRows: input.displayTitleMessages,
      identityRows: input.identityRows,
      directRecipientRows: input.directRecipientRows,
    });
    if (peerIdentity !== null) {
      const boundUserId = input.channelUserBindingRows.find(
        (binding) => binding.channelIdentityId === peerIdentity.id,
      )?.userId;
      const canonicalAvatar = boundUserId === undefined
        ? null
        : input.userRows.find((user) => user.id === boundUserId)?.avatarUrl ?? null;
      if (canonicalAvatar) {
        return canonicalAvatar;
      }
      if (peerIdentity.avatarUrl) {
        return peerIdentity.avatarUrl;
      }
    }
    const directCanonical = p2pCanonicalUserForSession({
      row,
      directRecipientRows: input.directRecipientRows,
      userIdentityLinkRows: input.userIdentityLinkRows,
      userRows: input.userRows,
    });
    if (directCanonical?.avatarUrl) {
      return directCanonical.avatarUrl;
    }
  }
  return input.surface?.avatarUrl ?? null;
}

function sessionAttentionStateForRow(
  sessionId: string,
  input: {
    readonly hasPendingWork: boolean;
    readonly hasClarification: boolean;
    readonly latestTurnFailed: boolean;
    readonly taskRows: readonly TaskRow[];
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly subscriptionRows: readonly TaskSubscriptionRow[];
  },
): SessionAttentionState {
  const taskIds = new Set(
    input.sourceContextItems
      .filter((source) => source.sourceSessionId === sessionId)
      .map((source) => source.taskId),
  );
  for (const subscription of input.subscriptionRows) {
    if (subscription.session_id === sessionId) {
      taskIds.add(subscription.task_id);
    }
  }
  const linkedTasks = input.taskRows.filter(
    (task) => task.primary_session_id === sessionId || taskIds.has(task.id),
  );
  if (
    input.hasPendingWork ||
    linkedTasks.some((task) => task.status === "running" || task.status === "new")
  ) {
    return "run";
  }
  if (
    input.hasClarification ||
    linkedTasks.some((task) => task.block_reason !== null)
  ) {
    return "wait";
  }
  if (
    input.latestTurnFailed ||
    linkedTasks.some((task) => task.status === "failed")
  ) {
    return "fail";
  }
  return "idle";
}

function messageSenderForRow(
  row: MessageRow,
  input: {
    readonly userRows: readonly UserRow[];
  },
) {
  return resolveMessageSender({
    senderUserId: row.senderUserId,
    deleted: row.deletedAt != null,
    userRows: input.userRows,
  });
}

function latestDashboardMessageProjection(
  sessionId: string,
  input: {
    readonly timelineRows: readonly DashboardMessageProjection[];
  },
): DashboardMessageProjection | undefined {
  return input.timelineRows
    .filter((item) => item.entry.sessionId === sessionId && !isInternalMessage(item.row))
    .sort((left, right) => right.row.occurredAt - left.row.occurredAt)[0];
}

function threadAnchorPreviewForSession(
  row: SessionRow,
  input: {
    readonly timelineRows: readonly DashboardMessageProjection[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): string | null {
  if (row.root_message_key === null && row.thread_key === null) {
    return null;
  }

  const rootMessage = row.root_message_key === null
    ? undefined
    : input.timelineRows.find(
      (item) =>
        item.entry.sessionId === row.id &&
        !isInternalMessage(item.row) &&
        (item.row.id === row.root_message_key ||
          item.row.externalMessageId === row.root_message_key),
    );
  if (rootMessage !== undefined) {
    const preview = previewMessageContent(rootMessage.row.contentJson, {
      artifactSigner: input.artifactSigner,
    });
    return preview.length === 0 ? null : preview;
  }

  const anchorRef = input.timelineRows.find(
    (item) =>
      item.entry.sessionId === row.id &&
      item.entry.entryKind === "reference" &&
      !isInternalMessage(item.row),
  );
  if (anchorRef === undefined) {
    const firstThreadMessage = input.timelineRows.find(
      (item) =>
        item.entry.sessionId === row.id &&
        item.entry.entryKind === "message" &&
        !isInternalMessage(item.row),
    );
    if (firstThreadMessage === undefined) {
      return null;
    }
    const fallbackPreview = previewMessageContent(firstThreadMessage.row.contentJson, {
      artifactSigner: input.artifactSigner,
    });
    return fallbackPreview.length === 0 ? null : fallbackPreview;
  }
  const preview = previewMessageContent(anchorRef.row.contentJson, {
    artifactSigner: input.artifactSigner,
  });
  return preview.length === 0 ? null : preview;
}

function previewMessageContent(
  content: unknown,
  options: { readonly artifactSigner: DashboardArtifactSigner },
): string {
  const safeContent = signDashboardArtifactReferencesInValue(content, {
    artifactSigner: options.artifactSigner,
  });
  const parsed = typeof safeContent === "string"
    ? parseJsonOrString(safeContent)
    : safeContent;
  const text = previewText(parsed).replace(/\s+/g, " ").trim();
  if (text.length <= 140) {
    return text;
  }
  return `${text.slice(0, 137)}…`;
}

function previewText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(previewText).filter(Boolean).join(" ");
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
  }
  return "";
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toDashboardSessionMessage(
  projection: DashboardMessageProjection,
  input: {
    readonly identityRows: readonly ChannelIdentityRow[];
    readonly userRows: readonly UserRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
    readonly mentionRows: readonly MessageMentionRow[];
    readonly sessionRows: readonly SessionRow[];
    readonly taskRows: readonly TaskRow[];
    readonly deletedTaskRefs?: readonly DeletedTaskReference[];
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly turnEntryRows: readonly {
      readonly turn: SessionTurnRow;
      readonly entry: SessionTurnEntryRow;
    }[];
    readonly replyTargetExternalIds: ReadonlySet<string>;
    readonly sessionProjections?: readonly DashboardMessageProjection[];
    readonly commandReplyToByCommandId?: ReadonlyMap<string, string>;
    readonly owningSessionIdForMessage: (messageId: string) => string | null;
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardSessionMessage {
  const row = projection.row;
  const linkedTasks = taskBadgesForMessage(row, input);
  const sender = messageSenderForRow(row, input);
  const mentions = mentionsForMessage(row.id, input);
  let presentation = presentationForMessage(row, input.taskRows);
  const deletedTask = linkedTasks.find(task => task.status === "deleted" && task.id === sourceTaskIdForMessage(row));
  if (deletedTask && presentation && "task" in presentation) presentation = { ...presentation, task: deletedTask };
  const turnEntries = input.turnEntryRows.filter(
    (item) => item.entry.entry_id === projection.entry.id,
  );
  const firstTurn = turnEntries[0]?.turn;
  const ingest = ingestForMessage(row);
  const thread = threadForMessage(row, input.replyTargetExternalIds);
  const replyQuote = replyQuoteForMessage(projection, thread, input);
  const owningSessionId = input.owningSessionIdForMessage(row.id)
    ?? projection.entry.sessionId;
  return signDashboardArtifactReferencesInValue({
    id: row.id,
    entryId: projection.entry.id,
    entryKind: projection.entry.entryKind,
    session_id: projection.entry.sessionId,
    owning_session_id: owningSessionId,
    channel_message_key: row.externalMessageId,
    senderUserId: sender.senderUserId,
    senderUser: sender.senderUser,
    role: row.role,
    contentKind: row.contentKind,
    presentationKind: row.presentationKind,
    providerMessageType: row.providerMessageType,
    content: row.contentJson,
    mentions,
    ...(ingest === undefined ? {} : { ingest }),
    ...(thread === undefined ? {} : { thread }),
    ...(replyQuote === undefined ? {} : { replyQuote }),
    turnRoles: turnEntries.map((item) => item.entry.role),
    turnStatus: firstTurn?.status ?? null,
    turnReason: firstTurn?.reason ?? null,
    ...(projection.entry.entryKind === "reference"
      ? {
          projection: {
            session_id: projection.entry.sessionId,
            source_session_id: owningSessionId,
            relation: "reference",
          },
        }
      : {}),
    ...(presentation !== undefined ? { presentation } : {}),
    linked_tasks: linkedTasks,
    linkedTasks,
    created_at: row.occurredAt,
  }, { artifactSigner: input.artifactSigner });
}

function ingestForMessage(
  row: MessageRow,
): DashboardSessionMessageIngest | undefined {
  const payload = isRecord(row.rawPayloadJson) ? row.rawPayloadJson : null;
  const ingest =
    payload !== null && isRecord(payload.lunaIngest)
      ? payload.lunaIngest
      : null;
  if (ingest?.mode !== "history_backfill") {
    return undefined;
  }
  return {
    mode: "history_backfill",
    source:
      typeof ingest.source === "string" && ingest.source.length > 0
        ? ingest.source
        : "group_join_backfill",
    importedAt: typeof ingest.importedAt === "number" ? ingest.importedAt : null,
    joinEventId:
      typeof ingest.joinEventId === "string" ? ingest.joinEventId : null,
  };
}

function threadForMessage(
  row: MessageRow,
  replyTargetExternalIds: ReadonlySet<string>,
): DashboardSessionMessageThread | undefined {
  const payload = isRecord(row.rawPayloadJson) ? row.rawPayloadJson : null;
  const normalizedThread = isRecord(payload?.thread) ? payload.thread : null;
  const rawPayload = isRecord(payload?.rawPayload) ? payload.rawPayload : null;
  const threadId =
    stringField(normalizedThread, "externalId") ??
    stringField(rawPayload, "thread_id") ??
    null;
  const rootMessageExternalId =
    stringField(normalizedThread, "rootMessageExternalId") ??
    stringField(rawPayload, "root_id") ??
    null;
  const parentMessageExternalId =
    stringField(normalizedThread, "parentMessageExternalId") ??
    stringField(rawPayload, "parent_id") ??
    null;
  const hasReplies = replyTargetExternalIds.has(row.externalMessageId);
  if (
    threadId === null &&
    rootMessageExternalId === null &&
    parentMessageExternalId === null &&
    !hasReplies
  ) {
    return undefined;
  }
  return {
    threadId,
    rootMessageExternalId,
    parentMessageExternalId,
    hasReplies,
  };
}

function replyQuoteForMessage(
  projection: DashboardMessageProjection,
  thread: DashboardSessionMessageThread | undefined,
  input: {
    readonly userRows: readonly UserRow[];
    readonly sessionRows: readonly SessionRow[];
    readonly sessionProjections?: readonly DashboardMessageProjection[];
    readonly commandReplyToByCommandId?: ReadonlyMap<string, string>;
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardSessionMessageQuote | undefined {
  const candidates = input.sessionProjections ?? [];
  if (candidates.length === 0) {
    return undefined;
  }
  const row = projection.row;
  const payload = isRecord(row.rawPayloadJson) ? row.rawPayloadJson : null;
  const commandId = stringField(payload, "commandId");
  const explicitReplyTo =
    stringField(payload, "replyTo") ??
    (commandId ? input.commandReplyToByCommandId?.get(commandId) : undefined);

  let target: DashboardMessageProjection | undefined;
  if (explicitReplyTo !== undefined) {
    target = candidates.find(
      (candidate) =>
        candidate.row.id === explicitReplyTo &&
        candidate.row.id !== row.id &&
        candidate.row.deletedAt === null &&
        !isInternalMessage(candidate.row),
    );
  } else if (thread?.parentMessageExternalId) {
    const currentSession = input.sessionRows.find(
      (session) => session.id === projection.entry.sessionId,
    );
    const isThreadRootReply =
      currentSession?.thread_key !== null &&
      (thread.parentMessageExternalId === thread.rootMessageExternalId ||
        thread.parentMessageExternalId === currentSession?.root_message_key);
    if (!isThreadRootReply) {
      target = candidates.find(
        (candidate) =>
          candidate.row.externalMessageId === thread.parentMessageExternalId &&
          candidate.row.id !== row.id &&
          candidate.row.deletedAt === null &&
          !isInternalMessage(candidate.row),
      );
    }
  }

  if (target === undefined) {
    return undefined;
  }
  const preview = previewMessageContent(target.row.contentJson, {
    artifactSigner: input.artifactSigner,
  });
  if (preview.length === 0) {
    return undefined;
  }
  const senderName = messageSenderForRow(target.row, {
    userRows: input.userRows,
  }).senderUser.displayName;
  return {
    messageId: target.row.id,
    senderName: senderName.length > 0 ? senderName : null,
    preview,
  };
}

function presentationForMessage(
  row: MessageRow,
  taskRows: readonly TaskRow[],
): DashboardSessionMessagePresentation | undefined {
  switch (row.presentationKind) {
    case "task_result_card": {
      const task = taskForSourceMessage(row, taskRows);
      return {
        kind: "task_final_answer",
        task: task === null
          ? null
          : {
              id: task.id,
              title: task.title,
            },
      };
    }
    case "status_card":
      return statusCardPresentation(row, taskRows);
    case "provider_rich_card":
    case "rich_markdown":
      return { kind: "rich_markdown_card" };
    default:
      return undefined;
  }
}

function statusCardPresentation(
  row: MessageRow,
  taskRows: readonly TaskRow[],
): DashboardSessionMessagePresentation {
  const task = taskForSourceMessage(row, taskRows);
  const card = firstStatusCardBlock(row.contentJson);
  const payload = isRecord(card?.payload) ? card.payload : {};
  const rawPayload = isRecord(row.rawPayloadJson) ? row.rawPayloadJson : {};
  return {
    kind: "status_card",
    task: task === null
      ? null
      : {
          id: task.id,
          title: task.title,
        },
    status: stringField(payload, "status") ?? stringField(rawPayload, "status") ?? null,
    title: stringField(card, "title") ?? stringField(rawPayload, "title") ?? task?.title ?? null,
    text: stringField(card, "text") ?? stringField(rawPayload, "text") ?? null,
  };
}

function taskForSourceMessage(
  row: MessageRow,
  taskRows: readonly TaskRow[],
): TaskRow | null {
  const taskId = sourceTaskIdForMessage(row);
  return taskId === null
    ? null
    : taskRows.find((candidate) => candidate.id === taskId) ?? null;
}

function firstStatusCardBlock(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.find((item) =>
    isRecord(item) &&
    item.type === "card" &&
    item.cardKind === "status_card"
  ) ?? null;
}

function stringField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function mentionsForMessage(
  messageId: string,
  input: {
    readonly identityRows: readonly ChannelIdentityRow[];
    readonly mentionRows: readonly MessageMentionRow[];
    readonly userRows: readonly UserRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
  },
): DashboardSessionMessageMention[] {
  return input.mentionRows
    .filter((mention) => mention.messageId === messageId)
    .map((mention) => {
      const targetUser = mentionCanonicalUser(mention, {
        userRows: input.userRows,
        channelUserBindingRows: input.channelUserBindingRows,
      });
      return {
        key: mention.mentionKey,
        label: mention.mentionLabel,
        targetIdentityId: mention.targetIdentityId,
        targetIdentity: mentionIdentity(mention, input.identityRows),
        targetUserId: targetUser?.id ?? null,
        targetUser,
        targetExternalId: mention.targetExternalId,
        targetKind: mention.targetKind,
      };
    });
}

function mentionIdentity(
  mention: MessageMentionRow,
  identityRows: readonly ChannelIdentityRow[],
): AgentIdentity | null {
  if (mention.targetIdentityId === null) {
    return null;
  }
  const row = identityRows.find(
    (candidate) => candidate.id === mention.targetIdentityId,
  );
  return row === undefined ? null : toAgentIdentity(row);
}

function mentionCanonicalUser(
  mention: MessageMentionRow,
  input: {
    readonly userRows: readonly UserRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
  },
): DashboardCanonicalUser | null {
  if (mention.targetIdentityId === null) {
    return null;
  }
  const linkedUserId = input.channelUserBindingRows.find(
    (candidate) => candidate.channelIdentityId === mention.targetIdentityId,
  )?.userId;
  if (linkedUserId === undefined) {
    return null;
  }
  const row = input.userRows.find((candidate) => candidate.id === linkedUserId);
  return row === undefined ? null : toDashboardCanonicalUser(row);
}






function toDisplayTitleMessage(
  projection: DashboardMessageProjection,
  identityRows: readonly ChannelIdentityRow[],
): {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly senderExternalId: string | null;
  readonly createdAt: number;
} {
  const sender = projection.row.senderIdentityId === null
    ? null
    : identityRows.find((candidate) => candidate.id === projection.row.senderIdentityId)
      ?.externalId ?? null;
  return {
    id: projection.row.id,
    sessionId: projection.entry.sessionId,
    role: projection.row.role,
    senderExternalId: sender,
    createdAt: projection.row.occurredAt,
  };
}

export function toDashboardSessionTimeline(input: {
  readonly messages: readonly DashboardSessionMessage[];
  readonly turns: readonly DashboardSessionTurn[];
  readonly events?: readonly DashboardSessionConversationControlEvent[];
}): DashboardSessionTimelineItem[] {
  const turnByEntryId = new Map<string, DashboardSessionTurn>();
  for (const turn of input.turns) {
    for (const entryId of turn.entryIds) {
      turnByEntryId.set(entryId, turn);
    }
  }
  const visibleMessageCountByTurnId = new Map<string, number>();
  for (const message of input.messages) {
    const turn = turnByEntryId.get(message.entryId);
    if (turn !== undefined) {
      visibleMessageCountByTurnId.set(
        turn.id,
        (visibleMessageCountByTurnId.get(turn.id) ?? 0) + 1,
      );
    }
  }

  const items: DashboardSessionTimelineItem[] = [];
  for (const message of input.messages) {
    const turn = turnByEntryId.get(message.entryId);
    if (turn === undefined) {
      items.push({ type: "message", message });
      continue;
    }
    const timelineTurn = toDashboardSessionTimelineTurn(
      turn,
      visibleMessageCountByTurnId.get(turn.id) ?? 0,
    );
    const latestItem = items[items.length - 1];
    if (latestItem?.type === "turn" && latestItem.turn.id === turn.id) {
      items[items.length - 1] = {
        ...latestItem,
        messages: [...latestItem.messages, message],
      };
      continue;
    }
    items.push({
      type: "turn",
      turn: timelineTurn,
      messages: [message],
    });
  }
  const groupedItems = items.flatMap((item) =>
    item.type === "turn" && !isMeaningfulTimelineTurnGroup(item)
      ? item.messages.map((message) => ({ type: "message" as const, message }))
      : [item],
  );
  const renderedTurnIds = new Set(
    items.flatMap((item) => (item.type === "turn" ? [item.turn.id] : [])),
  );
  const standaloneTurns: DashboardSessionTimelineItem[] = input.turns
    .filter(
      (turn) =>
        !renderedTurnIds.has(turn.id) &&
        turn.messageIds.length === 0 &&
        (turn.materializedPrompt !== null ||
          turn.runnerAttempts.length > 0 ||
          turn.status === "running" ||
          turn.status === "failed"),
    )
    .map((turn) => ({
      type: "turn" as const,
      turn: toDashboardSessionTimelineTurn(turn, 0),
      messages: [],
    }));
  const timelineItems = [
    ...groupedItems,
    ...standaloneTurns,
    ...(input.events ?? []).map((event) => ({ type: "event" as const, event })),
  ];
  return timelineItems.sort(compareDashboardSessionTimelineItems);
}

export function dashboardTimelineItemCursor(item: DashboardSessionTimelineItem): string {
  switch (item.type) {
    case "message":
      return `message:${item.message.entryId}`;
    case "turn":
      return `turn:${item.messages[0]?.entryId ?? item.turn.id}`;
    case "event":
      return `event:${item.event.entryId}`;
  }
}

function isMeaningfulTimelineTurnGroup(
  item: Extract<DashboardSessionTimelineItem, { readonly type: "turn" }>,
): boolean {
  return (
    item.turn.reason === "ambient" ||
    item.turn.materializedPrompt !== null ||
    item.turn.runnerAttempts.length > 0 ||
    item.messages.length >= 2 ||
    item.turn.entryRoles.includes("coalesced_input")
  );
}

function toDashboardSessionTimelineTurn(
  turn: DashboardSessionTurn,
  visibleMessageCount: number,
): DashboardSessionTimelineTurn {
  return {
    ...turn,
    messageCount: turn.messageIds.length,
    visibleMessageCount,
  };
}

export function toDashboardSessionConversationControlEvent(
  row: SessionTimelineEventRow,
): DashboardSessionConversationControlEvent {
  return {
    id: row.id,
    entryId: row.entryId,
    eventType: "conversation_control",
    controlKind: (row.controlKind as DashboardSessionConversationControlEvent["controlKind"]) ?? "followup_interrupted",
    reasonKind: (row.reasonKind as DashboardSessionConversationControlEvent["reasonKind"]) ?? "focus_shifted",
    summary: row.summary,
    sourceMessageId: row.sourceMessageId,
    anchorMessageId: row.anchorMessageId,
    sessionSourceMessageId: row.sessionSourceMessageId,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
}

function compareDashboardSessionTimelineItems(
  left: DashboardSessionTimelineItem,
  right: DashboardSessionTimelineItem,
): number {
  return (
    dashboardTimelineItemCreatedAt(left) - dashboardTimelineItemCreatedAt(right) ||
    dashboardTimelineItemStableId(left).localeCompare(
      dashboardTimelineItemStableId(right),
    )
  );
}

function dashboardTimelineItemCreatedAt(item: DashboardSessionTimelineItem): number {
  switch (item.type) {
    case "message":
      return item.message.created_at;
    case "turn":
      return item.messages[0]?.created_at ?? item.turn.startedAt;
    case "event":
      return item.event.createdAt;
  }
}

function dashboardTimelineItemStableId(item: DashboardSessionTimelineItem): string {
  switch (item.type) {
    case "message":
      return item.message.entryId;
    case "turn":
      return item.turn.id;
    case "event":
      return item.event.entryId;
  }
}



export function toDashboardSessionTurn(
  row: SessionTurnRow,
  allEntryRows: readonly {
    readonly entry: SessionTurnEntryRow;
    readonly timeline: SessionTimelineEntryRow;
  }[],
  attemptRows: readonly SessionRunnerAttemptRow[] = [],
): DashboardSessionTurn {
  const entryRows = allEntryRows.filter((item) =>
    item.entry.turn_id === row.id &&
    DASHBOARD_TURN_GROUP_ENTRY_ROLES.has(item.entry.role)
  );
  const messageIds = entryRows.map((item) => item.timeline.messageId);
  const runnerAttempts = runnerAttemptsForTurn(row.id, attemptRows);
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    materializedPrompt: runnerAttempts[0]?.inputPrompt ?? row.materialized_prompt,
    runnerAttempts,
    entryIds: entryRows.map((item) => item.entry.entry_id),
    entryRoles: entryRows.map((item) => item.entry.role),
    messageIds,
    latestMessageId: messageIds.at(-1) ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

function runnerAttemptsForTurn(
  turnId: string,
  attemptRows: readonly SessionRunnerAttemptRow[],
): DashboardSessionRunnerAttempt[] {
  return attemptRows
    .filter((row) => row.turnId === turnId)
    .sort((left, right) => left.attemptIndex - right.attemptIndex)
    .map((row) => ({
      id: row.id,
      attemptKind: row.attemptKind,
      attemptIndex: row.attemptIndex,
      status: row.status,
      runnerType: row.runnerType,
      runnerSessionId: row.runnerSessionId,
      inputPrompt: row.inputPrompt,
      rawOutput: row.rawOutput,
      rawOutputTruncated: row.rawOutputTruncated,
      parsedActionJson: row.parsedActionJson,
      parseErrorJson: row.parseErrorJson,
      repairSourceAttemptId: row.repairSourceAttemptId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));
}

const DASHBOARD_TURN_GROUP_ENTRY_ROLES = new Set([
  "trigger",
  "coalesced_input",
  "output",
]);

export function isInternalMessage(row: MessageRow): boolean {
  if (row.presentationKind === "internal") {
    return true;
  }
  const rawPayload = row.rawPayloadJson;
  return (
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    "origin" in rawPayload &&
    (rawPayload.origin === "main_runner_action_marker" ||
      rawPayload.origin === "main_runner_action_reply_marker" ||
      rawPayload.origin === "task_result_event")
  );
}

function taskBadgesForSession(
  sessionId: string,
  input: {
    readonly taskRows: readonly TaskRow[];
    readonly deletedTaskRefs?: readonly DeletedTaskReference[];
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly subscriptionRows: readonly TaskSubscriptionRow[];
  },
): SessionTaskBadge[] {
  const taskIds = new Set(
    input.sourceContextItems
      .filter((source) => source.sourceSessionId === sessionId)
      .map((source) => source.taskId),
  );
  for (const subscription of input.subscriptionRows) {
    if (subscription.session_id === sessionId) {
      taskIds.add(subscription.task_id);
    }
  }
  for (const ref of input.deletedTaskRefs ?? []) {
    if (ref.sessionId === sessionId) taskIds.add(ref.taskId);
  }
  return taskBadgesForIds(taskIds, input.taskRows, input.deletedTaskRefs);
}

function taskBadgesForMessage(
  message: MessageRow,
  input: {
    readonly taskRows: readonly TaskRow[];
    readonly deletedTaskRefs?: readonly DeletedTaskReference[];
    readonly sourceContextItems: readonly TaskSourceContextItem[];
  },
): SessionTaskBadge[] {
  const taskIds = new Set(
    input.sourceContextItems
      .filter((source) => source.sourceMessageId === message.id)
      .map((source) => source.taskId),
  );
  const sourceTaskId = sourceTaskIdForMessage(message);
  if (sourceTaskId !== null) {
    taskIds.add(sourceTaskId);
  }
  for (const ref of input.deletedTaskRefs ?? []) {
    if (ref.messageId === message.id) taskIds.add(ref.taskId);
  }
  return taskBadgesForIds(taskIds, input.taskRows, input.deletedTaskRefs);
}

function sourceTaskIdForMessage(row: MessageRow): string | null {
  if (
    row.presentationKind !== "task_result_card" &&
    row.presentationKind !== "status_card"
  ) {
    return null;
  }
  const payload = row.rawPayloadJson;
  return isRecord(payload) && typeof payload.sourceTaskId === "string"
    ? payload.sourceTaskId
    : null;
}

function taskBadgesForIds(
  taskIds: ReadonlySet<string>,
  taskRows: readonly TaskRow[],
  deletedRefs: readonly DeletedTaskReference[] = [],
): SessionTaskBadge[] {
  const deletedIds = new Set(deletedRefs.map(ref => ref.taskId));
  return [...taskIds].flatMap<SessionTaskBadge>(id => {
    if (deletedIds.has(id)) return [{ id, title: "该任务已删除", status: "deleted", priority: null }];
    const task = taskRows.find(row => row.id === id);
    return task ? [{ id: task.id, title: task.title, status: task.status, priority: task.priority }] : [];
  });
}
