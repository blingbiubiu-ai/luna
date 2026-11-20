import {fixtureScope} from "../helpers/platform-fixtures";
import {fixtureRunnerContext, fixtureNamedSession} from "../helpers/platform-fixtures";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  ActiveAgentConfigService,
  AgentProfileStore,
  AgentSecretCipher,
} from "../../src/agent-config";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { activeAgentConfig, runnerContexts } from "../../src/data/schema";
import { RunnerContextStore } from "../../src/runners/runner-context-store";
import { reloadConfig, setLunaHome } from "../../src/shared/config";
import { createSessionRunnerPaths } from "../../src/shared/runner-paths";

const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "luna-agent-runtime-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), "{}\n");
  setLunaHome(home);
  reloadConfig();
  const connection = new DataConnection(schema);
  const cipher = AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: randomBytes(32).toString("base64"),
  });
  const profiles = new AgentProfileStore(connection.db, cipher, fixtureScope(connection.db).agentId);
  const active = new ActiveAgentConfigService(connection.db, cipher);
  return { connection, profiles, active };
}

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

describe("ActiveAgentConfigService", () => {
  test("activates only a validated revision and resolves a secret-bearing snapshot", () => {
    const { connection, profiles, active } = setup();
    const profile = profiles.createProfile({
      name: "Codex",
      agentType: "codex",
      model: "gpt-5",
      env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
      secrets: { OPENAI_API_KEY: { set: "secret-value" } },
    });
    expect(() => active.activate(profiles.agentId, profile.latestRevision.id, "fixture-owner"))
      .toThrow(/validated/i);
    profiles.recordValidation(profile.latestRevision.id, {
      success: true,
      message: "connected",
    });

    active.activate(profiles.agentId, profile.latestRevision.id, "fixture-owner");
    const snapshot = active.resolveExecutionSnapshot(profiles.agentId);

    expect(snapshot).toMatchObject({
      profileId: profile.id,
      revisionId: profile.latestRevision.id,
      agentType: "codex",
      model: "gpt-5",
      resumeOnModelChange: true,
      env: {
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_API_KEY: "secret-value",
      },
    });
    expect(snapshot.providerFingerprint).toHaveLength(64);
    expect(snapshot.modelFingerprint).toHaveLength(64);
    connection.close();
  });

  test("activation changes only the Agent pointer", () => {
    const { connection, profiles, active } = setup();
    const profile = profiles.createProfile({
      name: "Claude",
      agentType: "claude",
      model: "claude-sonnet-4-6",
      env: {},
      secrets: {},
    });
    profiles.recordValidation(profile.latestRevision.id, { success: true, message: "ok" });
    connection.db.insert(runnerContexts).values(fixtureRunnerContext(connection.db, contextRow(connection.db, "context-1"))).run();
    const before = connection.db.select().from(runnerContexts).get()!;

    active.activate(profiles.agentId, profile.latestRevision.id, "fixture-owner");

    expect(connection.db.select().from(runnerContexts).get()).toEqual(before);
    expect(connection.db.select().from(activeAgentConfig).all()).toHaveLength(1);
    connection.close();
  });

  test("resolves the active runner type without decrypting credentials", () => {
    const { connection, profiles, active } = setup();
    const profile = profiles.createProfile({
      name: "Codex",
      agentType: "codex",
      model: "gpt-5",
      env: {},
      secrets: { OPENAI_API_KEY: { set: "secret-value" } },
    });
    profiles.recordValidation(profile.latestRevision.id, { success: true, message: "ok" });
    active.activate(profiles.agentId, profile.latestRevision.id, "fixture-owner");

    const withoutKey = new ActiveAgentConfigService(connection.db, undefined);
    expect(withoutKey.resolveActiveAgentType(profiles.agentId)).toBe("codex");
    expect(() => withoutKey.resolveExecutionSnapshot(profiles.agentId)).toThrow(/secret key is unavailable/i);
    connection.close();
  });
});

describe("lazy runner resume compatibility", () => {
  test("provider change always invalidates the stored resume id", () => {
    const { connection } = setup();
    connection.db.insert(runnerContexts).values(fixtureRunnerContext(connection.db, contextRow(connection.db, "provider-change"))).run();
    const store = new RunnerContextStore(connection.db);
    const result = store.syncAgentCompatibility("provider-change", {
      providerFingerprint: "provider-b",
      modelFingerprint: "model-a",
      resumeOnModelChange: true,
    });
    expect(result.runnerSessionInvalidated).toBe(true);
    expect(result.runnerContext.runner_session_id).toBeNull();
    connection.close();
  });

  test("model-only change follows the profile resume policy", () => {
    for (const [resumeOnModelChange, invalidated] of [[true, false], [false, true]] as const) {
      const { connection } = setup();
      const id = `model-${resumeOnModelChange}`;
      connection.db.insert(runnerContexts).values(fixtureRunnerContext(connection.db, contextRow(connection.db, id))).run();
      const result = new RunnerContextStore(connection.db).syncAgentCompatibility(id, {
        providerFingerprint: "provider-a",
        modelFingerprint: "model-b",
        resumeOnModelChange,
      });
      expect(result.runnerSessionInvalidated).toBe(invalidated);
      expect(result.runnerContext.runner_session_id).toBe(
        invalidated ? null : "resume-id",
      );
      connection.close();
    }
  });
});

function contextRow(db: import("../../src/data").DrizzleDB, id: string) {
  fixtureNamedSession(db, id);
  return {
    id,
    owner_type: "session",
    owner_id: id,
    runner_type: "codex",
    runner_session_id: "resume-id",
    instruction_fingerprint: "instructions",
    provider_fingerprint: "provider-a",
    model_fingerprint: "model-a",
    runner_root_path: createSessionRunnerPaths(id).runnerRootPath,
    last_run_id: null,
    created_at: 1,
    updated_at: 1,
  };
}
