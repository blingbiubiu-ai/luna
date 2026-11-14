import { describe, expect, test } from "bun:test";

import { resolveContainerRunnerProvider } from "@luna/executor/providers";

describe("inner container provider adapters", () => {
  test("claude provider builds first-run and resume args", () => {
    const provider = resolveContainerRunnerProvider("claude");
    expect(
      provider.buildCliArgs(
        { prompt: "hello", runnerType: "claude", model: "claude-sonnet-4-6" },
      ),
    ).toEqual([
      "claude",
      "--output-format",
      "stream-json",
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      "claude-sonnet-4-6",
      "--session-id",
      expect.any(String),
    ]);
    expect(
      provider.buildCliArgs(
        { prompt: "hello", runnerType: "claude", model: "claude-sonnet-4-6" },
        "claude-session-1",
      ),
    ).toEqual([
      "claude",
      "--output-format",
      "stream-json",
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      "claude-sonnet-4-6",
      "--resume",
      "claude-session-1",
    ]);
  });

  test("codex provider builds first-run and resume args", () => {
    const provider = resolveContainerRunnerProvider("codex");
    expect(
      provider.buildCliArgs(
        { prompt: "hello", runnerType: "codex", model: "gpt-5.5" },
      ),
    ).toEqual([
      "codex",
      "-c",
      "analytics.enabled=false",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "hello",
    ]);
    expect(
      provider.buildCliArgs(
        { prompt: "hello", runnerType: "codex", model: "gpt-5.5" },
        "thread-1",
      ),
    ).toEqual([
      "codex",
      "-c",
      "analytics.enabled=false",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "resume",
      "thread-1",
      "hello",
    ]);
  });

  test("Codex applies gateway settings to new and resumed runs without putting the key in argv", () => {
    const provider = resolveContainerRunnerProvider("codex");
    const input = {
      prompt: "hello", runnerType: "codex", model: "gpt-5.6-sol",
      env: { CODEX_PROVIDER_MODE: "gateway", OPENAI_BASE_URL: "http://gateway.test/v1", OPENAI_API_KEY: "test-secret" },
    };
    for (const sessionId of [undefined, "thread-1"]) {
      const args = provider.buildCliArgs(input, sessionId);
      expect(args[0]).toBe("codex");
      expect(args.slice(1, args.indexOf("exec"))).toContain('model_provider="luna_gateway"');
      expect(args).toContain('model_providers.luna_gateway.base_url="http://gateway.test/v1"');
      expect(args).toContain('model_providers.luna_gateway.env_key="OPENAI_API_KEY"');
      expect(args).toContain("model_providers.luna_gateway.supports_websockets=false");
      expect(args.join(" ")).not.toContain("test-secret");
      expect(args.includes("resume")).toBe(sessionId !== undefined);
    }
    expect(() => provider.buildCliArgs({
      ...input, env: { CODEX_PROVIDER_MODE: "gateway" },
    })).toThrow("OPENAI_API_KEY");
  });

  test("providers parse init lines into provider session ids", () => {
    const claude = resolveContainerRunnerProvider("claude");
    const codex = resolveContainerRunnerProvider("codex");

    expect(
      claude.parseStreamLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "claude-session-1",
        }),
      ),
    ).toEqual({ kind: "init", sessionId: "claude-session-1" });

    expect(
      codex.parseStreamLine(
        JSON.stringify({
          type: "thread.started",
          thread_id: "thread-1",
        }),
      ),
    ).toEqual({ kind: "init", sessionId: "thread-1" });
  });

  test("codex provider normalizes stale resume failures into protocol error codes", () => {
    const codex = resolveContainerRunnerProvider("codex");

    expect(
      codex.parseStreamLine(
        JSON.stringify({
          type: "error",
          message:
            "thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)",
        }),
      ),
    ).toEqual({
      kind: "error",
      code: "runner_session_not_found",
      message:
        "thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)",
    });
  });

  test("claude provider keeps generic errors provider-agnostic", () => {
    const claude = resolveContainerRunnerProvider("claude");

    expect(
      claude.parseStreamLine(
        JSON.stringify({
          type: "error",
          message: "ordinary failure",
        }),
      ),
    ).toEqual({ kind: "error", message: "ordinary failure" });
    expect(claude.normalizeFailure("ordinary failure")).toMatchObject({
      kind: "unknown",
      provider: "claude",
    });
  });

  test("claude provider parses an error result into the common error event", () => {
    const claude = resolveContainerRunnerProvider("claude");

    expect(
      claude.parseStreamLine(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "HTTP 529: overloaded_error",
        }),
      ),
    ).toEqual({
      kind: "error",
      message: "HTTP 529: overloaded_error",
    });
  });

  test("claude provider recognizes missing resumed conversations from errors arrays", () => {
    const claude = resolveContainerRunnerProvider("claude");
    const message =
      "No conversation found with session ID: 5586d2bf-1970-4601-b98d-c7f323efa34c";

    expect(
      claude.parseStreamLine(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [message],
        }),
      ),
    ).toEqual({
      kind: "error",
      code: "runner_session_not_found",
      message,
    });
    expect(claude.normalizeFailure(message)).toEqual({
      kind: "session_unusable",
      provider: "claude",
      message,
      providerCode: "runner_session_not_found",
    });
  });

  test("claude provider normalizes a terminal reconnect failure", () => {
    const claude = resolveContainerRunnerProvider("claude");

    expect(
      claude.normalizeFailure(
        "Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)",
      ),
    ).toEqual({
      kind: "transport_interrupted",
      provider: "claude",
      message:
        "Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)",
    });
  });

  test("providers normalize vendor-specific throttling into one failure kind", () => {
    const claude = resolveContainerRunnerProvider("claude");
    const codex = resolveContainerRunnerProvider("codex");

    expect(
      claude.normalizeFailure(
        '{"type":"rate_limit_error","message":"Too many requests"}',
      ),
    ).toMatchObject({
      kind: "rate_limited",
      provider: "claude",
    });
    expect(
      codex.normalizeFailure(
        "HTTP 429: rate_limit_exceeded",
      ),
    ).toMatchObject({
      kind: "rate_limited",
      provider: "codex",
      httpStatus: 429,
    });
  });

  test("providers preserve tool result IDs for completion and checkpoints", () => {
    const claude = resolveContainerRunnerProvider("claude");
    const codex = resolveContainerRunnerProvider("codex");

    expect(
      claude.parseStreamLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1" }],
          },
        }),
      ),
    ).toEqual({kind:"events",events:[{kind:"tool_result",id:"tool-1",text:"工具调用已结束"}]});
    expect(
      codex.parseStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", id: "item-1" },
        }),
      ),
    ).toEqual({kind:"events",events:[{kind:"tool_result",id:"item-1",text:"工具调用已结束"}]});
  });

  test("providers share transient and permanent failure categories", () => {
    for (const runnerType of ["claude", "codex"] as const) {
      const provider = resolveContainerRunnerProvider(runnerType);
      expect(
        provider.normalizeFailure("HTTP 529: overloaded_error"),
      ).toMatchObject({
        kind: "capacity_exhausted",
        provider: runnerType,
        httpStatus: 529,
      });
      expect(
        provider.normalizeFailure("HTTP 503: service unavailable"),
      ).toMatchObject({
        kind: "service_unavailable",
        provider: runnerType,
        httpStatus: 503,
      });
      expect(
        provider.normalizeFailure("HTTP 401: authentication failed"),
      ).toMatchObject({
        kind: "authentication_failed",
        provider: runnerType,
        httpStatus: 401,
      });
      expect(
        provider.normalizeFailure("context length exceeded"),
      ).toMatchObject({
        kind: "context_too_large",
        provider: runnerType,
      });
    }
  });

  test("codex provider classifies stderr-only stale resume failures", () => {
    const codex = resolveContainerRunnerProvider("codex");

    expect(
      codex.normalizeErrorCode(
        "Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)",
      ),
    ).toBe("runner_session_not_found");
  });

  test("codex provider classifies invalid encrypted resume content as an unusable session", () => {
    const codex = resolveContainerRunnerProvider("codex");

    expect(
      codex.normalizeErrorCode(
        'Container error: {"error":{"message":"code: invalid_encrypted_content; message: The encrypted content could not be verified.","type":"invalid_request_error","code":"-4003"}}',
      ),
    ).toBe("runner_session_not_found");
  });
});
