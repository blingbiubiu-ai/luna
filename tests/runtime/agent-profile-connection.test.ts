import { describe, expect, test } from "bun:test";

import {
  AgentProfileConnectionTester,
  buildConnectionTestDockerArgs,
  type AgentConnectionTestRequest,
} from "../../src/agent-config";

describe("AgentProfileConnectionTester", () => {
  test("keeps stdin attached for the one-shot worker protocol", () => {
    const args = buildConnectionTestDockerArgs("test-container", {
      image: "luna-runner:latest",
      runnerType: "codex",
      model: "gpt-5",
      prompt: "test",
      env: {},
      timeoutMs: 60_000,
    });
    expect(args.slice(0, 3)).toEqual(["docker", "run", "-i"]);
    expect(args).not.toContain("-v");
    expect(args).toContain(
      "/luna-runner/agent-profile-test:rw,size=256m,uid=1000,gid=1000",
    );
    expect(args).toContain("HOME=/luna-runner/agent-profile-test");
    expect(args).toContain("LUNA_RUNNER_HOME=/luna-runner/agent-profile-test");
    expect(args[args.indexOf("-w") + 1]).toBe("/luna-runner/agent-profile-test");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("bun");
    expect(args.slice(-2)).toEqual(["luna-runner:latest", "/app/agent-runner/dist/job-main.js"]);
  });

  test("uses a disposable one-shot runner request without business operations", async () => {
    let captured: AgentConnectionTestRequest | undefined;
    const tester = new AgentProfileConnectionTester({
      execute: async (request) => {
        captured = request;
        return { success: true, output: "LUNA_AGENT_PROFILE_OK" };
      },
    });

    const result = await tester.testSnapshot({
      agentId: "connection-test-agent",
      profileId: "profile",
      revisionId: "revision",
      activationSequence: 0,
      agentType: "codex",
      model: "gpt-5",
      resumeOnModelChange: true,
      env: { OPENAI_API_KEY: "secret" },
      providerFingerprint: "provider",
      modelFingerprint: "model",
      configFingerprint: "config",
    });

    expect(result).toEqual({ success: true, message: "Connection succeeded" });
    expect(captured).toMatchObject({
      image: "luna-runner:latest",
      runnerType: "codex",
      model: "gpt-5",
      timeoutMs: 60_000,
      env: { OPENAI_API_KEY: "secret" },
    });
    expect(captured?.prompt).toContain("LUNA_AGENT_PROFILE_OK");
    expect(captured).not.toHaveProperty("sessionId");
    expect(JSON.stringify(captured)).not.toContain("LUNA_ACCESS_TOKEN");
  });

  test("scrubs submitted secrets from failures", async () => {
    const tester = new AgentProfileConnectionTester({
      execute: async () => ({ success: false, output: "bad token secret-value" }),
    });
    const result = await tester.testSnapshot({
      agentId: "connection-test-agent",
      profileId: "p",
      revisionId: "r",
      activationSequence: 0,
      agentType: "claude",
      model: "model",
      resumeOnModelChange: true,
      env: { ANTHROPIC_API_KEY: "secret-value" },
      providerFingerprint: "p",
      modelFingerprint: "m",
      configFingerprint: "c",
    });
    expect(result.success).toBe(false);
    expect(result.message).not.toContain("secret-value");
    expect(result.message).toContain("[REDACTED]");
  });
});
