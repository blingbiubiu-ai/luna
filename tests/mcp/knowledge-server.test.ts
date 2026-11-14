import { describe, expect, test } from "bun:test";

import { type WorkspaceClient } from "@luna/service-client/workspace-client";
import { createKnowledgeMcpServer, createKnowledgeToolHandlers } from "../../src/mcp/knowledge-server";

class FakeWorkspaceClient implements WorkspaceClient {
  calls: string[] = [];

  async glob(workspaceId: string, pattern: string): Promise<unknown> {
    this.calls.push(`glob:${workspaceId}:${pattern}`);
    return { workspaceId, entries: [{ path: "wiki/domains/playback.md" }] };
  }

  async grep(workspaceId: string, query: string | Record<string, unknown>, glob?: string): Promise<unknown> {
    this.calls.push(
      `grep:${workspaceId}:${typeof query === "string" ? query : JSON.stringify(query)}:${glob ?? ""}`,
    );
    return { workspaceId, matches: [{ path: "wiki/domains/playback.md", line: 1, text: query }] };
  }

  async read(workspaceId: string, path: string): Promise<unknown> {
    this.calls.push(`read:${workspaceId}:${path}`);
    return { workspaceId, path, content: "# Playback" };
  }

  async write(workspaceId: string, path: string, content: string): Promise<unknown> {
    this.calls.push(`write:${workspaceId}:${path}:${content}`);
    return { workspaceId, path, written: true };
  }

  async gitStatus(workspaceId: string): Promise<unknown> {
    this.calls.push(`status:${workspaceId}`);
    return { workspaceId, clean: true, entries: [] };
  }

  async gitDiff(workspaceId: string): Promise<unknown> {
    this.calls.push(`diff:${workspaceId}`);
    return { workspaceId, diff: "" };
  }

  async gitCommit(workspaceId: string, message: string): Promise<unknown> {
    this.calls.push(`commit:${workspaceId}:${message}`);
    return { status: "committed", commitHash: "a".repeat(40) };
  }
}

describe("knowledge MCP server", () => {
  test("read alias delegates to the knowledge workspace client", async () => {
    const workspace = new FakeWorkspaceClient();
    const handlers = createKnowledgeToolHandlers(workspace);

    const readResult = await handlers.luna_knowledge_read({ path: "wiki/domains/playback.md" });

    expect(readResult.content[0]?.type === "text" ? readResult.content[0].text : "").toContain("# Playback");
    expect(workspace.calls).toContain("read:knowledge:wiki/domains/playback.md");
  });

  test("workspace and knowledge alias tools delegate to workspace client", async () => {
    const workspace = new FakeWorkspaceClient();
    const handlers = createKnowledgeToolHandlers(workspace);

    await handlers.luna_workspace_read({ workspaceId: "knowledge", path: "wiki/domains/playback.md" });
    await handlers.luna_knowledge_write({ path: "archive/seed.md", content: "# Seed\n" });
    await handlers.luna_knowledge_git_commit({ message: "docs: ingest seed" });

    expect(workspace.calls).toEqual([
      "read:knowledge:wiki/domains/playback.md",
      "write:knowledge:archive/seed.md:# Seed\n",
      "commit:knowledge:docs: ingest seed",
    ]);
  });

  test("grep aliases pass structured multi-query and regex options to workspace client", async () => {
    const workspace = new FakeWorkspaceClient();
    const handlers = createKnowledgeToolHandlers(workspace);

    await handlers.luna_knowledge_grep({
      queries: ["首帧", "起播"],
      match: "any",
      mode: "literal",
      glob: "wiki/**/*.md",
    });
    await handlers.luna_workspace_grep({
      workspaceId: "knowledge",
      query: "首帧|起播",
      mode: "regex",
      glob: "wiki/**/*.md",
    });

    expect(workspace.calls).toEqual([
      'grep:knowledge:{"queries":["首帧","起播"],"match":"any","mode":"literal","glob":"wiki/**/*.md"}:',
      'grep:knowledge:{"query":"首帧|起播","mode":"regex","glob":"wiki/**/*.md"}:',
    ]);
  });

  test("creates an MCP server instance", () => {
    const server = createKnowledgeMcpServer(new FakeWorkspaceClient());

    expect(server.isConnected()).toBe(false);
  });
});
