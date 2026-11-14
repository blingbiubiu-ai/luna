import {fixtureScope} from "../helpers/platform-fixtures";
import {AgentPluginStore} from "../../src/plugins/agent-plugin-store";
import { registerFixtureOperations } from "../helpers/operation-fixtures";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import {
  operationInvocationAudits,
  users,
} from "../../src/data/schema";
import { OperationDispatcher } from "../../src/plugins/dispatcher";
import {
  PluginRegistry,
  type PluginManifest,
  type PluginRuntimeFactory,
} from "../../src/plugins";
import { AuthorizationRuleStore } from "../../src/server/policy/authorization-rule-store";
import { setLunaHome } from "../../src/shared";

let testHome: string;
let database: DataConnection<typeof schema>;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "luna-operation-dispatcher-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
});

afterEach(() => {
  database.close();
  rmSync(testHome, { recursive: true, force: true });
});

describe("OperationDispatcher", () => {
  test("rejects missing grants without invoking plugin runtime", async () => {
    let invoked = false;
    const registry = alphaRegistry(async () => {
      invoked = true;
      return { status: "success", summary: {}, artifacts: [] };
    });
    seedAlphaPolicyAndUser(database.db);

    const result = await new OperationDispatcher({
      db: database.db,
      registry,
    }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_denied",
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected dispatcher error");
    }
    expect(result.errorCode).toBe("operation_not_granted");
    expect(invoked).toBe(false);
    expect(
      database.db.select().from(operationInvocationAudits).get()?.status,
    ).toBe("rejected");
  });

  test("rejects invocations without a resolved user subject before auditing", async () => {
    let invoked = false;
    const registry = alphaRegistry(async () => {
      invoked = true;
      return { status: "success", summary: {}, artifacts: [] };
    });
    seedAlphaPolicyAndUser(database.db);

    const result = await new OperationDispatcher({
      db: database.db,
      registry,
    }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_missing_subject",
      operationId: "alpha.echo",
      input: {},
      subject: { source: "service_api" },
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected dispatcher error");
    }
    expect(result.errorCode).toBe("operation_subject_missing");
    expect(invoked).toBe(false);
    expect(database.db.select().from(operationInvocationAudits).all()).toEqual(
      [],
    );
  });

  test("invokes plugin runtime and completes audit when granted", async () => {
    const registry = alphaRegistry(async () => ({
      status: "success",
      summary: { echoed: true },
      output: { ok: true },
      artifacts: [],
    }));
    seedAlphaPolicyAndUser(database.db);
    new AuthorizationRuleStore(database.db,{kind:"agent",agentId:fixtureScope(database.db,"user_1").agentId}).addGrant({ matchType: "exact",
      subjectType: "user",
      subjectId: "user_1",
      target: "alpha.echo",
      effect: "allow",
    });

    const result = await new OperationDispatcher({
      db: database.db,
      registry,
    }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_allowed",
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });

    expect(result.status).toBe("success");
    expect(
      database.db.select().from(operationInvocationAudits).get()?.status,
    ).toBe("success");
  });

  test("blocks plugin artifact creation when host permission is missing", async () => {
    const registry = alphaRegistry(async ({ runtimeContext }) => {
      runtimeContext!.artifacts.registerContent({
        scopeType: "test",
        scopeId: "cinv_host_permission",
        kind: "text",
        name: "blocked.txt",
        mimeType: "text/plain",
        content: new TextEncoder().encode("blocked"),
      });
      return { status: "success", summary: {}, artifacts: [] };
    }, []);
    seedAlphaPolicyAndUser(database.db);
    new AuthorizationRuleStore(database.db,{kind:"agent",agentId:fixtureScope(database.db,"user_1").agentId}).addGrant({ matchType: "exact",
      subjectType: "user",
      subjectId: "user_1",
      target: "alpha.echo",
      effect: "allow",
    });

    const result = await new OperationDispatcher({
      db: database.db,
      registry,
    }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_host_permission",
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected dispatcher error");
    }
    expect(result.errorCode).toBe("host_permission_denied");
    const audit = database.db.select().from(operationInvocationAudits).get();
    expect(audit?.status).toBe("error");
    expect(audit?.error_code).toBe("host_permission_denied");
  });

  test("runtime context exposes plugin config logger and temp workspace APIs", async () => {
    let observedConfig: unknown;
    let observedTempFile: string | undefined;
    const registry = alphaRegistry(
      async ({ runtimeContext }) => {
        observedConfig = runtimeContext!.config;
        runtimeContext!.logger.info({ checked: true }, "runtime context test");
        observedTempFile = runtimeContext!.workspace.tempFile({
          prefix: "alpha",
          suffix: ".txt",
        });
        return { status: "success", summary: {}, artifacts: [] };
      },
      ["workspace.tempFile"],
      { flag: true },
    );
    seedAlphaPolicyAndUser(database.db);
    new AuthorizationRuleStore(database.db,{kind:"agent",agentId:fixtureScope(database.db,"user_1").agentId}).addGrant({ matchType: "exact",
      subjectType: "user",
      subjectId: "user_1",
      target: "alpha.echo",
      effect: "allow",
    });

    const result = await new OperationDispatcher({
      db: database.db,
      registry,
    }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_runtime_context",
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });

    expect(result.status).toBe("success");
    expect(observedConfig).toEqual({ flag: true });
    expect(observedTempFile).toContain(
      join("plugins", "workspaces", "alpha", "cinv_runtime_context"),
    );
    expect(existsSync(observedTempFile!)).toBe(true);
  });

  test("an unrelated allow does not grant the requested operation", async () => {
    let invoked = false;
    const registry = twoCapRegistry(async () => { invoked = true; return { status: "success", summary: {}, artifacts: [] }; });
    seedTwoPolicies(database.db, "alpha.gate", "allow", "alpha.echo", "deny");
    new AuthorizationRuleStore(database.db,{kind:"agent",agentId:fixtureScope(database.db,"user_1").agentId}).addGrant({ matchType: "exact", subjectType: "user", subjectId: "user_1", target: "alpha.gate", effect: "allow" });

    const result = await new OperationDispatcher({ db: database.db, registry }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_2phase_override_denied",
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.errorCode).toBe("operation_not_granted");
    expect(invoked).toBe(false);
  });

  test("only the requested operation needs an allow rule", async () => {
    let invoked = false;
    const registry = twoCapRegistry(async () => { invoked = true; return { status: "success", summary: {}, artifacts: [] }; });
    seedTwoPolicies(database.db, "alpha.gate", "deny", "alpha.echo", "allow");
    new AuthorizationRuleStore(database.db,{kind:"agent",agentId:fixtureScope(database.db,"user_1").agentId}).addGrant({ matchType: "exact", subjectType: "user", subjectId: "user_1", target: "alpha.echo", effect: "allow" });

    const result = await new OperationDispatcher({ db: database.db, registry }).invoke({scope:fixtureScope(database.db,"user_1"),
      invocationId: "cinv_2phase_entry_denied",
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });
    expect(result.status).toBe("success");
    expect(invoked).toBe(true);
  });

  test("single operation authorization", async () => {
    const registry = alphaRegistry(async () => ({ status: "success", summary: {}, artifacts: [] }));
    seedAlphaPolicyAndUser(database.db);
    new AuthorizationRuleStore(database.db,{kind:"agent",agentId:fixtureScope(database.db,"user_1").agentId}).addGrant({ matchType: "exact", subjectType: "user", subjectId: "user_1", target: "alpha.echo", effect: "allow" });
    const result = await new OperationDispatcher({ db: database.db, registry }).invoke({scope:fixtureScope(database.db,"user_1"),
      operationId: "alpha.echo",
      input: {},
      subject: { userId: "user_1", source: "cli" },
    });
    expect(result.status).toBe("success");
  });
});

function twoCapRegistry(
  invoke: ReturnType<PluginRuntimeFactory>["invoke"],
): PluginRegistry {
  const registry = new PluginRegistry();
  registry.registerPlugin(
    {
      agentScopeVersion:2,id: "alpha", displayName: "Alpha", version: "1.0.0", source: "bundled",
      requestedHostPermissions: ["artifact.create"],
      operations: [
        { id: "alpha.gate", pluginId: "alpha", title: "Gate", inputSchema: { type: "object" }, riskLevel: "low", artifactPolicy: "none", defaultDecision: "allow" },
        { id: "alpha.echo", pluginId: "alpha", title: "Echo", inputSchema: { type: "object" }, riskLevel: "low", artifactPolicy: "none" },
      ],
      commands: [],
      tools: [],
      skills: [],
    } satisfies PluginManifest,
    () => ({ invoke }),
    {},
  );
  new AgentPluginStore(database.db,registry).put("user_1",fixtureScope(database.db,"user_1").agentId,"alpha",{expectedRevision:null,enabled:true,config:{}});
  return registry;
}

function seedTwoPolicies(
  db: DataConnection<typeof schema>["db"],
  idA: string,
  decisionA: "allow" | "deny",
  idB: string,
  decisionB: "allow" | "deny",
): void {
  const now = String(Date.now());
  for (const [id, decision] of [[idA, decisionA], [idB, decisionB]] as const) {
    registerFixtureOperations(db, {
        id, namespace: "alpha", operationKind: "execute", riskLevel: "low",
        defaultDecision: decision, providerType: "plugin", pluginId: "alpha",
        title: id, description: null, status: "active",
        allowedSubjectTypesJson: ["user"], constraintsSchemaJson: null, metadataJson: null,
        createdAt: now, updatedAt: now,
      });
  }
  db.insert(users)
    .values({
      id: "user_1", kind: "human", displayName: "User 1", avatarUrl: null,
      status: "active", mergedIntoUserId: null, profileSource: "test",
      createdAt: now, updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

function alphaRegistry(
  invoke: ReturnType<PluginRuntimeFactory>["invoke"],
  requestedHostPermissions: PluginManifest["requestedHostPermissions"] =
    alphaManifest.requestedHostPermissions,
  pluginConfig: unknown = {},
): PluginRegistry {
  const registry = new PluginRegistry();
  registry.registerPlugin(
    { ...alphaManifest, requestedHostPermissions },
    () => ({ invoke }),
    pluginConfig,
  );
  new AgentPluginStore(database.db,registry).put("user_1",fixtureScope(database.db,"user_1").agentId,"alpha",{expectedRevision:null,enabled:true,config:pluginConfig as Record<string,string|number|boolean|null>});
  return registry;
}

const alphaManifest = {
  agentScopeVersion:2,
  id: "alpha",
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
    },
  ],
  tools: [],
  skills: [],
} satisfies PluginManifest;

function seedAlphaPolicyAndUser(db: DataConnection<typeof schema>["db"]): void {
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
  db.insert(users)
    .values({
      id: "user_1",
      kind: "human",
      displayName: "User 1",
      avatarUrl: null,
      status: "active",
      mergedIntoUserId: null,
      profileSource: "test",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing().run();
}
