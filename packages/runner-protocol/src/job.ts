import { z } from "zod";
import {ExecutionScope,ResourceSelection} from "./scope.js";
import { ModelProviderReference } from "./model-provider.js";

import { Id } from "./id.js";
export { Id } from "./id.js";
export const Sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RunnerKind = z.enum(["main", "work", "task"]);
export const ExecutionDriverKind = z.enum(["stdio", "pty"]);
export type ExecutionDriverKind = z.infer<typeof ExecutionDriverKind>;
export const JobState = z.enum(["queued", "starting", "running", "retry_wait", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]);
export type JobState = z.infer<typeof JobState>;

/** Execution retry limits are frozen with the accepted Job, never read from Service after dispatch. */
export const RetryPolicy = z.object({
  maxConsecutiveRetries: z.number().int().min(0).max(100),
  maxTotalRetries: z.number().int().min(0).max(100),
  baseDelayMs: z.number().int().min(0).max(300000),
  maxDelayMs: z.number().int().min(0).max(300000),
}).strict().refine(policy => policy.baseDelayMs <= policy.maxDelayMs, "Retry delay bounds are reversed");
export type RetryPolicy = z.infer<typeof RetryPolicy>;

/** The business input is independent of Worker placement and credentials. */
export const JobRequest = z.object({
  version: z.literal(2), jobId: Id, invocationId: Id,
  scope: ExecutionScope, resources: ResourceSelection,
  environmentId: Id, runnerContextId: Id, scopeKey: z.string().min(1).max(512),
  projectId: Id.optional(),
  resourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  retryPolicy: RetryPolicy.optional(),
  runnerKind: RunnerKind, sessionId: Id.optional(), taskId: Id.optional(), taskRunId: Id.optional(),
  input: z.object({
    modelProvider: ModelProviderReference.optional(),
    runnerType: z.enum(["claude", "codex"]), executionDriver: ExecutionDriverKind.optional(),
    ptyIdleTimeoutMs: z.number().int().min(0).max(7 * 86400_000).optional(),
    prompt: z.string().max(8 * 1024 * 1024),
    sessionId: z.string().min(1).max(512).optional(), model: z.string().min(1).max(256).optional(),
  }).strict(),
  credentialsRevision: Sequence.min(1), timeoutMs: z.number().int().positive().max(7 * 86400_000),
  /** Shadow root switch at submission, and whether this Job's Runner may use sudo. */
  rootAccess: z.boolean().optional(), privileged: z.boolean().optional(),
}).strict().superRefine((job, context) => {
  if (job.input.modelProvider && (job.input.runnerType !== "codex" || !job.input.model)) context.addIssue({ code: "custom", message: "Worker models require a Codex model" });
  if (job.privileged && !job.rootAccess) context.addIssue({ code: "custom", message: "A privileged Job requires root access" });
  if(job.resourceRevision!==job.resources.digest)context.addIssue({code:"custom",message:"Resource revision mismatch"});
  if (job.runnerKind === "task" ? !job.taskId || !job.taskRunId : !job.sessionId) {
    context.addIssue({ code: "custom", message: "Task requires taskId/taskRunId; Main and Work require sessionId" });
  }
});
export type JobRequest = z.infer<typeof JobRequest>;

/** A reservation binds a Job to one logical Executor instance. */
export const Assignment = z.object({
  scope: ExecutionScope,
  jobId: Id, assignmentId: Id, reservationId: Id, instanceId: Id, workerId: Id,
  executionEnvironmentId: Id, contextId: Id, scopeKey: z.string().min(1).max(512),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Assignment = z.infer<typeof Assignment>;

export const JobSubmission = z.object({ job: JobRequest, assignment: Assignment }).strict();
export type JobSubmission = z.infer<typeof JobSubmission>;

export const Credentials = z.object({
  revision: Sequence.min(1), expiresAt: z.number().int().positive(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  modelProvider: ModelProviderReference.optional(),
}).strict();
export type Credentials = z.infer<typeof Credentials>;

export const JobSnapshot = z.object({
  jobId: Id, assignmentId: Id, instanceId: Id, bootId: Id, streamId: Id,
  requestHash: z.string(), state: JobState, lastSeq: Sequence,
  createdAt: z.number(), startedAt: z.number().optional(), endedAt: z.number().optional(),
  result: z.string().optional(),
  finalText: z.string().optional(),
  providerSessionId: z.string().optional(), providerCheckpoint: z.boolean().optional(),
  retry: z.object({ attempt: Sequence, totalRetries: Sequence, consecutiveRetries: Sequence,
    deadlineAt: z.number(), nextRetryAt: z.number().nullable(), reason: z.string().nullable() }).strict().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export type JobSnapshot = z.infer<typeof JobSnapshot>;

/** Only these states prove that no process remains attached to the Job. */
export function isTerminal(state: JobState): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
}
