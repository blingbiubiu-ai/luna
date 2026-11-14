import { afterEach, expect, test } from "bun:test";
import { testAgentProfileConnection } from "../src/lib/api/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function respond(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}
test("accepts successful connection tests", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return Response.json({ result: { success: true } });
  }) as typeof fetch;
  await expect(testAgentProfileConnection("agent/1", "revision/1")).resolves.toBeUndefined();
  expect(requests).toEqual([{ url: "/api/agent-config/revisions/revision%2F1/test?agentId=agent%2F1", method: "POST" }]);
});
test("preserves runner diagnostics from 422 responses", async () => {
  respond({ result: { success: false, message: "Agent connection test timed out" } }, 422);
  await expect(testAgentProfileConnection("agent-1", "revision-1")).rejects.toThrow("Agent connection test timed out");
});
test("preserves domain errors", async () => {
  respond({ message: "Agent profile revision not found" }, 400);
  await expect(testAgentProfileConnection("agent-1", "missing")).rejects.toThrow("Agent profile revision not found");
});
test("handles non-JSON server failures", async () => {
  globalThis.fetch = (async () => new Response("Bad gateway", { status: 502 })) as typeof fetch;
  await expect(testAgentProfileConnection("agent-1", "revision-1")).rejects.toThrow("HTTP 502");
});
test("does not treat an unexpected success body as a passed test", async () => {
  respond({});
  await expect(testAgentProfileConnection("agent-1", "revision-1")).rejects.toThrow("Connection test failed");
});
