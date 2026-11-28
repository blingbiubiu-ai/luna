import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export type LineageMemoryType = "procedure" | "feedback" | "reference" | "project";
export type LineageContributionStatus =
  | "pending_owner"
  | "pending_lineage"
  | "approved"
  | "rejected_by_owner"
  | "rejected_by_lineage"
  | "cancelled"
  | "expired";

export interface DashboardLineageTemplate {
  defaultAgentNamePrefix?: string;
  personaTemplates?: Array<{ title: string; description: string; body: string }>;
  recommendedPlugins?: string[];
  recommendedSkills?: string[];
}

export interface DashboardLineage {
  id: string;
  sourceAgentId: string;
  name: string;
  description: string;
  intakeGuidelines: string;
  allowAncestorLookup: boolean;
  allowMemberInvite: boolean;
  template: DashboardLineageTemplate;
  status: "active" | "paused" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface DashboardLineageStats {
  activeMemories: number;
  activeMembers: number;
  pendingMembers: number;
  pendingContributions: number;
}

export interface DashboardLineageMemory {
  id: string;
  lineageId: string;
  type: LineageMemoryType;
  title: string;
  description: string;
  body: string;
  status: "active" | "archived" | "deleted";
  revision: number;
  originKind: "owner_publish" | "contribution_approved" | "lineage_edit";
  contributorAccountName: string | null;
  approvedByAccountName: string | null;
  createdAt: number;
  updatedAt: number;
  override?: { mode: "muted" | "overridden"; localMemoryId: string | null } | null;
}

export interface DashboardLineageInvite {
  id: string;
  lineageId: string;
  label: string;
  requireApproval: boolean;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  status: "active" | "revoked";
  createdAt: number;
}

export interface DashboardLineageMember {
  subscriptionId: string;
  agentId: string;
  agentName: string;
  ownerAccountId: string;
  ownerDisplayName: string;
  status: "active" | "pending_approval";
  createdAt: number;
  updatedAt: number;
}

export interface DashboardLineageContribution {
  id: string;
  lineageId: string;
  sourceAgentId: string;
  sourceAgentName?: string;
  sourceOwnerName?: string;
  originKind: "consolidation" | "manual_dashboard" | "manual_chat";
  kind: "add" | "update";
  targetLineageMemoryId: string | null;
  baseRevision: number | null;
  proposedType: LineageMemoryType;
  proposedTitle: string;
  proposedDescription: string;
  proposedBody: string;
  rationale: string;
  status: LineageContributionStatus;
  reviewComment: string | null;
  resultLineageMemoryId: string | null;
  resultRevision: number | null;
  targetMemory?: DashboardLineageMemory | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardSubscriptionResponse {
  subscription: {
    id: string;
    agentId: string;
    lineageId: string;
    status: "active" | "pending_approval";
    createdAt: number;
  } | null;
  lineage: DashboardLineage | null;
  sourceAgentName: string | null;
  ancestors: Array<{
    lineageId: string;
    name: string;
    sourceAgentName: string;
    depth: number;
    allowAncestorLookup: boolean;
  }>;
}

export interface DashboardInvitePreview {
  inviteId: string;
  label: string;
  requireApproval: boolean;
  expiresAt: number | null;
  lineage: {
    id: string;
    name: string;
    description: string;
    intakeGuidelines: string;
    sourceAgentName: string;
    memoryCount: number;
    memberCount: number;
    template: DashboardLineageTemplate;
  };
}

export function useAgentLineage(agentId: string) {
  const qc = useQueryClient();
  const base = `/agents/${encodeURIComponent(agentId)}/lineage`;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agent-lineage", agentId] });
  };

  const overview = useQuery({
    queryKey: ["agent-lineage", agentId, "overview"],
    queryFn: () => apiFetch<{ lineage: DashboardLineage | null; stats?: DashboardLineageStats }>(base),
  });

  const saveConfig = useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      intakeGuidelines?: string;
      allowAncestorLookup?: boolean;
      allowMemberInvite?: boolean;
      template?: DashboardLineageTemplate;
      status?: "active" | "paused" | "archived";
    }) => apiFetch<{ lineage: DashboardLineage }>(base, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const memories = (query = "", type = "") =>
    useQuery({
      queryKey: ["agent-lineage", agentId, "memories", query, type],
      enabled: Boolean(overview.data?.lineage),
      queryFn: () => {
        const params = new URLSearchParams();
        if (query.trim()) params.set("query", query.trim());
        if (type) params.set("type", type);
        const qs = params.toString();
        return apiFetch<{ memories: DashboardLineageMemory[]; total: number }>(`${base}/memories${qs ? `?${qs}` : ""}`);
      },
    });

  const createMemory = useMutation({
    mutationFn: (body: { type: LineageMemoryType; title: string; description: string; body: string; reason?: string }) =>
      apiFetch<{ memory: DashboardLineageMemory }>(`${base}/memories`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const updateMemory = useMutation({
    mutationFn: ({ memoryId, ...body }: { memoryId: string; expectedRevision: number; type?: LineageMemoryType; title?: string; description?: string; body?: string; reason?: string }) =>
      apiFetch<{ memory: DashboardLineageMemory }>(`${base}/memories/${encodeURIComponent(memoryId)}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const deleteMemory = useMutation({
    mutationFn: ({ memoryId, expectedRevision }: { memoryId: string; expectedRevision: number }) =>
      apiFetch<{ memory: DashboardLineageMemory }>(`${base}/memories/${encodeURIComponent(memoryId)}?expectedRevision=${expectedRevision}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const publishFromLocal = useMutation({
    mutationFn: (body: { localMemoryId: string; type?: LineageMemoryType; title?: string; description?: string; body?: string; reason?: string }) =>
      apiFetch<{ memory: DashboardLineageMemory }>(`${base}/memories/publish-from-local`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const invites = useQuery({
    queryKey: ["agent-lineage", agentId, "invites"],
    enabled: Boolean(overview.data?.lineage),
    queryFn: () => apiFetch<{ invites: DashboardLineageInvite[] }>(`${base}/invites`),
  });

  const createInvite = useMutation({
    mutationFn: (body: { label?: string; requireApproval?: boolean; maxUses?: number | null }) =>
      apiFetch<{ invite: DashboardLineageInvite; token: string }>(`${base}/invites`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      apiFetch<{ invite: DashboardLineageInvite }>(`${base}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const members = useQuery({
    queryKey: ["agent-lineage", agentId, "members"],
    enabled: Boolean(overview.data?.lineage),
    queryFn: () => apiFetch<{ members: DashboardLineageMember[] }>(`${base}/members`),
  });

  const approveMember = useMutation({
    mutationFn: (subscriptionId: string) =>
      apiFetch(`${base}/members/${encodeURIComponent(subscriptionId)}/approve`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: (subscriptionId: string) =>
      apiFetch(`${base}/members/${encodeURIComponent(subscriptionId)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const contributions = useQuery({
    queryKey: ["agent-lineage", agentId, "contributions"],
    enabled: Boolean(overview.data?.lineage),
    queryFn: () => apiFetch<{ contributions: DashboardLineageContribution[] }>(`${base}/contributions`),
  });

  const decideContribution = useMutation({
    mutationFn: ({ contributionId, ...body }: {
      contributionId: string;
      action: "approve" | "reject";
      type?: LineageMemoryType;
      title?: string;
      description?: string;
      body?: string;
      reviewComment?: string;
      forceOnConflict?: boolean;
    }) => apiFetch(`${base}/contributions/${encodeURIComponent(contributionId)}/decide`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  return {
    overview,
    saveConfig,
    memories,
    createMemory,
    updateMemory,
    deleteMemory,
    publishFromLocal,
    invites,
    createInvite,
    revokeInvite,
    members,
    approveMember,
    removeMember,
    contributions,
    decideContribution,
  };
}

export function useAgentSubscription(agentId: string) {
  const qc = useQueryClient();
  const base = `/agents/${encodeURIComponent(agentId)}`;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agent-subscription", agentId] });
    void qc.invalidateQueries({ queryKey: ["agent-memories", agentId] });
  };

  const info = useQuery({
    queryKey: ["agent-subscription", agentId, "info"],
    queryFn: () => apiFetch<DashboardSubscriptionResponse>(`${base}/subscription`),
  });

  const memories = (query = "", type = "") =>
    useQuery({
      queryKey: ["agent-subscription", agentId, "memories", query, type],
      enabled: info.data?.subscription?.status === "active",
      queryFn: () => {
        const params = new URLSearchParams();
        if (query.trim()) params.set("query", query.trim());
        if (type) params.set("type", type);
        const qs = params.toString();
        return apiFetch<{ memories: DashboardLineageMemory[]; total: number }>(`${base}/subscription/memories${qs ? `?${qs}` : ""}`);
      },
    });

  const leave = useMutation({
    mutationFn: () => apiFetch(`${base}/subscription`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const setOverride = useMutation({
    mutationFn: ({ lineageMemoryId, ...body }: { lineageMemoryId: string; mode: "muted" | "overridden"; title?: string; description?: string; body?: string }) =>
      apiFetch(`${base}/subscription/overrides/${encodeURIComponent(lineageMemoryId)}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const clearOverride = useMutation({
    mutationFn: (lineageMemoryId: string) =>
      apiFetch(`${base}/subscription/overrides/${encodeURIComponent(lineageMemoryId)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const contributions = useQuery({
    queryKey: ["agent-subscription", agentId, "contributions"],
    queryFn: () => apiFetch<{ contributions: DashboardLineageContribution[] }>(`${base}/contributions`),
  });

  const submitContribution = useMutation({
    mutationFn: (body: {
      kind: "add" | "update";
      targetLineageMemoryId?: string | null;
      sourceLocalMemoryId?: string | null;
      proposedType: LineageMemoryType;
      proposedTitle: string;
      proposedDescription: string;
      proposedBody: string;
      rationale?: string;
    }) => apiFetch<{ contribution: DashboardLineageContribution }>(`${base}/contributions`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const decideOwnerContribution = useMutation({
    mutationFn: ({ contributionId, ...body }: {
      contributionId: string;
      action: "approve" | "reject" | "cancel";
      proposedType?: LineageMemoryType;
      proposedTitle?: string;
      proposedDescription?: string;
      proposedBody?: string;
      rationale?: string;
    }) => apiFetch<{ contribution: DashboardLineageContribution }>(`${base}/contributions/${encodeURIComponent(contributionId)}/decide`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  return {
    info,
    memories,
    leave,
    setOverride,
    clearOverride,
    contributions,
    submitContribution,
    decideOwnerContribution,
  };
}

export function useLineageInvitePreview(token: string) {
  return useQuery({
    queryKey: ["lineage-invite-preview", token],
    enabled: Boolean(token),
    queryFn: () => apiFetch<{ invite: DashboardInvitePreview }>(`/lineages/invites/${encodeURIComponent(token)}`),
  });
}

export function useAcceptLineageInvite(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mode: "create_agent"; agentName: string } | { mode: "attach_agent"; agentId: string }) =>
      apiFetch<{ agentId: string; subscription: { status: string }; lineage: DashboardLineage }>(
        `/lineages/invites/${encodeURIComponent(token)}/accept`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent-subscription"] });
    },
  });
}
