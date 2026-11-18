import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { ArtifactRegistry } from "../../src/artifacts/artifact-registry";
import { createPluginRuntimeContext, PluginHostPermissionError } from "../../src/plugins/runtime-context";
import { config, setLunaHome } from "../../src/shared";
import { AgentStore } from "@/agents/agent-store";
import { TaskScopeResolver } from "@/agents/task-scope";
import { fixtureScope } from "../helpers/platform-fixtures";
import type { HostPermission, PluginManifest } from "@luna/plugin-contracts";

let testHome: string, previousHome: string;
let scope: ReturnType<typeof fixtureScope>;
const owner = "host-exec-owner";
const taskId = "task_1";
let database: DataConnection<typeof schema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-hostexec-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(schema);
  scope = fixtureScope(database.db, owner);
  seedTask(taskId, scope);
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

function seedTask(id: string, taskScope: typeof scope) {
  database.db.insert(schema.tasks).values({
    id, agent_id: taskScope.agentId, shadow_id: taskScope.shadowId, creator_user_id: taskScope.ownerUserId,
    type: "work", title: id, status: "running", created_at: 1, updated_at: 1, last_activity_at: 1,
  }).run();
}

function manifest(allowed: string[], allowedEnv: string[] = [], perms: readonly HostPermission[] = ["host.exec"]): PluginManifest {
  return {
    id: "p", displayName: "p", version: "1", source: "bundled",
    requestedHostPermissions: perms,
    allowedExecutables: allowed,
    allowedEnvKeys: allowedEnv,
    operations: [],
  } as unknown as PluginManifest;
}

function makeCtx(
  m: PluginManifest,
  options: { readonly executionRoot?: string } = {},
) {
  return createPluginRuntimeContext({
    db: database.db,
    scope,
    resourceOwner: {type: "task", id: taskId},
    validate: () => {
      new AgentStore(database.db).requireScope(scope.ownerUserId, scope);
      new TaskScopeResolver(database.db).task(taskId);
    },
    hostPermissions: m.requestedHostPermissions,
    manifest: m,
    invocation: { pluginId: "p", operationId: "p.op", invocationId: "inv", subject: { source: "task_runner", userId: scope.ownerUserId } },
    ...(options.executionRoot === undefined
      ? {}
      : { executionRoot: options.executionRoot }),
  });
}

describe("host.exec", () => {
  test("rejects executable not in allowlist", async () => {
    const ctx = makeCtx(manifest(["lark-cli"]));
    await expect(ctx.host.exec({ cmd: "rm", args: ["-rf", "/"] })).rejects.toThrow(/not allowed/i);
  });

  test("rejects when host.exec permission missing", async () => {
    const ctx = makeCtx(manifest(["echo"], [], []));
    await expect(ctx.host.exec({ cmd: "echo", args: ["hi"] })).rejects.toBeInstanceOf(PluginHostPermissionError);
  });

  test("spawns allowlisted cmd, buffered stdout/stderr/exit", async () => {
    const script = join(testHome, "ok.sh");
    writeFileSync(script, "#!/bin/sh\necho out; echo err 1>&2\n");
    chmodSync(script, 0o755);
    const ctx = makeCtx(manifest([script]));
    const r = await ctx.host.exec({ cmd: script, args: [], stdin: "" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  test("spawns an allowlisted executable from the runner root", async () => {
    const runnerRoot = join(testHome, "runners", "task_1");
    mkdirSync(runnerRoot, { recursive: true });
    const script = join(testHome, "pwd.sh");
    writeFileSync(script, "#!/bin/sh\npwd\n");
    chmodSync(script, 0o755);

    const result = await makeCtx(manifest([script]), {
      executionRoot: runnerRoot,
    }).host.exec({ cmd: script, args: [] });

    expect(result.stdout.trim()).toBe(realpathSync(runnerRoot));
  });

  test("only allows listed env keys; inherits base process.env PATH", async () => {
    const script = join(testHome, "env.sh");
    writeFileSync(script, '#!/bin/sh\necho "PATH=$PATH"; echo "OK=$OK"; echo "LEAK=$LEAK"\n');
    chmodSync(script, 0o755);
    const ctx = makeCtx(manifest([script], ["OK"]));
    const r = await ctx.host.exec({ cmd: script, args: [], env: { OK: "yes", LEAK: "leaked" } });
    expect(r.stdout).toContain("PATH=");
    expect(r.stdout).toContain("OK=yes");
    expect(r.stdout).not.toContain("leaked");
  });
});

describe("plugin artifacts", () => {
  test("materializes artifact refs to managed local storage paths", () => {
    const source = join(testHome, "source.txt");
    writeFileSync(source, "hello");
    const artifact = new ArtifactRegistry(database.db).registerLocalFile({
      scopeType: "task",
      scopeId: taskId,
      producer: "test",
      kind: "text",
      name: "source.txt",
      path: source,
    });
    const ctx = makeCtx(manifest([], [], ["artifact.materialize"]));

    const materialized = ctx.artifacts.materializeLocalFile({
      ref: `artifact:${artifact.id}`,
    });

    expect(materialized).toMatchObject({
      artifactId: artifact.id,
      name: "source.txt",
      mimeType: "text/plain; charset=utf-8",
      sizeBytes: 5,
    });
    expect(materialized.path).toBe(artifact.storage_key);
  });

  test("a Task Runner cannot materialize artifacts owned by another task or Shadow", () => {
    const otherShadow = new AgentStore(database.db).createShadow(owner, scope.agentId, {name: "Other Shadow"}, "other");
    seedTask("same-shadow", scope);
    seedTask("other-shadow", {...scope, shadowId: otherShadow.id});
    const registry = new ArtifactRegistry(database.db);
    const ctx = makeCtx(manifest([], [], ["artifact.materialize"]));
    for (const [scopeId, error] of [
      ["same-shadow", "plugin_artifact_owner_denied"],
      ["other-shadow", "task_scope_mismatch"],
    ] as const) {
      const artifact = registry.registerContent({
        scopeType: "task", scopeId, producer: "test", kind: "text", name: "private.txt", content: Buffer.from("private"),
      });
      expect(() => ctx.artifacts.materializeLocalFile({ref: `artifact:${artifact.id}`})).toThrow(error);
    }
  });

  test("rejects materialization when host permission is missing", () => {
    const ctx = makeCtx(manifest([], [], []));

    expect(() =>
      ctx.artifacts.materializeLocalFile({ ref: "artifact:missing" })
    ).toThrow(PluginHostPermissionError);
  });
});
