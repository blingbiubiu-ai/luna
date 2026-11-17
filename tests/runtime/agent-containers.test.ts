import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { fixtureScope } from "../helpers/platform-fixtures";
import { AgentStore } from "@/agents/agent-store";
import { AgentWorkerAccessStore } from "@/agents/agent-worker-access-store";
import { createAgentContainerRoutes } from "@/server/routes/agent-containers";
import { ExecutionError } from "@luna/execution-store";
import type { ContainerConsoleSocketData } from "@/server/container-console";
import type { ContainerStreamHandlers, ContainerStreamRequest, WorkerGateway } from "@/runtime/worker-gateway";

let home: string, connection: DataConnection<typeof schema>, alice: ReturnType<typeof fixtureScope>, shadowId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luna-agent-containers-")); setLunaHome(home);
  connection = new DataConnection(schema);
  alice = fixtureScope(connection.db, "alice"); fixtureScope(connection.db, "bob");
  shadowId = new AgentStore(connection.db).createShadow("alice", alice.agentId, { name: "研究员" }, "researcher").id;
  new AgentWorkerAccessStore(connection.db).setOwned("alice", alice.agentId, "worker-1", "active");
});
afterEach(() => { connection.close(); rmSync(home, { recursive: true, force: true }); });

const summary = (environmentId: string, shadow: string) => ({ environmentId, shadowId: shadow, mode: "shared", state: "ready", running: true, activeJobs: 1,
  idleSince: null, resources: { memory: "2g", cpus: 2, pidsLimit: 512 } });

/** Workers: worker-1 is assigned to alice's Agent, worker-2 is connected but not assigned. */
function fakeGateway() {
  const calls: string[] = [];
  const opened: { workerId: string; request: ContainerStreamRequest; handlers: ContainerStreamHandlers; closed: boolean }[] = [];
  const gateway = {
    list: () => ["worker-1", "worker-2"].map(workerId => ({ workerId, connected: true, revoked: false, health: { capabilities: ["container-streams-v1"] } })),
    resetError: undefined as ExecutionError | undefined,
    scheduler: { workers: { client: (workerId: string) => ({ call: async (method: string, path: string, body?: unknown) => {
      if (method === "POST") {
        calls.push(`${workerId} POST ${path} ${JSON.stringify(body)}`);
        if (gateway.resetError) throw gateway.resetError;
        return undefined;
      }
      calls.push(`${workerId} ${path}`);
      return { containers: workerId === "worker-1" ? [summary("env_shadow", shadowId), summary("env_default", alice.shadowId)] : [summary("env_other", "x")] };
    } }) } },
    openStream: (workerId: string, request: ContainerStreamRequest, handlers: ContainerStreamHandlers) => {
      const record = { workerId, request, handlers, closed: false };
      opened.push(record);
      setTimeout(() => handlers.data(new TextEncoder().encode("welcome")), 10);
      return {
        write: (bytes: Uint8Array) => handlers.data(new TextEncoder().encode(`echo:${Buffer.from(bytes).toString()}`)),
        resize: (cols: number, rows: number) => handlers.data(new TextEncoder().encode(`resize:${cols}x${rows}`)),
        close: () => { record.closed = true; },
      };
    },
  };
  return { gateway: gateway as unknown as WorkerGateway, calls, opened, fail: (error: ExecutionError) => { gateway.resetError = error; } };
}

function app(actor: string, gateway: WorkerGateway) {
  return new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", { authenticated: true, user: { id: actor, name: actor, provider: "test" } });
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); (c as any).set("lunaAuthorizationDb", connection.db); await next();
  }).route("/", createAgentContainerRoutes(connection.db, () => gateway));
}

test("lists only the owner's assigned Workers, scoped to the Agent, with Shadow names", async () => {
  const fake = fakeGateway();
  const response = await app("alice", fake.gateway).request(`/${alice.agentId}/containers`);
  expect(response.status).toBe(200);
  const body = await response.json() as { containers: { environmentId: string; shadowName: string | null; workerId: string; supported: boolean }[]; workers: unknown[] };
  expect(body.containers.map(item => [item.environmentId, item.shadowName, item.workerId, item.supported])).toEqual([
    ["env_shadow", "研究员", "worker-1", true], ["env_default", expect.any(String), "worker-1", true]]);
  expect(body.workers).toEqual([{ workerId: "worker-1", supported: true }]);
  expect(fake.calls).toEqual([`worker-1 /v1/containers?agentId=${alice.agentId}`]);
  expect((await app("bob", fake.gateway).request(`/${alice.agentId}/containers`)).status).not.toBe(200);
  expect(fake.calls).toHaveLength(1);
});

test("stream requests check owner, Origin, assignment and container before upgrading", async () => {
  const fake = fakeGateway();
  const base = `http://luna.test/${alice.agentId}/containers`;
  const request = (actor: string, path: string, headers: Record<string, string> = { origin: "http://luna.test", host: "luna.test" }) =>
    app(actor, fake.gateway).request(new Request(`${base}/${path}`, { headers }));
  expect((await request("bob", "worker-1/env_shadow/stream?kind=terminal")).status).not.toBe(200);
  expect((await request("alice", "worker-1/env_shadow/stream?kind=terminal", { host: "luna.test" })).status).toBe(403);
  expect((await request("alice", "worker-1/env_shadow/stream?kind=terminal", { origin: "http://evil.test", host: "luna.test" })).status).toBe(403);
  expect((await request("alice", "worker-2/env_other/stream?kind=terminal")).status).toBe(404);
  expect((await request("alice", "worker-1/env_missing/stream?kind=terminal")).status).toBe(404);
  expect((await request("alice", "worker-1/env_shadow/stream?kind=shell")).status).toBe(400);
  expect((await request("alice", "worker-1/env_shadow/stream?kind=terminal")).status).toBe(426);
  expect(fake.opened).toEqual([]);
});

test("a Dashboard WebSocket relays bytes and resizes, and VNC always runs as the Runner", async () => {
  const fake = fakeGateway();
  const routes = app("alice", fake.gateway);
  const server = Bun.serve<ContainerConsoleSocketData>({ hostname: "127.0.0.1", port: 0, fetch: (request, server) => routes.fetch(request, server),
    websocket: { open: ws => ws.data.session.open(ws), message: (ws, raw) => ws.data.session.message(ws, raw), close: ws => ws.data.session.closed() } });
  try {
    const connect = async (query: string) => {
      const received: string[] = []; let closeReason = "";
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/${alice.agentId}/containers/worker-1/env_shadow/stream?${query}`,
        { headers: { origin: `http://127.0.0.1:${server.port}` } });
      socket.binaryType = "arraybuffer";
      socket.onmessage = event => received.push(Buffer.from(event.data as ArrayBuffer).toString());
      socket.onclose = event => { closeReason = event.reason || String(event.code); };
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("connect failed")); });
      return { socket, received, closeReason: () => closeReason };
    };

    const terminal = await connect("kind=terminal&user=root&cols=90&rows=20");
    await delay(50);
    terminal.socket.send(new TextEncoder().encode("ls\r"));
    terminal.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await delay(100);
    expect(terminal.received).toEqual(["welcome", "echo:ls\r", "resize:120x40"]);
    expect(fake.opened[0]!.request).toEqual({ environmentId: "env_shadow", agentId: alice.agentId, kind: "terminal", user: "root", cols: 90, rows: 20 });
    terminal.socket.close(); await delay(50);
    expect(fake.opened[0]!.closed).toBe(true);

    const vnc = await connect("kind=vnc&user=root");
    await delay(50);
    expect(fake.opened[1]!.request.user).toBe("runner");
    // Worker-side endings reach the browser as close reasons.
    fake.opened[1]!.handlers.close("desktop_unavailable"); await delay(50);
    expect(vnc.closeReason()).toBe("desktop_unavailable");

    const invalid = await connect("kind=terminal");
    invalid.socket.send("not json"); await delay(50);
    expect(invalid.closeReason()).toBe("invalid_message");
  } finally { void server.stop(true); }
});

test("system disk reset is owner-only, scoped to assigned Workers and reports busy containers", async () => {
  const fake = fakeGateway();
  const reset = (actor: string, path: string) => app(actor, fake.gateway).request(`/${alice.agentId}/containers/${path}/reset`, { method: "POST" });
  expect((await reset("bob", "worker-1/env_shadow")).status).not.toBe(200);
  expect((await reset("alice", "worker-2/env_other")).status).toBe(404);
  expect(fake.calls).toEqual([]);
  fake.fail(new ExecutionError(409, "environment_occupied"));
  const busy = await reset("alice", "worker-1/env_shadow");
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ code: "environment_occupied", message: expect.stringContaining("任务") });
  fake.fail(undefined as unknown as ExecutionError);
  expect((await reset("alice", "worker-1/env_shadow")).status).toBe(200);
  expect(fake.calls.at(-1)).toBe(`worker-1 POST /v1/environments/env_shadow/reset ${JSON.stringify({ agentId: alice.agentId })}`);
});
