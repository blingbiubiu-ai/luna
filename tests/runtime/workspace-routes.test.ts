import {fixtureScope} from "../helpers/platform-fixtures";
import {createKnowledgeWorkspaceRepository} from "../../extensions/workspace/knowledge/definition";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono, type MiddlewareHandler } from "hono";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import {
  createDashboardAuthMiddleware,
  DashboardAuthService,
  type DashboardAuthProvider,
} from "../../src/server/auth";
import {
  AccessTokenService,
  type LunaAccessTokenClaims,
} from "../../src/server/auth/access-token-service";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createWorkspaceRoutes } from "../../src/server/routes/workspaces";
import { setLunaHome } from "../../src/shared";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

describe("workspace routes", () => {
  let home: string;
  let repoRoot: string;
  let agentId:string;
  let knowledgeRoot:string;
  let connection: DataConnection<typeof schema>;
  // The signed-in account; inside its Agent it acts as the owner user.
  let account: { id: string; displayName: string };
  let ownerUserId: string;
  let accessTokenService: AccessTokenService;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "luna-workspace-home-"));
    repoRoot = mkdtempSync(join(tmpdir(), "luna-workspace-repo-"));
    mkdirSync(join(home, "data"), { recursive: true });


    setLunaHome(home);
    connection = new DataConnection(schema);
    account = { id: "writer", displayName: "Writer" };
    const scope=fixtureScope(connection.db,account.id);agentId=scope.agentId;ownerUserId=scope.ownerUserId;
    knowledgeRoot=createKnowledgeWorkspaceRepository(repoRoot,agentId).root;
    mkdirSync(join(knowledgeRoot, "wiki/domains"), { recursive: true });
    mkdirSync(join(knowledgeRoot, "archive"), { recursive: true });
    writeFileSync(
      join(knowledgeRoot, "wiki/domains/playback.md"),
      "# Playback\nSearchable\n首帧体验\n起播速度\n",
    );
    git(knowledgeRoot, ["init"]);
    git(knowledgeRoot, ["config", "user.email", "test@example.com"]);
    git(knowledgeRoot, ["config", "user.name", "Test User"]);
    git(knowledgeRoot, ["add", "."]);
    git(knowledgeRoot, ["commit", "-m", "seed"]);
    accessTokenService = new AccessTokenService({
      db: connection.db,
      signingSecret: "test-workspace-access-token-secret",
    });
    app = new Hono()
      .use("*", authenticateTestUser(account, issueClaims()))
      .route("/api/workspaces", createWorkspaceRoutes({ db: connection.db, serviceHome:repoRoot }));
  });

  afterEach(() => {
    connection.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("directory API returns immediate children and applies read authorization before discovery", async () => {
    const path = `/api/workspaces/knowledge/directory?agentId=${agentId}`;
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: "", entries: [
      { type: "directory", path: "archive", name: "archive" },
      { type: "directory", path: "wiki", name: "wiki" },
    ] });
    const child = await app.request(path + "&path=wiki");
    expect(await child.json()).toMatchObject({ entries: [{ type: "directory", path: "wiki/domains" }] });
    expect((await app.request(path + "&path=../")).status).toBe(400);
    expect((await app.request(path + "&path=wiki/missing")).status).toBe(404);
    expect((await app.request(path + "&path=wiki/domains/playback.md")).status).toBe(404);
    grant("workspace.knowledge.read", "deny");
    expect((await app.request(path)).status).toBe(403);
  });

  test("search returns filename hits from unopened folders separately from content matches", async () => {
    const response = await app.request(`/api/workspaces/knowledge/grep?agentId=${agentId}&query=playback&includeFileNames=true`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fileMatches: [expect.objectContaining({ path: "wiki/domains/playback.md" })] });
  });

  test("an explicit read denial applies to the Agent owner", async () => {
    grant("workspace.knowledge.read", "deny");
    const denied = await app.request(`/api/workspaces/knowledge/file?path=wiki/domains/playback.md&agentId=${agentId}`);
    expect(denied.status).toBe(403);

    removeDenial("workspace.knowledge.read");
    const allowed = await app.request(`/api/workspaces/knowledge/file?path=wiki/domains/playback.md&agentId=${agentId}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      path: "wiki/domains/playback.md",
      content: "# Playback\nSearchable\n首帧体验\n起播速度\n",
    });
  });

  test("workspace access uses token identity and current DB grants", async () => {
    const tokenIdentityApp = appWithClaims(issueClaims());
    grant("workspace.knowledge.read", "deny");
    const denied = await tokenIdentityApp.request(
      `/api/workspaces/knowledge/file?path=wiki/domains/playback.md&agentId=${agentId}`,
    );
    expect(denied.status).toBe(403);

    removeDenial("workspace.knowledge.read");
    const allowed = await tokenIdentityApp.request(
      `/api/workspaces/knowledge/file?path=wiki/domains/playback.md&agentId=${agentId}`,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      path: "wiki/domains/playback.md",
    });
  });

  test("dashboard cookie session can access workspace with DB grant and no access-token claims", async () => {
    grant("workspace.knowledge.read");
    const auth = new DashboardAuthService({
      provider: dashboardProvider(account),
      sessionSecret: "workspace-cookie-session-secret",
    });
    const login = await auth.login("dashboard-token");
    expect(login).not.toBeNull();
    const cookieApp = new Hono()
      .use("*", createDashboardAuthMiddleware(auth, { db: connection.db }))
      .route(
        "/api/workspaces",
        createWorkspaceRoutes({ db: connection.db, serviceHome:repoRoot }),
      );

    const response = await cookieApp.request(
      `/api/workspaces/knowledge/file?path=wiki/domains/playback.md&agentId=${agentId}`,
      {
        headers: {
          cookie: `luna_dashboard_session=${login!.sessionToken}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: "wiki/domains/playback.md",
      content: "# Playback\nSearchable\n首帧体验\n起播速度\n",
    });
  });

  test("write and Git commit honor separate operation rules", async () => {
    grant("workspace.knowledge.read");
    grant("workspace.knowledge.write");

    const writeResponse = await app.request(`/api/workspaces/knowledge/file?agentId=${agentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "archive/seed.md", content: "# Seed\n" }),
    });
    expect(writeResponse.status).toBe(200);
    expect(readFileSync(join(knowledgeRoot, "archive/seed.md"), "utf8")).toBe("# Seed\n");

    grant("workspace.knowledge.git.commit", "deny");
    const deniedCommit = await app.request(`/api/workspaces/knowledge/git/commit?agentId=${agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "docs: add seed" }),
    });
    expect(deniedCommit.status).toBe(403);

    removeDenial("workspace.knowledge.git.commit");
    const commitResponse = await app.request(`/api/workspaces/knowledge/git/commit?agentId=${agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "docs: add seed" }),
    });
    expect(commitResponse.status).toBe(200);
    expect(await commitResponse.json()).toMatchObject({ status: "committed" });
  });

  test("glob grep status and diff use the managed workspace", async () => {
    grant("workspace.knowledge.read");
    grant("workspace.knowledge.write");
    await app.request(`/api/workspaces/knowledge/file?agentId=${agentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "archive/seed.md", content: "# Seed\n" }),
    });

    const glob = await app.request(`/api/workspaces/knowledge/glob?pattern=wiki/**/*.md&agentId=${agentId}`);
    const grep = await app.request(`/api/workspaces/knowledge/grep?query=Searchable&glob=wiki/**/*.md&agentId=${agentId}`);
    const regexGrep = await app.request(
      `/api/workspaces/knowledge/grep?query=%E9%A6%96%E5%B8%A7%7C%E8%B5%B7%E6%92%AD&mode=regex&glob=wiki/**/*.md&agentId=${agentId}`,
    );
    const multiGrep = await app.request(
      `/api/workspaces/knowledge/grep?queries=%E9%A6%96%E5%B8%A7&queries=%E8%B5%B7%E6%92%AD&match=any&glob=wiki/**/*.md&agentId=${agentId}`,
    );
    const status = await app.request(`/api/workspaces/knowledge/git/status?agentId=${agentId}`);
    const diff = await app.request(`/api/workspaces/knowledge/git/diff?agentId=${agentId}`);

    expect(await glob.json()).toMatchObject({
      entries: [expect.objectContaining({ path: "wiki/domains/playback.md" })],
    });
    expect(await grep.json()).toMatchObject({
      matches: [expect.objectContaining({ path: "wiki/domains/playback.md", line: 2 })],
    });
    expect(await regexGrep.json()).toMatchObject({
      matches: [
        expect.objectContaining({ path: "wiki/domains/playback.md", text: "首帧体验" }),
        expect.objectContaining({ path: "wiki/domains/playback.md", text: "起播速度" }),
      ],
    });
    expect(await multiGrep.json()).toMatchObject({
      matches: [
        expect.objectContaining({ path: "wiki/domains/playback.md", text: "首帧体验" }),
        expect.objectContaining({ path: "wiki/domains/playback.md", text: "起播速度" }),
      ],
    });
    expect(await status.json()).toMatchObject({
      entries: [expect.objectContaining({ path: "archive/seed.md" })],
    });
    expect(await diff.json()).toMatchObject({
      diff: expect.stringContaining("archive/seed.md"),
    });
  });

  test("rejects unknown workspace and missing authenticated user", async () => {
    grant("workspace.knowledge.read");
    expect((await app.request(`/api/workspaces/memory/glob?pattern=**/*&agentId=${agentId}`)).status).toBe(404);

    const unauthenticated = new Hono().route(
      "/api/workspaces",
      createWorkspaceRoutes({ db: connection.db, serviceHome:repoRoot }),
    );
    expect((await unauthenticated.request(`/api/workspaces/knowledge/glob?pattern=**/*&agentId=${agentId}`)).status)
      .toBe(401);
  });

  function grant(operationId: string, effect: "allow" | "deny" = "allow"): void {
    new AuthorizationRuleStore(connection.db,{kind:"agent",agentId}).addGrant({ matchType: "exact",
      subjectType: "user",
      subjectId: ownerUserId,
      target: operationId,
      effect,
    });
  }

  function removeDenial(operationId: string): void {
    const rules = new AuthorizationRuleStore(connection.db, {kind:"agent", agentId});
    const denial = rules.listGrants().find(rule => rule.target === operationId && rule.effect === "deny");
    if (denial) rules.deleteGrant(denial.id);
  }

  function issueClaims(): LunaAccessTokenClaims {
    return accessTokenService.issueToken({
      accountId: account.id,
      name: "Workspace route test token",
      source: "cli",
      role: "user",
      ttlMs: 60 * 60 * 1000,
      now: 1000,
    }).claims;
  }

  function appWithClaims(claims: LunaAccessTokenClaims): Hono {
    return new Hono()
      .use("*", authenticateTestUser(account, claims))
      .route(
        "/api/workspaces",
        createWorkspaceRoutes({ db: connection.db, serviceHome:repoRoot }),
      );
  }
});

function authenticateTestUser(
  account: { readonly id: string; readonly displayName: string },
  claims: LunaAccessTokenClaims,
): MiddlewareHandler {
  return async (c, next) => {
    c.set("dashboardAuthSession", {
      authenticated: true,
      account: {
        id: account.id,
        name: account.displayName,
        provider: "test-access-token",
      },
    });
    c.set("lunaRequestAuthKind","luna-access-token");
    c.set("lunaAccessTokenClaims", claims);
    await next();
  };
}

function dashboardProvider(
  account: { readonly id: string; readonly displayName: string },
): DashboardAuthProvider {
  return {
    id: "test-dashboard",
    async authenticateToken(token: string) {
      return token === "dashboard-token"
        ? {
            id: account.id,
            name: account.displayName,
            provider: "test-dashboard",
          }
        : null;
    },
  };
}
