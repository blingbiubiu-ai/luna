import {fixtureScope} from "../helpers/platform-fixtures";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  AgentProfileStore,
  AgentSecretCipher,
} from "../../src/agent-config";
import { DataConnection } from "../../src/data";
import * as schema from "../../src/data/schema";
import { activeAgentConfig, agentProfileSecrets } from "../../src/data/schema";
import { reloadConfig, setLunaHome } from "../../src/shared/config";

const homes: string[] = [];

function masterKey(): string {
  return randomBytes(32).toString("base64");
}

function openStore() {
  const home = mkdtempSync(join(tmpdir(), "luna-agent-profile-store-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "{}\n",
  );
  setLunaHome(home);
  reloadConfig();
  const connection = new DataConnection(schema);
  const cipher = AgentSecretCipher.fromEnvironment({
    LUNA_AGENT_CONFIG_MASTER_KEY: masterKey(),
  });
  return { connection, cipher, store: new AgentProfileStore(connection.db, cipher, fixtureScope(connection.db).agentId) };
}

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

describe("AgentSecretCipher", () => {
  test("encrypts with authenticated binding and stable credential identity", () => {
    const cipher = AgentSecretCipher.fromEnvironment({
      LUNA_AGENT_CONFIG_MASTER_KEY: masterKey(),
    });
    const binding = { profileId: "p1", revisionId: "r1", key: "OPENAI_API_KEY" };
    const first = cipher.encrypt({ ...binding, plaintext: "top-secret" });
    const second = cipher.encrypt({ ...binding, plaintext: "top-secret" });

    expect(first.ciphertext).not.toBe("top-secret");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.credentialIdentity).toBe(second.credentialIdentity);
    expect(cipher.decrypt({ ...binding, ...first })).toBe("top-secret");
    expect(() =>
      cipher.decrypt({ ...binding, key: "OPENAI_OTHER_KEY", ...first }),
    ).toThrow();
  });

  test("reports an unavailable master key without inventing one", () => {
    expect(AgentSecretCipher.tryFromEnvironment({})).toBeUndefined();
  });
});

describe("AgentProfileStore", () => {
  test("requires an effective gateway key and supports inherited keys", () => {
    const { connection, store } = openStore();
    const config = {
      name: "Gateway",
      agentType: "codex" as const,
      model: "gpt-5.6-sol",
      env: { CODEX_PROVIDER_MODE: "gateway", OPENAI_BASE_URL: "http://gateway.test/v1" },
    };
    expect(() => store.createProfile(config)).toThrow("OPENAI_API_KEY");
    const profile = store.createProfile({ ...config, secrets: { OPENAI_API_KEY: { set: "secret" } } });
    expect(store.createRevision(profile.id, config).secrets.OPENAI_API_KEY?.configured).toBe(true);
    expect(() => store.createRevision(profile.id, {
      ...config, secrets: { OPENAI_API_KEY: { clear: true } },
    })).toThrow("OPENAI_API_KEY");
    connection.close();
  });

  test("starts in setup-required state and returns masked secrets", () => {
    const { connection, store } = openStore();
    expect(store.status()).toEqual({ status: "setup_required", active: null });

    const created = store.createProfile({
      name: "Primary Codex",
      agentType: "codex",
      model: "gpt-5",
      env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
      secrets: { OPENAI_API_KEY: { set: "top-secret" } },
      actorId: "fixture-owner",
    });

    expect(created.latestRevision.secrets).toEqual({
      OPENAI_API_KEY: { configured: true, updatedAt: expect.any(Number) },
    });
    expect(JSON.stringify(created)).not.toContain("top-secret");
    expect(store.listProfiles()).toHaveLength(1);
    connection.close();
  });

  test("creates immutable revisions and re-encrypts retained secrets", () => {
    const { connection, store } = openStore();
    const created = store.createProfile({
      name: "Claude",
      agentType: "claude",
      model: "claude-sonnet-4-6",
      env: {},
      secrets: { ANTHROPIC_API_KEY: { set: "retained-secret" } },
      actorId: "fixture-owner",
    });
    const before = connection.db.select().from(agentProfileSecrets).get()!;

    const revision = store.createRevision(created.id, {
      model: "claude-opus-4-1",
      env: {},
      secrets: {},
      actorId: "fixture-owner",
    });
    const rows = connection.db.select().from(agentProfileSecrets).all();

    expect(revision.revisionNumber).toBe(2);
    expect(revision.validationState).toBe("draft");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.ciphertext).not.toBe(before.ciphertext);
    expect(rows[1]?.credential_identity).toBe(before.credential_identity);
    connection.close();
  });

  test("does not delete the active profile", () => {
    const { connection, store } = openStore();
    const created = store.createProfile({
      name: "Active",
      agentType: "codex",
      model: "gpt-5",
      env: {},
      secrets: {},
      actorId: "fixture-owner",
    });
    connection.db.insert(activeAgentConfig).values({
      agent_id: fixtureScope(connection.db).agentId,
      agent_type: "codex",
      profile_id: created.id,
      revision_id: created.latestRevision.id,
      activation_sequence: 1,
      activated_by_account_id: "fixture-owner",
      activated_at: Date.now(),
    }).run();

    expect(() => store.deleteProfile(created.id, "fixture-owner")).toThrow(/active/i);
    expect(store.getProfile(created.id)?.deletedAt).toBeNull();
    expect(
      connection.db.select().from(activeAgentConfig)
        .where(eq(activeAgentConfig.profile_id, created.id)).get(),
    ).toBeDefined();
    connection.close();
  });

  test("credential replacement changes the non-reversible config fingerprint", () => {
    const { connection, store } = openStore();
    const created = store.createProfile({
      name: "Credential identity",
      agentType: "codex",
      model: "gpt-5",
      env: {},
      secrets: { OPENAI_API_KEY: { set: "first-secret" } },
    });
    const next = store.createRevision(created.id, {
      model: "gpt-5",
      env: {},
      secrets: { OPENAI_API_KEY: { set: "second-secret" } },
    });

    expect(next.configFingerprint).not.toBe(
      created.latestRevision.configFingerprint,
    );
    connection.close();
  });
});
