import { expect, test } from "bun:test";
import { ContainerAgentRunner } from "../../src/runners/container-agent-runner";

test("Runtime execution failures are not retried by ContainerAgentRunner", async () => {
  let attempts = 0;
  const transport = { async *stream() {
    attempts++;
    const error = new Error("rate limited");
    Object.assign(error, { failure: { kind: "rate_limited", provider: "claude", message: "rate limited" } });
    throw error;
  } };
  const runner = new ContainerAgentRunner(transport, "claude", "test");
  await expect(runner.stream(
    { id: "message", session_id: "session", role: "user", content: [{ type: "text", text: "hello" }] },
    { cwd: "/tmp", isNewSession: true },
  ).next()).rejects.toThrow("rate limited");
  expect(attempts).toBe(1);
});
