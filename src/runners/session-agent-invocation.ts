import type { ResolvedRunnerContext } from "./runner-context-store";
import type { RunnerContextStore } from "./runner-context-store";
import {
  extractTextContent,
  type AgentRunner,
  type AssistantMessage,
  type UserMessage,
} from "@/shared";

export interface SessionAgentInvocationInput {
  readonly runner: AgentRunner;
  readonly runnerContext: ResolvedRunnerContext;
  readonly runnerContextStore?: Pick<
    RunnerContextStore,
    "clearRunnerSessionId" | "persistRunnerSessionId"
  >;
  readonly runnerKind: "main" | "work";
  readonly messageId: string;
  readonly prompt: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onAssistantEvent?: (
    event: AssistantMessage,
  ) => Promise<void> | void;
  readonly onRunnerSessionInvalidated?: () => void;
}

export interface SessionAgentInvocationResult {
  readonly text: string;
  readonly runnerSessionId?: string;
}

/**
 * Runs one session-scoped agent invocation.
 *
 * Main and Work supply their prompt and event policy; this module owns the
 * shared stream, resume-id, invalidation, and final-text lifecycle.
 */
export async function invokeSessionAgent(
  input: SessionAgentInvocationInput,
): Promise<SessionAgentInvocationResult> {
  const userMessage: UserMessage = {
    id: input.messageId,
    session_id: input.runnerContext.id,
    role: "user",
    content: [{ type: "text", text: input.prompt }],
  };
  let runnerSessionId =
    input.runnerContext.runner_session_id ?? undefined;
  let lastAssistantText = "";

  for await (
    const event of input.runner.stream(userMessage, {
      cwd: input.runnerContext.runner_root_path,
      isNewSession: input.runnerContext.runner_session_id === null,
      runnerContextId: input.runnerContext.id,
      runnerKind: input.runnerKind,
      invalidateRunnerSession: () => {
        input.runnerContextStore?.clearRunnerSessionId(input.runnerContext.id);
        input.onRunnerSessionInvalidated?.();
      },
      env: { ...(input.env ?? {}) },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(runnerSessionId !== undefined ? { runnerSessionId } : {}),
    })
  ) {
    if (event.role === "system" && event.subtype === "init") {
      runnerSessionId = event.id;
      input.runnerContextStore?.persistRunnerSessionId(
        input.runnerContext.id,
        event.id,
      );
      continue;
    }
    if (event.role !== "assistant") {
      continue;
    }
    if (!event.final) await input.onAssistantEvent?.(event);
    const text = extractTextContent(event, {
      includeThinking: false,
      includeToolUse: false,
    });
    if (text || event.final) {
      lastAssistantText = text;
    }
  }

  return runnerSessionId === undefined
    ? { text: lastAssistantText }
    : { text: lastAssistantText, runnerSessionId };
}
