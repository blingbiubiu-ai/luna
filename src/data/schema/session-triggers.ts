import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { TaskResultForMainRunner } from "@/main-runner/types";

export const sessionTriggers = sqliteTable("session_triggers", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  kind: text("kind").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payload: text("payload_json", { mode: "json" }).$type<{ result: TaskResultForMainRunner; subscriptionId: string } | { inboxId: string; entryId: string } | { commandId: string }>().notNull(),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("session_triggers_dedupe").on(t.dedupeKey)]);
