import {sql} from "drizzle-orm";
import {users} from "./users";
import {check,foreignKey, integer, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";
import {lunaAgents,agentShadows} from "./luna-agents";

/** Immutable scoped document snapshots; pointers are advanced only after verified publication. */
export const agentDocumentRevisions=sqliteTable("agent_document_revisions",{
 id:text("id").primaryKey(),
 agentId:text("agent_id").notNull().references(()=>lunaAgents.id),
 shadowId:text("shadow_id"),
 kind:text("kind",{enum:["memory","persona"]}).notNull(),
 files:text("files_json",{mode:"json"}).$type<Record<string,string>>().notNull(),
 authorUserId:text("author_user_id").notNull().references(()=>users.id),
 parentRevision:text("parent_revision"),
 createdAt:integer("created_at").notNull(),
},t=>[
 check("agent_document_kind_scope",sql`(${t.kind}='memory' AND ${t.shadowId} IS NULL) OR (${t.kind}='persona' AND ${t.shadowId} IS NOT NULL)`),
 uniqueIndex("agent_document_revision_scope").on(t.agentId,t.shadowId,t.id),
 foreignKey({columns:[t.agentId,t.shadowId],foreignColumns:[agentShadows.agentId,agentShadows.id]}),
]);
