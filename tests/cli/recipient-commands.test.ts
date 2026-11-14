import { expect, test } from "bun:test";
import { runClientCli } from "@luna/cli/main";

test("recipient CLI uses runner endpoints, typed targets and stable idempotency keys", async () => {
  const requests: { path: string; body: unknown; key: string | null }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    requests.push({ path: url.pathname + url.search, body: req.method === "GET" ? null : await req.json(), key: req.headers.get("idempotency-key") });
    return Response.json(url.pathname === "/api/runner/messages"
      ? { commandId: "message-command", deliveryStatus: "sent" }
      : { ok: true });
  } });
  const env = { LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test" };
  try {
    expect((await runClientCli(["users", "search", "--query", "张 三", "--limit", "10"], env)).status).toBe("ok");
    expect((await runClientCli(["users", "get", "canonical-user"], env)).status).toBe("ok");
    expect((await runClientCli(["users", "lookup", "--channel-id", "feishu", "--feishu-user-id", "ou_new"], env)).status).toBe("ok");
    expect((await runClientCli(["messages", "send", "--channel-id", "feishu", "--feishu-user-id", "ou_new", "--text", "Hello", "--request-id", "first"], env)).status).toBe("ok");
    expect(requests[0]?.path).toContain("/api/runner/users?");
    expect(new URL(requests[0]!.path, "http://localhost").searchParams.get("q")).toBe("张 三");
    expect(requests[1]?.path).toBe("/api/runner/users/canonical-user");
    expect(requests[2]?.path).toContain("/api/runner/users/lookup?");
    expect(requests[3]).toMatchObject({ key: "first", body: { target: { kind: "feishu_user", channelId: "feishu", idType: "open_id", id: "ou_new" } } });
    expect((await runClientCli(["messages", "send", "--session-id", "s", "--feishu-user-id", "ou_new", "--text", "x", "--request-id", "x"], env)).status).toBe("error");
    expect(requests).toHaveLength(4);
  } finally { server.stop(true); }
});

test("group CLI uses runner directory and passes typed create/invite members plus chat targets", async () => {
  const requests: { path: string; body: unknown; key: string | null }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push({ path, body: req.method === "GET" ? null : await req.json(), key: req.headers.get("idempotency-key") });
    return Response.json(path === "/api/runner/messages"
      ? { commandId: "message-command", deliveryStatus: "sent" }
      : { ok: true });
  } });
  const env = { LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test" };
  try {
    for (const argv of [
      ["groups", "search", "--query", "项目"], ["groups", "get", "group-id"], ["groups", "lookup", "--channel-id", "feishu", "--chat-id", "oc_group"],
      ["groups", "create", "--channel-id", "feishu", "--name", "Project", "--member", "ou_a", "--member", "ou_b", "--request-id", "create"],
      ["groups", "invite", "--channel-id", "feishu", "--chat-id", "oc_group", "--member", "ou_c", "--request-id", "invite"],
      ["messages", "send", "--channel-id", "feishu", "--chat-id", "oc_group", "--text", "hi", "--request-id", "send"],
    ]) expect((await runClientCli(argv, env)).status).toBe("ok");
    expect(requests.map(r => r.path)).toEqual(["/api/runner/groups", "/api/runner/groups/group-id", "/api/runner/groups/lookup", "/api/runner/groups", "/api/runner/groups/invite", "/api/runner/messages"]);
    expect(requests[3]).toMatchObject({ key: "create", body: { memberIds: ["ou_a", "ou_b"], idType: "open_id" } });
    expect(requests[4]).toMatchObject({ key: "invite", body: { chatId: "oc_group", memberIds: ["ou_c"] } });
    expect(requests[5]).toMatchObject({ body: { target: { kind: "surface", channelId: "feishu", surfaceId: "oc_group" } } });
  } finally { server.stop(true); }
});
