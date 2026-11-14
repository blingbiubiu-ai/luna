import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { runClientCli } from "@luna/cli/main";

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
};

describe("client-only Luna CLI", () => {
  test("queries tasks and sessions through their top-level commands", async () => {
    await withMockFetch(200, [], async captured => {
      const env = { LUNA_SERVICE_URL: "http://service.test", LUNA_AGENT_ID: "agent-1" };
      for (const command of [
        ["task", "list"],
        ["task", "get", "--task-id", "task-1"],
        ["task", "status", "command-1"],
        ["session", "messages", "--session-id", "session-1"],
        ["session", "read_session_timeline", "--session-id", "session-1", "--limit", "5"],
      ]) expect((await runClientCli(command, env)).status).toBe("ok");
      expect(captured.map(({url}) => url)).toEqual([
        "http://service.test/api/tasks?agentId=agent-1",
        "http://service.test/api/tasks/task-1",
        "http://service.test/api/runner/operations/command-1",
        "http://service.test/api/sessions/session-1/messages",
        "http://service.test/api/sessions/session-1/timeline/read?limit=5",
      ]);
    });
  });

  test("does not expose the removed session attachment query", async () => {
    const result = await runClientCli([
      "session", "find_recent_session_attachments", "--session-id", "session-1",
    ], {});
    expect(result).toMatchObject({ status: "error", code: "invalid_operation" });
  });

  test("forwards plugin commands to Luna Service by default", async () => {
    await withMockFetch(
      200,
      { status: "success", summary: { ok: true }, artifacts: [] },
      async (captured) => {
        const result = await runClientCli(["diagnosis", "logtool", "logid", "query"], {
          LUNA_SERVICE_URL: "http://service.test",
        });

        expect(result.status).toBe("ok");
        expect(captured).toHaveLength(1);
        expect(captured[0]?.url).toBe(
          "http://service.test/api/plugins/commands/resolve-and-invoke",
        );
        expect(captured[0]?.method).toBe("POST");
        expect(captured[0]?.body).toEqual({
          path: ["diagnosis"],
          args: ["logtool", "logid", "query"],
        });
      },
    );
  });

  test("entrypoint stays client-only", () => {
    const source = readFileSync("apps/cli/src/main.ts", "utf8");

    expect(source).not.toContain("../index");
    expect(source).not.toContain("startAgentRuntime");
    expect(source).not.toContain("startMcpStdioBridge");
  });
});

async function withMockFetch<T>(
  status: number,
  responseBody: unknown,
  fn: (captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    captured.push({
      url: request.url,
      method: request.method,
      body: request.method === "GET" || !request.headers.get("content-type")
        ? null
        : await request.json(),
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
  try {
    return await fn(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
