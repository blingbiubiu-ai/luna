import { z } from "zod";
import type { NormalizedInboundMessage } from "@/channels";

const text = z.string().trim().min(1).max(20000);
const sourceMessageIds = z.array(text).min(1).max(100).optional();
const assumptions = z.array(text).max(5).optional();
export const operationSchemas = {
  "task.create": z.object({title: text, summary: text, facts: z.array(text).max(100), sessionId: text.optional(), sendStatusCard: z.boolean().optional(), statusCardStyle: z.enum(["card", "native"]).optional(), taskType: z.enum(["task", "question"]).default("task"), assumptions, sourceMessageIds}).strict(),
  "task.update": z.object({taskId: text, updateSummary: text, updatedTaskTitle: text.optional(), updatedTaskSummary: text.optional(), assumptions, sourceMessageIds}).strict(),
  "task.status_card": z.object({taskId: text, resend: z.boolean().default(false), style: z.enum(["card", "native"]).optional()}).strict(),
  "task.cancel": z.object({taskId: text, reason: text.default("用户取消任务"), sourceMessageIds}).strict(),
  "task.restart": z.object({taskId: text, sourceMessageIds}).strict(),
  "session.create_thread": z.object({anchorMessageId: text, contextMessageIds: z.array(text).max(100).default([]), title: text.optional()}).strict(),
  "session.clarify": z.object({pendingIntent: z.enum(["task", "question"]), missingFields: z.array(text).min(1), collectedFacts: z.array(text), question: text, reason: text}).strict(),
  "session.release": z.object({reason: text}).strict(),
} as const;
export type OperationKind = keyof typeof operationSchemas;
export type OperationRequest = { [K in OperationKind]: {kind: K; payload: z.output<typeof operationSchemas[K]>} }[OperationKind];
export interface OperationContext {
  sessionId: string;
  actorUserId: string;
  originId: string;
  sourceMessageIds: string[];
  inbound: NormalizedInboundMessage;
}
export interface StatusCardDelivery {
  notificationId: string;
  previousMessageId: string | null;
  operation: Omit<import("@/channels/outbound").OutboundChannelOperation, "id" | "channelId">;
}
export interface OperationResult { cancelled?: boolean; cardDelivery?: StatusCardDelivery; statusMessageId?: string; notificationId?: string; taskId?: string; sourceMessageId?: string; runId?: string; taskSessionId?: string; targetSessionId?: string; }
