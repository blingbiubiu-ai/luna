import { describe, expect, test } from "bun:test";

import { createWorkspaceClient } from "../src/workspace-client";

describe("Unified Service workspace client", () => {
  test("calls workspace file operations with bearer auth only", async () => {
    const requests: Request[] = [];
    const client = createWorkspaceClient(
      { serviceUrl: "http://service.test", accessToken: "token" },
      {
        fetch: (async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          requests.push(request);
          return new Response(JSON.stringify({ path: "wiki/a.md", content: "# A\n" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    );

    await client.read("knowledge", "wiki/a.md");

    expect(requests[0]?.url).toBe("http://service.test/api/workspaces/knowledge/file?path=wiki%2Fa.md");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]?.headers.get("x-luna-user-id")).toBeNull();
  });

  test("writes full content without a commit message", async () => {
    const bodies: unknown[] = [];
    const client = createWorkspaceClient(
      { serviceUrl: "http://service.test" },
      {
        fetch: (async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          bodies.push(await request.json());
          return new Response(JSON.stringify({ path: "archive/seed.md", written: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    );

    await client.write("knowledge", "archive/seed.md", "# Seed\n");

    expect(bodies).toEqual([{ path: "archive/seed.md", content: "# Seed\n" }]);
  });

  test("calls git commit explicitly", async () => {
    const requests: Request[] = [];
    const client = createWorkspaceClient(
      { serviceUrl: "http://service.test" },
      {
        fetch: (async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          requests.push(request);
          return new Response(JSON.stringify({ status: "committed", commitHash: "a".repeat(40) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    );

    await client.gitCommit("knowledge", "docs: update knowledge");

    expect(requests[0]?.url).toBe("http://service.test/api/workspaces/knowledge/git/commit");
    expect(await requests[0]?.json()).toEqual({ message: "docs: update knowledge" });
  });
});
