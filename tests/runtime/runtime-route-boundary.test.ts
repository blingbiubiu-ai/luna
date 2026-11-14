import { expect, test } from "bun:test";
import { Hono } from "hono";
import { runtimeRoutes } from "../../src/server/routes/runtime";

test("runtime HTTP routes cannot inject synthetic verified channel identities", async () => {
  // Even after authentication, runtime routes must not expose a test-only writer.
  const app = new Hono().route("/api/runtime", runtimeRoutes);
  const response = await app.request("/api/runtime/test/inject-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ senderId: "another-user", channelId: "feishu-default", text: "injected", sync: true }),
  });
  expect(response.status).toBe(404);
});
