import { toolTitle, toolResultText } from "./tool-progress";
import { randomUUID } from "node:crypto";

import type { ContainerInput } from "../types";
import type {
  ContainerRunnerProvider,
  ParsedRunnerLine,
  RunnerFailure,
} from "./types";
import { normalizeProviderFailure } from "./failure-normalizer";

function parseCodexErrorCode(message: string): string | undefined {
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

function codexErrorLine(message: string): ParsedRunnerLine {
  const code = parseCodexErrorCode(message);
  return code === undefined
    ? { kind: "error", message }
    : { kind: "error", message, code };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function parseCodexStreamLine(line: string): ParsedRunnerLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (obj.type === "turn.completed") return { kind: "complete" };

  if (obj.type === "thread.started") {
    return {
      kind: "init",
      sessionId:
        typeof obj.thread_id === "string" && obj.thread_id.length > 0
          ? obj.thread_id
          : randomUUID(),
    };
  }

  if (obj.type === "item.completed" && obj.item && typeof obj.item === "object") {
    const item = obj.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      return { kind: "text", text: item.text };
    }
  }

  if (["item.started", "item.completed"].includes(String(obj.type)) && obj.item && typeof obj.item === "object") {
    const item = obj.item as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) return null;
    const name = item.type === "command_execution" ? "Bash"
      : item.type === "file_change" ? "apply_patch"
      : item.type === "mcp_tool_call" ? (typeof item.tool === "string" ? item.tool : "MCP")
      : item.type === "web_search" ? "web_search" : undefined;
    if (!name) return null;
    const input = item.type === "mcp_tool_call" ? parseToolArguments(item.arguments)
      : item.type === "file_change" && Array.isArray(item.changes)
        ? parseToolArguments(item.changes[0]) : item;
    const title = toolTitle(name, input);
    const start = {kind: "tool_start" as const, id: item.id, name, title};
    // Search/file items may only acquire their subject on completion. Delay an
    // empty start and repeat the same stable ID at completion; native delivery
    // deduplicates it if the earlier start already supplied the subject.
    const lateSubject = item.type === "web_search" || item.type === "file_change";
    if (obj.type === "item.started") {
      return {kind: "events", events: lateSubject && title === toolTitle(name) ? [] : [start]};
    }
    return {kind: "events", events: [
      ...(lateSubject ? [start] : []),
      {kind: "tool_result", id: item.id, text: toolResultText(item.status === "failed" || item.error != null || (typeof item.exit_code === "number" && item.exit_code !== 0))},
    ]};
  }

  if (obj.type === "turn.failed") {
    const error = obj.error;
    const message =
      error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
        ? (error as Record<string, unknown>).message as string
        : "Unknown turn failure";
    return codexErrorLine(message);
  }

  if (obj.type === "error") {
    const message = typeof obj.message === "string" ? obj.message : "Unknown stream error";
    return codexErrorLine(message);
  }

  return null;
}

export const codexContainerRunnerProvider: ContainerRunnerProvider = {
  family: "codex",
  buildCliArgs(input: ContainerInput, sessionId?: string): string[] {
    // Avoid waiting for best-effort analytics uploads after the turn completes.
    const args = ["codex", "-c", "analytics.enabled=false"];
    if (input.env?.CODEX_PROVIDER_MODE === "gateway") {
      const baseUrl = input.env.OPENAI_BASE_URL;
      if (!baseUrl || !input.env.OPENAI_API_KEY?.trim()) {
        throw new Error("Codex gateway requires OPENAI_BASE_URL and OPENAI_API_KEY");
      }
      args.push(
        "-c", 'model_provider="luna_gateway"',
        "-c", 'model_providers.luna_gateway.name="Luna Gateway"',
        "-c", `model_providers.luna_gateway.base_url=${JSON.stringify(baseUrl)}`,
        "-c", 'model_providers.luna_gateway.env_key="OPENAI_API_KEY"',
        "-c", 'model_providers.luna_gateway.wire_api="responses"',
        "-c", "model_providers.luna_gateway.requires_openai_auth=false",
        "-c", "model_providers.luna_gateway.supports_websockets=false",
      );
    }
    args.push(
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    );
    if (input.model) {
      args.push("--model", input.model);
    }
    if (sessionId) {
      return [...args, "resume", sessionId, input.prompt];
    }
    return [...args, input.prompt];
  },
  parseStreamLine: parseCodexStreamLine,
  normalizeFailure(message: string): RunnerFailure {
    const code = parseCodexErrorCode(message);
    return normalizeProviderFailure("codex", message, {
      ...(code === undefined ? {} : { providerCode: code }),
      fallbackKind:
        code === "runner_session_not_found" ? "session_unusable" : "unknown",
    });
  },
  normalizeErrorCode(message: string): string | undefined {
    return parseCodexErrorCode(message);
  },
  writesPromptToStdin(): boolean {
    return false;
  },
};
