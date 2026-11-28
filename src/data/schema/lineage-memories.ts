import {sql} from "drizzle-orm";
import {check, index, integer, primaryKey, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";
import {accounts} from "./accounts";
import {agentMemories} from "./agent-memories";
import {lunaAgents} from "./luna-agents";

export const LINEAGE_MEMORY_TYPES = ["procedure", "feedback", "reference", "project"] as const;
export type LineageMemoryType = typeof LINEAGE_MEMORY_TYPES[number];

export const LINEAGE_STATUSES = ["active", "paused", "archived"] as const;
export type LineageStatus = typeof LINEAGE_STATUSES[number];

export const LINEAGE_MAINTAINER_ROLES = ["admin", "reviewer"] as const;
export type LineageMaintainerRole = typeof LINEAGE_MAINTAINER_ROLES[number];

export const LINEAGE_INVITE_STATUSES = ["active", "revoked"] as const;
export type LineageInviteStatus = typeof LINEAGE_INVITE_STATUSES[number];

export const LINEAGE_SUBSCRIPTION_STATUSES = ["pending_approval", "active", "left", "revoked"] as const;
export type LineageSubscriptionStatus = typeof LINEAGE_SUBSCRIPTION_STATUSES[number];

export const LINEAGE_MEMORY_STATUSES = ["active", "archived", "deleted"] as const;
export type LineageMemoryStatus = typeof LINEAGE_MEMORY_STATUSES[number];

export const LINEAGE_MEMORY_ORIGIN_KINDS = ["owner_publish", "contribution_approved", "lineage_edit"] as const;
export type LineageMemoryOriginKind = typeof LINEAGE_MEMORY_ORIGIN_KINDS[number];

export const LINEAGE_MEMORY_CHANGE_KINDS = [
  "owner_publish", "contribution_approved", "lineage_edit", "revert", "archive", "restore", "delete",
] as const;
export type LineageMemoryChangeKind = typeof LINEAGE_MEMORY_CHANGE_KINDS[number];

export const LINEAGE_OVERRIDE_MODES = ["muted", "overridden"] as const;
export type LineageOverrideMode = typeof LINEAGE_OVERRIDE_MODES[number];

export const LINEAGE_CONTRIBUTION_ORIGIN_KINDS = ["consolidation", "manual_dashboard", "manual_chat"] as const;
export type LineageContributionOriginKind = typeof LINEAGE_CONTRIBUTION_ORIGIN_KINDS[number];

export const LINEAGE_CONTRIBUTION_KINDS = ["add", "update"] as const;
export type LineageContributionKind = typeof LINEAGE_CONTRIBUTION_KINDS[number];

export const LINEAGE_CONTRIBUTION_STATUSES = [
  "pending_owner", "pending_lineage", "approved", "rejected_by_owner", "rejected_by_lineage", "cancelled", "expired",
] as const;
export type LineageContributionStatus = typeof LINEAGE_CONTRIBUTION_STATUSES[number];

export interface LineagePersonaTemplate {
  title: string;
  description: string;
  body: string;
}

export interface LineageTemplateConfig {
  defaultAgentNamePrefix?: string | undefined;
  personaTemplates?: LineagePersonaTemplate[] | undefined;
  recommendedPlugins?: string[] | undefined;
  recommendedSkills?: string[] | undefined;
}

export interface LineageMemorySnapshot {
  type: LineageMemoryType;
  title: string;
  description: string;
  body: string;
  status: LineageMemoryStatus;
}

/** Outbound lineage owned by one source Agent, physically isolating inherited memory from private agent_memories. */
export const agentLineages = sqliteTable("agent_lineages", {
  id: text("id").primaryKey(),
  sourceAgentId: text("source_agent_id").notNull().unique().references(() => lunaAgents.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  intakeGuidelines: text("intake_guidelines").notNull().default(""),
  allowAncestorLookup: integer("allow_ancestor_lookup", {mode: "boolean"}).notNull().default(true),
  allowMemberInvite: integer("allow_member_invite", {mode: "boolean"}).notNull().default(false),
  template: text("template_json", {mode: "json"}).$type<LineageTemplateConfig>().notNull().default({}),
  status: text("status", {enum: LINEAGE_STATUSES}).notNull().default("active"),
  createdByAccountId: text("created_by_account_id").notNull().references(() => accounts.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Co-maintainers/reviewers who can approve contributions and manage members alongside the source Agent owner. */
export const lineageMaintainers = sqliteTable("lineage_maintainers", {
  lineageId: text("lineage_id").notNull().references(() => agentLineages.id),
  accountId: text("account_id").notNull().references(() => accounts.id),
  role: text("role", {enum: LINEAGE_MAINTAINER_ROLES}).notNull().default("reviewer"),
  createdAt: integer("created_at").notNull(),
}, t => [primaryKey({columns: [t.lineageId, t.accountId]})]);

/** Shareable invite links for receiving a lineage when creating or attaching an Agent. */
export const lineageInvites = sqliteTable("lineage_invites", {
  id: text("id").primaryKey(),
  lineageId: text("lineage_id").notNull().references(() => agentLineages.id),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull().default(""),
  requireApproval: integer("require_approval", {mode: "boolean"}).notNull().default(false),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: integer("expires_at"),
  status: text("status", {enum: LINEAGE_INVITE_STATUSES}).notNull().default("active"),
  createdByAccountId: text("created_by_account_id").notNull().references(() => accounts.id),
  createdAt: integer("created_at").notNull(),
}, t => [index("lineage_invites_lineage_status_idx").on(t.lineageId, t.status)]);

/** One Agent subscribes to at most one active or pending lineage at a time. */
export const lineageSubscriptions = sqliteTable("lineage_subscriptions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => lunaAgents.id),
  lineageId: text("lineage_id").notNull().references(() => agentLineages.id),
  status: text("status", {enum: LINEAGE_SUBSCRIPTION_STATUSES}).notNull(),
  inviteId: text("invite_id").references(() => lineageInvites.id),
  approvedByAccountId: text("approved_by_account_id").references(() => accounts.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [
  uniqueIndex("lineage_subscriptions_active_agent_idx").on(t.agentId).where(sql`${t.status} IN ('pending_approval', 'active')`),
  index("lineage_subscriptions_lineage_status_idx").on(t.lineageId, t.status),
]);

/** Physically isolated inherited memory entries. Never mixed with private agent_memories. */
export const lineageMemories = sqliteTable("lineage_memories", {
  id: text("id").primaryKey(),
  lineageId: text("lineage_id").notNull().references(() => agentLineages.id),
  type: text("type", {enum: LINEAGE_MEMORY_TYPES}).notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  body: text("body").notNull(),
  status: text("status", {enum: LINEAGE_MEMORY_STATUSES}).notNull().default("active"),
  revision: integer("revision").notNull().default(1),
  changeSeq: integer("change_seq").notNull(),
  originKind: text("origin_kind", {enum: LINEAGE_MEMORY_ORIGIN_KINDS}).notNull(),
  contributorAgentId: text("contributor_agent_id").references(() => lunaAgents.id),
  contributorAccountId: text("contributor_account_id").references(() => accounts.id),
  approvedByAccountId: text("approved_by_account_id").notNull().references(() => accounts.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [
  index("lineage_memories_lineage_status_idx").on(t.lineageId, t.status, t.updatedAt),
  uniqueIndex("lineage_memories_change_seq_idx").on(t.changeSeq),
  check("lineage_memories_type_allowed", sql`${t.type} IN ('procedure', 'feedback', 'reference', 'project')`),
]);

/** Revision history of lineage memory entries, linking approved contributions. */
export const lineageMemoryRevisions = sqliteTable("lineage_memory_revisions", {
  memoryId: text("memory_id").notNull().references(() => lineageMemories.id),
  revision: integer("revision").notNull(),
  snapshot: text("snapshot_json", {mode: "json"}).$type<LineageMemorySnapshot>().notNull(),
  changeKind: text("change_kind", {enum: LINEAGE_MEMORY_CHANGE_KINDS}).notNull(),
  changedByAccountId: text("changed_by_account_id").notNull().references(() => accounts.id),
  contributionId: text("contribution_id"),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
}, t => [primaryKey({columns: [t.memoryId, t.revision]})]);

/** Per-Agent local mute or fork/override of a specific lineage memory entry. */
export const lineageMemoryOverrides = sqliteTable("lineage_memory_overrides", {
  agentId: text("agent_id").notNull().references(() => lunaAgents.id),
  lineageMemoryId: text("lineage_memory_id").notNull().references(() => lineageMemories.id),
  mode: text("mode", {enum: LINEAGE_OVERRIDE_MODES}).notNull(),
  localMemoryId: text("local_memory_id").references(() => agentMemories.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [primaryKey({columns: [t.agentId, t.lineageMemoryId]})]);

/** Two-stage approved contribution proposals from disciple Agents back to their direct lineage. */
export const lineageContributions = sqliteTable("lineage_contributions", {
  id: text("id").primaryKey(),
  lineageId: text("lineage_id").notNull().references(() => agentLineages.id),
  sourceAgentId: text("source_agent_id").notNull().references(() => lunaAgents.id),
  sourceOwnerAccountId: text("source_owner_account_id").notNull().references(() => accounts.id),
  sourceLocalMemoryId: text("source_local_memory_id").references(() => agentMemories.id),
  originKind: text("origin_kind", {enum: LINEAGE_CONTRIBUTION_ORIGIN_KINDS}).notNull(),
  batchId: text("batch_id"),
  kind: text("kind", {enum: LINEAGE_CONTRIBUTION_KINDS}).notNull(),
  targetLineageMemoryId: text("target_lineage_memory_id").references(() => lineageMemories.id),
  baseRevision: integer("base_revision"),
  proposedType: text("proposed_type", {enum: LINEAGE_MEMORY_TYPES}).notNull(),
  proposedTitle: text("proposed_title").notNull(),
  proposedDescription: text("proposed_description").notNull(),
  proposedBody: text("proposed_body").notNull(),
  rationale: text("rationale").notNull().default(""),
  status: text("status", {enum: LINEAGE_CONTRIBUTION_STATUSES}).notNull(),
  ownerRequestId: text("owner_request_id"),
  lineageRequestId: text("lineage_request_id"),
  reviewedByAccountId: text("reviewed_by_account_id").references(() => accounts.id),
  reviewComment: text("review_comment"),
  resultLineageMemoryId: text("result_lineage_memory_id").references(() => lineageMemories.id),
  resultRevision: integer("result_revision"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [
  index("lineage_contributions_lineage_status_idx").on(t.lineageId, t.status, t.createdAt),
  index("lineage_contributions_agent_status_idx").on(t.sourceAgentId, t.status, t.createdAt),
]);
