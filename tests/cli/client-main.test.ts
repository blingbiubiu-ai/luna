import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { runClientCli } from "@luna/cli/main";

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
};

describe("client-only Luna CLI (Protocol v2)", () => {
  test("queries tasks, sessions and unified command ledger through Protocol v2 commands", async () => {
    await withMockFetch(200, [], async captured => {
      const env = { LUNA_SERVICE_URL: "http://service.test", LUNA_AGENT_ID: "agent-1" };
      for (const command of [
        ["tasks", "list"],
        ["tasks", "list", "--session", "session:session-1"],
        ["tasks", "get", "--task-id", "task-1"],
        ["commands", "status", "command-1"],
        ["sessions", "list", "--kind", "group"],
        ["sessions", "messages", "--session", "session:session-1"],
        ["sessions", "timeline", "--session", "session:session-1", "--limit", "5"],
      ]) expect((await runClientCli(command, env)).status).toBe("ok");
      expect(captured.map(({ url }) => url)).toEqual([
        "http://service.test/api/tasks?agentId=agent-1",
        "http://service.test/api/tasks?sessionId=session-1",
        "http://service.test/api/tasks/task-1",
        "http://service.test/api/runner/commands/command-1",
        "http://service.test/api/runner/sessions?kind=group",
        "http://service.test/api/sessions/session-1/messages",
        "http://service.test/api/sessions/session-1/timeline/read?limit=5",
      ]);
    });
  });

  test("rejects removed v1 commands and attachment queries without forwarding to plugin resolver", async () => {
    for (const legacy of [
      ["task", "list"],
      ["session", "messages", "--session-id", "session-1"],
      ["messages", "send", "--text", "hi"],
      ["sessions", "find_recent_session_attachments", "--session", "session-1"],
      ["sessions", "read_session_timeline", "--session", "session-1"],
    ]) {
      const result = await runClientCli(legacy, {});
      expect(result.status).toBe("error");
    }
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
