import {fixtureScope} from "../helpers/platform-fixtures";
import {createKnowledgeWorkspaceRepository} from "../../extensions/workspace/knowledge/definition";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import {
  createDashboardAuthMiddleware,
  DashboardAuthService,
} from "../../src/server/auth";
import { AccessTokenService } from "../../src/server/auth/access-token-service";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createMcpRoutes } from "../../src/server/routes/mcp";
import { setLunaHome } from "../../src/shared";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

describe("Unified Service MCP route", () => {
  let home: string;
  let repoRoot: string;
  let agentId:string;
  let knowledgeRoot:string;
  let connection: DataConnection<typeof schema>;
  let user: { id: string; displayName: string };
  let token: string;
  let server: ReturnType<typeof Bun.serve>;
  let previousDashboardToken: string | undefined;
  let previousLunaHome: string | undefined;

  beforeEach(() => {
    previousDashboardToken = Bun.env.LUNA_DASHBOARD_TOKEN;
    previousLunaHome = Bun.env.LUNA_HOME;
    Bun.env.LUNA_DASHBOARD_TOKEN = "mcp-route-test-secret";
    home = mkdtempSync(join(tmpdir(), "luna-mcp-home-"));
    repoRoot = mkdtempSync(join(tmpdir(), "luna-mcp-repo-"));
    mkdirSync(join(home, "data"), { recursive: true });


    Bun.env.LUNA_HOME = home;
    setLunaHome(home);
    connection = new DataConnection(schema);
    user = new IdentityDirectory(connection.db).materializeIdentityClaims({
      kind: "human",
      displayName: "MCP User",
      claims: [
        {
          namespace: "local",
          kind: "local_id",
          value: "mcp-user",
          scope: "",
          confidence: "manual",
        },
      ],
    });
    const scope=fixtureScope(connection.db,user.id);agentId=scope.agentId;
    knowledgeRoot=createKnowledgeWorkspaceRepository(repoRoot,agentId).root;
    mkdirSync(join(knowledgeRoot, "wiki/domains"), { recursive: true });
    writeFileSync(
      join(knowledgeRoot, "wiki/domains/playback.md"),
      "# Playback\nSearchable from MCP\n首帧体验\n起播速度\n",
    );
    git(knowledgeRoot, ["init"]);
    git(knowledgeRoot, ["config", "user.email", "test@example.com"]);
    git(knowledgeRoot, ["config", "user.name", "Test User"]);
    git(knowledgeRoot, ["add", "."]);
    git(knowledgeRoot, ["commit", "-m", "seed"]);
    new AuthorizationRuleStore(connection.db,{kind:"agent",agentId}).addGrant({ matchType: "exact",
      subjectType: "user",
      subjectId: user.id,
      target: "workspace.knowledge.read",
      effect: "allow",
    });
    token = new AccessTokenService({
      db: connection.db,
      signingSecret: "mcp-route-test-secret",
    }).issueToken({
      userId: user.id,
      name: "MCP route test token",
      source: "cli",
      role: "user",
      ttlMs: 60 * 60 * 1000,
      now: Date.now(),
    }).token;

    const app = new Hono()
      .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db: connection.db }))
      .route("/mcp", createMcpRoutes({ db: connection.db, serviceHome:repoRoot }));
    server = Bun.serve({ port: 0, fetch: app.fetch });
  });

  afterEach(() => {
    server.stop(true);
    connection.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    if (previousDashboardToken === undefined) {
      delete Bun.env.LUNA_DASHBOARD_TOKEN;
    } else {
      Bun.env.LUNA_DASHBOARD_TOKEN = previousDashboardToken;
    }
    if (previousLunaHome === undefined) {
      delete Bun.env.LUNA_HOME;
      setLunaHome(join(homedir(), ".luna"));
    } else {
      Bun.env.LUNA_HOME = previousLunaHome;
      setLunaHome(previousLunaHome);
    }
  });

  test("serves knowledge tools over Unified Service /mcp with per-request bearer auth", async () => {
    const client = new Client({ name: "luna-unified-mcp-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp?agentId=${agentId}`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${token}` },
        },
      },
    );

    try {
      await client.connect(transport as never);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "luna_knowledge_read",
        arguments: { path: "wiki/domains/playback.md" },
      });
      const content = result.content as Array<{ type: string; text?: string }>;

      expect(tools.tools.map((tool) => tool.name)).toContain("luna_knowledge_read");
      expect(content[0]?.type === "text" ? content[0].text : "").toContain(
        "Searchable from MCP",
      );
    } finally {
      await transport.close();
    }
  });

  test("rejects unauthenticated MCP requests before tool dispatch", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp?agentId=${agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "unauthorized",
    });
  });

  test("serves regex grep over Unified Service /mcp", async () => {
    const client = new Client({ name: "luna-unified-mcp-regex-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp?agentId=${agentId}`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${token}` },
        },
      },
    );

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

      expect(text).toContain("首帧体验");
      expect(text).toContain("起播速度");
    } finally {
      await transport.close();
    }
  });
});
