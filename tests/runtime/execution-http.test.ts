import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { openExecutionDatabase } from "@luna/execution-store";
import { TokenAuthority, executionServer, closeExecutionServer, ExecutionClient, json, readJson, requirePeer } from "@luna/execution-transport";

test("HTTP authenticates stored role/instance, rejects missing/duplicate/revoked tokens and redirects", async () => {
  const db = openExecutionDatabase(":memory:");
  const authority = new TokenAuthority(db);
  const runtime = authority.issue("control", { role: "runtime", id: "runtime1" });
  const executor = authority.issue("ingest", { role: "executor", id: "instance1" });
  let accepted = 0;
  const server = executionServer(authority, async ({ peer, request, response, url }) => {
    if (url.pathname === "/v1/redirect") {
      response.writeHead(302, { location: "/v1/jobs" }); response.end(); return;
    }
    if (url.pathname === "/v1/ingest") {
      requirePeer(peer, "executor", "instance2");
    } else requirePeer(peer, "runtime", "runtime1");
    accepted++;
    json(response, 200, request.method === "POST" ? await readJson(request) : { ready: true });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const client = new ExecutionClient(endpoint, runtime);
    expect(await client.call<{ ready: boolean }>("GET", "/v1/health")).toEqual({ ready: true });
    expect(await client.call<{ value: string }>("POST", "/v1/jobs", { value: "input" })).toEqual({ value: "input" });
    await expect(new ExecutionClient(endpoint, executor).call("POST", "/v1/jobs", { role: "runtime", id: "runtime1" })).rejects.toThrow("peer_role_denied");
    await expect(new ExecutionClient(endpoint, executor).call("GET", "/v1/ingest")).rejects.toThrow("peer_role_denied");
    expect((await fetch(`${endpoint}/v1/health`)).status).toBe(401);
    await expect(new ExecutionClient(endpoint, "x".repeat(43)).call("GET", "/v1/health")).rejects.toThrow("invalid_credentials");
    const duplicated = await new Promise<number>((resolve, reject) => {
      const req = request(`${endpoint}/v1/health`, { headers: ["Authorization", `Bearer ${runtime}`, "Authorization", `Bearer ${runtime}`] }, (res) => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on("error", reject); req.end();
    });
    expect(duplicated).toBe(401);
    await expect(client.call("GET", "/v1/redirect")).rejects.toThrow("redirect_denied");
    expect(accepted).toBe(2);
    const responses = await Promise.all(Array.from({ length: 10 }, () => client.call<{ ready: boolean }>("GET", "/v1/health")));
    expect(responses.every((response) => response.ready)).toBe(true);
    authority.revoke("control");
    await expect(client.call("GET", "/v1/health")).rejects.toThrow("invalid_credentials");
    expect(accepted).toBe(12);
  } finally { await closeExecutionServer(server); db.close(); }
});

test("Token pairing survives restart, stores only hashes and cannot revive a revoked credential", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-http-auth-"));
  let db = openExecutionDatabase(join(root, "auth.sqlite"));
  try {
    let authority = new TokenAuthority(db);
    const peer = { role: "executor" as const, id: "executor1" };
    const token = authority.issue("upload", peer);
    const request = { rawHeaders: ["Authorization", `Bearer ${token}`], headers: { authorization: `Bearer ${token}` } };
    const rows = JSON.stringify(db.query("SELECT * FROM execution_credentials").all());
    expect(rows).not.toContain(token);
    db.close(); db = openExecutionDatabase(join(root, "auth.sqlite"));
    authority = new TokenAuthority(db);
    expect(authority.authenticate(request)).toEqual(peer);
    authority.register("upload", token, peer);
    expect(() => authority.register("other", token, peer)).toThrow("credential_conflict");
    expect(() => authority.register("upload", token, { role: "runtime", id: "runtime1" })).toThrow("credential_conflict");
    authority.revoke("upload");
    expect(() => authority.authenticate(request)).toThrow("invalid_credentials");
    expect(() => authority.register("upload", token, peer)).toThrow("credential_conflict");
    db.close(); db = openExecutionDatabase(join(root, "auth.sqlite"));
    expect(() => new TokenAuthority(db).authenticate(request)).toThrow("invalid_credentials");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an attached SSE stream rechecks a revoked Token before delivering another event", async () => {
  const db = openExecutionDatabase(":memory:");
  const authority = new TokenAuthority(db);
  const token = authority.issue("sse", { role: "service", id: "service1" });
  let continueStream!: () => void;
  const gate = new Promise<void>((resolve) => { continueStream = resolve; });
  const server = executionServer(authority, async ({ response, assertAuthorized }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": ready\n\n");
    await gate;
    assertAuthorized();
    response.end("data: should-not-arrive\n\n");
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
    const client = new ExecutionClient(`http://127.0.0.1:${address.port}`, token);
    expect(JSON.stringify(client)).not.toContain(token);
    const signal = AbortSignal.timeout(2000);
    const response = await client.open("GET", "/v1/events", undefined, signal);
    let output = "";
    const ended = new Promise<void>((resolve) => {
      response.on("data", (chunk) => { output += String(chunk); });
      response.on("error", () => resolve());
      response.on("close", () => resolve());
    });
    authority.revoke("sse"); continueStream();
    await ended;
    expect(signal.aborted).toBe(false);
    expect(output).not.toContain("should-not-arrive");
  } finally { continueStream(); await closeExecutionServer(server); db.close(); }
});

test("aborting a partially received JSON response releases the client request", async () => {
  const db = openExecutionDatabase(":memory:");
  const authority = new TokenAuthority(db);
  const token = authority.issue("control", { role: "runtime", id: "runtime1" });
  const abort = new AbortController();
  const server = executionServer(authority, async ({ response }) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"pending":');
    setTimeout(() => abort.abort(), 20);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
    const client = new ExecutionClient(`http://127.0.0.1:${address.port}`, token);
    await expect(client.call("GET", "/v1/health", undefined, abort.signal)).rejects.toThrow();
  } finally { await closeExecutionServer(server); db.close(); }
});
