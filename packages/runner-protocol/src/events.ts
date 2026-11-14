import { z } from "zod";
import { Id, JobSnapshot, Sequence } from "./job.js";

const Failure = z.object({
  kind: z.string(), provider: z.enum(["claude", "codex"]), message: z.string(),
  providerCode: z.string().optional(), httpStatus: z.number().optional(), retryAfterMs: z.number().optional(),
}).strict();

/** The existing provider-neutral stdout protocol, with explicit wire validation. */
export const ProviderOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("init"), sessionId: z.string() }).strict(),
  z.object({ status: z.literal("stream"), text: z.string() }).strict(),
  z.object({ status: z.literal("stderr"), text: z.string() }).strict(),
  z.object({ status: z.literal("checkpoint") }).strict(),
  z.object({ status: z.literal("tool_start"), id: z.string().min(1), name: z.string(), title: z.string() }).strict(),
  z.object({ status: z.literal("tool_result"), id: z.string().min(1), text: z.enum(["工具执行失败", "工具调用已结束"]) }).strict(),
  z.object({ status: z.literal("success"), result: z.string(), newSessionId: z.string().optional() }).strict(),
  z.object({ status: z.literal("error"), error: z.string(), failure: Failure.optional(), code: z.string().optional(), exitCode: z.number().nullable().optional() }).strict(),
]);
export type ProviderOutput = z.infer<typeof ProviderOutput>;

export const ExecutorEvent = z.discriminatedUnion("kind", [
  z.object({ seq: Sequence.min(1), at: z.number(), kind: z.literal("provider"), data: ProviderOutput }).strict(),
  z.object({ seq: Sequence.min(1), at: z.number(), kind: z.literal("state"), data: JobSnapshot }).strict(),
  z.object({ seq: Sequence.min(1), at: z.number(), kind: z.literal("terminal"), data: JobSnapshot }).strict(),
]);
export type ExecutorEvent = z.infer<typeof ExecutorEvent>;

export const EventBatch = z.object({
  version: z.literal(1), assignmentId: Id, instanceId: Id, streamId: Id,
  events: z.array(ExecutorEvent).min(1).max(256),
}).strict();
export type EventBatch = z.infer<typeof EventBatch>;

export interface RuntimeEvent {
  jobId: string;
  seq: number;
  kind: "placement" | "execution";
  data: unknown;
}
