import {sql} from "drizzle-orm";
import {check, index, integer, primaryKey, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";
import {lunaAgents} from "./luna-agents";

/** `persona` is one Shadow's identity and principles: private to it, always told in full, changed only for the Agent owner. */
/**
 * `episode` is episodic memory: something that happened, at `occurredAt`, with `participants`. Episodes form the
 * timeline; they are never core, never recalled by a message and fade by age.
 */
export const MEMORY_TYPES = ["persona", "person", "feedback", "project", "procedure", "reference", "episode"] as const;
export const MEMORY_ORIGIN_KINDS = ["inline", "reflection", "consolidation", "owner", "migration"] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
/** A change is made by one of the writers above, or by Service forgetting an entry. */
export const MEMORY_CHANGE_KINDS = [...MEMORY_ORIGIN_KINDS, "forgetting"] as const;
export const MEMORY_STATUSES = ["active", "deleted", "archived"] as const;
export type MemoryOriginKind = typeof MEMORY_ORIGIN_KINDS[number];
export type MemoryChangeKind = typeof MEMORY_CHANGE_KINDS[number];
export type MemoryStatus = typeof MEMORY_STATUSES[number];

/** Entry-level Agent memory shared by its Shadows; each entry has its own revision. */
export const agentMemories = sqliteTable("agent_memories", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => lunaAgents.id),
  type: text("type", {enum: MEMORY_TYPES}).notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  body: text("body").notNull(),
  subjectUserId: text("subject_user_id"),
  visibility: text("visibility", {enum: ["agent", "shadow"]}).notNull(),
  originKind: text("origin_kind", {enum: MEMORY_ORIGIN_KINDS}).notNull(),
  originShadowId: text("origin_shadow_id"),
  originSessionId: text("origin_session_id"),
  originTaskId: text("origin_task_id"),
  originUserId: text("origin_user_id"),
  /** Runner context of the latest change; that provider session already knows it and is not told again. */
  updatedContextId: text("updated_context_id"),
  trusted: integer("trusted", {mode: "boolean"}).notNull(),
  revision: integer("revision").notNull(),
  /** Position of the latest change in the order of all memory changes; clocks cannot order same-millisecond writes. */
  changeSeq: integer("change_seq").notNull(),
  /** `archived` entries were forgotten: they leave injection and recall but stay searchable and restorable. */
  status: text("status", {enum: MEMORY_STATUSES}).notNull(),
  supersededBy: text("superseded_by"),
  /** Core entries are told to every conversation at its start and are never forgotten. */
  core: integer("core", {mode: "boolean"}).notNull(),
  /** When set, the entry is archived once this time has passed. */
  expiresAt: integer("expires_at"),
  /** Last time a Runner read the body or anyone changed the entry. */
  lastUsedAt: integer("last_used_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** When an episode happened; null for every other type. */
  occurredAt: integer("occurred_at"),
  /** Users who took part in an episode. Anyone but the Agent owner sees only episodes they took part in. */
  participants: text("participants_json", {mode: "json"}).$type<string[]>().notNull().default([]),
}, t => [
  index("agent_memories_agent_status_idx").on(t.agentId, t.status, t.updatedAt),
  uniqueIndex("agent_memories_change_seq_idx").on(t.changeSeq),
  check("agent_memories_person_subject", sql`(${t.type}='person') = (${t.subjectUserId} IS NOT NULL)`),
  check("agent_memories_shadow_origin", sql`${t.visibility}='agent' OR ${t.originShadowId} IS NOT NULL`),
  check("agent_memories_core_type", sql`${t.core}=0 OR ${t.type} NOT IN ('person','persona','episode')`),
  check("agent_memories_episode_time", sql`(${t.type}='episode') = (${t.occurredAt} IS NOT NULL)`),
  check("agent_memories_persona_private", sql`${t.type}<>'persona' OR ${t.visibility}='shadow'`),
]);

export interface MemorySnapshot {
  type: MemoryType;
  title: string;
  description: string;
  body: string;
  subjectUserId: string | null;
  visibility: "agent" | "shadow";
  status: MemoryStatus;
  supersededBy: string | null;
  trusted: boolean;
  core: boolean;
  expiresAt: number | null;
  /** Absent in revisions written before episodes existed. */
  occurredAt?: number | null;
  /** Where in the conversation this change was made: its latest timeline entry at the time. Absent for maintenance and older revisions. */
  source?: MemorySource;
}

export interface MemorySource {
  sessionId: string;
  entryId: string;
  messageId: string;
  at: number;
}

/** State of an entry after each change; the latest row equals the current entry. */
export const agentMemoryRevisions = sqliteTable("agent_memory_revisions", {
  memoryId: text("memory_id").notNull().references(() => agentMemories.id),
  revision: integer("revision").notNull(),
  snapshot: text("snapshot_json", {mode: "json"}).$type<MemorySnapshot>().notNull(),
  changeKind: text("change_kind", {enum: MEMORY_CHANGE_KINDS}).notNull(),
  changedByUserId: text("changed_by_user_id"),
  changedByShadowId: text("changed_by_shadow_id"),
  createdAt: integer("created_at").notNull(),
}, t => [primaryKey({columns: [t.memoryId, t.revision]})]);

/** What a provider session has already been told about memory. */
export const memoryInjectionCursors = sqliteTable("memory_injection_cursors", {
  runnerContextId: text("runner_context_id").primaryKey(),
  runnerSessionId: text("runner_session_id").notNull(),
  injectedThrough: integer("injected_through").notNull(),
});

/** Entries a provider session has been shown, so they are not shown again and their later changes are reported. */
export const memoryInjectedEntries = sqliteTable("memory_injected_entries", {
  runnerContextId: text("runner_context_id").notNull(),
  memoryId: text("memory_id").notNull(),
}, t => [primaryKey({columns: [t.runnerContextId, t.memoryId]})]);

/** Human messages up to this time have been offered to reflection for the session. */
export const memoryReflectionCheckpoints = sqliteTable("memory_reflection_checkpoints", {
  sessionId: text("session_id").primaryKey(),
  reflectedThrough: integer("reflected_through").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Last consolidation of an Agent's memory and the internal session it runs in. */
export const memoryConsolidations = sqliteTable("memory_consolidations", {
  agentId: text("agent_id").primaryKey().references(() => lunaAgents.id),
  sessionId: text("session_id").notNull(),
  /** Last change handed to the latest run. */
  changeSeq: integer("change_seq").notNull(),
  /** Where the latest run started; a run that did not complete is handed its changes again from here. */
  coveredFrom: integer("covered_from").notNull().default(0),
  /** Session command of the latest run. */
  commandId: text("command_id"),
  ranAt: integer("ran_at").notNull(),
});
