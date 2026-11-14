import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runClientCli } from "@luna/cli/main";

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
};

async function withMockFetch<T>(
  responseBody: unknown,
  fn: (captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    captured.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? null : await request.json(),
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
  try {
    return await fn(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

describe("luna knowledge cli", () => {
  let root: string;
  let lunaHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "luna-knowledge-"));
    lunaHome = mkdtempSync(join(tmpdir(), "luna-knowledge-home-"));
    mkdirSync(join(root, "knowledge/wiki/domains"), { recursive: true });
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    writeFileSync(join(root, "knowledge/wiki/domains/playback.md"), "---\ntitle: Playback\n---\n# Playback\nCLI search text.\n");
    git(root, ["add", "knowledge"]);
    git(root, ["commit", "-m", "seed"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(lunaHome, { recursive: true, force: true });
  });

  test("prints knowledge command group help without calling service", async () => {
    await withMockFetch({ shouldNotBeCalled: true }, async (captured) => {
      const result = await runClientCli(["knowledge", "--help"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
      });

      expect(result.status).toBe("ok");
      expect(result.output).toContain("Usage:");
      expect(result.output).toContain("luna knowledge grep <query> [--glob <pattern>]");
      expect(result.output).toContain("luna knowledge write <path> --body <content>");
      expect(result.output).toContain("luna knowledge git-commit --message <message>");
      expect(captured).toEqual([]);
    });
  });

  test("prints knowledge subcommand help instead of validating required args", async () => {
    await withMockFetch({ shouldNotBeCalled: true }, async (captured) => {
      const result = await runClientCli(["knowledge", "write", "--help"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
      });

      expect(result.status).toBe("ok");
      expect(result.output).toContain("Usage:");
      expect(result.output).toContain("luna knowledge write <path> --body <content>");
      expect(result.output).toContain("luna knowledge write <path> --body-file <file>");
      expect(result.output).toContain("write does not commit");
      expect(captured).toEqual([]);
    });
  });

  test("greps knowledge through the managed workspace by default", async () => {
    await withMockFetch({ matches: [{ path: "wiki/domains/playback.md", line: 4, text: "playback" }] }, async (captured) => {
      const result = await runClientCli(["knowledge", "grep", "playback"], {
        LUNA_HOME: lunaHome,
        LUNA_SERVICE_URL: undefined,
        LUNA_SERVICE_HOST: "127.0.0.1",
        LUNA_SERVICE_PORT: "9000",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_USER_ID: "ou_user"
      });
      const output = JSON.parse(result.output ?? "{}") as { matches: Array<{ path: string }> };

      expect(result.status).toBe("ok");
      expect(output.matches.map((item) => item.path)).toEqual(["wiki/domains/playback.md"]);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe("http://127.0.0.1:9000/api/workspaces/knowledge/grep?query=playback&glob=**%2F*");
      expect(captured[0]?.headers.get("authorization")).toBe("Bearer user-token");
      expect(captured[0]?.headers.get("x-luna-user-id")).toBeNull();
    });
  });

  test("loads LUNA_ACCESS_TOKEN from credentials for knowledge commands", async () => {
    writeFileSync(join(lunaHome, "credentials.json"), JSON.stringify({
      serviceUrl: "http://credential-service.test",
      accessToken: "credential-token",
      expiresAt: 1_800_000_000_000,
      user: { id: "user_credential", displayName: "Credential User" },
    }));

    await withMockFetch({ matches: [] }, async (captured) => {
      const result = await runClientCli(["knowledge", "grep", "playback"], {
        LUNA_HOME: lunaHome,
      });

      expect(result.status).toBe("ok");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe("http://credential-service.test/api/workspaces/knowledge/grep?query=playback&glob=**%2F*");
      expect(captured[0]?.headers.get("authorization")).toBe("Bearer credential-token");
    });
  });

  test("reads files through the knowledge workspace", async () => {
    await withMockFetch({ path: "wiki/domains/playback.md", content: "CLI search text" }, async (captured) => {
      const result = await runClientCli(["knowledge", "read", "wiki/domains/playback.md", "--agent-id", "agent-b"], {
        LUNA_AGENT_ID: "agent-a",
        LUNA_SERVICE_URL: "http://service.test/base",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_USER_ID: "ou_user"
      });
      const output = JSON.parse(result.output ?? "{}") as { path: string; content: string };

      expect(result.status).toBe("ok");
      expect(output.path).toBe("wiki/domains/playback.md");
      expect(output.content).toContain("CLI search text");
      expect(captured[0]?.url).toBe("http://service.test/base/api/workspaces/knowledge/file?agentId=agent-b&path=wiki%2Fdomains%2Fplayback.md");
    });
  });

  test("writes files through the knowledge workspace without committing", async () => {
    await withMockFetch({ path: "wiki/domains/new.md", written: true }, async (captured) => {
      const result = await runClientCli(
        [
          "knowledge",
          "write",
          "wiki/domains/new.md",
          "--body",
          "# New\n",
        ],
        {
          LUNA_SERVICE_URL: "http://service.test",
          LUNA_ACCESS_TOKEN: "user-token",
          LUNA_USER_ID: "knowledge-writer"
        }
      );
      const output = JSON.parse(result.output ?? "{}") as { path: string; written: boolean };

      expect(result.status).toBe("ok");
      expect(output.path).toBe("wiki/domains/new.md");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe("http://service.test/api/workspaces/knowledge/file");
      expect(captured[0]?.method).toBe("PUT");
      expect(captured[0]?.headers.get("authorization")).toBe("Bearer user-token");
      expect(captured[0]?.headers.get("x-luna-user-id")).toBeNull();
      expect(captured[0]?.body).toEqual({
        path: "wiki/domains/new.md",
        content: "# New\n",
      });
    });
  });

  test("writes pages with body loaded from file", async () => {
    const bodyPath = join(root, "new-page.md");
    writeFileSync(bodyPath, "# New From File\n");

    await withMockFetch({ path: "wiki/domains/new.md", commitHash: "b".repeat(40) }, async (captured) => {
      const result = await runClientCli(
        [
          "knowledge",
          "write",
          "wiki/domains/new.md",
          "--body-file",
          bodyPath
        ],
        {
          LUNA_SERVICE_URL: "http://service.test",
          LUNA_ACCESS_TOKEN: "user-token",
          LUNA_USER_ID: "knowledge-writer"
        }
      );

      expect(result.status).toBe("ok");
      expect(captured[0]?.body).toEqual({
        path: "wiki/domains/new.md",
        content: "# New From File\n"
      });
    });
  });

  test("commits knowledge workspace changes explicitly", async () => {
    await withMockFetch({ status: "committed", commitHash: "a".repeat(40) }, async (captured) => {
      const result = await runClientCli(
        ["knowledge", "git-commit", "--message", "docs: update knowledge"],
        {
          LUNA_SERVICE_URL: "http://service.test",
          LUNA_ACCESS_TOKEN: "user-token",
        }
      );

      expect(result.status).toBe("ok");
      expect(captured[0]?.url).toBe("http://service.test/api/workspaces/knowledge/git/commit");
      expect(captured[0]?.method).toBe("POST");
      expect(captured[0]?.body).toEqual({ message: "docs: update knowledge" });
    });
  });

  test("glob grep and git status use workspace routes", async () => {
    await withMockFetch({ entries: [], matches: [], clean: true }, async (captured) => {
      await runClientCli(["knowledge", "glob", "wiki/**/*.md"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
      });
      await runClientCli(["knowledge", "grep", "playback", "--glob", "wiki/**/*.md"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
      });
      await runClientCli(["knowledge", "git-status"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
      });

      expect(captured.map((request) => request.url)).toEqual([
        "http://service.test/api/workspaces/knowledge/glob?pattern=wiki%2F**%2F*.md",
        "http://service.test/api/workspaces/knowledge/grep?query=playback&glob=wiki%2F**%2F*.md",
        "http://service.test/api/workspaces/knowledge/git/status",
      ]);
    });
  });

  test("workspace knowledge commands use generic workspace routes", async () => {
    await withMockFetch({ entries: [], matches: [], clean: true, path: "wiki/domains/new.md" }, async (captured) => {
      await runClientCli(["workspace", "knowledge", "glob", "wiki/**/*.md"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });
      await runClientCli(["workspace", "knowledge", "grep", "playback", "--glob", "wiki/**/*.md"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });
      await runClientCli(["workspace", "knowledge", "read", "wiki/domains/playback.md"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });
      await runClientCli(["workspace", "knowledge", "write", "wiki/domains/new.md", "--body", "# New\n"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });
      await runClientCli(["workspace", "knowledge", "git-status"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });
      await runClientCli(["workspace", "knowledge", "git-diff"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });
      await runClientCli(["workspace", "knowledge", "git-commit", "--message", "docs: update knowledge"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_AGENT_ID: "agent-a",
      });

      expect(captured.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET http://service.test/api/workspaces/knowledge/glob?agentId=agent-a&pattern=wiki%2F**%2F*.md",
        "GET http://service.test/api/workspaces/knowledge/grep?agentId=agent-a&query=playback&glob=wiki%2F**%2F*.md",
        "GET http://service.test/api/workspaces/knowledge/file?agentId=agent-a&path=wiki%2Fdomains%2Fplayback.md",
        "PUT http://service.test/api/workspaces/knowledge/file?agentId=agent-a",
        "GET http://service.test/api/workspaces/knowledge/git/status?agentId=agent-a",
        "GET http://service.test/api/workspaces/knowledge/git/diff?agentId=agent-a",
        "POST http://service.test/api/workspaces/knowledge/git/commit?agentId=agent-a",
      ]);
      expect(captured[3]?.body).toEqual({
        path: "wiki/domains/new.md",
        content: "# New\n",
      });
      expect(captured[6]?.body).toEqual({ message: "docs: update knowledge" });
    });
  });

  test("workspace command group help does not validate required args", async () => {
    await withMockFetch({ shouldNotBeCalled: true }, async (captured) => {
      const groupHelp = await runClientCli(["workspace", "--help"], {
        LUNA_SERVICE_URL: "http://service.test",
      });
      const writeHelp = await runClientCli(["workspace", "knowledge", "write", "--help"], {
        LUNA_SERVICE_URL: "http://service.test",
      });

      expect(groupHelp.status).toBe("ok");
      expect(groupHelp.output).toContain("luna workspace <workspace-id> glob <pattern>");
      expect(writeHelp.status).toBe("ok");
      expect(writeHelp.output).toContain("luna workspace knowledge write <path> --body <content>");
      expect(captured).toEqual([]);
    });
  }, 15_000);

  test("write rejects commit message because commits are explicit", async () => {
    const result = await runClientCli(
      ["knowledge", "write", "wiki/domains/new.md", "--body", "# New\n", "--message", "add new"],
      {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
      },
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain("knowledge write does not commit");
  });

  test("semantic knowledge commands are no longer exposed", async () => {
    await withMockFetch({ shouldNotBeCalled: true }, async (captured) => {
      const indexResult = await runClientCli(["knowledge", "index"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token"
      });
      const routeResult = await runClientCli(["knowledge", "route", "playback"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token"
      });
      const searchResult = await runClientCli(["knowledge", "search", "playback"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token"
      });
      const aclResult = await runClientCli(["knowledge", "acl", "backfill"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token"
      });

      expect(indexResult).toEqual(expect.objectContaining({ status: "error", code: "unknown_knowledge_command" }));
      expect(routeResult).toEqual(expect.objectContaining({ status: "error", code: "unknown_knowledge_command" }));
      expect(searchResult).toEqual(expect.objectContaining({ status: "error", code: "unknown_knowledge_command" }));
      expect(aclResult).toEqual(expect.objectContaining({ status: "error", code: "unknown_knowledge_command" }));
      expect(captured).toEqual([]);
    });
  });

  test("ignores legacy local backend flags and still uses Unified Service", async () => {
    await withMockFetch({ matches: [] }, async (captured) => {
      const result = await runClientCli([
        "knowledge",
        "grep",
        "playback",
        "--repo-root",
        root,
        "--backend",
        "local"
      ], {
        LUNA_SERVICE_URL: "http://service.test"
      });

      expect(result.status).toBe("ok");
      expect(captured[0]?.url).toBe("http://service.test/api/workspaces/knowledge/grep?query=playback&glob=**%2F*");
    });
  });

  test("does not forward provider identity environment for service routing", async () => {
    await withMockFetch({ matches: [] }, async (captured) => {
      const result = await runClientCli(["knowledge", "grep", "playback"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_IDENTITY_PROVIDER: "feishu",
        LUNA_IDENTITY_ID: "ou_xxx"
      });

      expect(result.status).toBe("ok");
      expect(captured[0]?.headers.get("authorization")).toBe("Bearer user-token");
      expect(captured[0]?.headers.get("x-luna-identity-provider")).toBeNull();
      expect(captured[0]?.headers.get("x-luna-identity-id")).toBeNull();
    });
  });

  test("ignores incomplete provider identity environment", async () => {
    await withMockFetch({ matches: [] }, async () => {
      const result = await runClientCli(["knowledge", "grep", "playback"], {
        LUNA_SERVICE_URL: "http://service.test",
        LUNA_ACCESS_TOKEN: "user-token",
        LUNA_IDENTITY_PROVIDER: "feishu"
      });

      expect(result.status).toBe("ok");
    });
  });

});
