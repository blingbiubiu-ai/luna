import { toolTitle, toolResultText } from "./tool-progress";
import type { PublicRunnerEvent } from "./types";
import { randomUUID } from "node:crypto";

import type { ContainerInput } from "../types";
import type {
  ContainerRunnerProvider,
  ParsedRunnerLine,
  RunnerFailure,
} from "./types";
import { normalizeProviderFailure } from "./failure-normalizer";

function normalizeClaudeFailure(message: string): RunnerFailure {
  const normalized = message.toLowerCase();
  const providerCode = claudeErrorCode(message);
  const kind =
    providerCode === "runner_session_not_found"
      ? "session_unusable"
      : normalized.includes("reconnecting") ||
      normalized.includes("response.failed") ||
      normalized.includes("stream disconnected before completion")
      ? "transport_interrupted"
      : "unknown";
  return normalizeProviderFailure("claude", message, {
    fallbackKind: kind,
    ...(providerCode === undefined ? {} : { providerCode }),
  });
}

function claudeErrorCode(message: string): string | undefined {
  return message.toLowerCase().includes(
      "no conversation found with session id",
    )
    ? "runner_session_not_found"
    : undefined;
}

function claudeResultError(obj: Record<string, unknown>): string {
  if (typeof obj.result === "string") {
    return obj.result;
  }
  if (typeof obj.error === "string") {
    return obj.error;
  }
  if (Array.isArray(obj.errors)) {
    const errors = obj.errors.filter(
      (error): error is string =>
        typeof error === "string" && error.trim().length > 0,
    );
    if (errors.length > 0) {
      return errors.join("\n");
    }
  }
  return "Unknown Claude execution failure";
}

function parseClaudeStreamLine(line: string): ParsedRunnerLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return { kind: "init", sessionId: obj.session_id };
  }

  if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
    const content = (obj.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const events: PublicRunnerEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") events.push({kind: "text", text: block.text});
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        events.push({kind: "tool_start", id: block.id, name: block.name,
          title: toolTitle(block.name, block.input && typeof block.input === "object" ? block.input : {})});
      }
    }
    if (events.every(event => event.kind === "text")) {
      return events.length ? {kind: "text", text: events.map(event => event.kind === "text" ? event.text : "").join("\n")} : null;
    }
    return {kind: "events", events};
  }

  if (obj.type === "user" && obj.message && typeof obj.message === "object") {
    const content = (obj.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const events: PublicRunnerEvent[] = content.flatMap(block => block?.type === "tool_result" && typeof block.tool_use_id === "string"
      ? [{kind: "tool_result" as const, id: block.tool_use_id, text: toolResultText(block.is_error === true)}] : []);
    if (events.length) return {kind: "events", events};
  }

  if (obj.type === "error") {
    return {
      kind: "error",
      message:
        typeof obj.message === "string"
          ? obj.message
          : "Unknown Claude stream error",
    };
  }

  if (obj.type === "result" && obj.is_error !== true) return { kind: "complete", finalText: typeof obj.result === "string" ? obj.result : "" };

  if (obj.type === "result" && obj.is_error === true) {
    const message = claudeResultError(obj);
    return {
      kind: "error",
      message,
      ...(claudeErrorCode(message) === undefined
        ? {}
        : { code: "runner_session_not_found" }),
    };
  }

  return null;
}

export const claudeContainerRunnerProvider: ContainerRunnerProvider = {
  family: "claude",
  buildCliArgs(input: ContainerInput, sessionId?: string): string[] {
    const args = [
      input.runnerType,
      "--output-format",
      "stream-json",
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (input.model) {
      args.push("--model", input.model);
    }
    if (sessionId) {
      return [...args, "--resume", sessionId];
    }
    return [...args, "--session-id", randomUUID()];
  },
  parseStreamLine: parseClaudeStreamLine,
  normalizeFailure: normalizeClaudeFailure,
  normalizeErrorCode(message: string): string | undefined {
    return claudeErrorCode(message);
  },
  writesPromptToStdin(): boolean {
    return true;
  },
};
