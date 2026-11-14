import { describe, expect, test } from "bun:test";

import {
  agentTypeDescriptors,
  validateAgentProfileInput,
} from "../../src/agent-config";

describe("agent type descriptors", () => {
  test("publishes the two production agent types", () => {
    expect(agentTypeDescriptors.map((item) => item.type)).toEqual([
      "claude",
      "codex",
    ]);
    expect(agentTypeDescriptors.every((item) => item.defaultResumeOnModelChange))
      .toBe(true);
  });

  test("Codex connection mode affects provider identity", () => {
    const codex = agentTypeDescriptors.find((item) => item.type === "codex")!;
    expect(
      codex.envFields.find((item) => item.key === "CODEX_PROVIDER_MODE"),
    ).toMatchObject({ sensitive: false, affectsProviderIdentity: true });
  });
});

describe("agent profile validation", () => {
  test("requires a safe base URL when Codex uses a gateway", () => {
    for (const url of ["", "file:///tmp/gateway", "https://u:p@gateway.test/v1", "https://gateway.test/v1?key=value"]) {
      expect(() => validateAgentProfileInput({
        agentType: "codex", model: "gpt-5.6-sol",
        env: { CODEX_PROVIDER_MODE: "gateway", OPENAI_BASE_URL: url },
      })).toThrow("OPENAI_BASE_URL");
    }
  });

  test("accepts known non-sensitive env and known secrets", () => {
    expect(
      validateAgentProfileInput({
        agentType: "claude",
        model: "claude-sonnet-4-6",
        env: { ANTHROPIC_BASE_URL: "https://example.test" },
        secrets: { ANTHROPIC_API_KEY: { set: "secret" } },
      }),
    ).toEqual({
      agentType: "claude",
      model: "claude-sonnet-4-6",
      resumeOnModelChange: true,
      env: { ANTHROPIC_BASE_URL: "https://example.test" },
      secrets: { ANTHROPIC_API_KEY: { set: "secret" } },
      customSensitiveKeys: [],
    });
  });

  test("accepts Claude API timeout without allowing unrelated prefixes", () => {
    expect(
      validateAgentProfileInput({
        agentType: "claude",
        model: "glm-5.2[1m]",
        env: { API_TIMEOUT_MS: "3000000" },
        secrets: {},
      }).env,
    ).toEqual({ API_TIMEOUT_MS: "3000000" });

    expect(() =>
      validateAgentProfileInput({
        agentType: "claude",
        model: "glm-5.2[1m]",
        env: { API_TIMEOUT_MS_EXTRA: "3000000" },
        secrets: {},
      }),
    ).toThrow("API_TIMEOUT_MS_EXTRA");
  });

  test("rejects control variables and unrelated prefixes", () => {
    for (const key of ["PATH", "HOME", "LUNA_SERVICE_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      expect(() =>
        validateAgentProfileInput({
          agentType: "codex",
          model: "gpt-5",
          env: { [key]: "unsafe" },
          secrets: {},
        }),
      ).toThrow(key);
    }
  });

  test("requires unknown custom variables to be explicitly sensitive", () => {
    expect(() =>
      validateAgentProfileInput({
        agentType: "codex",
        model: "gpt-5",
        env: { CODEX_VENDOR_TOKEN: "secret" },
        secrets: {},
      }),
    ).toThrow(/sensitive/i);

    expect(
      validateAgentProfileInput({
        agentType: "codex",
        model: "gpt-5",
        env: {},
        secrets: { CODEX_VENDOR_TOKEN: { set: "secret" } },
        customSensitiveKeys: ["CODEX_VENDOR_TOKEN"],
      }).customSensitiveKeys,
    ).toEqual(["CODEX_VENDOR_TOKEN"]);
  });
});
