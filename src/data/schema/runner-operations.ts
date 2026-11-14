import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessions } from "./sessions";
import type { OperationContext, OperationRequest, OperationResult } from "@/runners/operation-contract";
export const runnerOperations = sqliteTable("runner_operations", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, {onDelete: "cascade"}),
  originId: text("origin_id").notNull(),
  requestId: text("request_id").notNull(),
  request: text("request_json", {mode: "json"}).$type<OperationRequest>().notNull(),
  context: text("context_json", {mode: "json"}).$type<OperationContext>().notNull(),
  status: text("status").$type<"accepted" | "prepared" | "applied" | "failed">().notNull(),
  result: text("result_json", {mode: "json"}).$type<OperationResult>(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("runner_operations_request_unique").on(table.sessionId, table.originId, table.requestId), index("runner_operations_pending_idx").on(table.status)]);
