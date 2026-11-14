import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agentShadows } from "./luna-agents";
import { agentProfiles, agentProfileRevisions } from "./agent-profiles";
import { users } from "./users";

export const shadowModelSelections = sqliteTable("shadow_model_selections", {
  shadowId: text("shadow_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  mode: text("mode", {enum: ["inherit", "fixed"]}).notNull(),
  profileId: text("profile_id"),
  revisionId: text("revision_id"),
  updatedBy: text("updated_by").notNull().references(() => users.id),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  foreignKey({columns:[table.agentId,table.shadowId],foreignColumns:[agentShadows.agentId,agentShadows.id]}),
  foreignKey({columns:[table.agentId,table.profileId],foreignColumns:[agentProfiles.agent_id,agentProfiles.id]}),
  foreignKey({columns:[table.profileId,table.revisionId],foreignColumns:[agentProfileRevisions.profile_id,agentProfileRevisions.id]}),
  check("shadow_model_selection_mode",sql`(${table.mode}='inherit' AND ${table.profileId} IS NULL AND ${table.revisionId} IS NULL) OR (${table.mode}='fixed' AND ${table.profileId} IS NOT NULL AND ${table.revisionId} IS NOT NULL)`),
]);
