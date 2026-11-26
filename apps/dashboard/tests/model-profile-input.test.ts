import { describe, expect, test } from "bun:test";
import { buildProfileRevision, initialProfileExecutionDriver, type ProfileDraft } from "../src/app/settings/model-profile-input";
import { accountReference, resolveModelHint, type AccountTarget, type ModelAccount, type ProviderSource } from "../src/app/plugins/worker-models";

const target: AccountTarget = { agentId: "agent-a", pluginId: "plugin-a", providerId: "provider-a", workerId: "worker-a" };
const account: ModelAccount = { ...target, accountId: "account-a", credentialRevision: "credential-a", releaseSha256: "release-a", name: "Account", state: "ready", expiresAt: null, models: [{ id: "model-a", name: "Model A" }] };
const reference = accountReference(target, account)!;
const source: ProviderSource = { key: "source-a", target, account, reference, provider: { pluginId: target.pluginId, providerId: target.providerId, name: "Provider", enabled: true, loginLabel: null }, worker: { workerId: target.workerId, ready: true, supported: true, paused: false }, ready: true, loading: false, error: false };
const draft: ProfileDraft = { agentType: "codex", model: "model-a", executionDriver: "stdio", resume: true, gateway: true, workerMode: false, source: null, envText: "OPENAI_BASE_URL=https://gateway.test/v1\nCODEX_CUSTOM=retained", replacements: {}, newSecrets: [], configuredKeys: ["OPENAI_API_KEY", "CODEX_CUSTOM_SECRET"] };

describe("Provider selection ownership", () => {
  test("refuses accounts from a different Agent, plugin or Provider", () => {
    for (const key of ["agentId", "pluginId", "providerId"] as const) expect(accountReference(target, { ...account, [key]: "other" })).toBeNull();
    expect(accountReference(target, account)).toEqual(reference);
  });
  test("deep links require the exact ready source and a catalog model", () => {
    const hint = { ...target, model: "model-a" };
    expect(resolveModelHint(target.agentId, hint, [source])?.reference).toEqual(reference);
    for (const key of ["pluginId", "providerId", "workerId", "model"] as const) expect(resolveModelHint(target.agentId, { ...hint, [key]: "other" }, [source])).toBeNull();
    expect(resolveModelHint("other-agent", hint, [source])).toBeNull();
    expect(resolveModelHint(target.agentId, hint, [{ ...source, ready: false }])).toBeNull();
    expect(resolveModelHint(target.agentId, hint, [{ ...source, account: { ...account, state: "expired" } }])).toBeNull();
  });
});

describe("Profile revision input", () => {
  test("new configurations default to TUI while edits retain the existing execution driver", () => {
    expect(initialProfileExecutionDriver()).toBe("pty");
    expect(initialProfileExecutionDriver({ executionDriver: "stdio" })).toBe("stdio");
    expect(initialProfileExecutionDriver({ executionDriver: "pty" })).toBe("pty");
    expect(initialProfileExecutionDriver({})).toBe("stdio");
    for (const executionDriver of ["pty", "stdio"] as const) expect(buildProfileRevision({ ...draft, executionDriver }).executionDriver).toBe(executionDriver);
  });
  test("Provider conversion clears retained gateway credentials and preserves unrelated settings", () => {
    const input = buildProfileRevision({ ...draft, workerMode: true, source: reference });
    expect(input.modelProvider).toEqual(reference);
    expect(input.env).toEqual({ CODEX_CUSTOM: "retained" });
    expect(input.secrets).toEqual({ OPENAI_API_KEY: { clear: true } });
    expect(input.secrets).not.toHaveProperty("CODEX_CUSTOM_SECRET");
  });
  test("manual revisions retain write-only secrets unless explicitly replaced", () => {
    const input = buildProfileRevision(draft);
    expect(input.env.CODEX_PROVIDER_MODE).toBe("gateway");
    expect(input.env.OPENAI_BASE_URL).toBe("https://gateway.test/v1");
    expect(input.secrets).toEqual({});
    expect(buildProfileRevision({ ...draft, replacements: { OPENAI_API_KEY: "replacement" } }).secrets).toEqual({ OPENAI_API_KEY: { set: "replacement" } });
    expect(buildProfileRevision({ ...draft, gateway: false }).env).not.toHaveProperty("CODEX_PROVIDER_MODE");
  });
  test("validates missing bindings and duplicate or empty secrets before saving", () => {
    expect(() => buildProfileRevision({ ...draft, workerMode: true })).toThrow("Worker");
    expect(() => buildProfileRevision({ ...draft, newSecrets: [{ key: "OPENAI_API_KEY", value: "duplicate" }] })).toThrow("already exists");
    expect(() => buildProfileRevision({ ...draft, replacements: { OPENAI_API_KEY: "" } })).toThrow("Enter a value");
    expect(() => buildProfileRevision({ ...draft, newSecrets: [{ key: "bad key", value: "value" }] })).toThrow("valid environment variable");
  });
});
