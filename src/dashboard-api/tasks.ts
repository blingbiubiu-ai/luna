import { isAbsolute, relative, resolve, sep } from "node:path";

import { type ContextPackItemRow, type TaskSourceContextItem } from "@/context";
import { artifacts, channelIdentities, channelSurfaces, messages, sessionTimelineEntries, sessionTurnEntries, sessions, taskParticipants, taskRuns, taskSubscriptions, tasks, timelineEvents, channelUserBindings, users } from "@/data/schema";
import { config } from "@/shared";

import {
  buildDashboardContextBundle,
  type DashboardContextBundleRows,
  type DashboardContextPack,
  type DashboardContextPackItem,
  type DashboardRunnerContextSeedRecord,
} from "./context-packs";
import {
  type DashboardCanonicalUser,
  resolveCanonicalUser,
  resolveMessageSender,
} from "./identity";
import {
  type DashboardArtifactSigner,
  linkDashboardArtifactReferencesInMarkdown,
  signDashboardArtifactReferencesInValue,
} from "./local-paths";
import {
  type DirectRecipientRow,
  resolveSessionDisplayTitle,
  type SessionDisplayTitleMessage,
  type UserIdentityLinkRow,
} from "./session-display-title";

export type ChannelIdentityRow = typeof channelIdentities.$inferSelect;
export type ChannelSurfaceRow = typeof channelSurfaces.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ChannelUserBindingRow = typeof channelUserBindings.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SessionTimelineEntryRow = typeof sessionTimelineEntries.$inferSelect;
export type SessionTurnEntryRow = typeof sessionTurnEntries.$inferSelect;
export type TimelineMessageRow = {
  readonly entry: SessionTimelineEntryRow;
  readonly message: MessageRow;
};
export type TaskParticipantRow = typeof taskParticipants.$inferSelect;
export type TaskSubscriptionRow = typeof taskSubscriptions.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export interface ArtifactRow {
  readonly id: string;
  readonly task_id: string;
  readonly timeline_event_id: string | null;
  readonly type: string;
  readonly name: string;
  readonly mime_type: string | null;
  readonly path: string | null;
  readonly content: string | null;
  readonly metadata: unknown;
  readonly status: string;
  readonly retention_expires_at: number | null;
  readonly created_at: number;
}

export interface TaskRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly summary: string | null;
  readonly status: string;
  readonly block_reason?: string | null;
  readonly wake_at?: number | null;
  readonly wake_reason?: string | null;
  readonly priority: string;
  readonly severity: string | null;
  readonly creator_user_id: string | null;
  readonly session_id: string | null;
  readonly primary_session_id: string | null;
  readonly source_message_id: string | null;
  readonly source_entry_id: string | null;
  readonly context_json: unknown;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_activity_at: number;
}

export interface TaskRunRow {
  readonly id: string;
  readonly task_id: string;
  readonly run_index: number;
  readonly status: string;
  readonly reason: string;
  readonly input_snapshot: unknown;
  readonly materialized_prompt: string | null;
  readonly runner_type: string;
  readonly runner_context_id: string | null;
  readonly source_message_id: string | null;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly pause_reason?: string | null;
  readonly cancel_reason: string | null;
  readonly error: string | null;
  readonly final_report_artifact_id: string | null;
}

export interface TimelineEventRow {
  readonly id: string;
  readonly task_id: string;
  readonly session_id: string | null;
  readonly message_id: string | null;
  readonly actor_user_id: string | null;
  readonly source_message_id: string | null;
  readonly type: string;
  readonly summary: string;
  readonly data: unknown;
  readonly visibility: string;
  readonly created_at: number;
}

export type { AgentIdentity } from "./identity";
export type {
  DashboardContextBundleRows,
  DashboardContextPack,
  DashboardContextPackItem,
  DashboardRunnerContextSeedRecord,
} from "./context-packs";

/**
 * Describes the Dashboard Task Participant contract used by HTTP route DTO.
 */
export interface DashboardTaskParticipant {
  readonly userId: string;
  readonly role: string;
  readonly user: DashboardCanonicalUser | null;
}

/**
 * Describes the Dashboard Task Session contract used by HTTP route DTO.
 */
export interface DashboardTaskSession {
  readonly id: string;
  readonly title: string | null;
  readonly display_title: string;
  readonly displayTitle: string;
  readonly channel_type: string;
  readonly channelType: string;
  readonly channel_id: string;
  readonly group_id: string | null;
  readonly thread_id: string | null;
}

/**
 * Describes the Dashboard Linked Session contract used by HTTP route DTO.
 */
export interface DashboardLinkedSession {
  readonly id: string;
  readonly channelType: string;
  readonly title: string | null;
  readonly displayTitle: string;
}

/**
 * Describes the Dashboard Timeline Event contract used by HTTP route DTO.
 */
export interface DashboardTimelineEvent extends TimelineEventRow {
  readonly actorUserId: string | null;
  readonly actorUser: DashboardCanonicalUser | null;
  readonly taskRunId: string | null;
  readonly runIndex: number | null;
  readonly runReason: string | null;
  readonly runnerType: string | null;
}

export interface DashboardTaskRunContextSummary {
  readonly run_id: string;
  readonly runId: string;
  readonly run_index: number;
  readonly runIndex: number;
  readonly runner_context_id: string | null;
  readonly runnerContextId: string | null;
  readonly contextPackIds: readonly string[];
  readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
  readonly hasMaterializedPrompt: boolean;
  readonly seedContextPackIds: readonly string[];
  readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
}

/**
 * Describes the Dashboard Task Run contract used by HTTP route DTO.
 */
export interface DashboardTaskRun {
  readonly id: string;
  readonly task_id: string;
  readonly taskId: string;
  readonly run_index: number;
  readonly runIndex: number;
  readonly status: string;
  readonly reason: string;
  readonly input_snapshot: unknown;
  readonly inputSnapshot: unknown;
  readonly materialized_prompt: string | null;
  readonly materializedPrompt: string | null;
  readonly runner_type: string;
  readonly runnerType: string;
  readonly runner_context_id: string | null;
  readonly runnerContextId: string | null;
  readonly source_message_id: string | null;
  readonly sourceMessageId: string | null;
  readonly started_at: number;
  readonly startedAt: number;
  readonly finished_at: number | null;
  readonly finishedAt: number | null;
  readonly pause_reason: string | null;
  readonly pauseReason: string | null;
  readonly cancel_reason: string | null;
  readonly cancelReason: string | null;
  readonly error: string | null;
  readonly final_report_artifact_id: string | null;
  readonly finalReportArtifactId: string | null;
  readonly contextPackIds: readonly string[];
  readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
  readonly hasMaterializedPrompt: boolean;
  readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
}

export interface DashboardTaskContextMessage {
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

export interface DashboardTaskSourceMessage {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly message: DashboardTaskContextMessage;
}

export interface DashboardTaskSourceTurnMessage {
  readonly turnId: string;
  readonly turnRole: string;
  readonly sessionId: string;
  readonly message: DashboardTaskContextMessage;
}

/**
 * Describes the Dashboard Task contract used by HTTP route DTO.
 */
export interface DashboardTask {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly block_reason: string | null;
  readonly blockReason: string | null;
  readonly wake_at: number | null;
  readonly wakeAt: number | null;
  readonly wake_reason: string | null;
  readonly wakeReason: string | null;
  readonly primary_session_id?: string | null;
  readonly primarySessionId?: string | null;
  readonly priority: string | null;
  readonly severity: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly creatorUserId: string | null;
  readonly creatorUser: DashboardCanonicalUser | null;
  readonly participants: readonly DashboardTaskParticipant[];
  readonly linked_session_count: number;
  readonly linked_sessions: readonly DashboardTaskSession[];
  readonly linkedSessions: readonly DashboardLinkedSession[];
  readonly taskContext: unknown;
  readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
  readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
  readonly runContextSummaries: readonly DashboardTaskRunContextSummary[];
  readonly sourceMessages: readonly DashboardTaskSourceMessage[];
  readonly sourceTurnMessages: readonly DashboardTaskSourceTurnMessage[];
  readonly runs: readonly DashboardTaskRun[];
  readonly timeline: readonly DashboardTimelineEvent[];
  readonly artifacts: readonly DashboardArtifact[];
  readonly subscriptions: readonly TaskSubscriptionRow[];
  readonly workSession: DashboardTaskSession | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_activity_at: number;
}

/**
 * Describes the Dashboard Artifact contract used by HTTP route DTO.
 */
export interface DashboardArtifact extends Omit<ArtifactRow, "path"> {
  readonly path: string | null;
  readonly href: string | null;
  readonly mimeType: string | null;
}


export interface DashboardTasksProjectionRows {
  readonly participantRows: readonly TaskParticipantRow[];
  readonly sourceContextItems: readonly TaskSourceContextItem[];
  readonly subscriptionRows: readonly TaskSubscriptionRow[];
  readonly sessionRows: readonly SessionRow[];
  readonly surfaceRows: readonly ChannelSurfaceRow[];
  readonly messageRows: readonly TimelineMessageRow[];
  readonly turnEntryRows: readonly SessionTurnEntryRow[];
  readonly runRows: readonly TaskRunRow[];
  readonly timelineRows: readonly TimelineEventRow[];
  readonly artifactRows: readonly ArtifactRow[];
  readonly identityRows: readonly ChannelIdentityRow[];
  readonly userRows: readonly UserRow[];
  readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
  readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
  readonly userIdentityLinkRows?: readonly UserIdentityLinkRow[] | undefined;
  readonly displayTitleMessages?: readonly SessionDisplayTitleMessage[] | undefined;
  readonly contextBundleRows: DashboardContextBundleRows;
  readonly artifactSigner: DashboardArtifactSigner;
  readonly summaryOnly?: boolean | undefined;
}

export function buildDashboardTasks(
  taskRows: readonly TaskRow[],
  input: DashboardTasksProjectionRows,
): DashboardTask[] {
  const displayTitleMessages =
    input.displayTitleMessages ??
    input.messageRows.map((message) =>
      toDisplayTitleMessage(message, input.identityRows),
    );
  return taskRows.map((row) => toDashboardTask(row, input, displayTitleMessages));
}

export function buildDashboardTaskContextBundle(
  taskId: string,
  input: {
    readonly contextBundleRows: DashboardContextBundleRows;
    readonly messageRows: readonly TimelineMessageRow[];
    readonly userRows: readonly UserRow[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): {
  readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
  readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
} {
  return buildDashboardContextBundle(
    "task",
    taskId,
    input.contextBundleRows,
    (item) => {
      const messageRow = contextItemTimelineMessage(item, input.messageRows);
      return messageRow === undefined
        ? null
        : toDashboardTaskContextMessage(messageRow, {
            userRows: input.userRows,
            artifactSigner: input.artifactSigner,
          });
    },
    {
      previewContextMessage: (message) =>
        previewContextMessageContent(message.content),
    },
  );
}

export function toDashboardTask(
  row: TaskRow,
  input: {
    readonly participantRows: readonly TaskParticipantRow[];
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly subscriptionRows: readonly TaskSubscriptionRow[];
    readonly sessionRows: readonly SessionRow[];
    readonly surfaceRows: readonly ChannelSurfaceRow[];
    readonly messageRows: readonly TimelineMessageRow[];
    readonly turnEntryRows: readonly SessionTurnEntryRow[];
    readonly runRows: readonly TaskRunRow[];
    readonly timelineRows: readonly TimelineEventRow[];
    readonly artifactRows: readonly ArtifactRow[];
    readonly identityRows: readonly ChannelIdentityRow[];
    readonly userRows: readonly UserRow[];
    readonly channelUserBindingRows: readonly ChannelUserBindingRow[];
    readonly directRecipientRows?: readonly DirectRecipientRow[] | undefined;
    readonly userIdentityLinkRows?: readonly UserIdentityLinkRow[] | undefined;
    readonly displayTitleMessages?: readonly SessionDisplayTitleMessage[] | undefined;
    readonly contextBundleRows: DashboardContextBundleRows;
    readonly artifactSigner: DashboardArtifactSigner;
    readonly summaryOnly?: boolean | undefined;
  },
  precomputedDisplayTitleMessages?: readonly SessionDisplayTitleMessage[],
): DashboardTask {
  const linkedSessionIds = linkedSessionIdsForTask(row.id, input);
  const displayTitleMessages =
    precomputedDisplayTitleMessages ??
    input.displayTitleMessages ??
    input.messageRows.map((message) =>
      toDisplayTitleMessage(message, input.identityRows),
    );

  const linkedSessions = input.sessionRows
    .filter((session) => linkedSessionIds.has(session.id))
    .map((session) => {
      const displayTitle = resolveSessionDisplayTitle({
        row: session,
        surfaceRows: input.surfaceRows,
        messageRows: displayTitleMessages,
        identityRows: input.identityRows,
        directRecipientRows: input.directRecipientRows,
        userIdentityLinkRows: input.userIdentityLinkRows,
        userRows: input.userRows,
      });
      return {
        id: session.id,
        title: session.title,
        display_title: displayTitle,
        displayTitle,
        channel_type: session.channel_type,
        channelType: session.channel_type,
        channel_id: session.channel_id,
        group_id: session.group_id,
        thread_id: session.thread_key,
      };
    });
  const linkedSessionSummaries = linkedSessions.map(
    (session) => ({
      id: session.id,
      channelType: session.channel_type,
      title: session.title,
      displayTitle: session.displayTitle,
    }),
  );
  const workSession =
    linkedSessions.find((session) => session.id === row.primary_session_id) ??
    null;
  const isSummary = input.summaryOnly === true;
  const sourceMessages = isSummary ? [] : taskSourceMessages(row.id, input);

  const taskContext = parseJsonOrNull(row.context_json);
  const sourceTurnMessages = isSummary ? [] : taskSourceTurnMessages(row.id, input);
  const contextBundle = isSummary
    ? { contextPacks: [], seedRecords: [] }
    : buildDashboardTaskContextBundle(row.id, {
        contextBundleRows: input.contextBundleRows,
        messageRows: input.messageRows,
        userRows: input.userRows,
        artifactSigner: input.artifactSigner,
      });
  const taskRuns = input.runRows
    .filter((run) => run.task_id === row.id)
    .map((run) =>
      toDashboardTaskRun(run, {
        contextPacks: contextBundle.contextPacks,
        seedRecords: contextBundle.seedRecords,
        artifactSigner: input.artifactSigner,
      }),
    );
  const latestRun = taskRuns.reduce<DashboardTaskRun | undefined>(
    (latest, run) =>
      latest === undefined || run.runIndex > latest.runIndex ? run : latest,
    undefined,
  );
  const resolvedStatus = latestRun?.status ?? row.status;
  const isWaiting = resolvedStatus === "waiting";
  const blockReason = isWaiting ? (row.block_reason ?? null) : null;
  const wakeAt = isWaiting ? (row.wake_at ?? null) : null;
  const wakeReason = isWaiting
    ? (row.wake_reason ?? latestRun?.pauseReason ?? null)
    : null;

  return signDashboardArtifactReferencesInValue({
    id: row.id,
    type: row.type,
    status: resolvedStatus,
    block_reason: blockReason,
    blockReason,
    wake_at: wakeAt,
    wakeAt,
    wake_reason: wakeReason,
    wakeReason,
    primary_session_id: row.primary_session_id,
    primarySessionId: row.primary_session_id,
    priority: row.priority,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    creatorUserId: row.creator_user_id,
    creatorUser: resolveTaskUser(row.creator_user_id, {
      userRows: input.userRows,
    }),
    participants: input.participantRows
      .filter((participant) => participant.task_id === row.id)
      .map((participant) => ({
        userId: participant.user_id,
        role: participant.role,
        user: resolveTaskUser(participant.user_id, {
          userRows: input.userRows,
        }),
      })),
    linked_session_count: linkedSessions.length,
    linked_sessions: linkedSessions,
    linkedSessions: linkedSessionSummaries,
    taskContext,
    contextPacks: contextBundle.contextPacks,
    seedRecords: contextBundle.seedRecords,
    runContextSummaries: isSummary
      ? []
      : input.runRows
          .filter((run) => run.task_id === row.id)
          .map((run) =>
            toDashboardTaskRunContextSummary(run, {
              contextPacks: contextBundle.contextPacks,
              seedRecords: contextBundle.seedRecords,
            }),
          ),
    sourceMessages,
    sourceTurnMessages,
    runs: taskRuns,
    timeline: isSummary
      ? []
      : input.timelineRows
          .filter((event) => event.task_id === row.id)
          .map((event) =>
            toDashboardTimelineEvent(event, {
              userRows: input.userRows,
              artifactSigner: input.artifactSigner,
            }),
          ),
    artifacts: input.artifactRows
      .filter((artifact) => artifact.task_id === row.id)
      .map((artifact) =>
        toDashboardArtifact(artifact, {
          artifactSigner: input.artifactSigner,
        })
      ),
    subscriptions: isSummary
      ? []
      : input.subscriptionRows.filter(
          (subscription) => subscription.task_id === row.id,
        ),
    workSession,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.last_activity_at,
  }, { artifactSigner: input.artifactSigner });
}

function taskSourceMessages(
  taskId: string,
  input: {
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly messageRows: readonly TimelineMessageRow[];
    readonly userRows: readonly UserRow[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardTaskSourceMessage[] {
  return input.sourceContextItems
    .filter((source) => source.taskId === taskId)
    .flatMap((source) => {
      const messageRow =
        input.messageRows.find(
          (row) =>
            row.entry.sessionId === source.sourceSessionId &&
            row.message.id === source.sourceMessageId,
        ) ??
        input.messageRows.find((row) => row.message.id === source.sourceMessageId);
      if (messageRow === undefined) {
        return [];
      }
      return [{
        sourceId: source.id,
        sessionId: source.sourceSessionId,
        createdAt: source.createdAt,
        message: toDashboardTaskContextMessage(messageRow, {
          userRows: input.userRows,
          artifactSigner: input.artifactSigner,
        }),
      }];
    });
}

function taskSourceTurnMessages(
  taskId: string,
  input: {
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly messageRows: readonly TimelineMessageRow[];
    readonly turnEntryRows: readonly SessionTurnEntryRow[];
    readonly userRows: readonly UserRow[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardTaskSourceTurnMessage[] {
  const rows: DashboardTaskSourceTurnMessage[] = [];
  const seen = new Set<string>();
  for (const source of input.sourceContextItems) {
    if (source.taskId !== taskId || source.sourceEntryId === null) {
      continue;
    }
    const sourceTurnEntry = input.turnEntryRows.find(
      (entry) => entry.entry_id === source.sourceEntryId,
    );
    if (sourceTurnEntry === undefined) {
      continue;
    }
    for (const turnEntry of input.turnEntryRows) {
      if (turnEntry.turn_id !== sourceTurnEntry.turn_id) {
        continue;
      }
      const messageRow = input.messageRows.find(
        (row) => row.entry.id === turnEntry.entry_id,
      );
      if (messageRow === undefined) {
        continue;
      }
      const key = `${turnEntry.turn_id}:${turnEntry.id}:${messageRow.entry.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        turnId: turnEntry.turn_id,
        turnRole: turnEntry.role,
        sessionId: turnEntry.session_id,
        message: toDashboardTaskContextMessage(messageRow, {
          userRows: input.userRows,
          artifactSigner: input.artifactSigner,
        }),
      });
    }
  }
  return rows;
}

export function toDashboardTaskContextMessage(
  row: TimelineMessageRow,
  input: {
    readonly userRows: readonly UserRow[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardTaskContextMessage {
  const sender = resolveMessageSender({
    senderUserId: row.message.senderUserId,
    deleted: row.message.deletedAt != null,
    userRows: input.userRows,
  });
  return signDashboardArtifactReferencesInValue({
    id: row.message.id,
    entryId: row.entry.id,
    entryKind: row.entry.entryKind,
    session_id: row.entry.sessionId,
    sessionId: row.entry.sessionId,
    channel_message_key: row.message.externalMessageId,
    channelMessageKey: row.message.externalMessageId,
    senderUserId: sender.senderUserId,
    senderUser: sender.senderUser,
    role: row.message.role,
    contentKind: row.message.contentKind,
    presentationKind: row.message.presentationKind,
    providerMessageType: row.message.providerMessageType,
    content: row.message.contentJson,
    created_at: row.message.occurredAt,
    createdAt: row.message.occurredAt,
  }, { artifactSigner: input.artifactSigner });
}

export function linkedSessionIdsForTask(
  taskId: string,
  input: {
    readonly sourceContextItems: readonly TaskSourceContextItem[];
    readonly subscriptionRows: readonly TaskSubscriptionRow[];
  },
): Set<string> {
  const linkedSessionIds = new Set<string>();
  for (const source of input.sourceContextItems) {
    if (source.taskId === taskId) {
      linkedSessionIds.add(source.sourceSessionId);
    }
  }
  for (const subscription of input.subscriptionRows) {
    if (subscription.task_id === taskId) {
      linkedSessionIds.add(subscription.session_id);
    }
  }
  return linkedSessionIds;
}







function contextItemTimelineMessage(
  item: ContextPackItemRow,
  rows: readonly TimelineMessageRow[],
): TimelineMessageRow | undefined {
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
    row.message.id === messageId &&
    (item.sourceSessionId === null || row.entry.sessionId === item.sourceSessionId)
  ) ?? rows.find((row) => row.message.id === messageId);
}



function previewContextMessageContent(content: unknown): string {
  const text = previewText(content).replace(/\s+/g, " ").trim();
  return text.length <= 140 ? text : `${text.slice(0, 137)}…`;
}

function previewText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(previewText).filter(Boolean).join(" ");
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
  }
  return "";
}

function toDisplayTitleMessage(
  row: TimelineMessageRow,
  identityRows: readonly ChannelIdentityRow[],
): {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly senderExternalId: string | null;
  readonly createdAt: number;
} {
  const sender = row.message.senderIdentityId === null
    ? null
    : identityRows.find((identity) => identity.id === row.message.senderIdentityId)
      ?.externalId ?? null;
  return {
    id: row.message.id,
    sessionId: row.entry.sessionId,
    role: row.message.role,
    senderExternalId: sender,
    createdAt: row.message.occurredAt,
  };
}

export function toDashboardTaskRun(
  row: TaskRunRow,
  input: {
    readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
    readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardTaskRun {
  const inputSnapshot = parseJsonOrNull(row.input_snapshot);
  const contextPackIds = contextPackIdsFromInputSnapshot(inputSnapshot);
  const associatedContextPacks = contextPacksForRun(row, {
    contextPackIds,
    contextPacks: input.contextPacks,
  });
  const seedRecords = seedRecordsForRun(row, input.seedRecords);
  const signedRun = signDashboardArtifactReferencesInValue({
    id: row.id,
    task_id: row.task_id,
    taskId: row.task_id,
    run_index: row.run_index,
    runIndex: row.run_index,
    status: row.status,
    reason: row.reason,
    input_snapshot: inputSnapshot,
    inputSnapshot,
    materialized_prompt: row.materialized_prompt,
    materializedPrompt: row.materialized_prompt,
    runner_type: row.runner_type,
    runnerType: row.runner_type,
    runner_context_id: row.runner_context_id,
    runnerContextId: row.runner_context_id,
    source_message_id: row.source_message_id,
    sourceMessageId: row.source_message_id,
    started_at: row.started_at,
    startedAt: row.started_at,
    finished_at: row.finished_at,
    finishedAt: row.finished_at,
    pause_reason: row.pause_reason ?? null,
    pauseReason: row.pause_reason ?? null,
    cancel_reason: row.cancel_reason,
    cancelReason: row.cancel_reason,
    error: row.error,
    final_report_artifact_id: row.final_report_artifact_id,
    finalReportArtifactId: row.final_report_artifact_id,
    contextPackIds,
    contextPacks: associatedContextPacks,
    hasMaterializedPrompt: row.materialized_prompt !== null &&
      row.materialized_prompt.length > 0,
    seedRecords,
  }, { artifactSigner: input.artifactSigner });
  return {
    ...signedRun,
    materialized_prompt: row.materialized_prompt,
    materializedPrompt: row.materialized_prompt,
  };
}

export function toDashboardTaskRunContextSummary(
  row: TaskRunRow,
  input: {
    readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
    readonly seedRecords: readonly DashboardRunnerContextSeedRecord[];
  },
): DashboardTaskRunContextSummary {
  const inputSnapshot = parseJsonOrNull(row.input_snapshot);
  const contextPackIds = contextPackIdsFromInputSnapshot(inputSnapshot);
  const seedRecords = seedRecordsForRun(row, input.seedRecords);
  return {
    run_id: row.id,
    runId: row.id,
    run_index: row.run_index,
    runIndex: row.run_index,
    runner_context_id: row.runner_context_id,
    runnerContextId: row.runner_context_id,
    contextPackIds,
    contextPacks: contextPacksForRun(row, {
      contextPackIds,
      contextPacks: input.contextPacks,
    }),
    hasMaterializedPrompt: row.materialized_prompt !== null &&
      row.materialized_prompt.length > 0,
    seedContextPackIds: seedRecords.map((record) => record.seedContextPackId),
    seedRecords,
  };
}

function contextPackIdsFromInputSnapshot(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const candidate = (value as Record<string, unknown>).contextPackIds;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return uniqueStrings(candidate);
}

function contextPacksForRun(
  row: TaskRunRow,
  input: {
    readonly contextPackIds: readonly string[];
    readonly contextPacks: readonly DashboardContextPack<DashboardTaskContextMessage>[];
  },
): DashboardContextPack<DashboardTaskContextMessage>[] {
  const associatedIds = new Set(input.contextPackIds);
  if (row.run_index === 1 || row.reason === "initial") {
    for (const pack of input.contextPacks) {
      if (pack.kind === "task_launch") {
        associatedIds.add(pack.id);
      }
    }
  }
  return input.contextPacks.filter((pack) => associatedIds.has(pack.id));
}

function seedRecordsForRun(
  row: TaskRunRow,
  seedRecords: readonly DashboardRunnerContextSeedRecord[],
): DashboardRunnerContextSeedRecord[] {
  if (row.runner_context_id === null) {
    return [];
  }
  return seedRecords.filter(
    (record) => record.runnerContextId === row.runner_context_id,
  );
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseJsonOrNull(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}




export function toDashboardTimelineEvent(
  row: TimelineEventRow,
  input: {
    readonly userRows?: readonly UserRow[] | undefined;
    readonly artifactSigner: DashboardArtifactSigner;
  },
): DashboardTimelineEvent {
  const data = parseJsonOrNull(parseJsonOrNull(row.data));
  const runMetadata = timelineRunMetadata(data);
  return signDashboardArtifactReferencesInValue({
    ...row,
    data,
    actorUserId: row.actor_user_id,
    actorUser: resolveTaskUser(row.actor_user_id, {
      userRows: input.userRows,
    }),
    taskRunId: runMetadata.taskRunId,
    runIndex: runMetadata.runIndex,
    runReason: runMetadata.runReason,
    runnerType: runMetadata.runnerType,
  }, { artifactSigner: input.artifactSigner });
}




function resolveTaskUser(
  userId: string | null,
  input: {
    readonly userRows?: readonly UserRow[] | undefined;
  },
): DashboardCanonicalUser | null {
  if (userId === null) {
    return null;
  }
  if (input.userRows === undefined) {
    return null;
  }
  const userRow = input.userRows.find((candidate) => candidate.id === userId);
  if (userRow === undefined) {
    return null;
  }
  return resolveCanonicalUser(userId, input.userRows);
}



function timelineRunMetadata(data: unknown): {
  readonly taskRunId: string | null;
  readonly runIndex: number | null;
  readonly runReason: string | null;
  readonly runnerType: string | null;
} {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      taskRunId: null,
      runIndex: null,
      runReason: null,
      runnerType: null,
    };
  }
  const record = data as Record<string, unknown>;
  return {
    taskRunId:
      typeof record.taskRunId === "string" ? record.taskRunId : null,
    runIndex:
      typeof record.runIndex === "number" ? record.runIndex : null,
    runReason:
      typeof record.runReason === "string" ? record.runReason : null,
    runnerType:
      typeof record.runnerType === "string" ? record.runnerType : null,
  };
}

export function toDashboardArtifact(
  row: ArtifactRow,
  input: { readonly artifactSigner: DashboardArtifactSigner },
): DashboardArtifact {
  const safePath = toDashboardArtifactPath(row.path);
  const metadata = parseJsonOrNull(row.metadata);
  const downloadArtifactId = dashboardArtifactDownloadId(row, metadata);
  const signedHref = input.artifactSigner.previewUrl(downloadArtifactId);
  const signedArtifact = signDashboardArtifactReferencesInValue({
    ...row,
    metadata,
    content: null,
    path: safePath.path,
    href: signedHref ?? null,
    mimeType: row.mime_type,
  }, { artifactSigner: input.artifactSigner });
  return {
    ...signedArtifact,
    content: row.content === null
      ? null
      : linkDashboardArtifactReferencesInMarkdown(row.content, {
          artifactSigner: input.artifactSigner,
        }),
  };
}

function dashboardArtifactDownloadId(row: ArtifactRow, metadata: unknown): string {
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    typeof (metadata as { managedArtifactId?: unknown }).managedArtifactId ===
      "string"
  ) {
    return (metadata as { managedArtifactId: string }).managedArtifactId;
  }
  return row.id;
}

function toDashboardArtifactPath(path: string | null): {
  readonly path: string | null;
  readonly href: string | null;
} {
  if (path === null) {
    return { path: null, href: null };
  }
  const displayPath = toDashboardRelativeArtifactPath(path);
  if (displayPath === null) {
    return { path: null, href: null };
  }
  return {
    path: displayPath,
    href: null,
  };
}

function toDashboardRelativeArtifactPath(path: string): string | null {
  if (path.includes("\0")) {
    return null;
  }
  if (!isAbsolute(path)) {
    return normalizePathSeparators(path);
  }

  const home = resolve(config.paths.home);
  const target = resolve(path);
  const relativePath = relative(home, target);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return normalizePathSeparators(relativePath);
}

function normalizePathSeparators(path: string): string {
  return path.split(sep).join("/");
}
