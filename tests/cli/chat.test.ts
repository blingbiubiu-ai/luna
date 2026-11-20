import { expect, test } from "bun:test";
import { runChatCli } from "@luna/cli/commands/chat";

test("chat CLI maps listen status, on and off to the Runner route and refuses anything else", async () => {
  const requests: {method: string; path: string; body: unknown}[] = [];
  const server = Bun.serve({port: 0, async fetch(req) {
    requests.push({method: req.method, path: new URL(req.url).pathname, body: req.method === "GET" ? undefined : await req.json()});
    return Response.json({listening: true});
  }});
  const env = {LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test"};
  try {
    for (const action of ["status", "on", "off"]) expect((await runChatCli(["listen", action], env)).status).toBe("ok");
    expect(requests).toEqual([
      {method: "GET", path: "/api/runner/chat/listening", body: undefined},
      {method: "PUT", path: "/api/runner/chat/listening", body: {enabled: true}},
      {method: "PUT", path: "/api/runner/chat/listening", body: {enabled: false}},
    ]);
    for (const args of [["listen"], ["listen", "maybe"], ["mute", "on"]]) expect((await runChatCli(args, env)).status).toBe("error");
    expect(requests).toHaveLength(3);
  } finally { server.stop(true); }
});
