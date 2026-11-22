import { expect, test } from "bun:test";
import { runClientCli } from "@luna/cli/main";

test("recipient CLI uses runner endpoints, unified addresses and derived Protocol v2 idempotency keys", async () => {
  const requests: { path: string; body: unknown; key: string | null; version: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        path: url.pathname + url.search,
        body: req.method === "GET" ? null : await req.json(),
        key: req.headers.get("idempotency-key"),
        version: req.headers.get("x-luna-protocol-version"),
      });
      return Response.json(
        url.pathname === "/api/runner/messages"
          ? { commandId: "message-command", status: "sent", deliveryStatus: "sent" }
          : { ok: true },
      );
    },
  });
  const env = {
    LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`,
    LUNA_ACCESS_TOKEN: "test",
    LUNA_INVOCATION_ID: "inv-recipient-1",
  };
  try {
    expect((await runClientCli(["users", "search", "--query", "张 三", "--limit", "10"], env)).status).toBe("ok");
    expect((await runClientCli(["users", "get", "canonical-user"], env)).status).toBe("ok");
    expect((await runClientCli(["users", "lookup", "--channel-id", "feishu", "--feishu-user-id", "ou_new"], env)).status).toBe("ok");
    expect((await runClientCli(["say", "--to", "user:canonical-user", "--text", "Hello"], env)).status).toBe("ok");
    expect(requests[0]?.path).toContain("/api/runner/users?");
    expect(new URL(requests[0]!.path, "http://localhost").searchParams.get("q")).toBe("张 三");
    expect(requests[0]?.version).toBe("2");
    expect(requests[1]?.path).toBe("/api/runner/users/canonical-user");
    expect(requests[2]?.path).toContain("/api/runner/users/lookup?");
    expect(requests[3]?.key).toMatch(/^v2_[0-9a-f]{32}$/);
    expect(requests[3]?.body).toMatchObject({
      to: "user:canonical-user",
      purpose: "notification",
    });

    // Legacy targets and --request-id are rejected before hitting the network.
    expect((await runClientCli(["say", "--feishu-user-id", "ou_new", "--text", "x"], env)).status).toBe("error");
    expect((await runClientCli(["say", "--text", "x", "--request-id", "old"], env)).status).toBe("error");
    expect(requests).toHaveLength(4);
  } finally {
    server.stop(true);
  }
});

test("group CLI uses runner directory and passes unified user/group addresses", async () => {
  const requests: { path: string; body: unknown; key: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({
        path,
        body: req.method === "GET" ? null : await req.json(),
        key: req.headers.get("idempotency-key"),
      });
      return Response.json(
        path === "/api/runner/messages"
          ? { commandId: "message-command", status: "sent", deliveryStatus: "sent" }
          : { commandId: "group-command", status: "applied", ok: true },
      );
    },
  });
  const env = {
    LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`,
    LUNA_ACCESS_TOKEN: "test",
    LUNA_INVOCATION_ID: "inv-group-1",
  };
  try {
    for (const argv of [
      ["groups", "search", "--query", "项目"],
      ["groups", "get", "group-id"],
      ["groups", "lookup", "--channel-id", "feishu", "--chat-id", "oc_group"],
      ["groups", "create", "--name", "Project", "--member", "user:u_a", "--member", "user:u_b"],
      ["groups", "invite", "--to", "group:group-id", "--member", "user:u_c"],
      ["say", "--to", "group:group-id", "--text", "hi"],
    ]) {
      expect((await runClientCli(argv, env)).status).toBe("ok");
    }
    expect(requests.map(r => r.path)).toEqual([
      "/api/runner/groups",
      "/api/runner/groups/group-id",
      "/api/runner/groups/lookup",
      "/api/runner/groups",
      "/api/runner/groups/invite",
      "/api/runner/messages",
    ]);
    expect(requests[3]?.key).toMatch(/^v2_[0-9a-f]{32}$/);
    expect(requests[3]?.body).toMatchObject({ name: "Project", memberIds: ["user:u_a", "user:u_b"] });
    expect(requests[4]?.body).toMatchObject({ to: "group:group-id", memberIds: ["user:u_c"] });
    expect(requests[5]?.body).toMatchObject({ to: "group:group-id", purpose: "notification" });
  } finally {
    server.stop(true);
  }
});
