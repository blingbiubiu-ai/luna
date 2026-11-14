import {integer,sqliteTable,text,index,foreignKey} from "drizzle-orm/sqlite-core";
import type {ResourceSelection} from "@luna/host-runtime/scoped-runner-resources";
import {agentShadows} from "./luna-agents";
import {runnerInvocations} from "./runner-execution";

/** Immutable manifest identity; bytes are durably published before these records become visible. */
export const runnerResourceSnapshots=sqliteTable("runner_resource_snapshots",{
 digest:text("digest").primaryKey(),agentId:text("agent_id").notNull(),shadowId:text("shadow_id").notNull(),
 selection:text("selection_json",{mode:"json"}).$type<ResourceSelection>().notNull(),createdAt:integer("created_at").notNull(),
},t=>[foreignKey({columns:[t.agentId,t.shadowId],foreignColumns:[agentShadows.agentId,agentShadows.id]})]);
/** One permanent selection per invocation; unfinished invocations retain their snapshots. */
export const invocationResourceSnapshots=sqliteTable("invocation_resource_snapshots",{
 invocationId:text("invocation_id").primaryKey().references(()=>runnerInvocations.id),
 digest:text("digest").notNull().references(()=>runnerResourceSnapshots.digest),createdAt:integer("created_at").notNull(),
},t=>[index("invocation_resources_digest").on(t.digest)]);
