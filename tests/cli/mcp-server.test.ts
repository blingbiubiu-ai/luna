import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("luna mcp bridge cli", () => {
  let root: string;
  let service: ReturnType<typeof Bun.serve>;
  let serviceUrl: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "luna-mcp-"));
    service = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/workspaces/knowledge/file") {
          return Response.json({
            path: url.searchParams.get("path"),
            authorization: request.headers.get("authorization"),
            content: "# 全网资源\nworkspace content",
          });
        }
        if (url.pathname === "/api/workspaces/knowledge/grep") {
          return Response.json({
            query: url.searchParams.get("query"),
            mode: url.searchParams.get("mode"),
            glob: url.searchParams.get("glob"),
            authorization: request.headers.get("authorization"),
            matches: [
              { path: "wiki/domains/playback.md", line: 1, text: "首帧体验" },
            ],
          });
        }
        return Response.json({ code: "not_found" }, { status: 404 });
      },
    });
    serviceUrl = `http://127.0.0.1:${service.port}`;
  });

  afterEach(() => {
    service.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("starts over stdio and serves knowledge read tool", async () => {
    const client = new Client({ name: "luna-mcp-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [
        "src/cli/server-main.ts",
        "mcp",
        "bridge",
        "--stdio",
        "--service-url",
        serviceUrl,
        "--access-token",
        "access-token",
      ],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    try {
      await client.connect(transport as never);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "luna_knowledge_read",
        arguments: { path: "wiki/domains/all-web-resource.md" }
      });
      const content = result.content as Array<{ type: string; text?: string }>;

      expect(tools.tools.map((tool) => tool.name)).not.toContain("luna_knowledge_route");
      expect(tools.tools.map((tool) => tool.name)).toContain("luna_knowledge_read");
      expect(content[0]?.type === "text" ? content[0].text : "").toContain("wiki/domains/all-web-resource.md");
      expect(content[0]?.type === "text" ? content[0].text : "").toContain("Bearer access-token");
    } finally {
      await transport.close();
    }
  });

  test("stdio bridge forwards regex grep options to Unified Service", async () => {
    const client = new Client({ name: "luna-mcp-grep-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [
        "src/cli/server-main.ts",
        "mcp",
        "bridge",
        "--stdio",
        "--service-url",
        serviceUrl,
        "--access-token",
        "access-token",
      ],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    try {
      await client.connect(transport as never);
      const result = await client.callTool({
        name: "luna_knowledge_grep",
        arguments: {
          query: "首帧|起播",
          mode: "regex",
          glob: "wiki/**/*.md",
        },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content[0]?.type === "text" ? content[0].text ?? "" : "";

      expect(text).toContain('"query":"首帧|起播"');
      expect(text).toContain('"mode":"regex"');
      expect(text).toContain("Bearer access-token");
    } finally {
      await transport.close();
    }
  });
});
