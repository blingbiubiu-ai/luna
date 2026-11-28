import { z } from "zod";
import type { MainRunnerRunInput } from "@/main-runner/main-runner";
import type { TaskInvocation } from "@/tasks/task-report-store";

const text = z.string();
const nullableText = text.nullable();
const identity = z.object({ externalId: text, kind: z.enum(["user", "bot", "system", "unknown"]) }).passthrough();
const inbound = z.object({ id: text, channel: z.object({ type: text, id: text }), surface: z.object({ externalId: text, kind: text }).passthrough(), sender: identity,
  text, mentions: z.array(z.object({ key: text, label: text, target: identity }).passthrough()), addressing: z.object({ addressedToBot: z.boolean(), reason: text }).passthrough() }).passthrough();
const taskSummary = z.object({ taskId: text, taskType: text, status: text, title: text, summary: text }).passthrough();
const context = z.object({ sessionId: text, candidateOpenTasks: z.array(taskSummary) }).passthrough();
const message = z.object({ messageId: text, channelMessageKey: nullableText, role: z.enum(["user", "assistant"]), senderUserId: nullableText,
  sender: z.object({ id: text, externalId: text, kind: text, displayName: text }), text, createdAt: z.number(), rawMessage: inbound }).passthrough();
const mainInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_messages"), messages: z.array(message), latestMessage: inbound, context }).passthrough(),
  z.object({ type: z.literal("session_trigger"), triggerId: text, instruction: text, requesterUserId: text, context, artifactRefs: z.array(text), sourceSessionId: text, correlationId: text, hops: z.number().int().nonnegative() }).passthrough(),
  z.object({ type: z.literal("task_result"), sessionId: text, taskId: text, context, result: z.object({ taskId: text, taskRunId: text, status: z.enum(["completed", "failed", "cancelled"]), title: text, summary: text, evidenceSummary: z.array(text), userVisibleReport: text, artifactIds: z.array(text), nextActions: z.array(text) }).passthrough() }).passthrough(),
]);
const runnerContext = z.object({ id: text, agent_id: text, shadow_id: text, owner_type: text, owner_id: text, runner_type: text, runner_session_id: nullableText, instruction_fingerprint: nullableText,
  runner_root_path: text, workspacePath: text, ipcPath: text, last_run_id: nullableText, created_at: z.number(), updated_at: z.number() }).passthrough();
const main = z.object({ input: mainInput, runnerContext, turnId: text.optional(), invocationId: text.optional() }).strict();
const task = z.object({ taskId: text, taskRunId: text, runnerContextId: text }).strict();

export type PersistedInvocationInput =
  | { version: 1; kind: "main"; input: Omit<MainRunnerRunInput, "signal"> }
  | { version: 1; kind: "task"; input: Omit<TaskInvocation, "signal"> };
const snapshot = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("main"), input: main }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("task"), input: task }).strict(),
]);

/** Recovery rejects unknown versions and malformed business identities instead of guessing. */
export function decodeInvocation(value: unknown): PersistedInvocationInput {
  z.json().parse(value);
  return snapshot.parse(value) as PersistedInvocationInput;
}

/** AbortSignal is a local handle, never a durable authority or serialized execution input. */
export function encodeInvocation(kind: "main" | "task", value: MainRunnerRunInput | TaskInvocation): PersistedInvocationInput {
  const { signal: _, ...input } = value;
  return decodeInvocation(JSON.parse(JSON.stringify({ version: 1, kind, input })));
}
