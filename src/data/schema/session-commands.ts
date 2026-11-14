import type { CalendarRule } from "@luna/service-client/schedule-timing";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
export const sessionCommands = sqliteTable("session_commands", {
    id: text("id").primaryKey(), kind: text("kind").notNull(), sessionId: text("session_id").notNull(),
    sourceSessionId: text("source_session_id").notNull(), actorUserId: text("actor_user_id").notNull(),
    originId: text("origin_id").notNull(), dedupeKey: text("dedupe_key").notNull(), payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(), error: text("error"), messageId: text("message_id"), providerMessageId: text("provider_message_id"),
    correlationId: text("correlation_id").notNull(), hops: integer("hops").notNull().default(3),
    availableAt: integer("available_at").notNull(), expiresAt: integer("expires_at"), attempts: integer("attempts").notNull().default(0),
    claim: text("claim"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, t => [uniqueIndex("session_commands_dedupe").on(t.dedupeKey), index("session_commands_pending").on(t.status, t.availableAt)]);
export const sessionSchedules = sqliteTable("session_schedules", {
    recurrence: text("recurrence", { mode: "json" }).$type<CalendarRule>(),
    title: text("title").notNull().default(""), paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    id: text("id").primaryKey(), actorUserId: text("actor_user_id").notNull(), sourceSessionId: text("source_session_id").notNull(),
    targetSessionId: text("target_session_id").notNull(),
    action: text("action", { mode: "json" }).$type<Record<string, unknown>>().notNull(), timezone: text("timezone").notNull(),
    nextAt: integer("next_at").notNull(), intervalMs: integer("interval_ms"), enabled: integer("enabled", { mode: "boolean" }).notNull(),
    revision: integer("revision").notNull(), overlap: text("overlap").notNull(), misfire: text("misfire").notNull(), expiresAfterMs: integer("expires_after_ms").notNull(), createdAt: integer("created_at").notNull(),
});
export const scheduleOccurrences = sqliteTable("schedule_occurrences", {
    id: text("id").primaryKey(), scheduleId: text("schedule_id").notNull(), scheduledAt: integer("scheduled_at").notNull(),
    revision: integer("revision").notNull(), commandId: text("command_id"), status: text("status").notNull(), reason: text("reason"),
    snapshot: text("snapshot", { mode: "json" }).notNull(), createdAt: integer("created_at").notNull(),
}, t => [uniqueIndex("schedule_occurrence_unique").on(t.scheduleId, t.revision, t.scheduledAt)]);
