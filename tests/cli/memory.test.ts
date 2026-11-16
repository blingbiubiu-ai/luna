import { expect, test } from "bun:test";
import { runMemoryCli } from "@luna/cli/commands/memory";

test("memory CLI maps commands to Runner memory routes and rejects invalid input before sending", async () => {
  const requests: {method: string; path: string; body: unknown}[] = [];
  const server = Bun.serve({port: 0, async fetch(req) {
    const url = new URL(req.url);
    requests.push({method: req.method, path: url.pathname + url.search, body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.json()});
    return Response.json({ok: true});
  }});
  const env = {LUNA_SERVICE_URL: `http://127.0.0.1:${server.port}`, LUNA_ACCESS_TOKEN: "test"};
  const run = (args: string[], stdin = "") => runMemoryCli(args, env, async () => stdin);
  try {
    for (const [args, stdin] of [
      [["list", "--type", "feedback", "--limit", "50"]],
      [["search", "周报", "格式", "--subject", "u1", "--archived"]],
      [["get", "m 1"]],
      [["add", "--type", "person", "--title", "张三", "--description", "只要结论", "--subject", "u1", "--visibility", "shadow", "--force", "--stdin"], "不要过程\n"],
      [["add", "--type", "project", "--title", "t", "--description", "d", "--body", "b", "--expires", "2026-11-20", "--core", "true"]],
      [["update", "m1", "--expected-revision", "2", "--expires", "none", "--core", "false"]],
      [["restore", "m1", "--expected-revision", "4"]],
      [["update", "m1", "--expected-revision", "2", "--body", "v2"]],
      [["delete", "m1", "--expected-revision", "3", "--superseded-by", "m2"]],
      [["search", "--type", "feedback", "周报", "--archived", "格式"]],
      [["update", "m1", "--expected-revision", "2", "--type", "project", "--subject", "none"]],
    ] as [string[], string?][]) expect((await run(args, stdin)).status).toBe("ok");
    expect(requests).toEqual([
      {method: "GET", path: "/api/runner/memory?type=feedback&limit=50", body: undefined},
      {method: "GET", path: `/api/runner/memory/search?q=${encodeURIComponent("周报 格式").replace(/%20/g, "+")}&subject=u1&archived=true`, body: undefined},
      {method: "GET", path: "/api/runner/memory/m%201", body: undefined},
      {method: "POST", path: "/api/runner/memory", body: {type: "person", title: "张三", description: "只要结论", subjectUserId: "u1", visibility: "shadow", body: "不要过程\n", force: true}},
      {method: "POST", path: "/api/runner/memory", body: {type: "project", title: "t", description: "d", body: "b", expiresAt: Date.parse("2026-11-20T23:59:59Z"), core: true}},
      {method: "PUT", path: "/api/runner/memory/m1", body: {expiresAt: null, core: false, expectedRevision: 2}},
      {method: "POST", path: "/api/runner/memory/m1/restore", body: {expectedRevision: 4}},
      {method: "PUT", path: "/api/runner/memory/m1", body: {body: "v2", expectedRevision: 2}},
      {method: "DELETE", path: "/api/runner/memory/m1?expectedRevision=3&supersededBy=m2", body: undefined},
      {method: "GET", path: `/api/runner/memory/search?q=${encodeURIComponent("周报 格式").replace(/%20/g, "+")}&type=feedback&archived=true`, body: undefined},
      {method: "PUT", path: "/api/runner/memory/m1", body: {type: "project", subjectUserId: null, expectedRevision: 2}},
    ]);
    for (const args of [
      ["search"], ["search", "--type", "feedback"], ["get"], ["update", "m1", "--body", "x"], ["update", "m1", "--expected-revision", "0"],
      ["delete", "m1"], ["add", "--body", "a", "--stdin"], ["unknown"], ["restore", "m1"],
      ["update", "m1", "--expected-revision", "1", "--expires", "soon"], ["update", "m1", "--expected-revision", "1", "--core", "yes"],
    ]) expect(await run(args)).toMatchObject({status: "error", code: "invalid_memory_command"});
    expect(requests).toHaveLength(11);
    expect((await run(["help"])).output).toContain("luna memory search");
  } finally { server.stop(true); }
});
