import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillDetail } from "@/types/agentara";

import { ApiFetchError, agentConfigPath, apiFetch, testAgentProfileConnection } from "./client";

export type ArtifactRenderMode =
  | "markdown"
  | "html"
  | "json"
  | "text"
  | "image"
  | "pdf"
  | "binary";

export interface ArtifactPreviewData {
  id: string;
  name: string;
  kind: string;
  mimeType: string;
  renderMode: ArtifactRenderMode;
  content?: string;
  downloadUrl: string;
}

export interface ArtifactPreviewResponse {
  status: "ok";
  artifact: ArtifactPreviewData;
}

export function useArtifactPreview(
  artifactId: string | undefined,
  search: string,
) {
	  return useQuery({
	    queryKey: ["artifact-preview", artifactId, search],
	    enabled: artifactId !== undefined && artifactId.length > 0,
	    queryFn: () =>
	      apiFetch<ArtifactPreviewResponse>(
	        `/artifacts/${encodeURIComponent(artifactId ?? "")}/preview${search}`,
	      ),
	    retry: (failureCount, error) => {
	      if (
	        error instanceof ApiFetchError &&
	        (error.status === 403 || error.status === 404)
	      ) {
	        return false;
	      }
	      return failureCount < 3;
	    },
	  });
	}

// --- Luna sessions ---

export interface SessionTaskBadge {
  id: string;
  title: string;
  status: string;
  priority: string | null;
}

export interface AgentIdentity {
  id: string;
  channel: { type: string; id: string };
  externalId: string;
  identityKind: "user" | "bot" | "system" | "unknown";
  displayName?: string | null;
  avatarUrl?: string | null;
  providerIds: Record<string, string>;
}

export interface DashboardCanonicalUser {
  id: string;
  kind: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  profileSource: string;
  displayNameSource?: "manual" | "channel" | "mention" | "id";
}

export interface DashboardSurface {
  id: string;
  externalId: string;
  kind: string;
  displayName: string | null;
  avatarUrl: string | null;
  memberCount?: number | null;
}

export type SessionAttentionState = "run" | "wait" | "fail" | "idle";

export interface DashboardParentSessionSummary {
  id: string;
  displayTitle: string;
  avatarUrl: string | null;
  memberCount: number | null;
}

export interface DashboardSessionMessageQuote {
  messageId: string | null;
  senderName: string | null;
  preview: string;
}

export interface AgentMessageMention {
  key: string;
  label: string;
  targetIdentityId?: string | null;
  targetIdentity?: AgentIdentity | null;
  targetUserId?: string | null;
  targetUser?: DashboardCanonicalUser | null;
  targetExternalId: string;
  targetKind: "user" | "bot" | "system" | "unknown";
}

export type DashboardSessionMessageMention = AgentMessageMention;

export interface DashboardContextMessage {
  id: string;
  entryId: string;
  entryKind: string;
  session_id: string;
  sessionId: string;
  channel_message_key: string | null;
  channelMessageKey: string | null;
  senderUserId: string;
  senderUser: DashboardCanonicalUser;
  role: string;
  contentKind: string;
  presentationKind: string;
  providerMessageType: string | null;
  content: unknown;
  created_at: number;
  createdAt: number;
}

export interface DashboardContextPackItem {
  id: string;
  context_pack_id: string;
  contextPackId: string;
  item_kind: string;
  itemKind: string;
  item_id: string;
  itemId: string;
  source_session_id: string | null;
  sourceSessionId: string | null;
  source_entry_id: string | null;
  sourceEntryId: string | null;
  source_message_id: string | null;
  sourceMessageId: string | null;
  source_identity_id: string | null;
  sourceIdentityId: string | null;
  role: string;
  reason: string;
  display_order: number;
  displayOrder: number;
  metadata_json: unknown;
  metadataJson: unknown;
  metadata: unknown;
  messagePreview: string | null;
  contextMessage: DashboardContextMessage | null;
}

export interface DashboardContextPack {
  id: string;
  owner_type: string;
  ownerType: string;
  owner_id: string;
  ownerId: string;
  kind: string;
  selection_strategy: string;
  selectionStrategy: string;
  trigger_entry_id: string | null;
  triggerEntryId: string | null;
  trigger_message_id: string | null;
  triggerMessageId: string | null;
  created_for_invocation_id: string | null;
  createdForInvocationId: string | null;
  created_at: number;
  createdAt: number;
  metadata_json: unknown;
  metadataJson: unknown;
  metadata: unknown;
  itemCount: number;
  items: DashboardContextPackItem[];
}

export interface DashboardRunnerContextSeedRecord {
  id: string;
  runner_context_id: string;
  runnerContextId: string;
  owner_type: string;
  ownerType: string;
  owner_id: string;
  ownerId: string;
  seed_context_pack_id: string;
  seedContextPackId: string;
  seed_hash: string;
  seedHash: string;
  seed_entry_ids_json: unknown;
  seedEntryIdsJson: unknown;
  seedEntryIds: string[];
  seed_context_item_ids_json: unknown;
  seedContextItemIdsJson: unknown;
  seedContextItemIds: string[];
  created_at: number;
  createdAt: number;
}

export interface DashboardTaskRunContextSummary {
  run_id: string;
  runId: string;
  run_index: number;
  runIndex: number;
  runner_context_id: string | null;
  runnerContextId: string | null;
  contextPackIds: string[];
  contextPacks: DashboardContextPack[];
  hasMaterializedPrompt: boolean;
  seedContextPackIds: string[];
  seedRecords: DashboardRunnerContextSeedRecord[];
}

export interface DashboardSessionMessagePresentationTask {
  status?: string;
  id: string;
  title: string;
}

export type DashboardSessionMessagePresentation =
  | {
      kind: "task_final_answer";
      task: DashboardSessionMessagePresentationTask | null;
    }
  | {
      kind: "status_card";
      task: DashboardSessionMessagePresentationTask | null;
      status: string | null;
      title: string | null;
      text: string | null;
    }
  | {
      kind: "rich_markdown_card";
    };

export interface DashboardSessionMessageIngest {
  mode: "realtime" | "history_backfill";
  source: string;
  importedAt: number | null;
  joinEventId: string | null;
}

export interface DashboardSessionMessageThread {
  threadId: string | null;
  rootMessageExternalId: string | null;
  parentMessageExternalId: string | null;
  hasReplies: boolean;
}

export interface DashboardSessionRunnerAttempt {
  id: string;
  attemptKind: string;
  attemptIndex: number;
  status: string;
  runnerType: string;
  runnerSessionId: string | null;
  inputPrompt: string;
  rawOutput: string | null;
  rawOutputTruncated: boolean;
  parsedActionJson: unknown;
  parseErrorJson: unknown;
  repairSourceAttemptId: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface DashboardSession {
  status?: string;
  kind?: string;
  shadowId?: string;
  shadowName?: string | null;
  workerId?: string | null;
  bindingStatus?: "active" | "retired" | null;
  id: string;
  channel_type: string;
  channelType: string;
  channel_id: string;
  group_id: string | null;
  thread_id: string | null;
  root_message_id: string | null;
  parent_session_id?: string | null;
  parentSessionId?: string | null;
  parentSession?: DashboardParentSessionSummary | null;
  title: string | null;
  display_title: string;
  displayTitle: string;
  avatarUrl?: string | null;
  listening?: boolean | null;
  attentionState?: SessionAttentionState;
  surface: DashboardSurface | null;
  message_count: number;
  thread_anchor_preview: string | null;
  threadAnchorPreview: string | null;
  latest_message_preview: string | null;
  latestMessagePreview: string | null;
  latestSenderUserId: string | null;
  latestSenderUser: DashboardCanonicalUser | null;
  latest_message_at: number | null;
  latestMessageAt: number | null;
  linked_tasks: SessionTaskBadge[];
  linkedTasks: SessionTaskBadge[];
  contextPacks: DashboardContextPack[];
  launchContextPacks: DashboardContextPack[];
  seedRecords: DashboardRunnerContextSeedRecord[];
  created_at: number;
  updated_at: number;
}

export interface DashboardSessionMessage {
  id: string;
  entryId?: string;
  entryKind?: string;
  session_id: string;
  owning_session_id: string;
  channel_message_key: string | null;
  senderUserId: string;
  senderUser: DashboardCanonicalUser;
  role: string;
  contentKind?: string;
  presentationKind?: string;
  providerMessageType?: string | null;
  content: unknown;
  mentions: DashboardSessionMessageMention[];
  ingest?: DashboardSessionMessageIngest;
  thread?: DashboardSessionMessageThread;
  replyQuote?: DashboardSessionMessageQuote;
  turnRoles?: string[];
  turnStatus?: string | null;
  turnReason?: string | null;
  projection?: {
    session_id: string;
    source_session_id: string;
    relation: string;
  };
  presentation?: DashboardSessionMessagePresentation;
  linked_tasks: SessionTaskBadge[];
  linkedTasks: SessionTaskBadge[];
  created_at: number;
}

export interface DashboardSessionTurn {
  id: string;
  status: string;
  reason?: string;
  materializedPrompt: string | null;
  runnerAttempts?: DashboardSessionRunnerAttempt[];
  entryIds?: string[];
  entryRoles?: string[];
  messageIds: string[];
  latestMessageId: string;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
}

export interface DashboardSessionTimelineTurn extends DashboardSessionTurn {
  messageCount: number;
  visibleMessageCount: number;
}

export interface DashboardSessionConversationControlEvent {
  id: string;
  entryId: string;
  eventType: "conversation_control";
  controlKind: "followup_interrupted" | "outbound_throttled" | "outbound_deferred";
  reasonKind:
    | "focus_shifted"
    | "duplicate_content"
    | "session_hourly_limit"
    | "recipient_daily_limit"
    | "quiet_hours";
  summary: string;
  sourceMessageId: string;
  anchorMessageId: string;
  sessionSourceMessageId: string;
  turnId: string;
  createdAt: number;
}

export type DashboardSessionTimelineItem =
  | {
      type: "message";
      message: DashboardSessionMessage;
    }
  | {
      type: "turn";
      turn: DashboardSessionTimelineTurn;
      messages: DashboardSessionMessage[];
    }
  | {
      type: "event";
      event: DashboardSessionConversationControlEvent;
    };

export type UserKind = "human" | "bot" | "service" | "system";
export type IdentityKind = string;

export interface UserIdentityLink {
  id: string;
  channelIdentityId: string | null;
  identityNamespace: string;
  identityKind: IdentityKind;
  identityValue: string;
  identityScope: string;
  confidence: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
  channelIdentity: {
    id: string;
    channelType: string;
    channelId: string;
    externalId: string;
    identityKind: IdentityKind;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
}

export interface DashboardUser {
  canManageUsers?: boolean;
  /** This user is the Agent owner; the owner cannot be blocked or removed. */
  isOwner?: boolean;
  id: string;
  kind: UserKind;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  profileSource: string;
  displayNameSource?: "manual" | "channel" | "mention" | "id";
  linkedIdentities: UserIdentityLink[];
  messageCount: number;
  sessionCount: number;
  latestSessionId: string | null;
  latestSessionTitle: string | null;
  groups: DashboardUserGroup[];
  directGrants: OperationGrant[];
  indirectGrants: DashboardIndirectOperationGrant[];
  canonicalizedFromUserId?: string;
}

export interface DashboardRuntimeChannelInboundStatus {
  state: string;
  lastConnectAt?: number;
  nextConnectAt?: number;
  reconnectAttempts?: number;
  lastErrorAt?: number;
  lastError?: string;
}

export interface DashboardRuntimeChannelStatus {
  id: string;
  type: string;
  inbound?: DashboardRuntimeChannelInboundStatus;
}

export interface DashboardRuntimeAgentStatus {
  type: string;
  model: string;
}

export interface DashboardRuntimeStatus {
  status: string;
  uptime: number;
  channels: DashboardRuntimeChannelStatus[];
}

/** A signed-in Dashboard account. */
export interface DashboardAccount {
  id: string;
  name: string;
  provider: string;
  avatarUrl?: string | null;
}

export interface DashboardAuthSession {
  authenticated: boolean;
  account: DashboardAccount | null;
}

export interface DashboardAccessToken {
  id: string;
  accountId: string | null;
  source: "cli" | "mcp";
  name: string;
  role: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  metadata: unknown;
}

export interface CreateAccessTokenInput {
  readonly name: string;
  readonly source: "cli" | "mcp";
  readonly ttlMs: number;
}

export interface CreatedAccessToken {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly token: DashboardAccessToken;
}

/** Signed-in account with platform role; platform APIs still enforce it themselves. */
export function useDashboardMe() {
  return useQuery({
    queryKey: ["luna", "auth", "me"],
    queryFn: () =>
      apiFetch<{
        account?: { id: string; displayName: string; provider?: string };
        isPlatformAdmin: boolean;
        isSuperAdmin?: boolean;
      }>("/auth/me"),
  });
}

export function useDashboardAuthSession() {
  return useQuery({
    queryKey: ["luna", "auth", "session"],
    queryFn: () => apiFetch<DashboardAuthSession>("/auth/session"),
  });
}

export function useAccessTokens() {
  return useQuery({
    queryKey: ["luna", "auth", "tokens"],
    queryFn: async () => {
      const json = await apiFetch<{ tokens: DashboardAccessToken[] }>(
        "/auth/tokens",
      );
      return json.tokens;
    },
  });
}

export function useAccessTokenCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccessTokenInput) =>
      apiFetch<CreatedAccessToken>("/auth/tokens", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["luna", "auth", "tokens"],
      });
    },
  });
}

export function useAccessTokenRevokeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      apiFetch<{ status: string }>(
        `/auth/tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["luna", "auth", "tokens"],
      });
    },
  });
}

export interface DashboardAgentChoice {
  id: string;
  name: string;
  ownerAccountId: string;
  /** The owner's user inside the Agent. */
  ownerUserId: string;
  defaultShadowId: string;
  status: string;
}

export const dashboardAgentsKey = ["luna", "platform-agents"] as const;

export function useDashboardAgent(agentId?: string) {
  return useQuery({
    queryKey: [...dashboardAgentsKey, agentId],
    queryFn: ({ signal }) =>
      apiFetch<{ agent: DashboardAgentChoice }>(`/agents/${encodeURIComponent(agentId!)}`, { signal }),
    enabled: Boolean(agentId),
  });
}

export function useDashboardAgents() {
  return useQuery({
    queryKey: dashboardAgentsKey,
    queryFn: async ({ signal }) => {
      const agents: DashboardAgentChoice[] = [];
      let cursor: string | null = null;
      do {
        const page: { agents: DashboardAgentChoice[]; nextCursor: string | null } = await apiFetch(
          cursor ? `/agents?cursor=${encodeURIComponent(cursor)}` : "/agents", { signal },
        );
        agents.push(...page.agents);
        cursor = page.nextCursor;
      } while (cursor);
      return { agents };
    },
  });
}

interface DashboardResourceScope { agentId: string; shadowId?: string }

function useDashboardResourceList<T>(resource: "sessions" | "tasks", scope?: DashboardResourceScope) {
  const agentId = scope?.agentId;
  const shadowId = scope?.shadowId;
  return useQuery({
    queryKey: ["luna", resource, "list", agentId, shadowId],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ agentId: agentId! });
      if (shadowId) query.set("shadowId", shadowId);
      return apiFetch<T[]>(`/${resource}?${query}`, { signal });
    },
    enabled: Boolean(agentId),
  });
}

export function useSessions(scope?: DashboardResourceScope) {
  return useDashboardResourceList<DashboardSession>("sessions", scope);
}

export function useSession(sessionId: string, agentId: string) {
  return useQuery({
    queryKey: ["luna", "sessions", sessionId, "detail", agentId],
    queryFn: ({ signal }) => apiFetch<DashboardSession>(`/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}`, { signal }),
    enabled: Boolean(sessionId),
    refetchInterval: 10_000,
  });
}

/** Service status with this Agent's channel connections. */
export function useRuntimeStatus(agentId: string) {
  return useQuery({
    queryKey: ["luna", "runtime", "status", agentId],
    queryFn: () => apiFetch<DashboardRuntimeStatus>(`/runtime/status?agentId=${encodeURIComponent(agentId)}`),
    refetchInterval: 10_000,
  });
}

export function useUsers(agentId: string) {
  return useQuery({
    queryKey: ["luna", "users", "list", agentId],
    queryFn: async () => {
      const json = await apiFetch<{ users: DashboardUser[] }>(`/users?agentId=${encodeURIComponent(agentId)}`);
      return json.users;
    },
  });
}

/** The owner renames, blocks or unblocks a user of the Agent. */
export function useUserUpdateMutation(userId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName?: string; status?: "active" | "blocked" }) =>
      apiFetch<{ user: DashboardUser }>(`/users/${encodeURIComponent(userId)}?agentId=${encodeURIComponent(agentId)}`,
        { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["luna", "users"] }); },
  });
}

/** Takes a user off the Agent's list; a later message from them brings them back. */
export function useUserRemoveMutation(userId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/users/${encodeURIComponent(userId)}?agentId=${encodeURIComponent(agentId)}`, { method: "DELETE" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["luna", "users"] }); },
  });
}

export interface AccountLinkPreview {
  userId: string;
  channelIdentityId: string;
  channelId: string;
  channelName: string;
  shadowName: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface LinkedChannelIdentity {
  channelIdentityId: string;
  channelId: string;
  channelName: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Chat identities linked to the owner's account in this Agent, and their link/unlink operations. */
export function useAccountLinks(agentId: string) {
  const queryClient = useQueryClient();
  const base = `/agents/${encodeURIComponent(agentId)}/account-links`;
  const key = ["luna", "account-links", agentId];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
  };
  return {
    list: useQuery({ queryKey: key, queryFn: async () => (await apiFetch<{ links: LinkedChannelIdentity[] }>(base)).links }),
    preview: useMutation({
      mutationFn: (token: string) => apiFetch<{ link: AccountLinkPreview }>(`${base}/preview`, { method: "POST", body: JSON.stringify({ token }) }).then(result => result.link),
    }),
    link: useMutation({
      mutationFn: (token: string) => apiFetch<{ link: AccountLinkPreview }>(base, { method: "POST", body: JSON.stringify({ token }) }).then(result => result.link),
      onSuccess: refresh,
    }),
    unlink: useMutation({
      mutationFn: (channelIdentityId: string) => apiFetch(`${base}/${encodeURIComponent(channelIdentityId)}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}

export function useUser(userId: string, agentId: string) {
  return useQuery({
    queryKey: ["luna", "users", userId, agentId],
    queryFn: () => apiFetch<DashboardUser>(`/users/${encodeURIComponent(userId)}?agentId=${encodeURIComponent(agentId)}`),
    enabled: !!userId,
  });
}

export function useSessionMessages(sessionId: string) {
  return useQuery({
    queryKey: ["luna", "sessions", sessionId, "messages"],
    queryFn: () =>
      apiFetch<DashboardSessionMessage[]>(
        `/sessions/${sessionId}/messages`,
      ),
    enabled: !!sessionId,
  });
}

export function useSessionTurns(sessionId: string) {
  return useQuery({
    queryKey: ["luna", "sessions", sessionId, "turns"],
    queryFn: () =>
      apiFetch<DashboardSessionTurn[]>(
        `/sessions/${sessionId}/turns`,
      ),
    enabled: !!sessionId,
  });
}

export function useSessionTimeline(sessionId: string, agentId: string) {
  return useInfiniteQuery({
    queryKey: ["luna", "sessions", sessionId, "timeline", agentId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ agentId, limit: "15" });
      if (pageParam !== null) query.set("before", pageParam);
      return apiFetch<{
        items: DashboardSessionTimelineItem[];
        olderCursor: string | null;
      }>(`/sessions/${encodeURIComponent(sessionId)}/timeline?${query}`);
    },
    getNextPageParam: (page) => page.olderCursor ?? undefined,
    enabled: !!sessionId,
    refetchInterval: 3000,
  });
}

// --- Luna tasks ---

export interface DashboardTaskParticipant {
  userId: string;
  role: string;
  user: DashboardCanonicalUser;
}

export interface DashboardTaskSession {
  id: string;
  title: string | null;
  display_title: string;
  displayTitle: string;
  channel_type: string;
  channelType: string;
  channel_id: string;
  group_id: string | null;
  thread_id: string | null;
}

export interface DashboardLinkedSession {
  id: string;
  title: string | null;
  displayTitle: string;
  channelType: string;
}

export interface DashboardTaskSubscription {
  id: string;
  task_id: string;
  session_id: string;
  channel_type: string;
  channel_id: string;
  group_id: string | null;
  thread_id: string | null;
  visibility: string;
  created_at: number;
  updated_at: number;
}

export interface DashboardTaskContextMessage {
  id: string;
  entryId: string;
  entryKind: string;
  session_id: string;
  sessionId: string;
  channel_message_key: string | null;
  channelMessageKey: string | null;
  senderUserId: string;
  senderUser: DashboardCanonicalUser;
  role: string;
  contentKind: string;
  presentationKind: string;
  providerMessageType: string | null;
  content: unknown;
  created_at: number;
  createdAt: number;
}

export interface DashboardTaskSourceMessage {
  sourceId: string;
  sessionId: string;
  createdAt: number;
  message: DashboardTaskContextMessage;
}

export interface DashboardTaskSourceTurnMessage {
  turnId: string;
  turnRole: string;
  sessionId: string;
  message: DashboardTaskContextMessage;
}

export interface DashboardTask {
  id: string;
  type: string;
  status: string;
  priority: string | null;
  severity: string | null;
  title: string;
  summary: string | null;
  creatorUserId: string | null;
  creatorUser: DashboardCanonicalUser | null;
  participants: DashboardTaskParticipant[];
  linked_session_count: number;
  linked_sessions: DashboardTaskSession[];
  linkedSessions: DashboardLinkedSession[];
  taskContext: unknown;
  contextPacks: DashboardContextPack[];
  seedRecords: DashboardRunnerContextSeedRecord[];
  runContextSummaries: DashboardTaskRunContextSummary[];
  sourceMessages: DashboardTaskSourceMessage[];
  sourceTurnMessages: DashboardTaskSourceTurnMessage[];
  runs: DashboardTaskRun[];
  timeline: DashboardTaskTimelineEvent[];
  artifacts: DashboardTaskArtifact[];
  subscriptions: DashboardTaskSubscription[];
  workSession: DashboardTaskSession | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

export interface DashboardTaskRun {
  id: string;
  task_id: string;
  taskId: string;
  run_index: number;
  runIndex: number;
  status: string;
  reason: string;
  input_snapshot: unknown;
  inputSnapshot: unknown;
  materialized_prompt: string | null;
  materializedPrompt: string | null;
  runner_type: string;
  runnerType: string;
  runner_context_id: string | null;
  runnerContextId: string | null;
  source_message_id: string | null;
  sourceMessageId: string | null;
  started_at: number;
  startedAt: number;
  finished_at: number | null;
  finishedAt: number | null;
  cancel_reason: string | null;
  cancelReason: string | null;
  error: string | null;
  final_report_artifact_id: string | null;
  finalReportArtifactId: string | null;
  contextPackIds: string[];
  contextPacks: DashboardContextPack[];
  hasMaterializedPrompt: boolean;
  seedRecords: DashboardRunnerContextSeedRecord[];
}

export interface DashboardTaskTimelineEvent {
  id: string;
  task_id: string;
  session_id: string | null;
  message_id: string | null;
  type: string;
  summary: string;
  data: unknown;
  taskRunId: string | null;
  runIndex: number | null;
  runReason: string | null;
  runnerType: string | null;
  visibility: string;
  actor_user_id: string | null;
  actorUserId: string | null;
  actorUser: DashboardCanonicalUser | null;
  created_at: number;
}

export interface DashboardTaskArtifact {
  id: string;
  task_id: string;
  type: string;
  name: string;
  mime_type: string | null;
  mimeType: string | null;
  path: string | null;
  content: string | null;
  metadata: unknown;
  status: string;
  created_at: number;
  href: string | null;
}

export function useTasks(scope?: DashboardResourceScope) {
  return useDashboardResourceList<DashboardTask>("tasks", scope);
}

function useTaskResource<T>(taskId: string, agentId: string, resource?: string) {
  const path = `/tasks/${encodeURIComponent(taskId)}${resource ? `/${resource}` : ""}`;
  return useQuery({
    queryKey: ["luna", "tasks", taskId, resource ?? "detail", agentId],
    queryFn: ({ signal }) => apiFetch<T>(`${path}?agentId=${encodeURIComponent(agentId)}`, { signal }),
    enabled: Boolean(taskId),
  });
}

export function useTask(taskId: string, agentId: string) {
  return useTaskResource<DashboardTask>(taskId, agentId);
}

export interface DashboardPrunedToolsSummary {
  totalCount: number;
  byRunIndex: Record<string, number>;
}

export function useTaskTimeline(taskId: string, agentId: string) {
  return useInfiniteQuery({
    queryKey: ["luna", "tasks", taskId, "timeline", agentId],
    initialPageParam: null as string | null,
    queryFn: ({signal, pageParam}) => apiFetch<{items: DashboardTaskTimelineEvent[]; nextCursor: string | null; prunedTools?: DashboardPrunedToolsSummary}>(
      `/tasks/${encodeURIComponent(taskId)}/timeline/page?agentId=${encodeURIComponent(agentId)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, {signal}),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(taskId),
    refetchInterval: 5000,
  });
}

export function useTaskRuns(taskId: string, agentId: string) {
  return useTaskResource<DashboardTaskRun[]>(taskId, agentId, "runs");
}

export function useTaskArtifacts(taskId: string, agentId: string) {
  return useTaskResource<DashboardTaskArtifact[]>(taskId, agentId, "artifacts");
}

// --- Managed Workspaces ---

export type WorkspaceFileKind = "markdown" | "json" | "yaml" | "text";

export interface WorkspaceFileEntry {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  kind: WorkspaceFileKind;
}

export type WorkspaceDirectoryEntry =
  | { type: "directory"; path: string; name: string }
  | (WorkspaceFileEntry & { type: "file"; name: string });
export interface WorkspaceDirectoryResult {
  workspaceId: string;
  path: string;
  entries: WorkspaceDirectoryEntry[];
}

export interface WorkspaceGlobResult {
  workspaceId: string;
  entries: WorkspaceFileEntry[];
}

export interface WorkspaceGrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface WorkspaceGrepResult {
  workspaceId: string;
  matches: WorkspaceGrepMatch[];
  fileMatches?: WorkspaceFileEntry[];
  fileMatchesTruncated?: boolean;
  skippedFiles?: number;
  truncated?: boolean;
}

export interface WorkspaceReadFile extends WorkspaceFileEntry {
  workspaceId?: string;
  content: string;
}

export interface WorkspaceGitStatusEntry {
  path: string;
  status: string;
}

export interface WorkspaceGitStatus {
  workspaceId: string;
  clean: boolean;
  entries: WorkspaceGitStatusEntry[];
}

export interface WorkspaceGitDiff {
  workspaceId: string;
  diff: string;
}

export interface WorkspaceGitCommitResult {
  status: "committed" | "nothing_to_commit";
  commitHash?: string;
  message?: string;
}

function workspacePath(agentId: string, workspaceId: string, operation: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({ ...params, agentId });
  return `/workspaces/${encodeURIComponent(workspaceId)}/${operation}?${query}`;
}

function useWorkspaceQuery<T>(agentId: string, workspaceId: string, operation: string, params: Record<string, string> = {}, enabled = true) {
  return useQuery({
    queryKey: ["workspace", agentId, workspaceId, operation, params],
    queryFn: ({ signal }) => apiFetch<T>(workspacePath(agentId, workspaceId, operation, params), { signal }),
    enabled: Boolean(agentId) && enabled,
    retry: false,
  });
}

export function useWorkspaceDirectory(agentId: string, workspaceId: string, path = "") {
  return useWorkspaceQuery<WorkspaceDirectoryResult>(agentId, workspaceId, "directory", { path });
}

export function useWorkspaceGlob(agentId: string, workspaceId: string, pattern = "**/*") {
  return useWorkspaceQuery<WorkspaceGlobResult>(agentId, workspaceId, "glob", { pattern });
}

export function useWorkspaceGrep(agentId: string, workspaceId: string, query: string, glob = "**/*", includeFileNames = false) {
  return useWorkspaceQuery<WorkspaceGrepResult>(agentId, workspaceId, "grep", { query, glob, ...(includeFileNames ? { includeFileNames: "true" } : {}) }, query.trim().length > 0);
}

export function useWorkspaceFile(agentId: string, workspaceId: string, path: string | null) {
  return useWorkspaceQuery<WorkspaceReadFile>(agentId, workspaceId, "file", { path: path ?? "" }, Boolean(path));
}

export function useWorkspaceGitStatus(agentId: string, workspaceId: string) {
  return useWorkspaceQuery<WorkspaceGitStatus>(agentId, workspaceId, "git/status");
}

export function useWorkspaceGitDiff(agentId: string, workspaceId: string) {
  return useWorkspaceQuery<WorkspaceGitDiff>(agentId, workspaceId, "git/diff");
}

export function useWorkspaceGitCommit(agentId: string, workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: string }) => apiFetch<WorkspaceGitCommitResult>(
      workspacePath(agentId, workspaceId, "git/commit"), { method: "POST", body: JSON.stringify(input) },
    ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["workspace", agentId, workspaceId] }),
  });
}

// --- Unified Operations and authorization subjects ---

export interface OperationPolicy {
  id: string;
  namespace: string;
  operationKind: string;
  riskLevel: string;
  defaultDecision: string;
  providerType?: "core" | "plugin";
  pluginId?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  allowedSubjectTypes: string[];
  constraintsSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface OperationInvocationAudit {
  id: string;
  invocationId?: string;
  operationId: string;
  providerType: string;
  pluginId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  source: string;
  status: string;
  errorCode?: string | null;
  artifactCount?: number;
  sessionId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
  startedAt?: number;
  endedAt?: number | null;
  durationMs?: number | null;
  expiresAt?: number;
}

export interface DashboardPluginOperation {
  id: string;
  pluginId?: string;
  providerType?: string;
  title?: string;
  description?: string;
  riskLevel?: string;
  artifactPolicy?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface DashboardPluginCommand {
  path: string[];
  operationId: string;
  help?: string;
}

export interface DashboardPluginTool {
  name: string;
  operationId: string;
  description?: string;
}

export interface DashboardPluginSkill {
  id: string;
  title?: string;
  description?: string;
  path?: string;
}

export interface DashboardPlugin {
  id: string;
  displayName: string;
  version: string;
  source: string;
  status?: string;
  requestedHostPermissions: string[];
  operations?: DashboardPluginOperation[];
  commands?: DashboardPluginCommand[];
  tools?: DashboardPluginTool[];
  skills?: DashboardPluginSkill[];
  recentAudits?: OperationInvocationAudit[];
  latestLoadError?: string | null;
  installation?: DashboardPluginInstallation | null;
  marketplaceVersions?: DashboardPluginRelease[];
}

export interface DashboardPluginMarketplaceSummary {
  id: string;
  displayName: string;
  source: string;
  latestVersion: string;
  status: "enabled" | "disabled";
  latestRelease: DashboardPluginRelease;
  installation: DashboardPluginInstallation | null;
  latestLoadError: string | null;
}

export interface DashboardPluginRelease {
  id: string;
  marketplaceId: string;
  pluginId: string;
  version: string;
  releasePath: string;
  manifestSha256: string;
  pluginJsSha256: string;
  releaseSha256: string;
  lunaApiVersion: string;
  marketplaceCommit?: string;
  validationStatus: "valid" | "invalid";
  validationError?: string;
  discoveredAt: number;
  manifest?: DashboardPlugin;
}

export interface DashboardPluginInstallation {
  pluginId: string;
  desiredState: "enabled" | "disabled";
  desiredVersion?: string;
  desiredReleaseSha256?: string;
  desiredInstalledPath?: string;
  activeState: "enabled" | "disabled";
  activeVersion?: string;
  activeReleaseSha256?: string;
  activeInstalledPath?: string;
  pendingAction: string;
  lastActivatedAt?: number;
  lastError?: string;
}

export interface DashboardPluginMarketplaceList {
  plugins: DashboardPluginMarketplaceSummary[];
}

interface DashboardPluginMarketplaceListPayload {
  plugins: DashboardPluginMarketplaceSummary[];
}

interface DashboardPluginMarketplaceDetailPayload {
  plugin: DashboardPlugin;
}

export type AuthorizationSubjectType = "user" | "group";
export type OperationGrantEffect = "allow" | "deny";

export interface OperationGrant {
  id: string;
  subjectType: AuthorizationSubjectType;
  subjectId: string;
  target: string;
  matchType: "exact" | "prefix";
  effect: OperationGrantEffect;
  expiresAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardIndirectOperationGrant extends OperationGrant {
  sourceGroup: DashboardUserGroup;
}

export interface DashboardUserGroup {
  id: string;
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
}

export interface DashboardGroupMember {
  id: string;
  groupId: string;
  userId: string;
  role: "member" | "owner" | "admin";
  createdAt: string;
  updatedAt: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
}

export interface DashboardGroup {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  avatarUrl: string | null;
  status: "active" | "disabled";
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  members: DashboardGroupMember[];
  directGrants: OperationGrant[];
}

/** Operations an Agent owner can grant on the Agent's Users and Groups pages. */
export function useOperations(agentId: string, namespace?: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["operations", agentId, namespace ?? null],
    queryFn: async () => {
      const params = new URLSearchParams({ agentId });
      const trimmedNamespace = namespace?.trim();
      if (trimmedNamespace) params.set("namespace", trimmedNamespace);
      const path = `/operations?${params}`;
      const json = await apiFetch<{ operations: OperationPolicy[] }>(
        path,
      );
      return json.operations;
    },
  });
}

export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: async () => {
      return await apiFetch<DashboardPluginMarketplaceListPayload>(
        "/plugins",
      );
    },
  });
}

export function usePlugin(pluginId: string | undefined) {
  return useQuery({
    queryKey: ["plugins", pluginId ?? null],
    enabled: pluginId !== undefined && pluginId.length > 0,
    queryFn: async () => {
      const json = await apiFetch<DashboardPluginMarketplaceDetailPayload>(
        `/plugins/${encodeURIComponent(pluginId ?? "")}`,
      );
      return json.plugin;
    },
  });
}

export function useRefreshPlugins() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ status: string; releaseCount?: number }>(
        "/plugins/refresh",
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useEnablePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { pluginId: string; version: string }) =>
      apiFetch<{ status: string; restartRequired: boolean }>(
        `/plugins/${encodeURIComponent(input.pluginId)}/enable`,
        {
          method: "POST",
          body: JSON.stringify({ version: input.version }),
        },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins", input.pluginId] });
    },
  });
}

export function useUpgradePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { pluginId: string; version: string }) =>
      apiFetch<{ status: string; restartRequired: boolean }>(
        `/plugins/${encodeURIComponent(input.pluginId)}/upgrade`,
        {
          method: "POST",
          body: JSON.stringify({ version: input.version }),
        },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins", input.pluginId] });
    },
  });
}

export function useRollbackPlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { pluginId: string; version: string }) =>
      apiFetch<{ status: string; restartRequired: boolean }>(
        `/plugins/${encodeURIComponent(input.pluginId)}/rollback`,
        {
          method: "POST",
          body: JSON.stringify({ version: input.version }),
        },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins", input.pluginId] });
    },
  });
}

export function useDisablePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pluginId: string) =>
      apiFetch<{ status: string; restartRequired: boolean }>(
        `/plugins/${encodeURIComponent(pluginId)}/disable`,
        { method: "POST" },
      ),
    onSuccess: (_data, pluginId) => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins", pluginId] });
    },
  });
}

export function useGroups(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["groups", "list", agentId],
    enabled,
    queryFn: ({ signal }) => apiFetch<{ groups: DashboardGroup[]; canManageGroups: boolean }>(
      `/groups?agentId=${encodeURIComponent(agentId)}`,
      { signal },
    ),
  });
}

export function useGroup(groupId: string, agentId: string) {
  return useQuery({
    queryKey: ["groups", groupId, agentId],
    queryFn: () => apiFetch<{ group: DashboardGroup; canManageGroups: boolean }>(
      `/groups/${encodeURIComponent(groupId)}?agentId=${encodeURIComponent(agentId)}`,
    ),
    enabled: groupId.trim().length > 0,
  });
}

export function useGroupCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agentId: string;
      slug: string;
      displayName: string;
      description?: string;
      avatarUrl?: string;
    }) =>
      apiFetch<{ group: DashboardGroup }>("/groups", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function useGroupMemberMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      groupId: string;
      userId: string;
      role?: "member" | "owner" | "admin";
    }) =>
      apiFetch<{ member: DashboardGroupMember }>(
        `/groups/${input.groupId}/members`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: input.userId,
            role: input.role ?? "member",
          }),
        },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["groups", input.groupId] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users", input.userId] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
    },
  });
}

export function useGroupMemberDeleteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      groupId: string;
      userId: string;
    }) =>
      apiFetch<{ member: DashboardGroupMember }>(
        `/groups/${input.groupId}/members/${input.userId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["groups", input.groupId] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users", input.userId] });
    },
  });
}

export function useGroupGrantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      groupId: string;
      target: string;
      matchType?: "exact" | "prefix";
      effect: OperationGrantEffect;
      constraints?: Record<string, unknown>;
      expiresAt?: number;
    }) =>
      apiFetch<{ grant: OperationGrant }>(
        `/groups/${input.groupId}/authorization-rules`,
        {
          method: "POST",
          body: JSON.stringify({
            target: input.target,
            effect: input.effect,
            matchType: input.matchType,
            ...(input.expiresAt === undefined
              ? {}
              : { expiresAt: input.expiresAt }),
          }),
        },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["groups", input.groupId] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["authorization-rules"] });
    },
  });
}

export function useOperationGrantBatchMutation(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      items: Array<{
        subjectType: AuthorizationSubjectType;
        subjectId: string;
        target: string;
      matchType?: "exact" | "prefix";
        effect: OperationGrantEffect;
        constraints?: Record<string, unknown>;
        expiresAt?: number;
      }>;
    }) =>
      apiFetch<{ grants: OperationGrant[] }>(`/groups/${encodeURIComponent(groupId)}/authorization-rules/batch`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["authorization-rules"] });
    },
  });
}

export function useOperationGrantDeleteMutation(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      apiFetch<{ grant: OperationGrant }>(
        `/groups/${encodeURIComponent(groupId)}/authorization-rules/${encodeURIComponent(grantId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["authorization-rules"] });
    },
  });
}

export function useUserGroupMembershipMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      groupId: string;
      role?: "member" | "owner" | "admin";
    }) =>
      apiFetch<{ membership: DashboardGroupMember }>(
        `/users/${userId}/group-memberships`,
        {
          method: "POST",
          body: JSON.stringify({
            groupId: input.groupId,
            role: input.role ?? "member",
          }),
        },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users", userId] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["groups", input.groupId] });
    },
  });
}

export function useUserGroupMembershipDeleteMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) =>
      apiFetch<{ membership: DashboardGroupMember }>(
        `/users/${userId}/group-memberships/${groupId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, groupId) => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users", userId] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["groups", groupId] });
    },
  });
}

/** Agent-scoped grants for one user, managed by the Agent owner on the Users page. */
export function useUserOperationGrantBatchMutation(userId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      items: Array<{
        target: string;
        matchType?: "exact" | "prefix";
        effect: OperationGrantEffect;
        expiresAt?: number;
      }>;
    }) =>
      apiFetch<{ grants: OperationGrant[] }>(
        `/users/${encodeURIComponent(userId)}/authorization-rules/batch?agentId=${encodeURIComponent(agentId)}`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function useUserOperationGrantDeleteMutation(userId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      apiFetch<{ grant: OperationGrant }>(
        `/users/${encodeURIComponent(userId)}/authorization-rules/${encodeURIComponent(grantId)}?agentId=${encodeURIComponent(agentId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

// --- Skills ---

/**
 * Fetches all installed Claude Code skills from `~/.claude/skills/`.
 */
export interface SkillsResult {
  entries: Skill[];
}

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => apiFetch<SkillsResult>("/skills"),
  });
}

export function useSkill(slug: string | null) {
  return useQuery({
    queryKey: ["skills", slug],
    queryFn: () => apiFetch<SkillDetail>(`/skills/${encodeURIComponent(slug ?? "")}`),
    enabled: slug !== null && slug.length > 0,
  });
}

// --- Agent memory ---

export type DashboardMemoryType = "persona" | "person" | "chat" | "feedback" | "project" | "procedure" | "reference" | "episode";
export type DashboardMemoryOriginKind = "inline" | "reflection" | "consolidation" | "owner" | "migration";
export type DashboardMemoryChangeKind = DashboardMemoryOriginKind | "forgetting";
export type DashboardMemoryStatus = "active" | "deleted" | "archived";

export interface DashboardMemoryFields {
  type: DashboardMemoryType;
  title: string;
  description: string;
  body: string;
  subjectId: string | null;
  core: boolean;
  expiresAt: number | null;
}

export interface DashboardMemory extends DashboardMemoryFields {
  id: string;
  visibility: "agent" | "shadow";
  originKind: DashboardMemoryOriginKind;
  originShadowId: string | null;
  originShadowName: string | null;
  originSessionId: string | null;
  originTaskId: string | null;
  originUserId: string | null;
  originUserName: string | null;
  subjectName: string | null;
  trusted: boolean;
  revision: number;
  status: DashboardMemoryStatus;
  supersededBy: string | null;
  lastUsedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardMemoryRevision {
  revision: number;
  changeKind: DashboardMemoryChangeKind;
  changedByUserId: string | null;
  changedByShadowId: string | null;
  createdAt: number;
  snapshot: DashboardMemoryFields & {
    status: DashboardMemoryStatus;
    trusted: boolean;
    visibility: "agent" | "shadow";
    /** Why the writer made this change, in one line; absent when none was given. */
    reason?: string;
    /** Where in a conversation this version was written; absent for maintenance, Dashboard edits and older versions. */
    source?: DashboardMemorySource;
  };
}

export interface DashboardMemorySource {
  sessionId: string;
  entryId: string;
  messageId: string;
  at: number;
}

export interface DashboardMemoryFilter {
  query: string;
  type: string;
  excludeType?: string;
  originKind: string;
  originShadowId: string;
  status: string;
  core: string;
  /** "false" lists entries waiting for the owner's confirmation. */
  trusted: string;
  sort: "updatedAt" | "createdAt";
  limit: number;
  offset: number;
}

export interface DashboardMemoryListResponse {
  memories: DashboardMemory[];
  total: number;
  core: { used: number; limit: number; shadowLimit: number };
  persona: { limit: number; byShadow: Record<string, number> };
  stats: { activeMemories: number; archivedMemories: number; untrustedMemories: number; activePersonas: number };
}

/** Owner view of an Agent's memory, one server-filtered page at a time, with its edit, delete and restore operations. */
export function useAgentMemories(agentId: string, filter: DashboardMemoryFilter) {
  const base = `/agents/${encodeURIComponent(agentId)}/memories`;
  const scopeKey = ["luna", "agent-memories", agentId];
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: scopeKey });
  const send = (path: string, method: string, body?: unknown) =>
    apiFetch<{ memory: DashboardMemory }>(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(result => result.memory);
  const params = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
  const list = useQuery({
    queryKey: [...scopeKey, "list", params.toString()],
    queryFn: ({ signal }) => apiFetch<DashboardMemoryListResponse>(`${base}?${params}`, { signal }),
    placeholderData: previous => previous,
  });
  const save = useMutation({
    mutationFn: (input: DashboardMemoryFields & { id?: string; expectedRevision?: number; shadowId?: string; reason?: string }) => {
      // `shadowId` names the Shadow a new persona entry belongs to; it is not part of an update. `reason` says why an update is made.
      const { id, expectedRevision, shadowId, reason, ...fields } = input;
      return id ? send(`/${encodeURIComponent(id)}`, "PUT", { ...fields, expectedRevision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }) : send("", "POST", { ...fields, ...(shadowId ? { shadowId } : {}) });
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (input: { id: string; expectedRevision: number }) => send(`/${encodeURIComponent(input.id)}?expectedRevision=${input.expectedRevision}`, "DELETE"),
    onSettled: refresh,
  });
  /** Goes back to an earlier revision. */
  const revert = useMutation({
    mutationFn: (input: { id: string; revision: number; expectedRevision: number }) =>
      send(`/${encodeURIComponent(input.id)}/revert`, "POST", { revision: input.revision, expectedRevision: input.expectedRevision }),
    onSettled: refresh,
  });
  /** Brings a forgotten entry back. */
  const restore = useMutation({
    mutationFn: (input: { id: string; expectedRevision: number }) => send(`/${encodeURIComponent(input.id)}/restore`, "POST", { expectedRevision: input.expectedRevision }),
    onSettled: refresh,
  });
  /** Vouches for an untrusted entry, which shares it with every conversation. */
  const confirm = useMutation({
    mutationFn: (input: { id: string; expectedRevision: number }) => send(`/${encodeURIComponent(input.id)}/confirm`, "POST", { expectedRevision: input.expectedRevision }),
    onSettled: refresh,
  });
  return { list, save, remove, revert, restore, confirm };
}

export function useAgentMemoryHistory(agentId: string, memoryId: string | undefined, revision: number | undefined) {
  return useQuery({
    queryKey: ["luna", "agent-memories", agentId, memoryId, "history", revision],
    queryFn: ({ signal }) => apiFetch<{ revisions: DashboardMemoryRevision[] }>(
      `/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId ?? "")}/history`, { signal }).then(result => result.revisions),
    enabled: memoryId !== undefined,
  });
}

// --- Agent configuration ---

export type DashboardAgentType = "claude" | "codex";

export interface DashboardAgentEnvironmentField {
  key: string;
  label: string;
  sensitive: boolean;
  required: boolean;
  affectsProviderIdentity: boolean;
}

export interface DashboardAgentTypeDescriptor {
  type: DashboardAgentType;
  label: string;
  defaultResumeOnModelChange: boolean;
  allowedCustomPrefixes: readonly string[];
  envFields: readonly DashboardAgentEnvironmentField[];
}

export type DashboardExecutionDriver = "stdio" | "pty";

export interface DashboardAgentProfileRevision {
  modelProvider?:DashboardModelProviderReference;
  id: string;
  revisionNumber: number;
  model: string;
  executionDriver?: DashboardExecutionDriver;
  resumeOnModelChange: boolean;
  env: Record<string, string>;
  secrets: Record<string, { configured: true; updatedAt: number }>;
  configFingerprint: string;
  validationState: string;
  validationResult: unknown;
  validatedAt: number | null;
  createdAt: number;
}
export interface DashboardModelProviderReference {
  kind:"worker-plugin";pluginId:string;providerId:string;workerId:string;accountId:string;credentialRevision:string;releaseSha256:string;
}

export interface DashboardAgentProfile {
  id: string;
  name: string;
  agentType: DashboardAgentType;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  latestRevision: DashboardAgentProfileRevision;
}

export type DashboardAgentConfigStatus =
  | { status: "setup_required"; active: null }
  | {
      status: "ready";
      active: {
        profileId: string;
        revisionId: string;
        name: string;
        agentType: DashboardAgentType;
        model: string;
        executionDriver?: DashboardExecutionDriver;
        resumeOnModelChange: boolean;
      };
    };

export interface CreateAgentProfileInput {
  modelProvider?:DashboardModelProviderReference|null;
  name: string;
  agentType: DashboardAgentType;
  model: string;
  executionDriver?: DashboardExecutionDriver;
  resumeOnModelChange: boolean;
  env: Record<string, string>;
  secrets: Record<string, { set: string }>;
  customSensitiveKeys?: string[];
  customNonSensitiveKeys?: string[];
}

function agentConfigKey(agentId: string) {
  return ["agent-config", agentId] as const;
}

export function useAgentConfigStatus(agentId: string) {
  return useQuery({
    queryKey: [...agentConfigKey(agentId), "status"],
    queryFn: ({ signal }) => apiFetch<DashboardAgentConfigStatus>(agentConfigPath(agentId, "status"), { signal }),
  });
}

export function useAgentTypeDescriptors(agentId: string) {
  return useQuery({
    queryKey: [...agentConfigKey(agentId), "types"],
    queryFn: async ({ signal }) => (await apiFetch<{ types: DashboardAgentTypeDescriptor[] }>(
      agentConfigPath(agentId, "types"), { signal },
    )).types,
  });
}

export function useAgentProfiles(agentId: string) {
  return useQuery({
    queryKey: [...agentConfigKey(agentId), "profiles"],
    queryFn: async ({ signal }) => (await apiFetch<{ profiles: DashboardAgentProfile[] }>(
      agentConfigPath(agentId, "profiles"), { signal },
    )).profiles,
  });
}

function useAgentConfigMutation<TInput>(
  agentId: string,
  mutationFn: (input: TInput) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentConfigKey(agentId) }),
  });
}

export function useCreateAgentProfile(agentId: string) {
  return useAgentConfigMutation(agentId, (input: CreateAgentProfileInput) =>
    apiFetch(agentConfigPath(agentId, "profiles"), {
      method: "POST",
      body: JSON.stringify(input),
    }));
}

export function useCreateAgentProfileRevision(agentId: string) {
  return useAgentConfigMutation(agentId, (input: {
    profileId: string;
    revision: Omit<CreateAgentProfileInput, "name" | "agentType">;
  }) => apiFetch(
    agentConfigPath(agentId, `profiles/${encodeURIComponent(input.profileId)}/revisions`),
    { method: "POST", body: JSON.stringify(input.revision) },
  ));
}

export function useTestAgentProfileRevision(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) => testAgentProfileConnection(agentId, revisionId),
    // Failed tests also persist a new validation state on the server.
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentConfigKey(agentId) }),
  });
}

export function useActivateAgentProfileRevision(agentId: string) {
  return useAgentConfigMutation(agentId, (revisionId: string) =>
    apiFetch(agentConfigPath(agentId, `revisions/${encodeURIComponent(revisionId)}/activate`), {
      method: "POST",
    }));
}

export function useDeleteAgentProfile(agentId: string) {
  return useAgentConfigMutation(agentId, (profileId: string) =>
    apiFetch(agentConfigPath(agentId, `profiles/${encodeURIComponent(profileId)}`), {
      method: "DELETE",
    }));
}

// --- Agent Proactivity Center ---

export interface DashboardShadowHeartbeatItem {
  shadowId: string;
  shadowName: string;
  isDefault: boolean;
  sessionId: string | null;
  cursorAt: number | null;
  lastQueuedAt: number | null;
  nextEligibleAt: number | null;
  latestCommand: {
    id: string;
    status: string;
    error: string | null;
    summary?: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  pendingActivity: {
    hasWakeActivity: boolean;
    messageSessions: number;
    messageCount: number;
    taskRunCount: number;
    scheduleOccurrenceCount: number;
    correlatedRequestCount: number;
  };
}

export interface DashboardCorrelatedRequestEventItem {
  id: string;
  seq: number;
  direction: "origin_to_target" | "target_to_origin" | "system";
  kind: string;
  content: string;
  createdAt: number;
}

export interface DashboardCorrelatedRequestItem {
  id: string;
  kind: "request";
  mode: "card" | "delegate";
  status: "open" | "in_progress" | "done" | "declined" | "expired" | "failed" | "cancelled";
  shadowId: string;
  shadowName: string;
  originSessionId: string;
  originSessionTitle: string;
  originTaskId: string | null;
  targetAddress: string;
  targetSessionId: string;
  targetSessionTitle: string;
  targetUserId: string | null;
  targetUserName: string | null;
  canAnswer?: boolean;
  instruction: string;
  contextSummary: string | null;
  options: string[];
  result: Record<string, unknown> | null;
  events: DashboardCorrelatedRequestEventItem[];
  resolvedByUserId: string | null;
  resolvedByUserName: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardProactivityOverview {
  now: number;
  settings: {
    heartbeatIntervalMs: number;
    heartbeatApprovalRequired: boolean;
    outboundPerSessionPerHour: number;
    outboundPerRecipientPerDay: number;
    outboundDedupWindowMs: number;
    quietHours: { start: string; end: string } | null;
    askDefaultExpiresMs: number;
    scheduleFailureNotifyIntervalMs: number;
    timezone: string;
    inQuietHours: boolean;
    quietHoursEndsAt: number | null;
  };
  heartbeats: DashboardShadowHeartbeatItem[];
  requests: DashboardCorrelatedRequestItem[];
  governance: {
    sentLast24h: number;
    deferredQueue: {
      id: string;
      sessionId: string;
      sessionTitle: string;
      contentPreview: string;
      availableAt: number;
      createdAt: number;
    }[];
    recentEvents: {
      id: string;
      sessionId: string;
      sessionTitle: string;
      controlKind: string;
      reasonKind: string;
      summary: string;
      createdAt: number;
    }[];
  };
}

export function useProactivityOverview(scope?: DashboardResourceScope) {
  const agentId = scope?.agentId;
  const shadowId = scope?.shadowId;
  return useQuery({
    queryKey: ["luna", "proactivity", "overview", agentId, shadowId],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ agentId: agentId! });
      if (shadowId) query.set("shadowId", shadowId);
      return apiFetch<DashboardProactivityOverview>(`/proactivity/overview?${query}`, { signal });
    },
    enabled: Boolean(agentId),
    refetchInterval: 10_000,
  });
}

export function useTriggerShadowHeartbeat(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shadowId: string) =>
      apiFetch<{ ok: boolean; commandId: string; sessionId: string; alreadyRunning: boolean }>(
        `/proactivity/heartbeats/${encodeURIComponent(shadowId)}/trigger?agentId=${encodeURIComponent(agentId)}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "proactivity"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "sessions"] });
    },
  });
}

export function useCancelProactivityRequest(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      apiFetch<{ ok: boolean; status: string; alreadySettled: boolean }>(
        `/proactivity/requests/${encodeURIComponent(requestId)}/cancel?agentId=${encodeURIComponent(agentId)}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "proactivity"] });
    },
  });
}

export function useAnswerProactivityRequest(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      requestId: string;
      answer: string;
      selectedOption?: string;
    }) =>
      apiFetch<{
        ok: boolean;
        alreadyResolved: boolean;
      }>(
        `/proactivity/requests/${encodeURIComponent(input.requestId)}/answer?agentId=${encodeURIComponent(agentId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            answer: input.answer,
            ...(input.selectedOption ? { selectedOption: input.selectedOption } : {}),
          }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["luna", "proactivity"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["luna", "sessions"] });
    },
  });
}
