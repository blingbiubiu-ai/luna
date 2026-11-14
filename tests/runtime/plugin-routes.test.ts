import {fixturePlatformAdmin, fixtureRunnerContext, fixtureScope} from "../helpers/platform-fixtures";
import { registerTestRunnerJob } from "./support/runner-job";
import { TaskRunStore } from "../../src/tasks/task-run-store";
import { AgentPluginStore } from "../../src/plugins/agent-plugin-store";
import { InvocationStore } from "../../src/runners/invocation-store";
import type { LunaAccessTokenClaims } from "../../src/server/auth/access-token-service";
import { eq } from "drizzle-orm";
import { registerFixtureOperations } from "../helpers/operation-fixtures";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { PluginCommandInputError } from "@luna/plugin-contracts";
import {
  PluginRegistry,
  type PluginCommandInputParser,
  type PluginManifest,
  type PluginRuntimeFactory,
} from "../../src/plugins";
import {
  canonicalJson,
  sha256Content,
  sha256File,
} from "../../src/plugins/marketplace/checksums";
import { PluginMarketplaceService } from "../../src/plugins/marketplace/marketplace-service";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { createOperationsRoutes } from "../../src/server/routes/operations";
import { createPluginsRoutes } from "../../src/server/routes/plugins";
import { bindRunnerContextsToRuntime, RunnerContextStore } from "../../src/runners/runner-context-store";
import { createScopedResources } from "@luna/host-runtime/scoped-runner-resources";
import { config, setLunaHome } from "../../src/shared";

let testHome: string;
let database: DataConnection<typeof schema>;
let previousHome: string;
let scope: ReturnType<typeof fixtureScope>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-plugin-routes-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
  scope = fixtureScope(database.db, "user_1");
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe("plugin routes", () => {
  test("lists plugins and invokes a granted plugin operation", async () => {
    const registry = alphaRegistry(async () => ({
      status: "success",
      summary: {},
      artifacts: [],
    }));
    seedAlphaPolicyAndGrant(database.db, registry);
    fixturePlatformAdmin(database.db, "user_1");
    const app = new Hono()
      .use("*", async (c, next) => {
        (c as any).set("dashboardAuthSession", {
          authenticated: true,
          user: {
            id: "user_1",
            name: "User 1",
            provider: "test",
          },
        });
        (c as any).set("lunaRequestAuthKind", "dashboard-cookie");
        (c as any).set("lunaAuthorizationDb", database.db);
        await next();
      })
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }))
      .route(
        "/api/operations",
        createOperationsRoutes({ db: database.db, pluginRegistry: registry }),
      );

    expect(
      (
        await app.request(scopedPath("/api/operations/alpha.echo/invoke"), {
          method: "POST",
          body: JSON.stringify({ input: {} }),
        })
      ).status,
    ).toBe(200);

    const operationsBody = await (
      await app.request("/api/operations")
    ).json() as {
      operations: {
        id: string;
        metadata: { recentAudits: { status: string }[] };
      }[];
    };
    const alphaOperation = operationsBody.operations.find(
      (operation: { id: string }) => operation.id === "alpha.echo",
    );
    expect(alphaOperation).toBeDefined();
    expect(alphaOperation!.metadata.recentAudits[0]!.status).toBe("success");
  });

  test("plugin route lists summaries and installation state", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      await service.refresh();
      await service.enable({ pluginId: "echo", version: "0.1.0" });
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry: new PluginRegistry(),
          marketplaceService: service,
        }),
      );

      const response = await app.request("/api/plugins");
      const body = await response.json() as {
        plugins: {
          id: string;
          latestRelease: { manifest?: { operations?: { id: string }[] } };
          installation: { pendingAction: string } | null;
        }[];
      };

      expect(response.status).toBe(200);
      expect(body.plugins[0]?.id).toBe("echo");
      expect(body.plugins[0]?.latestRelease.manifest?.operations?.[0]?.id).toBe("echo.echo");
      expect(body.plugins[0]?.installation?.pendingAction).toBe("enable");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 15_000);

  test("plugin refresh route updates releases", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry: new PluginRegistry(),
          marketplaceService: service,
        }),
      );

      const response = await app.request("/api/plugins/refresh", {
        method: "POST",
      });
      const body = await response.json() as {
        status: string;
        releaseCount: number;
      };

      expect(response.status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.releaseCount).toBe(1);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("plugin enable route returns restart required", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      await service.refresh();
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry: new PluginRegistry(),
          marketplaceService: service,
        }),
      );

      const response = await app.request("/api/plugins/echo/enable", {
        method: "POST",
        body: JSON.stringify({ version: "0.1.0" }),
      });
      const body = await response.json() as {
        status: string;
        restartRequired: boolean;
        installation: {
          pluginId: string;
          desiredState: string;
          pendingAction: string;
        };
      };

      expect(body).toMatchObject({
        status: "success",
        restartRequired: true,
        installation: {
          pluginId: "echo",
          desiredState: "enabled",
          pendingAction: "enable",
        },
      });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("plugin disable route returns restart required", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      await service.refresh();
      await service.enable({ pluginId: "echo", version: "0.1.0" });
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry: new PluginRegistry(),
          marketplaceService: service,
        }),
      );

      const response = await app.request("/api/plugins/echo/disable", {
        method: "POST",
      });
      const body = await response.json() as {
        restartRequired: boolean;
        installation: { desiredState: string; pendingAction: string };
      };

      expect(response.status).toBe(200);
      expect(body.restartRequired).toBe(true);
      expect(body.installation.desiredState).toBe("disabled");
      expect(body.installation.pendingAction).toBe("disable");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("plugin upgrade and rollback routes return restart required", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      await service.refresh();
      await service.enable({ pluginId: "echo", version: "0.1.0" });
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry: new PluginRegistry(),
          marketplaceService: service,
        }),
      );

      const upgrade = await app.request("/api/plugins/echo/upgrade", {
        method: "POST",
        body: JSON.stringify({ version: "0.1.0" }),
      });
      const upgradeBody = await upgrade.json() as {
        restartRequired: boolean;
        installation: { pendingAction: string };
      };
      const rollback = await app.request("/api/plugins/echo/rollback", {
        method: "POST",
        body: JSON.stringify({ version: "0.1.0" }),
      });
      const rollbackBody = await rollback.json() as {
        restartRequired: boolean;
        installation: { pendingAction: string };
      };

      expect(upgrade.status).toBe(200);
      expect(upgradeBody.restartRequired).toBe(true);
      expect(upgradeBody.installation.pendingAction).toBe("upgrade");
      expect(rollback.status).toBe(200);
      expect(rollbackBody.restartRequired).toBe(true);
      expect(rollbackBody.installation.pendingAction).toBe("rollback");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 15_000);

  test("plugin routes keep active registry unchanged before restart", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      await service.refresh();
      const registry = new PluginRegistry();
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry,
          marketplaceService: service,
        }),
      );
      await app.request("/api/plugins/echo/enable", {
        method: "POST",
        body: JSON.stringify({ version: "0.1.0" }),
      });

      const body = await (await app.request("/api/plugins")).json() as {
        plugins: {
          id: string;
          installation: { pluginId: string; desiredState: string } | null;
        }[];
      };

      expect(body.plugins[0]?.id).toBe("echo");
      expect(body.plugins[0]?.installation).toMatchObject({
        pluginId: "echo",
        desiredState: "enabled",
      });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("plugin detail route returns cached plugin manifests", async () => {
    const repo = createEchoMarketplaceRepo();
    try {
      const service = marketplaceService(repo.root);
      await service.refresh();
      const app = appWithDashboardAuth().route(
        "/api/plugins",
        createPluginsRoutes({
          db: database.db,
          registry: new PluginRegistry(),
          marketplaceService: service,
        }),
      );

      const response = await app.request("/api/plugins/echo");
      const body = await response.json() as {
        plugin: {
          id: string;
          version: string;
          marketplaceVersions: {
            pluginId: string;
            version: string;
            manifest?: { operations?: { id: string }[] };
          }[];
        };
      };

      expect(response.status).toBe(200);
      expect(body.plugin).toMatchObject({
        id: "echo",
        version: "0.1.0",
      });
      expect(body.plugin.marketplaceVersions[0]).toMatchObject({
        pluginId: "echo",
        version: "0.1.0",
      });
      expect(body.plugin.marketplaceVersions[0]?.manifest?.operations?.[0]?.id)
        .toBe("echo.echo");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("plugin management is admin-only while command help remains operation-route scoped", async () => {
    const registry = alphaRegistry(async () => {
      throw new Error("runtime should not run for help");
    });
    const app = appWithAccessTokenAuth()
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const management = await app.request("/api/plugins");
    expect(management.status).toBe(403);
    expect(await management.json()).toMatchObject({
      status: "error",
      code: "dashboard_session_required",
    });

    const help = await app.request(
      scopedPath("/api/plugins/commands/resolve-and-invoke"),
      {
        method: "POST",
        body: JSON.stringify({
          path: ["alpha"],
          args: ["--help"],
          help: true,
        }),
      },
    );
    expect(help.status).toBe(200);
    expect(await help.json()).toMatchObject({
      status: "ok",
    });
  });

  test("plugin command route resolves active command and parses input service-side", async () => {
    const parseCommandInput: PluginCommandInputParser = ({ args }) => ({
      input: { message: args.at(-1) },
    });
    const registry = alphaRegistry(async (input) => ({
      status: "success",
      summary: input.input,
      output: input.input,
      artifacts: [],
    }), parseCommandInput);
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = new Hono()
      .use("*", async (c, next) => {
        (c as any).set("dashboardAuthSession", {
          authenticated: true,
          user: { id: "user_1", name: "User 1", provider: "test" },
        });
        (c as any).set("lunaRequestAuthKind", "dashboard-cookie");
        await next();
      })
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await app.request(
      scopedPath("/api/plugins/commands/resolve-and-invoke"),
      {
        method: "POST",
        body: JSON.stringify({
          path: ["alpha"],
          args: ["echo", "--message", "hello"],
        }),
      },
    );
    const body = await response.json() as {
      status: string;
      output: { message: string };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.output).toEqual({ message: "hello" });
    const deny = new AuthorizationRuleStore(database.db, {kind: "agent", agentId: scope.agentId}).addGrant({
      subjectType:"user",subjectId:"user_1",target:"alpha.echo",matchType:"exact",effect:"deny",
    });
    const denied = await app.request(scopedPath("/api/plugins/commands/resolve-and-invoke"), {
      method:"POST",body:JSON.stringify({path:["alpha"],args:["echo","--message","hello"]}),
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json() as { invocationId:string;errorCode:string };
    expect(deniedBody.errorCode).toBe("operation_not_granted");
    const audit = database.db.select().from(schema.operationInvocationAudits).all().find(a=>a.invocation_id===deniedBody.invocationId);
    expect(audit?.authorization_json).toMatchObject({decision:"forbidden",matchedRuleIds:[deny.id],matchedRules:[{id:deny.id,target:"alpha.echo",effect:"deny"}]});

  });

  test("runner plugin commands execute host CLIs from the verified runner root", async () => {
    seedPluginTask("task_runner_cwd");
    const context = new RunnerContextStore(database.db).resolveForTask(
      "task_runner_cwd",
      "codex",
    );
    const registry = runnerCwdRegistry();
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithRunnerAuth(context.id, registry)
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await invokeAlphaCommand(app);
    const body = await response.json() as {
      status: string;
      output: { stdout: string };
    };

    expect(response.status).toBe(200);
    expect(body.output.stdout.trim()).toBe(realpathSync(context.runner_root_path));
  });

  test("runner plugin commands use the local Worker's prepared directory", async () => {
    seedPluginTask("worker_plugin_task");
    const resources = createScopedResources(scope, []).selection;
    const home = join(realpathSync(testHome), "worker", "agents", scope.agentId, "shadows", scope.shadowId);
    let cwd: string | undefined;
    bindRunnerContextsToRuntime(database.db, {runtimeId: "test-runtime", preparedContext: () => cwd ? {
      protocolVersion: 2, local: true, workerId: "worker", scope: {...scope, placementGeneration: 1},
      resources, resourceRevision: resources.digest, home, cwd, instructionFingerprint: "test", env: {},
    } : undefined});
    const context = new RunnerContextStore(database.db).resolveForTask("worker_plugin_task", "codex");
    const registry = runnerCwdRegistry();
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithRunnerAuth(context.id, registry).route("/api/plugins", createPluginsRoutes({db: database.db, registry}));
    expect(await (await invokeAlphaCommand(app)).json()).toMatchObject({errorCode: "runner_root_unavailable"});
    cwd = join(home, "runners", context.id);
    mkdirSync(cwd, {recursive: true});
    const response = await invokeAlphaCommand(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({output: {stdout: `${cwd}\n`}});
    expect(await Bun.file(join(context.runner_root_path, "AGENTS.md")).exists()).toBe(false);
  });

  test("runner plugin commands reject an unknown runner context", async () => {
    const registry = runnerCwdRegistry();
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithRunnerAuth("missing-context", registry)
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await invokeAlphaCommand(app);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      status: "error",
      code: "token_inactive",
    });
  });

  test("runner plugin commands reject a deleted runner root", async () => {
    seedPluginTask("task_deleted_root");
    const context = new RunnerContextStore(database.db).resolveForTask(
      "task_deleted_root",
      "codex",
    );
    rmSync(context.runner_root_path, { recursive: true, force: true });
    const registry = runnerCwdRegistry();
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithRunnerAuth(context.id, registry)
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await invokeAlphaCommand(app);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      status: "error",
      errorCode: "runner_root_unavailable",
    });
  });

  test("runner plugin commands reject a runner root redirected to another task", async () => {
    seedPluginTask("redirected_root");
    seedPluginTask("other_root");
    const roots = new RunnerContextStore(database.db);
    const target = roots.resolveForTask("redirected_root", "codex");
    const other = roots.resolveForTask("other_root", "codex");
    rmSync(target.runner_root_path, {recursive: true, force: true});
    symlinkSync(other.runner_root_path, target.runner_root_path);
    const registry = runnerCwdRegistry();
    seedAlphaPolicyAndGrant(database.db, registry);
    const response = await invokeAlphaCommand(appWithRunnerAuth(target.id, registry)
      .route("/api/plugins", createPluginsRoutes({db: database.db, registry})));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({errorCode: "runner_root_mismatch"});
  });

  test("a revoked Runner invocation cannot start another plugin host command", async () => {
    seedPluginTask("revoked_plugin_task");
    const target = new RunnerContextStore(database.db).resolveForTask("revoked_plugin_task", "codex");
    const registry = new PluginRegistry();
    const marker = join(testHome, "must-not-exist");
    registry.registerPlugin({...alphaManifest, requestedHostPermissions: ["host.exec"], allowedExecutables: ["/usr/bin/touch"]},
      () => ({invoke: async ({runtimeContext}) => {
        await Promise.resolve();
        new InvocationStore(database.db).revoke("plugin-invocation", "cancelled while the plugin was running");
        await runtimeContext!.host.exec({cmd: "/usr/bin/touch", args: [marker]});
        return {status: "success", summary: {}, artifacts: []};
      }}), {}, () => ({input: {}}));
    seedAlphaPolicyAndGrant(database.db, registry);
    const response = await invokeAlphaCommand(appWithRunnerAuth(target.id, registry)
      .route("/api/plugins", createPluginsRoutes({db: database.db, registry})));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({status: "error", errorCode: "invocation_inactive"});
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(database.db.select().from(schema.operationInvocationAudits).get()).toMatchObject({status: "error", error_code: "invocation_inactive"});
  });

  test("runner plugin commands reject persisted roots outside the active base", async () => {
    seedPluginTask("task_outside_root");
    const now = Date.now();
    database.db.insert(schema.runnerContexts).values(fixtureRunnerContext(database.db, {
      id: "context_outside_root",
      owner_type: "task",
      owner_id: "task_outside_root",
      runner_type: "codex",
      runner_session_id: null,
      instruction_fingerprint: null,
      runner_root_path: join(testHome, "outside", "task_outside_root"),
      last_run_id: null,
      created_at: now,
      updated_at: now,
    })).run();
    const registry = runnerCwdRegistry();
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithRunnerAuth("context_outside_root", registry)
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await invokeAlphaCommand(app);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      status: "error",
      errorCode: "runner_root_mismatch",
    });
  });

  test("plugin command failures preserve host CLI output", async () => {
    const registry = alphaRegistry(async () => ({
      status: "error",
      summary: { exitCode: 23 },
      output: {
        exitCode: 23,
        stdout: "partial output\n",
        stderr: "file missing\n",
      },
      artifacts: [],
    }), () => ({ input: {} }));
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithDashboardAuth()
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await invokeAlphaCommand(app);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      status: "error",
      errorCode: "plugin_error",
      message: "file missing",
      output: {
        exitCode: 23,
        stdout: "partial output\n",
        stderr: "file missing\n",
      },
    });
  });

  test("plugin command route resolves logtool operation override from parser", async () => {
    const parseCommandInput: PluginCommandInputParser = ({ args }) => ({
      operationId: args[0] === "tool" ? "logtool.tool.log" : "logtool.run",
      input: { argv: args },
    });
    const registry = logtoolRegistry(async (input) => ({
      status: "success",
      summary: { operationId: input.operationId },
      output: input.input,
      artifacts: [],
    }), parseCommandInput);
    seedLogToolPolicyAndGrant(database.db, registry);
    const app = new Hono()
      .use("*", async (c, next) => {
        (c as any).set("dashboardAuthSession", {
          authenticated: true,
          user: { id: "user_1", name: "User 1", provider: "test" },
        });
        (c as any).set("lunaRequestAuthKind", "dashboard-cookie");
        await next();
      })
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await app.request(
      scopedPath("/api/plugins/commands/resolve-and-invoke"),
      {
        method: "POST",
        body: JSON.stringify({
          path: ["logtool"],
          args: ["tool", "log", "search.keywords", "{}"],
        }),
      },
    );
    const body = await response.json() as {
      status: string;
      summary: { operationId: string };
      output: { argv: string[] };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.summary.operationId).toBe("logtool.tool.log");
    expect(body.output.argv).toEqual(["tool", "log", "search.keywords", "{}"]);
  });

  test("plugin command route renders help without invoking parser or runtime", async () => {
    const parseCommandInput: PluginCommandInputParser = () => {
      throw new Error("parser should not run for help");
    };
    const registry = alphaRegistry(async () => {
      throw new Error("runtime should not run for help");
    }, parseCommandInput);
    const app = new Hono()
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await app.request(
      scopedPath("/api/plugins/commands/resolve-and-invoke"),
      {
        method: "POST",
        body: JSON.stringify({
          path: ["alpha"],
          args: ["echo", "--help"],
          help: true,
        }),
      },
    );
    const body = await response.json() as {
      status: string;
      output: string;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.output).toContain("Usage:");
    expect(body.output).toContain("luna alpha echo");
    expect(body.output).toContain("Echo plugin command");
    expect(body.output).toContain("Options:");
    expect(body.output).toContain("--message <text>");
  });

  test("plugin command route renders group help like a normal command group", async () => {
    const registry = alphaRegistry(async () => {
      throw new Error("runtime should not run for group help");
    });
    const app = new Hono()
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));

    const response = await app.request(
      scopedPath("/api/plugins/commands/resolve-and-invoke"),
      {
        method: "POST",
        body: JSON.stringify({
          path: ["alpha"],
          args: ["--help"],
          help: true,
        }),
      },
    );
    const body = await response.json() as {
      status: string;
      output: string;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.output).toContain("Luna Alpha plugin CLI");
    expect(body.output).toContain("Usage:");
    expect(body.output).toContain("luna alpha echo [options]");
    expect(body.output).toContain("Commands:");
    expect(body.output).toContain("echo");
    expect(body.output).toContain("Echo plugin command");
    expect(body.output).not.toContain("Options:");
    expect(body.output).not.toContain("--message <text>");
    expect(body.output).not.toContain("Plugin Commands:");
  });

  test("parser error maps to 400", async () => {
    const parseCommandInput: PluginCommandInputParser = () => {
      throw new PluginCommandInputError("bad input");
    };
    const registry = alphaRegistry(async () => ({ status: "success", summary: {}, artifacts: [] }), parseCommandInput);
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithDashboardAuth().route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));
    const response = await app.request(scopedPath("/api/plugins/commands/resolve-and-invoke"), {
      method: "POST",
      body: JSON.stringify({ path: ["alpha"], args: ["echo"] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { code: string };
    expect(body.code).toBe("plugin_command_input_invalid");
  });

  test("override operation belonging to another plugin is rejected 403", async () => {
    const parseCommandInput: PluginCommandInputParser = ({ args }) => ({
      input: { args },
      operationId: "other.cap",
    });
    const registry = alphaRegistry(async () => ({ status: "success", summary: {}, artifacts: [] }), parseCommandInput);
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = appWithDashboardAuth().route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));
    const response = await app.request(scopedPath("/api/plugins/commands/resolve-and-invoke"), {
      method: "POST",
      body: JSON.stringify({ path: ["alpha"], args: ["echo"] }),
    });
    expect(response.status).toBe(403);
  });

  test("stdin flows into parseCommandInput", async () => {
    let seenStdin: string | undefined;
    const parseCommandInput: PluginCommandInputParser = ({ stdin }) => {
      seenStdin = stdin;
      return { input: { stdin } };
    };
    const registry = alphaRegistry(async (i) => ({ status: "success", summary: i.input, output: i.input, artifacts: [] }), parseCommandInput);
    seedAlphaPolicyAndGrant(database.db, registry);
    const app = new Hono()
      .use("*", async (c, next) => {
        (c as any).set("dashboardAuthSession", { authenticated: true, user: { id: "user_1", name: "User 1", provider: "test" } });
        (c as any).set("lunaRequestAuthKind", "dashboard-cookie");
        await next();
      })
      .route("/api/plugins", createPluginsRoutes({ db: database.db, registry }));
    const response = await app.request(scopedPath("/api/plugins/commands/resolve-and-invoke"), {
      method: "POST",
      body: JSON.stringify({ path: ["alpha"], args: ["echo"], stdin: "payload" }),
    });
    expect(response.status).toBe(200);
    expect(seenStdin).toBe("payload");
  });
});

function alphaRegistry(
  invoke: ReturnType<PluginRuntimeFactory>["invoke"],
  parseCommandInput?: PluginCommandInputParser,
): PluginRegistry {
  const registry = new PluginRegistry();
  registry.registerPlugin(
    alphaManifest,
    () => ({ invoke }),
    {},
    parseCommandInput,
  );
  return registry;
}

function runnerCwdRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.registerPlugin(
    {
      ...alphaManifest,
      requestedHostPermissions: ["host.exec"],
      allowedExecutables: ["/bin/pwd"],
    },
    () => ({
      invoke: async (input) => {
        if (input.runtimeContext === undefined) {
          throw new Error("runtime context is required");
        }
        const output = await input.runtimeContext.host.exec({
          cmd: "/bin/pwd",
          args: [],
        });
        return {
          status: "success",
          summary: { exitCode: output.exitCode },
          output,
          artifacts: [],
        };
      },
    }),
    {},
    () => ({ input: {} }),
  );
  return registry;
}

async function invokeAlphaCommand(app: Hono): Promise<Response> {
  return await app.request(scopedPath("/api/plugins/commands/resolve-and-invoke"), {
    method: "POST",
    body: JSON.stringify({ path: ["alpha"], args: ["echo"] }),
  });
}

function logtoolRegistry(
  invoke: ReturnType<PluginRuntimeFactory>["invoke"],
  parseCommandInput?: PluginCommandInputParser,
): PluginRegistry {
  const registry = new PluginRegistry();
  registry.registerPlugin(
    logtoolManifest,
    () => ({ invoke }),
    {},
    parseCommandInput,
  );
  return registry;
}

const alphaManifest = {
  id: "alpha",
  agentScopeVersion: 2,
  displayName: "Alpha",
  version: "1.0.0",
  source: "bundled",
  requestedHostPermissions: ["artifact.create"],
  operations: [
    {
      id: "alpha.echo",
      pluginId: "alpha",
      title: "Echo",
      inputSchema: { type: "object" },
      riskLevel: "low",
      artifactPolicy: "none",
    },
  ],
  commands: [
    {
      path: ["alpha", "echo"],
      operationId: "alpha.echo",
      help: [
        "Echo plugin command",
        "",
        "Options:",
        "  --message <text>  Message to echo.",
      ].join("\n"),
    },
  ],
  tools: [],
  skills: [],
} satisfies PluginManifest;

const logtoolManifest = {
  id: "logtool",
  agentScopeVersion: 2,
  displayName: "LogTool",
  version: "1.0.0",
  source: "bundled",
  requestedHostPermissions: ["host.exec"],
  operations: [
    {
      id: "logtool.exec",
      pluginId: "logtool",
      title: "LogTool exec",
      inputSchema: { type: "object" },
      riskLevel: "low",
      artifactPolicy: "none",
    },
    {
      id: "logtool.run",
      pluginId: "logtool",
      title: "LogTool run",
      inputSchema: { type: "object" },
      riskLevel: "medium",
      artifactPolicy: "none",
    },
    {
      id: "logtool.tool.log",
      pluginId: "logtool",
      title: "LogTool tool log",
      inputSchema: { type: "object" },
      riskLevel: "medium",
      artifactPolicy: "none",
    },
  ],
  commands: [
    {
      path: ["logtool"],
      operationId: "logtool.exec",
      help: "LogTool plugin command",
    },
  ],
  tools: [],
  skills: [],
} satisfies PluginManifest;

function seedAlphaPolicyAndGrant(db: DataConnection<typeof schema>["db"], registry: PluginRegistry): void {
  const now = String(Date.now());
  registerFixtureOperations(db, {
      id: "alpha.echo",
      namespace: "alpha",
      operationKind: "execute",
      riskLevel: "low",
      defaultDecision: "deny",
      providerType: "plugin",
      pluginId: "alpha",
      title: "Echo",
      description: null,
      status: "active",
      allowedSubjectTypesJson: ["user"],
      constraintsSchemaJson: null,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });
  enableFixturePlugin(db, registry, "alpha");
  new AuthorizationRuleStore(db, {kind: "agent", agentId: scope.agentId}).addGrant({ matchType: "exact",
    subjectType: "user",
    subjectId: "user_1",
    target: "alpha.echo",
    effect: "allow",
  });
}

function seedLogToolPolicyAndGrant(db: DataConnection<typeof schema>["db"], registry: PluginRegistry): void {
  const now = String(Date.now());
  registerFixtureOperations(db, [
      {
        id: "logtool.run",
        namespace: "logtool",
        operationKind: "execute",
        riskLevel: "medium",
        defaultDecision: "deny",
        providerType: "plugin",
        pluginId: "logtool",
        title: "LogTool run",
        description: null,
        status: "active",
        allowedSubjectTypesJson: ["user"],
        constraintsSchemaJson: null,
        metadataJson: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "logtool.tool.log",
        namespace: "logtool",
        operationKind: "execute",
        riskLevel: "medium",
        defaultDecision: "deny",
        providerType: "plugin",
        pluginId: "logtool",
        title: "LogTool tool log",
        description: null,
        status: "active",
        allowedSubjectTypesJson: ["user"],
        constraintsSchemaJson: null,
        metadataJson: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  enableFixturePlugin(db, registry, "logtool");
  const grants = new AuthorizationRuleStore(db, {kind: "agent", agentId: scope.agentId});
  grants.addGrant({ matchType: "exact",
    subjectType: "user",
    subjectId: "user_1",
    target: "logtool.run",
    effect: "allow",
  });
  grants.addGrant({ matchType: "exact",
    subjectType: "user",
    subjectId: "user_1",
    target: "logtool.tool.log",
    effect: "allow",
  });
}

function marketplaceService(repoRoot: string): PluginMarketplaceService {
  return new PluginMarketplaceService({
    db: database.db,
    marketplace: {
      id: "trusted",
      gitUrl: repoRoot,
      branch: "main",
      localPath: join(testHome, "plugins", "marketplace", "trusted"),
    },
    lunaHome: testHome,
    currentLunaApiVersion: "0.1.0",
  });
}

function scopedPath(path: string): string {
  return `${path}?agentId=${scope.agentId}&shadowId=${scope.shadowId}`;
}

function enableFixturePlugin(db: DataConnection<typeof schema>["db"], registry: PluginRegistry, id: string): void {
  new AgentPluginStore(db, registry).put("user_1", scope.agentId, id, {expectedRevision: null, enabled: true, config: {}});
}

function seedPluginTask(id: string): void {
  database.db.insert(schema.tasks).values({id, type: "task", title: "Plugin task", status: "new", creator_user_id: "user_1",
    agent_id: scope.agentId, shadow_id: scope.shadowId, created_at: 1, updated_at: 1, last_activity_at: 1}).run();
}

function appWithDashboardAuth(): Hono {
  fixturePlatformAdmin(database.db, "user_1");
  return new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", {
      authenticated: true,
      user: {
        id: "user_1",
        name: "User 1",
        provider: "test",
      },
    });
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie");
    (c as any).set("lunaAuthorizationDb", database.db);
    await next();
  });
}

function appWithAccessTokenAuth(): Hono {
  return new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", {
      authenticated: true,
      user: {
        id: "user_1",
        name: "User 1",
        provider: "test-access-token",
      },
    });
    (c as any).set("lunaRequestAuthKind", "luna-access-token");
    (c as any).set("lunaAccessTokenClaims", {
      tokenId: "token_1",
      actorUserId: "user_1",
      source: "cli",
      role: "user",
      issuedAt: 1000,
      expiresAt: 2000,
    });
    await next();
  });
}

function appWithRunnerAuth(runnerJobId: string, registry: PluginRegistry): Hono {
  const db = database.db;
  const context = db.select().from(schema.runnerContexts).where(eq(schema.runnerContexts.id, runnerJobId)).get();
  const run = context ? new TaskRunStore(db).createRun({taskId: context.owner_id, reason: "initial",
    inputSnapshot: {}, runnerType: "codex", runnerContextId: context.id}) : undefined;
  const claims: LunaAccessTokenClaims = {tokenId: "runner_token_1", actorUserId: "user_1", source: "runner", role: "runner",
    runnerKind: "task", runnerJobId, ...scope, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    ...(context && run ? {taskId: context.owner_id, taskRunId: run.id} : {})};
  if (context && run) {
    db.insert(schema.accessTokens).values({id: claims.tokenId, tokenHash: "fixture", userId: claims.actorUserId,
      source: "runner", name: "Plugin test", role: "runner", issuedAt: claims.issuedAt, expiresAt: claims.expiresAt,
      createdAt: claims.issuedAt, metadataJson: {invocationId: "plugin-invocation"}}).run();
    registerTestRunnerJob(db, "plugin-invocation", claims, {version: 1, kind: "task",
      input: {taskId: context.owner_id, taskRunId: run.id, runnerContextId: context.id}}, run.id, registry);
  }
  return new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", {
      authenticated: true,
      user: {
        id: "user_1",
        name: "User 1",
        provider: "test-access-token",
      },
    });
    (c as any).set("lunaRequestAuthKind", "luna-access-token");
    (c as any).set("lunaAccessTokenClaims", claims);
    await next();
  });
}

interface EchoReleaseFixture {
  readonly packagePath: string;
  readonly manifestSha256: string;
  readonly pluginJsSha256: string;
  readonly packageSha256: string;
  readonly releaseSha256: string;
}

function createEchoMarketplaceRepo(): { readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "luna-plugin-route-marketplace-"));
  const release = writeEchoReleaseArchive(root);
  writeEchoMarketplaceIndex(root, release);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "luna@example.com"]);
  git(root, ["config", "user.name", "Luna Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return { root };
}

function writeEchoReleaseArchive(root: string): EchoReleaseFixture {
  const packagePath = "plugins/echo/release/0.1.0/echo-0.1.0.tgz";
  const archivePath = join(root, packagePath);
  mkdirSync(dirname(archivePath), { recursive: true });
  const stagingRoot = mkdtempSync(join(tmpdir(), "luna-echo-route-release-"));
  const releaseRoot = join(stagingRoot, "package");
  mkdirSync(join(releaseRoot, "skills", "echo"), { recursive: true });
  const manifest = JSON.stringify(
    {
      id: "echo",
      displayName: "Echo",
      version: "0.1.0",
      source: "marketplace",
      lunaApiVersion: "^0.1.0",
      runtime: { entrypoint: "plugin.js" },
      requestedHostPermissions: [],
      operations: [
        {
          id: "echo.echo",
          pluginId: "echo",
          providerType: "plugin",
          title: "Echo",
          inputSchema: { type: "object" },
          riskLevel: "low",
          artifactPolicy: "none",
        },
      ],
      commands: [{ path: ["echo"], operationId: "echo.echo" }],
      skills: [{ id: "echo.echo", title: "Echo", path: "skills/echo/SKILL.md" }],
    },
    null,
    2,
  );
  const pluginJs = [
    "export const plugin = {",
    "  createRuntime: () => ({",
    "    invoke: async () => ({ status: 'success', summary: {}, artifacts: [] }),",
    "  }),",
    "};",
    "export default plugin;",
    "",
  ].join("\n");
  const packageJson = JSON.stringify({
    name: "@luna-plugin/echo",
    version: "0.1.0",
    private: true,
  }, null, 2);
  const skill = "# Echo\n";
  writeFileSync(join(releaseRoot, "manifest.json"), manifest);
  writeFileSync(join(releaseRoot, "package.json"), packageJson);
  writeFileSync(join(releaseRoot, "plugin.js"), pluginJs);
  writeFileSync(join(releaseRoot, "skills", "echo", "SKILL.md"), skill);
  const checksums = canonicalJson({
    schemaVersion: 1,
    files: [
      { path: "manifest.json", sha256: sha256Content(manifest) },
      { path: "package.json", sha256: sha256Content(packageJson) },
      { path: "plugin.js", sha256: sha256Content(pluginJs) },
      { path: "skills/echo/SKILL.md", sha256: sha256Content(skill) },
    ],
  });
  writeFileSync(join(releaseRoot, "checksums.json"), checksums);
  tar(stagingRoot, ["-czf", archivePath, "package"]);
  rmSync(stagingRoot, { recursive: true, force: true });
  return {
    packagePath,
    manifestSha256: sha256Content(manifest),
    pluginJsSha256: sha256Content(pluginJs),
    packageSha256: sha256File(archivePath),
    releaseSha256: sha256Content(checksums),
  };
}

function writeEchoMarketplaceIndex(
  root: string,
  release: EchoReleaseFixture,
): void {
  writeFileSync(
    join(root, "marketplace.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: "Luna Test Marketplace",
        plugins: [
          {
            id: "echo",
            displayName: "Echo",
            description: "Echo plugin",
            latestVersion: "0.1.0",
            versions: [
              {
                version: "0.1.0",
                packagePath: release.packagePath,
                lunaApiVersion: "^0.1.0",
                manifestSha256: release.manifestSha256,
                pluginJsSha256: release.pluginJsSha256,
                packageSha256: release.packageSha256,
                releaseSha256: release.releaseSha256,
                publishedAt: "2026-06-27T00:00:00.000Z",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

function tar(cwd: string, args: readonly string[]): void {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tar ${args.join(" ")} failed`);
  }
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}
