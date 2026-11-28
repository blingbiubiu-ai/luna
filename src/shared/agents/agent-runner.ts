import { z } from "zod";

import type {
  AssistantMessage,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from "../messaging";

/**
 * The options for the agent runner.
 */
export const AgentRunOptions = z.object({
  /**
   * Whether to start a new session.
   */
  isNewSession: z.boolean(),

  /**
   * The current working directory.
   */
  cwd: z.string(),

  /**
   * Runner-specific session/thread id used by some providers for true resume.
   */
  runnerSessionId: z.string().optional(),

  /**
   * Abort signal for cancelling the running task.
   * When aborted, the agent runner should kill any spawned subprocesses.
   */
  signal: z.instanceof(AbortSignal).optional(),

  /**
   * Additional environment variables injected into the runner process.
   */
  env: z.record(z.string(), z.string()).optional(),

  /**
   * Stable runner context id for container/session lifecycle.
   */
  runnerContextId: z.string().optional(),

  /**
   * Invalidates a stale persisted runner session id before retrying fresh.
   */
  invalidateRunnerSession: z.custom<() => void>().optional(),

  /**
   * Task ID for task runner sessions. Used by container runner to scope containers.
   */
  taskId: z.string().optional(),

  /**
   * Explicit role for session-scoped containers.
   */
  runnerKind: z.enum(["main", "task"]).optional(),
});
/**
 * Configuration options for runtime agent run behavior in agent.
 */
export interface AgentRunOptions extends z.infer<typeof AgentRunOptions> {}

/**
 * A wrapper of the real agent behind.
 * Used to interact with Agent, supporting streaming output
 */
export interface AgentRunner {
  /**
   * The type of the agent runner.
   */
  readonly type: string;

  /**
   * Streams the chunking messages from the agent.
   */
  stream(
    // eslint-disable-next-line no-unused-vars
    userMessage: UserMessage,
    // eslint-disable-next-line no-unused-vars
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage>;
}
