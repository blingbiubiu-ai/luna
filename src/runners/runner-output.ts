import type { RunnerFailure, RunnerFailureKind } from "@luna/runner-protocol/failure";
import type { AssistantMessage, SystemMessage, ToolMessage } from "@/shared";

export interface RunnerOutputHooks {
  readonly onCheckpoint?: () => void;
  readonly onSessionId?: (id: string) => void;
}

/** Provider output mapping shared by local Docker and remote Runtime transports. */
export class RunnerOutputState {
  terminal = false;
  private initializedSessionId: string | undefined;
  private streamed = false;
  private stderr = "";
  constructor(private readonly sessionId: string, private readonly hooks: RunnerOutputHooks = {}) {}
  accept(status: string, data: Record<string, unknown>, useFinalResult = false): (SystemMessage | AssistantMessage | ToolMessage)[] {
    const messages: (SystemMessage | AssistantMessage | ToolMessage)[] = [];
    const initialize = (id: unknown) => {
      if (typeof id !== "string" || !id || this.initializedSessionId === id || (this.initializedSessionId && !useFinalResult)) return;
      this.hooks.onSessionId?.(id); this.initializedSessionId = id;
      messages.push({ id, session_id: this.sessionId, role: "system", subtype: "init" });
    };
    if (status === "init") initialize(data.sessionId);
    else if (status === "checkpoint") this.hooks.onCheckpoint?.();
    else if (status === "tool_start" && typeof data.id === "string" && typeof data.name === "string") {
      messages.push({id: `tool-start-${data.id}`, session_id: this.sessionId, role: "assistant", content: [{type: "tool_use", id: data.id, name: data.name, input: {}, ...(typeof data.title === "string" ? {displayTitle: data.title} : {})}]});
    } else if (status === "tool_result" && typeof data.id === "string") {
      messages.push({id: `tool-result-${data.id}`, session_id: this.sessionId, role: "tool", content: [{type: "tool_result", tool_use_id: data.id, content: data.text === "工具执行失败" ? "工具执行失败" : "工具调用已结束"}]});
    }
    else if (status === "stream" && typeof data.text === "string" && data.text) {
      this.streamed = true;
      messages.push({ id: `container-stream-${Date.now()}`, session_id: this.sessionId, role: "assistant", content: [{ type: "text", text: data.text }] });
    } else if (status === "success") {
      this.terminal = true; initialize(data.newSessionId);
      const text = data.result ? String(data.result) : "";
      if (useFinalResult || (text && !this.streamed)) messages.push({ final: true, id: `container-success-${Date.now()}`, session_id: this.sessionId, role: "assistant", content: [{ type: "text", text }] });
    } else if (status === "stderr" && typeof data.text === "string" && data.text.trim()) this.stderr = data.text.trim();
    else if (status === "error") { this.terminal = true; throw _containerProtocolError(data, this.stderr); }
    return messages;
  }
}

const RETRYABLE_FAILURE_KINDS = new Set<RunnerFailureKind>([
  "rate_limited",
  "capacity_exhausted",
  "transport_interrupted",
  "timeout",
  "service_unavailable",
]);

function _containerOutputErrorMessage(
  data: Record<string, unknown>,
  stderr = "",
): string {
  const message =
    typeof data.error === "string" && data.error.length > 0
      ? data.error
      : stderr.length > 0
        ? stderr
        : "unknown";
  const exitCode = data.exitCode;
  return `Container error: ${message}${
    exitCode === undefined ? "" : ` (exit code ${exitCode})`
  }`;
}

export function _containerProtocolError(
  data: Record<string, unknown>,
  stderr = "",
): Error {
  const error = new Error(_containerOutputErrorMessage(data, stderr));
  const failure = _parseRunnerFailure(data.failure);
  if (failure !== undefined) {
    Object.assign(error, { failure });
  }
  const code =
    (typeof data.code === "string" && data.code.length > 0
      ? data.code
      : _inferProtocolErrorCode(error.message)) ?? undefined;
  if (code !== undefined) {
    Object.assign(error, { code });
  }
  return error;
}

export function _runnerFailure(error: unknown): RunnerFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  return _parseRunnerFailure(
    (error as Error & { failure?: unknown }).failure,
  );
}

function _parseRunnerFailure(value: unknown): RunnerFailure | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<RunnerFailure>;
  if (
    typeof candidate.kind !== "string" ||
    !isRunnerFailureKind(candidate.kind) ||
    (candidate.provider !== "claude" && candidate.provider !== "codex") ||
    typeof candidate.message !== "string"
  ) {
    return undefined;
  }
  return candidate as RunnerFailure;
}

function isRunnerFailureKind(value: string): value is RunnerFailureKind {
  return [
    "rate_limited",
    "capacity_exhausted",
    "transport_interrupted",
    "timeout",
    "service_unavailable",
    "authentication_failed",
    "permission_denied",
    "invalid_request",
    "model_not_found",
    "context_too_large",
    "quota_exhausted",
    "session_unusable",
    "process_failed",
    "unknown",
  ].includes(value);
}

export function _isRetryableRunnerFailure(error: unknown): boolean {
  const failure = _runnerFailure(error);
  if (failure !== undefined) {
    return RETRYABLE_FAILURE_KINDS.has(failure.kind);
  }
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
  return (
    message.includes("response.failed") ||
    message.includes("stream disconnected before completion") ||
    message.includes("high demand") ||
    message.includes("peak load")
  );
}

export function _containerProtocolErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  return _inferProtocolErrorCode(error.message);
}

function _inferProtocolErrorCode(message: string): string | undefined {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid_encrypted_content")) {
    return "runner_session_not_found";
  }
  if (
    normalized.includes("thread/resume failed") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("no thread found") ||
      normalized.includes("not found"))
  ) {
    return "runner_session_not_found";
  }
  return undefined;
}
