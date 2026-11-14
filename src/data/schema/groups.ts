import { sql } from "drizzle-orm";
import { lunaAgents } from "./luna-agents";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => lunaAgents.id),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    slugUnique: uniqueIndex("groups_slug_unique").on(table.agentId, table.slug),
    statusIdx: index("groups_status_idx").on(table.status),
  }),
);

export const groupMemberships = sqliteTable(
  "group_memberships",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    membershipUnique: uniqueIndex("group_memberships_unique").on(
      table.groupId,
      table.userId,
    ),
    userIdx: index("group_memberships_user_idx").on(table.userId),
    groupIdx: index("group_memberships_group_idx").on(table.groupId),
  }),
);

export const authorizationRules = sqliteTable(
  "authorization_rules",
  {
    id: text("id").primaryKey(),
    scopeType: text("scope_type", {enum: ["platform", "agent"]}).notNull(),
    agentId: text("agent_id").references(() => lunaAgents.id),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    target: text("target").notNull(),
    matchType: text("match_type").notNull(),
    effect: text("effect").notNull(),
    expiresAt: integer("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    subjectIdx: index("authorization_rules_subject_idx").on(
      table.subjectType,
      table.subjectId,
    ),
    operationIdx: index("authorization_rules_operation_idx").on(
      table.target,
    ),
    scopeCheck: check("authorization_rules_scope_check", sql`(${table.scopeType} = 'platform' AND ${table.agentId} IS NULL) OR (${table.scopeType} = 'agent' AND ${table.agentId} IS NOT NULL)`),
    uniqueGrant: uniqueIndex("authorization_rules_unique").on(
      table.scopeType, sql`coalesce(${table.agentId}, '')`, table.subjectType,
      table.subjectId,
      table.target,
      table.matchType,
      table.effect,
    ),
  }),
);
