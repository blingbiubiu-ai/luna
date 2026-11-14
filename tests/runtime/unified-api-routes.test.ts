import {fixtureTaskOwnership} from "../helpers/platform-fixtures";
import { fixtureAgent, fixtureNamedSession, fixturePlatformAdmin, fixtureScope, fixtureSessionOwnership } from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";
import { TaskRunStore } from "../../src/tasks/task-run-store";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { listOperationSuggestions } from "../../src/operations/operation-registry";
import { registerFixtureOperations } from "../helpers/operation-fixtures";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import {
  authorizationRules,
  users,
} from "../../src/data/schema";
import { IdentityDirectory } from "../../src/identity/identity-directory";
import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";
import {
  artifactRef,
  parseArtifactRef,
  rewriteArtifactRefsInValue,
  scanArtifactRefs,
} from "@luna/service-client/artifact-ref";
import { signDashboardArtifactReferencesInValue } from "../../src/dashboard-api/local-paths";
import {
  AccessTokenService,
  type LunaAccessTokenClaims,
} from "../../src/server/auth/access-token-service";
import {
  createDashboardAuthMiddleware,
  DashboardAuthService,
} from "../../src/server/auth";
import { GroupStore } from "../../src/server/groups/group-store";
import { evaluateOperationPolicy } from "../../src/server/policy/operation-policy";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { agentRoutes } from "../../src/server/routes/agent";
import { AgentStore } from "../../src/agents/agent-store";
import { AgentLifecycleStore } from "../../src/agents/agent-lifecycle-store";
import { createPlatformAgentRoutes } from "../../src/server/routes/platform-agents";
import { createAuthRoutes } from "../../src/server/routes/auth";
import { signedArtifactPreviewUrl } from "../../src/server/artifact-content-url";
import { createArtifactsRoutes } from "../../src/server/routes/artifacts";
import { createOperationsRoutes } from "../../src/server/routes/operations";
import { createOperationGrantsRoutes } from "../../src/server/routes/authorization-rules";
import { createGroupsRoutes } from "../../src/server/routes/groups";
import { createPluginsRoutes } from "../../src/server/routes/plugins";
import { createSessionsRoutes } from "../../src/server/routes/sessions";
import { createTasksRoutes } from "../../src/server/routes/tasks";
import { createWorkspaceRoutes } from "../../src/server/routes/workspaces";
import { createUsersRoutes } from "../../src/server/routes/users";
import { HonoServer } from "../../src/server/server";
import { MessageStore } from "../../src/sessions/message-store";
import { SessionStore } from "../../src/sessions/session-store";
import { SessionTimelineStore } from "../../src/sessions/session-timeline-store";
import { ContextPackStore } from "../../src/context";
import { config, reloadConfig, setLunaHome } from "../../src/shared";

const TEST_ACCESS_TOKEN_SECRET = "test-luna-access-token-secret";
const TEST_DASHBOARD_TOKEN = "test-luna-dashboard-token";

describe("artifact refs", () => {
  test("formats and parses artifact refs", () => {
    expect(artifactRef("img_123")).toBe("artifact:img_123");
    expect(parseArtifactRef("artifact:img_123")).toBe("img_123");
    expect(parseArtifactRef("workspace/uploads/images/a.jpeg")).toBeUndefined();
  });

  test("scans nested values without local path compatibility", () => {
    expect(
      scanArtifactRefs({
        text: "see ![image](artifact:img_123)",
        blocks: [{ type: "image", url: "artifact:img_456" }],
        old: "workspace/uploads/images/a.jpeg",
      }),
    ).toEqual(["img_123", "img_456"]);
  });

  test("rewrites artifact refs in strings and nested blocks", () => {
    expect(
      rewriteArtifactRefsInValue(
        {
          text: "![image](artifact:img_123)",
          blocks: [{ type: "image", url: "artifact:img_456" }],
        },
        (id) => `/signed/${id}`,
      ),
    ).toEqual({
      text: "![image](/signed/img_123)",
      blocks: [{ type: "image", url: "/signed/img_456" }],
    });
  });

  test("dashboard artifact signing only rewrites refs approved by the signer", () => {
    expect(
      signDashboardArtifactReferencesInValue(
        {
          owned: "![image](artifact:owned-image)",
          other: "![image](artifact:other-image)",
        },
        {
          artifactSigner: {
            previewUrl: (artifactId) =>
              artifactId === "owned-image"
                ? `/preview/${artifactId}`
                : undefined,
            contentUrl: (artifactId) =>
              artifactId === "owned-image"
                ? `/content/${artifactId}`
                : undefined,
          },
        },
      ),
    ).toEqual({
      owned: "![image](/content/owned-image)",
      other: "![image](artifact:other-image)",
    });
  });
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

test("Dashboard owner can read inactive Shadow task history without granting that access to members or tokens", async () => {
  await withFreshDb("luna-task-history-", async ({ db }) => {
    const owner = materializeLocalUser(db, "history-owner");
    const member = materializeLocalUser(db, "history-member");
    const scope = fixtureScope(db, owner.id);
    const agents = new AgentStore(db);
    const shadow = agents.createShadow(owner.id, scope.agentId, { name: "History" }, "history-shadow");
    db.insert(lunaSchema.tasks).values({
      id: "history-task", agent_id: scope.agentId, shadow_id: shadow.id, type: "work", title: "Past work",
      status: "completed", creator_user_id: member.id, created_at: 1, updated_at: 1, last_activity_at: 1,
    }).run();
    const dashboard = (user: typeof owner, claims?: LunaAccessTokenClaims) => new Hono()
      .use("*", authenticateTestUser(user, claims))
      .route("/api/tasks", createTasksRoutes({ db }));
    const ownerApp = dashboard(owner), memberApp = dashboard(member);
    const detail = "/api/tasks/history-task";
    const list = `/api/tasks?agentId=${scope.agentId}`;
    expect((await memberApp.request(detail)).status).toBe(403);
    new AgentLifecycleStore(db).request(owner.id, {agentId: scope.agentId, shadowId: shadow.id}, "disabled", "disable-history-shadow");
    expect((await ownerApp.request(detail)).status).toBe(200);
    expect((await ownerApp.request(detail + "/timeline")).status).toBe(200);
    const ownerList = await ownerApp.request(`${list}&shadowId=${shadow.id}`);
    expect(ownerList.status).toBe(200);
    expect(await ownerList.json()).toEqual(expect.arrayContaining([expect.objectContaining({id: "history-task"})]));
    expect((await memberApp.request(detail)).status).toBe(403);
    expect((await memberApp.request(list)).status).toBe(403);
    expect((await dashboard(owner, defaultClaims()).request(detail)).status).toBe(403);
  });
});

describe("unified API namespaces", () => {
  test("exposes agent, knowledge, plugins, groups, and typed grant routes", async () => {
    await withFreshDb("luna-api-namespaces-", async ({ db }) => {
      const admin = materializeLocalUser(db, "dashboard-admin");
      const {id: agentId} = fixtureAgent(db, admin.id);
      const app = new Hono()
        .use("*", authenticateTestAdmin(db, admin))
        .route("/api/agent", agentRoutes)
        .route("/api/plugins", createPluginsRoutes({ db }))
        .route("/api/groups", createGroupsRoutes({ db }))
        .route("/api/authorization-rules", createOperationGrantsRoutes({ db }))
        .route("/api/workspaces", createWorkspaceRoutes({ db }));

      expect((await app.request("/api/agent/skills")).status).not.toBe(404);
      expect((await app.request("/api/workspaces/knowledge/glob?pattern=wiki/**/*.md")).status).not.toBe(404);
      expect((await app.request("/api/knowledge/page?path=wiki/index.md")).status).toBe(404);
      expect((await app.request("/api/legacy-plugin/operations")).status).toBe(404);
      expect(
        (
          await app.request("/api/plugins/commands/resolve-and-invoke", {
            method: "POST",
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(400);
      expect((await app.request(`/api/groups?agentId=${agentId}`)).status).toBe(200);
      expect((await app.request(`/api/agent/groups?agentId=${agentId}`)).status).toBe(404);
      expect((await app.request(`/api/agent/users?agentId=${agentId}`)).status).toBe(404);
      expect((await app.request("/api/authorization-rules")).status).toBe(200);
      expect((await app.request("/api/workspaces/knowledge/glob?pattern=wiki/**/*.md")).status).not.toBe(404);
      expect((await app.request("/api/principals")).status).toBe(404);
    });
  });

  test("signed LUNA_ACCESS_TOKEN authenticates API requests as token user without admin access", async () => {
    const previousProcessSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunSecret = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-access-token-api-", async ({ db }) => {
        const user = materializeLocalUser(db, "access-token-user");
        const token = issueAccessToken(db, user).token;
        const server = new HonoServer({ db });

        const me = await server.app.fetch(
          new Request("http://luna.test/api/auth/me", {
            headers: { authorization: `Bearer ${token}` },
          }),
        );

        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({
          status: "ok",
          authenticated: true,
          authKind: "luna-access-token",
          user: { id: user.id },
          token: { source: "cli", role: "user" },
        });

        const adminOnly = await server.app.fetch(
          new Request("http://luna.test/api/users", {
            headers: { authorization: `Bearer ${token}` },
          }),
        );

        expect(adminOnly.status).toBe(403);
        expect(await adminOnly.json()).toMatchObject({
          status: "error",
          code: "dashboard_session_required",
        });
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousProcessSecret, previousBunSecret);
    }
  });

  test("literal luna-local-service bearer is rejected", async () => {
    await withFreshDb("luna-local-service-rejected-", async ({ db }) => {
      const server = new HonoServer({ db });
      const rejected = await server.app.fetch(
        new Request("http://luna.test/api/workspaces/knowledge/glob?pattern=wiki/**/*.md", {
          headers: { authorization: "Bearer luna-local-service" },
        }),
      );
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({
        status: "error",
        code: "unauthorized",
        message: "authentication required",
      });
    });
  });

  test("HonoServer injected DB keeps users and groups isolated per server", async () => {
    const previousProcessSecret = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunSecret = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousHome = config.paths.home;
    const firstHome = mkdtempSync(join(tmpdir(), "luna-server-db-first-"));
    const secondHome = mkdtempSync(join(tmpdir(), "luna-server-db-second-"));
    mkdirSync(join(firstHome, "data"), { recursive: true });
    mkdirSync(join(secondHome, "data"), { recursive: true });
    let firstDatabase: DataConnection<typeof lunaSchema> | undefined;
    let secondDatabase: DataConnection<typeof lunaSchema> | undefined;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      setLunaHome(firstHome);
      firstDatabase = new DataConnection(lunaSchema);
      const firstUser = materializeLocalUser(firstDatabase.db, "first-user");
      fixturePlatformAdmin(firstDatabase.db, "local-dashboard-user");
      const firstAgent = fixtureAgent(firstDatabase.db, "local-dashboard-user");
      const firstGroups = new GroupStore(firstDatabase.db);
      const firstGroup = firstGroups.createGroup({
        agentId: firstAgent.id,
        slug: "first_group",
        displayName: "First Group",
      });
      firstGroups.addMember({groupId: firstGroup.id, userId: firstUser.id, role: "member"});

      setLunaHome(secondHome);
      secondDatabase = new DataConnection(lunaSchema);
      const secondUser = materializeLocalUser(secondDatabase.db, "second-user");
      fixturePlatformAdmin(secondDatabase.db, "local-dashboard-user");
      const secondAgent = fixtureAgent(secondDatabase.db, "local-dashboard-user");
      const secondGroups = new GroupStore(secondDatabase.db);
      const secondGroup = secondGroups.createGroup({
        agentId: secondAgent.id,
        slug: "second_group",
        displayName: "Second Group",
      });
      secondGroups.addMember({groupId: secondGroup.id, userId: secondUser.id, role: "member"});

      const firstServer = new HonoServer({ db: firstDatabase.db });
      const secondServer = new HonoServer({ db: secondDatabase.db });
      const firstAuthHeaders = {
        cookie: await dashboardCookieFromServer(firstServer),
      };
      const secondAuthHeaders = {
        cookie: await dashboardCookieFromServer(secondServer),
      };

      expect(await jsonFrom(firstServer, `/api/users?agentId=${firstAgent.id}`, firstAuthHeaders)).toMatchObject({
        users: expect.arrayContaining([expect.objectContaining({ id: firstUser.id })]),
      });
      expect(await jsonFrom(secondServer, `/api/users?agentId=${secondAgent.id}`, secondAuthHeaders)).toMatchObject({
        users: expect.arrayContaining([expect.objectContaining({ id: secondUser.id })]),
      });
      expect(await jsonFrom(firstServer, `/api/groups?agentId=${firstAgent.id}`, firstAuthHeaders)).toMatchObject({
        groups: expect.arrayContaining([expect.objectContaining({ displayName: "First Group" })]),
      });
      expect(await jsonFrom(secondServer, `/api/groups?agentId=${secondAgent.id}`, secondAuthHeaders)).toMatchObject({
        groups: expect.arrayContaining([expect.objectContaining({ displayName: "Second Group" })]),
      });
    } finally {
      setLunaHome(previousHome);
      firstDatabase?.close();
      secondDatabase?.close();
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousProcessSecret, previousBunSecret);
      rmSync(firstHome, { recursive: true, force: true });
      rmSync(secondHome, { recursive: true, force: true });
    }
  });

  test("builtin operation suggestions are available without persisted definitions", async () => {
    await withFreshDb("luna-operations-", async ({ db }) => {
      const rows = listOperationSuggestions(db);

      expect(rows.map((row) => row.id)).toContain(
        "workspace.knowledge.read",
      );
      expect(rows.map((row) => row.id)).not.toContain("knowledge.page.read");
      expect(rows.map((row) => row.id)).toContain("workspace.knowledge.write");
      expect(rows.map((row) => row.id)).not.toContain("knowledge.page.write");
      expect(
        rows.find((row) => row.id === "workspace.knowledge.read"),
      ).toMatchObject({
        namespace: "workspace",
        operationKind: "read",
        riskLevel: "low",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user", "group"],
      });
    });
  });

  test("restart preserves authorization rules independently of loaded operations", async () => {
    await withFreshDb("luna-operation-cleanup-", async ({ connection, db }) => {
      const now = String(Date.now());
      registerFixtureOperations(db, {
        id: "custom.internal.read",
        namespace: "custom",
        operationKind: "read",
        riskLevel: "low",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user"],
        constraintsSchemaJson: null,
        metadataJson: { label: "Custom internal read" },
        createdAt: now,
        updatedAt: now,
      });
      db.insert(authorizationRules).values([
        { matchType: "exact", scopeType: "agent", agentId: fixtureAgent(db).id,
          id: "custom-grant",
          subjectType: "user",
          subjectId: "user-1",
          target: "custom.internal.read",
          effect: "allow",

          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        },
        { matchType: "exact", scopeType: "agent", agentId: fixtureAgent(db).id,
          id: "stale-grant",
          subjectType: "user",
          subjectId: "user-1",
          target: "missing.operation",
          effect: "allow",

          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ]).run();

      connection.close();
      const reopened = new DataConnection(lunaSchema);
      try {
        const remaining = reopened.db.select().from(authorizationRules).all();
        expect(remaining.map((row) => row.id)).toEqual(["custom-grant", "stale-grant"]);
      } finally {
        reopened.close();
      }
    });
  });

  test("operation routes list registry and filter by namespace", async () => {
    await withFreshDb("luna-operation-routes-", async ({ db }) => {
      const admin = materializeLocalUser(db, "dashboard-admin");
      const app = new Hono()
        .use("*", authenticateTestAdmin(db, admin))
        .route(
          "/api/operations",
          createOperationsRoutes({ db }),
        );

      const all = await app.request("/api/operations");
      const workspace = await app.request("/api/operations?namespace=workspace");
      const missing = await app.request("/api/operations/missing.operation");

      expect(all.status).toBe(200);
      expect(await all.json()).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            id: "workspace.knowledge.read",
            allowedSubjectTypes: ["user", "group"],
          }),
        ]),
      });
      expect(
        ((await workspace.json()) as { operations: Array<{ namespace: string }> })
          .operations.every((item) => item.namespace === "workspace"),
      ).toBe(true);
      expect(missing.status).toBe(404);
    });
  });

  test("group and operation grant stores resolve indirect group grants", async () => {
    await withFreshDb("luna-subject-grants-", async ({ db }) => {
      const user = materializeLocalUser(db, "granted-user");
      const groups = new GroupStore(db);
      const agentId = fixtureAgent(db, user.id).id;
      const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId});
      const group = groups.createGroup({
        agentId,
        slug: "workspace_readers",
        displayName: "Workspace Readers",
      });
      groups.addMember({ groupId: group.id, userId: user.id, role: "member" });
      grants.addGrant({ matchType: "exact",
        subjectType: "group",
        subjectId: group.id,
        target: "workspace.knowledge.read",
        effect: "allow",
      });

      expect(groups.listGroups(agentId)[0]).toMatchObject({
        slug: "workspace_readers",
        memberCount: 1,
      });
      expect(grants.getEffectiveGrantsForUser(user.id)).toEqual([
        expect.objectContaining({
          subjectType: "group",
          subjectId: group.id,
          target: "workspace.knowledge.read",
        }),
      ]);
      expect(grants.getIndirectGrantsForUser(user.id)).toEqual([
        expect.objectContaining({
          subjectType: "group",
          subjectId: group.id,
          target: "workspace.knowledge.read",
        }),
      ]);
    });
  });

  test("operation grant store updates duplicate grants and excludes inactive subjects", async () => {
    await withFreshDb("luna-subject-grants-update-", async ({ db }) => {
      const activeUser = materializeLocalUser(db, "active-user");
      const inactiveUser = materializeLocalUser(db, "inactive-user");
      const agentId = fixtureAgent(db, activeUser.id).id;
      const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId});
      const first = grants.addGrant({ matchType: "exact",
        subjectType: "user",
        subjectId: activeUser.id,
        target: "workspace.knowledge.read",
        effect: "allow",

      });
      const second = grants.addGrant({ matchType: "exact",
        subjectType: "user",
        subjectId: activeUser.id,
        target: "workspace.knowledge.read",
        effect: "allow",

      });
      grants.addGrant({ matchType: "exact",
        subjectType: "user",
        subjectId: inactiveUser.id,
        target: "workspace.knowledge.read",
        effect: "allow",
      });

      db.update(users).set({status: "disabled"}).where(eq(users.id, inactiveUser.id)).run();
      expect(second.id).toBe(first.id);
      expect(
        grants.getEffectiveGrantsForUser(activeUser.id)[0]?.id,
      ).toEqual(first.id);
      expect(grants.getEffectiveGrantsForUser(inactiveUser.id)).toEqual([]);
    });
  });

  test("operation policy engine allows matching grants and denies missing grants", async () => {
    await withFreshDb("luna-policy-engine-", async ({ db }) => {
      const user = materializeLocalUser(db, "policy-user");
      const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId: fixtureAgent(db, user.id).id});
      grants.addGrant({ matchType: "exact",
        subjectType: "user",
        subjectId: user.id,
        target: "workspace.knowledge.read",
        effect: "allow",

      });
      const operation = {
        id: "workspace.knowledge.read",
        namespace: "workspace",
        operationKind: "read",
        riskLevel: "low",
        defaultDecision: "deny",
        allowedSubjectTypes: ["user", "group"],
      } as const;

      expect(
        evaluateOperationPolicy({
          grants: grants.getEffectiveGrantsForUser(user.id),
          operation,
        }),
      ).toMatchObject({
        decision: "allow",
        matchedRule: "allow_rule_match",
      });
      expect(
        evaluateOperationPolicy({
          grants: [],
          operation,
        }),
      ).toMatchObject({
        decision: "forbidden",
        matchedRule: "operation_default",
      });
      expect(
        evaluateOperationPolicy({
          grants: grants.getEffectiveGrantsForUser(user.id),
          operation,
        }),
      ).toMatchObject({
        decision: "allow",
        matchedRule: "allow_rule_match",
      });
    });
  });

  test("groups, users, and typed grant API expose the new authorization model", async () => {
    await withFreshDb("luna-group-routes-", async ({ db }) => {
      const user = materializeLocalUser(db, "api-user");
      const admin = materializeLocalUser(db, "dashboard-admin");
      const agentId = fixtureAgent(db, admin.id).id;
      const app = new Hono()
        .use("*", authenticateTestAdmin(db, admin))
        .route("/api/users", createUsersRoutes({ db }))
        .route("/api/groups", createGroupsRoutes({ db }))
        .route("/api/agents", createPlatformAgentRoutes(db));

      const created = await app.request("/api/groups", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          slug: "wukong_android",
          displayName: "Wukong Android",
        }),
      });
      expect(created.status).toBe(200);
      const group = ((await created.json()) as { group: { id: string } }).group;

      const otherOwner = materializeLocalUser(db, "other-group-owner");
      const otherAgent = fixtureAgent(db, otherOwner.id);
      const otherGroup = new GroupStore(db).createGroup({
        agentId: otherAgent.id,
        slug: "other_group",
        displayName: "Other Group",
      });
      const ordinaryOwner = new Hono()
        .use("*", authenticateTestUser(otherOwner))
        .route("/api/groups", createGroupsRoutes({db}));

      for (const path of ["/api/groups", `/api/groups/${group.id}`, `/api/groups/${group.id}/members`]) {
        expect((await app.request(path)).status).toBe(400);
      }
      const ownScope = `?agentId=${otherAgent.id}`;
      expect(await (await ordinaryOwner.request("/api/groups" + ownScope)).json()).toMatchObject({
        canManageGroups: false,
        groups: [expect.objectContaining({id: otherGroup.id})],
      });
      for (const suffix of ["", "/members"]) {
        expect((await ordinaryOwner.request(`/api/groups/${otherGroup.id}${suffix}${ownScope}`)).status).toBe(200);
        expect((await app.request(`/api/groups/${otherGroup.id}${suffix}?agentId=${agentId}`)).status).toBe(404);
        expect((await app.request(`/api/groups/${otherGroup.id}${suffix}${ownScope}`)).status).toBe(403);
      }
      expect((await app.request(`/api/groups/${otherGroup.id}`, {method: "PATCH"})).status).toBe(403);
      expect((await ordinaryOwner.request(`/api/groups/${otherGroup.id}`, {method: "PATCH"})).status).toBe(403);
      expect((await app.request(`/api/users/${user.id}/group-memberships`, {
        method: "POST",
        body: JSON.stringify({groupId: otherGroup.id}),
      })).status).toBe(403);

      const membership = await app.request(`/api/users/${user.id}/group-memberships`, {
        method: "POST",
        body: JSON.stringify({ groupId: group.id }),
      });
      expect(membership.status).toBe(200);

      const grant = await app.request(`/api/agents/${agentId}/authorization-rules`, {
        method: "POST",
        body: JSON.stringify({ matchType: "exact",
          subjectType: "group",
          subjectId: group.id,
          target: "workspace.knowledge.read",
          effect: "allow",
        }),
      });
      expect(grant.status).toBe(201);
      expect(await grant.json()).toMatchObject({
        grant: {
          subjectType: "group",
          subjectId: group.id,
          target: "workspace.knowledge.read",
        },
      });

      const userDetail = await app.request(`/api/users/${user.id}?agentId=${agentId}`);
      expect(await userDetail.json()).toMatchObject({
        id: user.id,
        groups: [expect.objectContaining({ id: group.id })],
        directGrants: [],
        indirectGrants: [expect.objectContaining({subjectId: group.id, target: "workspace.knowledge.read"})],
      });

      const scopedRules = new AuthorizationRuleStore(db, {kind: "agent", agentId});
      expect(scopedRules.getIndirectGrantsForUser(user.id)).toEqual([
        expect.objectContaining({ subjectType: "group", subjectId: group.id, target: "workspace.knowledge.read" }),
      ]);
      const invalidRule = await app.request(`/api/agents/${agentId}/authorization-rules`, {
        method: "POST",
        body: JSON.stringify({ matchType: "exact", subjectType: "user", subjectId: user.id, target: "workspace.*", effect: "allow" }),
      });
      expect(invalidRule.status).toBe(400);
      expect(scopedRules.listGrants()).toHaveLength(1);

      const removedFromGroup = await app.request(
        `/api/groups/${group.id}/members/${user.id}`,
        { method: "DELETE" },
      );
      expect(removedFromGroup.status).toBe(200);
      expect(await removedFromGroup.json()).toMatchObject({
        status: "ok",
        member: expect.objectContaining({
          groupId: group.id,
          userId: user.id,
        }),
      });
      expect((await app.request(`/api/groups/${group.id}?agentId=${agentId}`)).status).toBe(200);
      const groupAfterRemove = await app.request(`/api/groups/${group.id}?agentId=${agentId}`);
      expect(await groupAfterRemove.json()).toMatchObject({
        group: {
          members: [],
          memberCount: 0,
        },
      });

      await app.request(`/api/users/${user.id}/group-memberships`, {
        method: "POST",
        body: JSON.stringify({ groupId: group.id }),
      });
      const removedFromUser = await app.request(
        `/api/users/${user.id}/group-memberships/${group.id}`,
        { method: "DELETE" },
      );
      expect(removedFromUser.status).toBe(200);
      expect(await removedFromUser.json()).toMatchObject({
        status: "ok",
        membership: expect.objectContaining({
          groupId: group.id,
          userId: user.id,
        }),
      });
      const userAfterRemove = await app.request(`/api/users/${user.id}?agentId=${agentId}`);
      expect(userAfterRemove.status).toBe(404);
      expect(scopedRules.getIndirectGrantsForUser(user.id)).toEqual([]);
      expect((await app.request("/api/principals")).status).toBe(404);
    });
  });

  test("users list only returns active canonical users", async () => {
    await withFreshDb("luna-users-route-", async ({ db }) => {
      const canonical = materializeLocalUser(db, "canonical-user");
      db.insert(users).values({
        id: "merged-user",
        kind: "human",
        displayName: "Merged User",
        avatarUrl: null,
        status: "merged",
        mergedIntoUserId: canonical.id,
        profileSource: "channel",
        createdAt: "1",
        updatedAt: "1",
      }).run();
      db.insert(users).values({
        id: "inactive-user",
        kind: "human",
        displayName: "Inactive User",
        avatarUrl: null,
        status: "inactive",
        mergedIntoUserId: null,
        profileSource: "channel",
        createdAt: "2",
        updatedAt: "2",
      }).run();

      const agent = fixtureAgent(db, canonical.id);
      const app = new Hono()
        .use("*", authenticateTestAdmin(db, canonical))
        .route("/api/users", createUsersRoutes({ db }));

      const response = await app.request(`/api/users?agentId=${agent.id}`);
      expect(response.status).toBe(200);
      const payload = await response.json() as { users: Array<{ id: string }> };
      expect(payload.users).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: canonical.id })]),
      );
      expect(payload.users.some((user) => user.id === "merged-user")).toBe(false);
      expect(payload.users.some((user) => user.id === "inactive-user")).toBe(false);
    });
  });

  test("user detail canonicalizes merged user ids", async () => {
    await withFreshDb("luna-user-detail-", async ({ db }) => {
      const canonical = materializeLocalUser(db, "canonical-user");
      db.insert(users).values({
        id: "merged-user",
        kind: "human",
        displayName: "Merged User",
        avatarUrl: null,
        status: "merged",
        mergedIntoUserId: canonical.id,
        profileSource: "channel",
        createdAt: "1",
        updatedAt: "1",
      }).run();

      const agent = fixtureAgent(db, canonical.id);
      const app = new Hono()
        .use("*", authenticateTestAdmin(db, canonical))
        .route("/api/users", createUsersRoutes({ db }));

      const response = await app.request(`/api/users/merged-user?agentId=${agent.id}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: canonical.id,
        canonicalizedFromUserId: "merged-user",
      });
    });
  });

  test("operation grant API batches grants atomically and deletes direct grants", async () => {
    await withFreshDb("luna-operation-grant-batch-", async ({ db }) => {
      const firstUser = materializeLocalUser(db, "batch-user-a");
      const secondUser = materializeLocalUser(db, "batch-user-b");
      const admin = materializeLocalUser(db, "dashboard-admin");
      const app = new Hono()
        .use("*", authenticateTestAdmin(db, admin))
        .route("/api/users", createUsersRoutes({ db }))
        .route("/api/authorization-rules", createOperationGrantsRoutes({ db }));

      const batch = await app.request("/api/authorization-rules/batch", {
        method: "POST",
        body: JSON.stringify({
          items: [
            { matchType: "exact",
              subjectType: "user",
              subjectId: firstUser.id,
              target: "system.admin",
              effect: "allow",
            },
            { matchType: "exact",
              subjectType: "user",
              subjectId: secondUser.id,
              target: "system.admin",
              effect: "allow",
            },
          ],
        }),
      });
      expect(batch.status).toBe(200);
      const batchBody = await batch.json() as {
        grants: Array<{ id: string; subjectId: string; target: string }>;
      };
      expect(batchBody.grants).toHaveLength(2);
      expect(batchBody.grants.map((grant) => grant.subjectId)).toEqual([
        firstUser.id,
        secondUser.id,
      ]);

      const invalidBatch = await app.request("/api/authorization-rules/batch", {
        method: "POST",
        body: JSON.stringify({
          items: [
            { matchType: "exact",
              subjectType: "user",
              subjectId: firstUser.id,
              target: "system.admin",
              effect: "deny",
            },
            { matchType: "exact",
              subjectType: "user",
              subjectId: secondUser.id,
              target: "workspace.knowledge.write",
              effect: "allow",
            },
          ],
        }),
      });
      expect(invalidBatch.status).toBe(400);
      expect(new AuthorizationRuleStore(db, {kind: "platform"}).listGrants()).not.toContainEqual(
        expect.objectContaining({
          subjectId: firstUser.id,
          target: "system.admin",
          effect: "deny",
        }),
      );

      const deleted = await app.request(
        `/api/authorization-rules/${batchBody.grants[0]!.id}`,
        { method: "DELETE" },
      );
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({
        status: "ok",
        grant: {
          subjectId: firstUser.id,
          target: "system.admin",
        },
      });
      expect(new AuthorizationRuleStore(db, {kind: "platform"}).listGrants()).not.toContainEqual(
        expect.objectContaining({
          id: batchBody.grants[0]!.id,
        }),
      );
    });
  });

  test("legacy knowledge service routes are removed from the service API", async () => {
    const root = mkdtempSync(join(tmpdir(), "luna-knowledge-admin-write-removed-"));
    try {
      mkdirSync(join(root, "knowledge", "wiki"), { recursive: true });
      writeFileSync(
        join(root, "knowledge", "wiki", "new.md"),
        "---\ntitle: New\nsensitivity: internal\n---\n# Old\n",
        "utf-8",
      );
      await withFreshDb("luna-knowledge-admin-write-db-", async ({ db }) => {
        const user = materializeLocalUser(db, "knowledge-admin-writer");
        const app = new Hono()
          .use("*", authenticateTestUser(user, defaultClaims()))
          .route("/api/workspaces", createWorkspaceRoutes({ serviceHome: root, db }));

        new AuthorizationRuleStore(db, {kind: "agent", agentId: fixtureAgent(db, user.id).id}).addGrant({ matchType: "exact",
          subjectType: "user",
          subjectId: user.id,
          target: "workspace.knowledge.write",
          effect: "allow",
        });
        expect((await app.request("/api/knowledge/page?path=wiki/new.md")).status).toBe(404);
        expect((await app.request("/api/knowledge/page/acl", { method: "PUT" })).status).toBe(404);
        expect((await app.request("/api/knowledge/admin/write", { method: "POST" })).status).toBe(404);
        expect(readFileSync(join(root, "knowledge", "wiki", "new.md"), "utf-8")).toContain("# Old\n");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("artifact content signed links are public until expiry and then fall back to owner auth", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-signed-artifact-content-", async ({ db, root }) => {
        const owner = materializeLocalUser(db, "artifact-owner");
        const other = materializeLocalUser(db, "artifact-other");
        const ownerToken = issueAccessToken(db, owner).token;
        const otherToken = issueAccessToken(db, other).token;
        fixtureNamedSession(db, "session-1", owner.id);
        const artifactPath = join(root, "owned-image.png");
        writeFileSync(artifactPath, "image-bytes");
        const row = new ArtifactRegistry(db).registerLocalFile({
          scopeType: "session",
          scopeId: "session-1",
          relatedUserId: owner.id,
          producer: "test",
          kind: "image",
          name: "owned-image.png",
          mimeType: "image/png",
          path: artifactPath,
        });
        let now = 1000;
        const app = new Hono()
          .use(
            "*",
            createDashboardAuthMiddleware(new DashboardAuthService(), { db }),
          )
          .route(
            "/api/artifacts",
            createArtifactsRoutes({
              db,
              now: () => now,
              signedUrlTtlMs: 1,
            }),
          );

        const metadata = await app.request(`/api/artifacts/${row.id}`, {
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        const body = await metadata.json() as {
          artifact: { downloadUrl: string };
        };

        expect(metadata.status).toBe(200);
        expect(body.artifact.downloadUrl).toStartWith(
          `/api/artifacts/${row.id}/content?`,
        );
        expect(body.artifact.downloadUrl).toContain("expires=");
        expect(body.artifact.downloadUrl).toContain("sig=");
        const previewUrl = signedArtifactPreviewUrl({
          artifactId: row.id,
          now,
          ttlMs: 1,
        });
        expect(previewUrl).toStartWith(`/artifacts/${row.id}/preview?`);
        expect(previewUrl).toContain("expires=");
        expect(previewUrl).toContain("sig=");

        const publicContent = await app.request(body.artifact.downloadUrl);

        expect(publicContent.status).toBe(200);
        expect(await publicContent.text()).toBe("image-bytes");

        now = 2000;

        const expiredAnonymous = await app.request(body.artifact.downloadUrl);
        const expiredOwner = await app.request(body.artifact.downloadUrl, {
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        const expiredOther = await app.request(body.artifact.downloadUrl, {
          headers: { authorization: `Bearer ${otherToken}` },
        });

        expect(expiredAnonymous.status).toBe(403);
        expect(expiredOwner.status).toBe(200);
        expect(await expiredOwner.text()).toBe("image-bytes");
        expect(expiredOther.status).toBe(403);
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("artifact content renders browser-previewable formats inline", async () => {
    await withFreshDb("luna-inline-artifact-content-", async ({ db, root }) => {
      const owner = materializeLocalUser(db, "artifact-inline-owner");
      const scope = fixtureScope(db, owner.id);
      const sibling = new AgentStore(db).createShadow(owner.id, scope.agentId, {name: "Foreign Shadow"}, "foreign-shadow");
      createArtifactTask(db, owner.id, "task-inline", scope);
      createArtifactTask(db, owner.id, "task-inline-foreign", {...scope, shadowId: sibling.id});
      const imagePath = join(root, "preview.png");
      const foreignImagePath = join(root, "foreign-preview.png");
      const markdownPath = join(root, "report.md");
      const htmlPath = join(root, "report.html");
      const textPath = join(root, "notes.txt");
      const jsonPath = join(root, "data.json");
      const zipPath = join(root, "archive.zip");
      writeFileSync(imagePath, "image-bytes");
      writeFileSync(foreignImagePath, "foreign-image-bytes");
      writeFileSync(textPath, "plain notes\n");
      writeFileSync(jsonPath, "{\"ok\":true}\n");
      writeFileSync(zipPath, "zip-bytes");
      const registry = new ArtifactRegistry(db);
      const image = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline",
        relatedUserId: owner.id,
        producer: "test",
        kind: "image",
        name: "preview.png",
        mimeType: "image/png",
        path: imagePath,
      });
      const foreignImage = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline-foreign",
        relatedUserId: owner.id,
        producer: "test",
        kind: "image",
        name: "foreign-preview.png",
        mimeType: "image/png",
        path: foreignImagePath,
      });
      writeFileSync(
        markdownPath,
        [
          "# report",
          `检测对象是 \`artifact:${image.id}\`。`,
          `![preview](artifact:${image.id})`,
          `[download](artifact:${image.id})`,
          `foreign artifact:${foreignImage.id}`,
          "",
        ].join("\n"),
      );
      writeFileSync(
        htmlPath,
        `<h1>report</h1><img src="artifact:${image.id}"><a href='artifact:${image.id}'>download</a><a href="artifact:${foreignImage.id}">foreign</a><script>alert(1)</script>\n`,
      );
      const markdown = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline",
        relatedUserId: owner.id,
        producer: "test",
        kind: "file",
        name: "report.md",
        mimeType: "text/markdown",
        path: markdownPath,
      });
      const html = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline",
        relatedUserId: owner.id,
        producer: "test",
        kind: "file",
        name: "report.html",
        mimeType: "text/html",
        path: htmlPath,
      });
      const text = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline",
        relatedUserId: owner.id,
        producer: "test",
        kind: "file",
        name: "notes.txt",
        mimeType: "text/plain; charset=utf-8",
        path: textPath,
      });
      const json = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline",
        relatedUserId: owner.id,
        producer: "test",
        kind: "file",
        name: "data.json",
        mimeType: "application/json",
        path: jsonPath,
      });
      const zip = registry.registerLocalFile({
        scopeType: "task",
        scopeId: "task-inline",
        relatedUserId: owner.id,
        producer: "test",
        kind: "file",
        name: "archive.zip",
        mimeType: "application/zip",
        path: zipPath,
      });
      const app = new Hono()
        .use("*", authenticateTestUser(owner, defaultClaims()))
        .route("/api/artifacts", createArtifactsRoutes({ db }));

      const imageContent = await app.request(`/api/artifacts/${image.id}/content`);
      const markdownContent = await app.request(
        `/api/artifacts/${markdown.id}/content`,
      );
      const apiMarkdownPreview = await app.request(
        `/api/artifacts/${markdown.id}/preview`,
      );
      const htmlContent = await app.request(`/api/artifacts/${html.id}/content`);
      const htmlPreview = await app.request(`/api/artifacts/${html.id}/preview`);
      const textContent = await app.request(`/api/artifacts/${text.id}/content`);
      const jsonContent = await app.request(`/api/artifacts/${json.id}/content`);
      const zipContent = await app.request(`/api/artifacts/${zip.id}/content`);

      expect(imageContent.status).toBe(200);
      expect(imageContent.headers.get("content-type")).toContain("image/png");
      expect(imageContent.headers.get("content-disposition")).toBe(
        'inline; filename="preview.png"',
      );
      expect(markdownContent.status).toBe(200);
      expect(markdownContent.headers.get("content-type")).toBe(
        "text/markdown; charset=utf-8",
      );
      expect(markdownContent.headers.get("content-disposition")).toBe(
        'inline; filename="report.md"',
      );
      const rawMarkdownText = await markdownContent.text();
      expect(rawMarkdownText).toContain(`\`artifact:${image.id}\``);
      expect(rawMarkdownText).toContain(`![preview](artifact:${image.id})`);
      expect(rawMarkdownText).toContain(`[download](artifact:${image.id})`);
      expect(apiMarkdownPreview.status).toBe(200);
      expect(apiMarkdownPreview.headers.get("content-type")).toContain(
        "application/json",
      );
      const markdownPreviewBody = await apiMarkdownPreview.json() as {
        artifact: { renderMode: string; content: string; downloadUrl: string };
      };
      expect(markdownPreviewBody.artifact.renderMode).toBe("markdown");
      expect(markdownPreviewBody.artifact.downloadUrl).toStartWith(
        `/api/artifacts/${markdown.id}/content?`,
      );
      expect(markdownPreviewBody.artifact.content).toContain(
        `![preview](/api/artifacts/${image.id}/content?expires=`,
      );
      expect(markdownPreviewBody.artifact.content).toContain(
        `[download](/artifacts/${image.id}/preview?expires=`,
      );
      expect(markdownPreviewBody.artifact.content).toContain(
        `[artifact:${image.id}](/artifacts/${image.id}/preview?expires=`,
      );
      expect(markdownPreviewBody.artifact.content).toContain(
        `foreign artifact:${foreignImage.id}`,
      );
      expect(htmlContent.status).toBe(200);
      expect(htmlContent.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(htmlContent.headers.get("content-disposition")).toBe(
        'inline; filename="report.html"',
      );
      expect(htmlContent.headers.get("content-security-policy")).toContain(
        "sandbox",
      );
      expect(await htmlContent.text()).toContain(`src="artifact:${image.id}"`);
      expect(htmlPreview.status).toBe(200);
      const htmlPreviewBody = await htmlPreview.json() as {
        artifact: { renderMode: string; content: string };
      };
      expect(htmlPreviewBody.artifact.renderMode).toBe("html");
      expect(htmlPreviewBody.artifact.content).toContain(
        `src="/api/artifacts/${image.id}/content?expires=`,
      );
      expect(htmlPreviewBody.artifact.content).toContain(
        `href='/artifacts/${image.id}/preview?expires=`,
      );
      expect(htmlPreviewBody.artifact.content).toContain(
        `href="artifact:${foreignImage.id}"`,
      );
      expect(textContent.status).toBe(200);
      expect(textContent.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(textContent.headers.get("content-disposition")).toBe(
        'inline; filename="notes.txt"',
      );
      expect(jsonContent.status).toBe(200);
      expect(jsonContent.headers.get("content-disposition")).toBe(
        'inline; filename="data.json"',
      );
      expect(zipContent.status).toBe(200);
      expect(zipContent.headers.get("content-disposition")).toBe(
        'attachment; filename="archive.zip"',
      );
    });
  });

  test("registered artifacts remain readable after the source file is removed", async () => {
    await withFreshDb("luna-managed-artifact-storage-", async ({ db, root }) => {
      const owner = materializeLocalUser(db, "artifact-managed-owner");
      createArtifactTask(db, owner.id, "task-1");
      const artifactPath = join(root, "runner", "result.json");
      mkdirSync(join(root, "runner"), { recursive: true });
      writeFileSync(artifactPath, "{\"ok\":true}\n");
      const row = new ArtifactRegistry(db).registerLocalFile({
        scopeType: "task",
        scopeId: "task-1",
        relatedUserId: owner.id,
        producer: "runner",
        kind: "raw_json",
        name: "result.json",
        mimeType: "application/json; charset=utf-8",
        path: artifactPath,
      });
      unlinkSync(artifactPath);
      const app = new Hono()
        .use("*", authenticateTestUser(owner, defaultClaims()))
        .route("/api/artifacts", createArtifactsRoutes({ db }));

      const content = await app.request(`/api/artifacts/${row.id}/content`);

      expect(content.status).toBe(200);
      expect(await content.text()).toBe("{\"ok\":true}\n");
      expect(existsSync(row.storage_key)).toBe(true);
      expect(row.storage_key).not.toBe(artifactPath);
    });
  });

  test("MCP tokens can register artifacts in an accessible task", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-artifact-create-route-", async ({ db, root }) => {
        const user = materializeLocalUser(db, "artifact-api-user");
        createArtifactTask(db, user.id, "task-api");
        const internalToken = new AccessTokenService({
          db,
          signingSecret: TEST_ACCESS_TOKEN_SECRET,
        }).issueToken({
          userId: user.id,
          name: "internal service token",
          source: "mcp",
          role: "user",
          ttlMs: 60 * 60 * 1000,
          now: Date.now(),
        }).token;
        const userToken = issueAccessToken(db, user).token;
        const artifactPath = join(root, "api-artifact.txt");
        writeFileSync(artifactPath, "api artifact");
        const app = new Hono()
          .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }))
          .route("/api/artifacts", createArtifactsRoutes({ db }));

        const denied = await app.request("/api/artifacts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${userToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            scopeType: "task",
            scopeId: "task-api",
            producer: "test",
            kind: "text",
            name: "api-artifact.txt",
            path: artifactPath,
          }),
        });
        const created = await app.request("/api/artifacts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${internalToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            scopeType: "task",
            scopeId: "task-api",
            relatedUserId: user.id,
            producer: "test",
            kind: "text",
            name: "api-artifact.txt",
            path: artifactPath,
          }),
        });
        const body = await created.json() as {
          artifact: { id: string; downloadUrl: string };
        };

        expect(denied.status).toBe(403);
        expect(created.status).toBe(201);
        expect(body.artifact.downloadUrl).toStartWith(
          `/api/artifacts/${body.artifact.id}/content?`,
        );
        const content = await app.request(body.artifact.downloadUrl);
        expect(await content.text()).toBe("api artifact");
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("dashboard session DTOs only sign artifact refs accessible to the requester", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-dashboard-artifact-signing-", async ({ db, root }) => {
        const owner = materializeLocalUser(db, "dashboard-artifact-owner");
        const other = materializeLocalUser(db, "dashboard-artifact-other");
        fixtureNamedSession(db, "session-dashboard", owner.id);
        fixtureNamedSession(db, "foreign-session", other.id);
        const ownerToken = issueAccessToken(db, owner).token;
        const registry = new ArtifactRegistry(db);
        const ownedPath = join(root, "owned.png");
        const otherPath = join(root, "other.png");
        writeFileSync(ownedPath, "owned");
        writeFileSync(otherPath, "other");
        const owned = registry.registerLocalFile({
          scopeType: "session",
          scopeId: "session-dashboard",
          relatedUserId: owner.id,
          producer: "test",
          kind: "image",
          name: "owned.png",
          path: ownedPath,
        });
        const foreign = registry.registerLocalFile({
          scopeType: "session",
          scopeId: "foreign-session",
          relatedUserId: other.id,
          producer: "test",
          kind: "image",
          name: "other.png",
          path: otherPath,
        });
        fixtureSessionOwnership(db, "feishu", "main", owner.id);
        const session = new SessionStore(db).resolveByChannelSurface({
          channelType: "feishu",
          channelId: "main",
          groupId: "oc_dashboard",
        });
        new MessageStore(db).appendOnce({
          sessionId: session.id,
          channelMessageKey: "om_dashboard_artifacts",
          role: "user",
          channel: { type: "feishu", id: "main" },
          surface: { externalId: "oc_dashboard", kind: "group" },
          sender: { externalId: owner.id, kind: "user" },
          content: [
            {
              type: "text",
              text: `owned artifact:${owned.id} foreign artifact:${foreign.id}`,
            },
          ],
        });
        const app = new Hono()
          .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }))
          .route("/api/sessions", createSessionsRoutes({ db }));

        const response = await app.request(`/api/sessions/${session.id}/messages`, {
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        const body = await response.json() as Array<{ content: Array<{ text: string }> }>;
        const text = body[0]?.content[0]?.text ?? "";

        expect(response.status).toBe(200);
        expect(text).toContain(`/artifacts/${owned.id}/preview?`);
        expect(text).toContain(`artifact:${foreign.id}`);
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("dashboard session DTOs sign visible artifact refs for dashboard sessions", async () => {
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;
    try {
      process.env.LUNA_DASHBOARD_TOKEN = "dashboard-secret";
      Bun.env.LUNA_DASHBOARD_TOKEN = "dashboard-secret";
      await withFreshDb("luna-dashboard-session-artifact-signing-", async ({ db, root }) => {
        const owner = materializeLocalUser(db, "feishu-artifact-owner");
        fixtureNamedSession(db, "session-dashboard-cookie", "local-dashboard-user");
        const registry = new ArtifactRegistry(db);
        const imagePath = join(root, "feishu-owned.png");
        writeFileSync(imagePath, "image-bytes");
        const image = registry.registerLocalFile({
          scopeType: "session",
          scopeId: "session-dashboard-cookie",
          relatedUserId: owner.id,
          producer: "test",
          kind: "image",
          name: "feishu-owned.png",
          path: imagePath,
        });
        fixtureSessionOwnership(db, "feishu", "main", "local-dashboard-user");
        const session = new SessionStore(db).resolveByChannelSurface({
          channelType: "feishu",
          channelId: "main",
          groupId: "oc_dashboard_cookie",
        });
        new MessageStore(db).appendOnce({
          sessionId: session.id,
          channelMessageKey: "om_dashboard_cookie_artifact",
          role: "user",
          channel: { type: "feishu", id: "main" },
          surface: { externalId: "oc_dashboard_cookie", kind: "group" },
          sender: { externalId: owner.id, kind: "user" },
          content: [
            {
              type: "image",
              url: `artifact:${image.id}`,
              alt: "image",
            },
          ],
        });
        const auth = new DashboardAuthService();
        const app = new Hono()
          .route("/api/auth", createAuthRoutes(auth, { db }))
          .use("*", createDashboardAuthMiddleware(auth, { db }))
          .route("/api/sessions", createSessionsRoutes({ db }));
        const login = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "dashboard-secret" }),
        });
        const cookie = login.headers.get("set-cookie") ?? "";
        const response = await app.request(`/api/sessions/${session.id}/messages`, {
          headers: { cookie },
        });
        const body = await response.json() as Array<{
          content: Array<{ url?: string }>;
        }>;
        const url = body[0]?.content[0]?.url ?? "";

        expect(response.status).toBe(200);
        expect(url).toStartWith(`/api/artifacts/${image.id}/content?`);
        expect(url).toContain("expires=");
        expect(url).toContain("sig=");
      });
    } finally {
      restoreEnv("LUNA_DASHBOARD_TOKEN", previousToken, previousBunToken);
    }
  });

  test("default session DTOs expose canonical latest sender users without sender identities", async () => {
    await withFreshDb("luna-session-user-first-routes-", async ({ db }) => {
      const requester = materializeLocalUser(db, "session-requester");
      const admin = materializeLocalUser(db, "session-admin");
      const {agent_id: agentId} = fixtureSessionOwnership(db, "feishu", "main", admin.id);
      const session = new SessionStore(db).resolveByChannelSurface({
        channelType: "feishu",
        channelId: "main",
        groupId: "oc_user_first_session",
      });
      new MessageStore(db).appendOnce({
        sessionId: session.id,
        channelMessageKey: "session-user-first-message",
        senderUserId: requester.id,
        role: "user",
        channel: { type: "feishu", id: "main" },
        surface: { externalId: "oc_user_first_session", kind: "group" },
        content: [{ type: "text", text: "hello session api" }],
      });

      const app = new Hono()
        .use("*", authenticateTestUser(admin))
        .route("/api/sessions", createSessionsRoutes({ db }));

      const response = await app.request(`/api/sessions?agentId=${agentId}`);
      const body = await response.json() as Array<Record<string, unknown>>;
      const first = body[0] ?? {};

      expect(response.status).toBe(200);
      expect(first.latestSenderUserId).toBe(requester.id);
      expect(first.latestSenderUser).toMatchObject({
        id: requester.id,
        displayName: requester.displayName,
      });
      expect("latestSenderIdentity" in first).toBe(false);
    });
  });

  test("default task DTOs expose canonical users for creator, participants, timeline, and source messages", async () => {
    await withFreshDb("luna-task-user-first-routes-", async ({ db }) => {
      const requester = materializeLocalUser(db, "task-requester");
      const admin = materializeLocalUser(db, "task-admin");
      fixtureSessionOwnership(db, "feishu", "main", admin.id);
      const session = new SessionStore(db).resolveByChannelSurface({
        channelType: "feishu",
        channelId: "main",
        groupId: "oc_user_first_task",
      });
      const sourceMessage = new MessageStore(db).appendOnce({
        sessionId: session.id,
        channelMessageKey: "task-source-message",
        senderUserId: requester.id,
        role: "user",
        channel: { type: "feishu", id: "main" },
        surface: { externalId: "oc_user_first_task", kind: "group" },
        content: [{ type: "text", text: "turn this into a task" }],
      }).row;
      const now = Date.now();
      db.insert(lunaSchema.tasks).values({
        id: "task-user-first",
        type: "investigation",
        title: "Task user first",
        summary: "Verify canonical task users",
        status: "open",
        block_reason: null,
        priority: "medium",
        severity: null,
        creator_user_id: requester.id,
        primary_session_id: session.id,
        source_message_id: sourceMessage.id,
        source_entry_id: null,
        context_json: null,
        created_at: now,
        updated_at: now,
        last_activity_at: now, ...fixtureTaskOwnership(db,session.id)}).run();
      db.insert(lunaSchema.taskParticipants).values({
        id: "task-user-first-participant",
        task_id: "task-user-first",
        user_id: requester.id,
        role: "owner",
        created_at: now,
      }).run();
      db.insert(lunaSchema.timelineEvents).values({
        id: "task-user-first-timeline",
        task_id: "task-user-first",
        session_id: session.id,
        message_id: sourceMessage.id,
        actor_user_id: requester.id,
        source_message_id: sourceMessage.id,
        type: "task.created",
        summary: "Task created",
        data: { status: "open" },
        visibility: "visible",
        created_at: now,
      }).run();
      new ContextPackStore(db).appendTaskSourceItem({
        taskId: "task-user-first",
        sessionId: session.id,
        messageId: sourceMessage.id,
        userId: requester.id,
        createdAt: now,
      });

      const app = new Hono()
        .use("*", authenticateTestUser(admin))
        .route("/api/tasks", createTasksRoutes({ db }));

      const response = await app.request("/api/tasks/task-user-first");
      const task = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(task.creatorUserId).toBe(requester.id);
      expect(task.creatorUser).toMatchObject({
        id: requester.id,
        displayName: requester.displayName,
      });
      expect(task.participants).toEqual([
        expect.objectContaining({
          userId: requester.id,
          user: expect.objectContaining({ id: requester.id }),
        }),
      ]);
      expect(task.timeline).toEqual([
        expect.objectContaining({
          actorUserId: requester.id,
        }),
      ]);
      expect(task.sourceMessages).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            senderUserId: requester.id,
            senderUser: expect.objectContaining({ id: requester.id }),
          }),
        }),
      ]);
    });
  });

  test("user detail activity is derived from sender_user_id when no sender identity is present", async () => {
    await withFreshDb("luna-user-activity-user-first-", async ({ db }) => {
      const requester = materializeLocalUser(db, "user-activity-requester");
      const admin = materializeLocalUser(db, "user-activity-admin");
      const {agent_id: agentId} = fixtureSessionOwnership(db, "feishu", "main", admin.id);
      const session = new SessionStore(db).resolveByChannelSurface({
        channelType: "feishu",
        channelId: "main",
        groupId: "oc_user_activity",
      });
      new MessageStore(db).appendOnce({
        sessionId: session.id,
        channelMessageKey: "user-activity-message",
        senderUserId: requester.id,
        role: "user",
        channel: { type: "feishu", id: "main" },
        surface: { externalId: "oc_user_activity", kind: "group" },
        content: [{ type: "text", text: "count me" }],
      });

      const app = new Hono()
        .use("*", authenticateTestAdmin(db, admin))
        .route("/api/users", createUsersRoutes({ db }));

      const response = await app.request(`/api/users/${requester.id}?agentId=${agentId}`);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.messageCount).toBe(1);
      expect(body.sessionCount).toBe(1);
      expect(body.latestSessionId).toBe(session.id);
    });
  });

  test("runner tokens can register artifacts for their own runner scope", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-runner-artifact-register-", async ({ db }) => {
        const user = materializeLocalUser(db, "runner-artifact-register-user");
        createArtifactTask(db, user.id, "task_runner_register");
        const issuedRunnerToken = issueTaskArtifactToken(db, user.id, "task_runner_register", []);
        const runnerToken = issuedRunnerToken.token;
        const app = new Hono()
          .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }))
          .route("/api/artifacts", createArtifactsRoutes({ db }));

        const created = await app.request("/api/artifacts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${runnerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            scopeType: "task",
            scopeId: "task_runner_register",
            producer: "runner",
            kind: "report",
            name: "yellow-content-check.md",
            mimeType: "text/markdown; charset=utf-8",
            contentBase64: Buffer.from("# report").toString("base64"),
          }),
        });
        const spoofed = await app.request("/api/artifacts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${runnerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            scopeType: "task",
            scopeId: "another_task",
            producer: "runner",
            kind: "report",
            name: "spoof.md",
            contentBase64: Buffer.from("# spoof").toString("base64"),
          }),
        });
        const body = await created.json() as {
          artifact: { id: string; downloadUrl: string };
        };
        const artifact = db
          .select()
          .from(lunaSchema.managedArtifacts)
          .where(eq(lunaSchema.managedArtifacts.id, body.artifact.id))
          .get();

        expect(created.status).toBe(201);
        expect(spoofed.status).toBe(403);
        expect(body.artifact.downloadUrl).toBe(`/api/artifacts/${body.artifact.id}/content`);
        expect((await app.request(body.artifact.downloadUrl)).status).toBe(401);
        const runnerHeaders = {authorization: `Bearer ${runnerToken}`};
        const metadata = await app.request(`/api/artifacts/${body.artifact.id}`, {headers: runnerHeaders});
        expect(metadata.status).toBe(200);
        expect(await metadata.json()).toMatchObject({artifact: {downloadUrl: body.artifact.downloadUrl}});
        const preview = await app.request(`/api/artifacts/${body.artifact.id}/preview`, {headers: runnerHeaders});
        expect(preview.status).toBe(200);
        expect(await preview.json()).toMatchObject({artifact: {downloadUrl: body.artifact.downloadUrl, content: "# report"}});
        expect(artifact).toMatchObject({
          scope_type: "task",
          scope_id: "task_runner_register",
          related_user_id: user.id,
          producer: "runner",
          kind: "report",
          name: "yellow-content-check.md",
          mime_type: "text/markdown; charset=utf-8",
        });
        const materialized = await app.request(
          `/api/artifacts/${body.artifact.id}/content`,
          { headers: { authorization: `Bearer ${runnerToken}` } },
        );
        const tokenRow = db
          .select({ metadataJson: lunaSchema.accessTokens.metadataJson })
          .from(lunaSchema.accessTokens)
          .where(eq(lunaSchema.accessTokens.id, issuedRunnerToken.claims.tokenId))
          .get();
        expect(materialized.status).toBe(200);
        expect(await materialized.text()).toBe("# report");
        expect(tokenRow?.metadataJson).toEqual({
          artifactIds: [body.artifact.id],
          invocationId: "artifact-invocation",
          preserved: "runner-metadata",
        });
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("runner tokens can read allowlisted artifacts from a sibling task in the same Shadow", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-runner-artifact-allowlist-", async ({ db, root }) => {
        const user = materializeLocalUser(db, "runner-artifact-user");
        createArtifactTask(db, user.id, "task-allowlist");
        createArtifactTask(db, user.id, "task-allowlist-sibling");
        const allowedPath = join(root, "allowed.txt");
        const deniedPath = join(root, "denied.txt");
        writeFileSync(allowedPath, "allowed");
        writeFileSync(deniedPath, "denied");
        const registry = new ArtifactRegistry(db);
        const allowed = registry.registerLocalFile({
          scopeType: "task",
          scopeId: "task-allowlist-sibling",
          producer: "runner",
          kind: "text",
          name: "allowed.txt",
          path: allowedPath,
        });
        const denied = registry.registerLocalFile({
          scopeType: "task",
          scopeId: "task-allowlist-sibling",
          producer: "runner",
          kind: "text",
          name: "denied.txt",
          path: deniedPath,
        });
        const runnerToken = issueTaskArtifactToken(db, user.id, "task-allowlist", [allowed.id]).token;
        const app = new Hono()
          .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }))
          .route("/api/artifacts", createArtifactsRoutes({ db }));

        const allowedContent = await app.request(
          `/api/artifacts/${allowed.id}/content`,
          { headers: { authorization: `Bearer ${runnerToken}` } },
        );
        const deniedContent = await app.request(
          `/api/artifacts/${denied.id}/content`,
          { headers: { authorization: `Bearer ${runnerToken}` } },
        );

        expect(allowedContent.status).toBe(200);
        expect(await allowedContent.text()).toBe("allowed");
        expect(deniedContent.status).toBe(403);
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("runner ownership and allowlists cannot grant access to another Shadow", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-runner-owned-artifact-", async ({ db, root }) => {
        const user = materializeLocalUser(db, "runner-owned-artifact-user");
        const scope = fixtureScope(db, user.id);
        const sibling = new AgentStore(db).createShadow(user.id, scope.agentId, {name: "Other Shadow"}, "other-shadow");
        createArtifactTask(db, user.id, "task-owned-artifact", scope);
        createArtifactTask(db, user.id, "task-other-artifact", {...scope, shadowId: sibling.id});
        const ownPath = join(root, "own.txt");
        const otherPath = join(root, "other.txt");
        writeFileSync(ownPath, "own");
        writeFileSync(otherPath, "other");
        const registry = new ArtifactRegistry(db);
        const ownArtifact = registry.registerLocalFile({
          scopeType: "task",
          scopeId: "task-owned-artifact",
          relatedUserId: user.id,
          producer: "plugin:diagnosis",
          kind: "text",
          name: "own.txt",
          path: ownPath,
        });
        const otherArtifact = registry.registerLocalFile({
          scopeType: "task",
          scopeId: "task-other-artifact",
          relatedUserId: user.id,
          producer: "plugin:diagnosis",
          kind: "text",
          name: "other.txt",
          path: otherPath,
        });
        const runnerToken = issueTaskArtifactToken(db, user.id, "task-owned-artifact", [otherArtifact.id]).token;
        const app = new Hono()
          .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }))
          .route("/api/artifacts", createArtifactsRoutes({ db }));

        const ownContent = await app.request(
          `/api/artifacts/${ownArtifact.id}/content`,
          { headers: { authorization: `Bearer ${runnerToken}` } },
        );
        const otherContent = await app.request(
          `/api/artifacts/${otherArtifact.id}/content`,
          { headers: { authorization: `Bearer ${runnerToken}` } },
        );

        expect(ownContent.status).toBe(200);
        expect(await ownContent.text()).toBe("own");
        expect(otherContent.status).toBe(403);
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("runner timeline reads are session-bound and grant only returned same-Shadow artifact refs", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-runner-timeline-grants-", async ({ db, root }) => {
        const user = materializeLocalUser(db, "runner-timeline-user");
        fixtureSessionOwnership(db, "feishu", "main", user.id);
        const session = new SessionStore(db).resolveByChannelSurface({
          channelType: "feishu",
          channelId: "main",
          groupId: "oc_runner_timeline",
        });
        const otherSession = new SessionStore(db).resolveByChannelSurface({
          channelType: "feishu",
          channelId: "main",
          groupId: "oc_other_runner_timeline",
        });
        const registry = new ArtifactRegistry(db);
        const artifacts = ["returned", "later", "reference"].map((name) => {
          const path = join(root, `${name}.txt`);
          writeFileSync(path, name);
          return registry.registerLocalFile({
            scopeType: "session",
            scopeId: otherSession.id,
            relatedUserId: materializeLocalUser(db, "artifact-owner").id,
            producer: "test",
            kind: "text",
            name: `${name}.txt`,
            path,
          });
        });
        new MessageStore(db).appendOnce({
          sessionId: session.id,
          channelMessageKey: "om_timeline_returned",
          senderUserId: user.id,
          role: "user",
          channel: { type: "feishu", id: "main" },
          surface: { externalId: "oc_runner_timeline", kind: "group" },
          content: [{ type: "text", text: `artifact:${artifacts[0]!.id}` }],
        });
        const laterMessage = new MessageStore(db).appendOnce({
          sessionId: session.id,
          channelMessageKey: "om_timeline_later",
          senderUserId: user.id,
          role: "user",
          channel: { type: "feishu", id: "main" },
          surface: { externalId: "oc_runner_timeline", kind: "group" },
          content: [{ type: "text", text: `artifact:${artifacts[1]!.id}` }],
        }).row;
        const laterEntry = new SessionTimelineStore(db).appendMessage({
          sessionId: session.id,
          messageId: laterMessage.id,
        });
        const referenceMessage = new MessageStore(db).appendOnce({
          sessionId: otherSession.id,
          channelMessageKey: "om_timeline_reference",
          senderUserId: user.id,
          role: "user",
          channel: { type: "feishu", id: "main" },
          surface: { externalId: "oc_other_runner_timeline", kind: "group" },
          content: [{ type: "image", url: `artifact:${artifacts[2]!.id}` }],
        }).row;
        new SessionTimelineStore(db).appendReference({
          sessionId: session.id,
          messageId: referenceMessage.id,
        });

        const tokenService = new AccessTokenService({
          db,
          signingSecret: TEST_ACCESS_TOKEN_SECRET,
        });
        const runnerContext = new RunnerContextStore(db).resolveForSession(session.id, "codex");
        const ownToken = tokenService.issueToken({
          userId: user.id,
          name: "session runner token",
          source: "runner",
          role: "runner",
          runnerKind: "main",
          sourceSessionId: session.id,
          sourceRunnerJobId: runnerContext.id,
          ttlMs: 60 * 60 * 1000,
          now: Date.now(),
          metadata: {
            invocationId: "timeline-invocation",
            artifactIds: ["existing-grant", "existing-grant"],
            preserved: "timeline-metadata",
          },
        });
        expect(() => tokenService.issueToken({
          userId: user.id,
          name: "unbound runner token",
          source: "runner",
          role: "runner",
          runnerKind: "main",
          ttlMs: 60 * 60 * 1000,
          now: Date.now(),
        })).toThrow("invocation_context_scope_mismatch");
        registerTestRunnerJob(db, "timeline-invocation", ownToken.claims, {
          version: 1, kind: "main",
          input: {
            runnerContext,
            input: { type: "session_trigger", triggerId: "test", instruction: "test", requesterUserId: user.id,
              context: { sessionId: session.id, candidateOpenTasks: [] }, artifactRefs: [],
              sourceSessionId: session.id, correlationId: "test", hops: 0 },
          },
        }, "timeline-invocation");
        const app = new Hono()
          .use("*", createDashboardAuthMiddleware(new DashboardAuthService(), { db }))
          .route("/api/sessions", createSessionsRoutes({ db }))
          .route("/api/artifacts", createArtifactsRoutes({ db }));
        const ownHeaders = { authorization: `Bearer ${ownToken.token}` };

        const before = await Promise.all(
          artifacts.map((artifact) =>
            app.request(`/api/artifacts/${artifact.id}/content`, {
              headers: ownHeaders,
            })
          ),
        );
        expect(before.map((response) => response.status)).toEqual([403, 403, 403]);

        const ownRead = await app.request(
          `/api/sessions/${session.id}/timeline/read?limit=1&includeReferences=false`,
          { headers: ownHeaders },
        );
        const ownBody = await ownRead.json() as {
          entries: Array<{ entryId: string; text: string }>;
        };
        expect(ownRead.status).toBe(200);
        expect(ownBody.entries).toHaveLength(1);
        expect(ownBody.entries[0]).toMatchObject({
          entryId: expect.any(String),
          text: expect.stringContaining(`artifact:${artifacts[0]!.id}`),
        });

        const after = await Promise.all(
          artifacts.map((artifact) =>
            app.request(`/api/artifacts/${artifact.id}/content`, {
              headers: ownHeaders,
            })
          ),
        );
        expect(after.map((response) => response.status)).toEqual([200, 403, 403]);
        expect(await after[0]!.text()).toBe("returned");

        const referenceFilteredRead = await app.request(
          `/api/sessions/${session.id}/timeline/read?afterEntryId=${laterEntry.id}&includeReferences=false`,
          { headers: ownHeaders },
        );
        expect(referenceFilteredRead.status).toBe(200);
        expect(await referenceFilteredRead.json()).toEqual({ entries: [] });
        expect(
          (
            await app.request(`/api/artifacts/${artifacts[2]!.id}/content`, {
              headers: ownHeaders,
            })
          ).status,
        ).toBe(403);

        const otherRead = await app.request(
          `/api/sessions/${otherSession.id}/timeline/read`,
          { headers: ownHeaders },
        );
        expect(otherRead.status).toBe(403);

        const tokenRow = db
          .select({ metadataJson: lunaSchema.accessTokens.metadataJson })
          .from(lunaSchema.accessTokens)
          .where(eq(lunaSchema.accessTokens.id, ownToken.claims.tokenId))
          .get();
        expect(tokenRow?.metadataJson).toEqual({
          invocationId: "timeline-invocation",
          artifactIds: ["existing-grant", artifacts[0]!.id],
          preserved: "timeline-metadata",
        });
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });

  test("dashboard timeline reads enforce Agent access and the removed attachment route stays absent", async () => {
    const previousToken = process.env.LUNA_DASHBOARD_TOKEN;
    const previousBunToken = Bun.env.LUNA_DASHBOARD_TOKEN;
    try {
      process.env.LUNA_DASHBOARD_TOKEN = TEST_DASHBOARD_TOKEN;
      Bun.env.LUNA_DASHBOARD_TOKEN = TEST_DASHBOARD_TOKEN;
      await withFreshDb("luna-dashboard-generic-timeline-", async ({ db }) => {
        const sender = materializeLocalUser(db, "timeline-message-sender");
        fixtureSessionOwnership(db, "feishu", "main", "local-dashboard-user");
        fixtureSessionOwnership(db, "feishu", "foreign", sender.id);
        const session = new SessionStore(db).resolveByChannelSurface({
          channelType: "feishu",
          channelId: "main",
          groupId: "oc_dashboard_timeline",
        });
        const foreign = new SessionStore(db).resolveByChannelSurface({
          channelType: "feishu",
          channelId: "foreign",
          groupId: "oc_dashboard_timeline",
        });
        new MessageStore(db).appendOnce({
          sessionId: session.id,
          channelMessageKey: "om_dashboard_timeline",
          senderUserId: sender.id,
          role: "user",
          channel: { type: "feishu", id: "main" },
          surface: { externalId: "oc_dashboard_timeline", kind: "group" },
          content: [{ type: "text", text: "dashboard timeline" }],
        });
        const auth = new DashboardAuthService();
        const app = new Hono()
          .route("/api/auth", createAuthRoutes(auth, { db }))
          .use("*", createDashboardAuthMiddleware(auth, { db }))
          .route("/api/sessions", createSessionsRoutes({ db }));
        const login = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TEST_DASHBOARD_TOKEN }),
        });
        const cookie = login.headers.get("set-cookie") ?? "";

        const timeline = await app.request(
          `/api/sessions/${session.id}/timeline/read`,
          { headers: { cookie } },
        );
        const removed = await app.request(
          `/api/sessions/${session.id}/attachments/recent`,
          { headers: { cookie } },
        );

        expect(login.status).toBe(200);
        expect(cookie).not.toBe("");
        expect(timeline.status).toBe(200);
        expect(await timeline.json()).toMatchObject({
          entries: [expect.objectContaining({ text: "dashboard timeline" })],
        });
        expect((await app.request(`/api/sessions/${foreign.id}/timeline/read`, { headers: { cookie } })).status).toBe(403);
        expect(removed.status).toBe(404);
      });
    } finally {
      restoreEnv("LUNA_DASHBOARD_TOKEN", previousToken, previousBunToken);
    }
  });

  test("HonoServer no longer exposes path based file reads", async () => {
    const previousToken = process.env.LUNA_ACCESS_TOKEN_SECRET;
    const previousBunToken = Bun.env.LUNA_ACCESS_TOKEN_SECRET;
    try {
      process.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      Bun.env.LUNA_ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
      await withFreshDb("luna-no-files-route-", async ({ db, root }) => {
        const user = materializeLocalUser(db, "files-route-user");
        const token = issueAccessToken(db, user).token;
        mkdirSync(join(root, "workspace", "uploads", "images"), { recursive: true });
        writeFileSync(join(root, "workspace", "uploads", "images", "topic.jpeg"), "image");
        const server = new HonoServer({ db });

        const response = await server.app.fetch(
          new Request("http://luna.test/api/files/workspace/uploads/images/topic.jpeg", {
            headers: { authorization: `Bearer ${token}` },
          }),
        );

        expect(response.status).toBe(404);
      });
    } finally {
      restoreEnv("LUNA_ACCESS_TOKEN_SECRET", previousToken, previousBunToken);
    }
  });
});

async function withFreshDb(
  prefix: string,
  fn: (input: {
    readonly connection: DataConnection<typeof lunaSchema>;
    readonly db: DataConnection<typeof lunaSchema>["db"];
    readonly root: string;
  }) => Promise<void> | void,
): Promise<void> {
  const previousHome = config.paths.home;
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "data"), { recursive: true });
  let connection: DataConnection<typeof lunaSchema> | undefined;
  try {
    setLunaHome(root);
    connection = new DataConnection(lunaSchema);
    await fn({ connection, db: connection.db, root });
  } finally {
    connection?.close();
    setLunaHome(previousHome);
    rmSync(root, { recursive: true, force: true });
  }
}

function materializeLocalUser(
  db: DataConnection<typeof lunaSchema>["db"],
  id: string,
) {
  return new IdentityDirectory(db).materializeIdentityClaims({
    kind: "human",
    displayName: id,
    claims: [
      {
        namespace: "local",
        kind: "local_id",
        value: id,
        scope: "",
        confidence: "manual",
      },
    ],
  });
}

function createArtifactTask(
  db: DataConnection<typeof lunaSchema>["db"], ownerId: string, id: string, scope = fixtureScope(db, ownerId),
) {
  const now = Date.now();
  db.insert(lunaSchema.tasks).values({
    id, agent_id: scope.agentId, shadow_id: scope.shadowId, type: "task", title: "Test", status: "running",
    creator_user_id: ownerId, created_at: now, updated_at: now, last_activity_at: now,
  }).run();
}

function issueTaskArtifactToken(
  db: DataConnection<typeof lunaSchema>["db"],
  userId: string,
  taskId: string,
  artifactIds: string[],
) {
  const runnerContextId = new RunnerContextStore(db).resolveForTask(taskId, "codex").id;
  const now = Date.now();
  const run = new TaskRunStore(db).createRun({
    taskId, reason: "initial", inputSnapshot: {}, runnerType: "codex", runnerContextId,
  });
  const invocationId = "artifact-invocation";
  const token = new AccessTokenService({ db, signingSecret: TEST_ACCESS_TOKEN_SECRET }).issueToken({
    userId, name: "task runner token", source: "runner", role: "runner", runnerKind: "task",
    sourceRunnerJobId: runnerContextId, sourceTaskId: taskId, sourceTaskRunId: run.id,
    ttlMs: 3600000, now, metadata: { invocationId, artifactIds, preserved: "runner-metadata" },
  });
  registerTestRunnerJob(db, invocationId, token.claims, {
    version: 1, kind: "task", input: { taskId, taskRunId: run.id, runnerContextId },
  }, run.id);
  return token;
}

function issueAccessToken(
  db: DataConnection<typeof lunaSchema>["db"],
  user: { readonly id: string; readonly displayName?: string },
): {
  readonly token: string;
  readonly claims: LunaAccessTokenClaims;
} {
  const now = Date.now();
  const issued = new AccessTokenService({
    db,
    signingSecret: TEST_ACCESS_TOKEN_SECRET,
  }).issueToken({
    userId: user.id,
    name: "Route test token",
    source: "cli",
    role: "user",
    ttlMs: 60 * 60 * 1000,
    now,
  });
  return {
    token: issued.token,
    claims: issued.claims,
  };
}

function defaultClaims(): LunaAccessTokenClaims {
  return {
    tokenId: "test-token",
    actorUserId: "test-user",
    source: "cli",
    role: "user",
    issuedAt: 1000,
    expiresAt: 60 * 60 * 1000,
  };
}

function authenticateTestAdmin(db: DataConnection<typeof lunaSchema>["db"], user: {id: string; displayName?: string}): MiddlewareHandler {
  fixturePlatformAdmin(db, user.id);
  const authenticate = authenticateTestUser(user);
  return (c, next) => {
    c.set("lunaAuthorizationDb", db);
    return authenticate(c, next);
  };
}

function authenticateTestUser(
  user: { id: string; displayName?: string },
  claims?: LunaAccessTokenClaims,
): MiddlewareHandler {
  return async (c, next) => {
    c.set("dashboardAuthSession", {
      authenticated: true,
      user: {
        id: user.id,
        name: user.displayName ?? user.id,
        provider: "test-access-token",
      },
    });
    if (claims !== undefined) {
      c.set("lunaRequestAuthKind", "luna-access-token");
      c.set("lunaAccessTokenClaims", {
        ...claims,
        actorUserId: user.id,
      });
    } else {
      c.set("lunaRequestAuthKind", "dashboard-cookie");
    }
    await next();
  };
}

async function jsonFrom(
  server: HonoServer,
  path: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await server.app.fetch(
    new Request(`http://luna.test${path}`, { headers }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function dashboardCookieFromServer(server: HonoServer): Promise<string> {
  const response = await server.app.fetch(
    new Request("http://luna.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "luna-local-dev" }),
    }),
  );
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

function restoreEnv(
  key: string,
  processValue: string | undefined,
  bunValue: string | undefined,
): void {
  if (processValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = processValue;
  }
  if (bunValue === undefined) {
    delete Bun.env[key];
  } else {
    Bun.env[key] = bunValue;
  }
}
