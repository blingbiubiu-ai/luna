import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DataConnection } from "@/data";
import * as schema from "@/data/schema";
import { setLunaHome } from "@/shared";
import { fixtureScope, fixtureSessionOwnership } from "../helpers/platform-fixtures";
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

const summary = (environmentId: string, shadow: string, hostAllowed = true) => ({ environmentId, shadowId: shadow, mode: "shared", state: "ready", running: true, activeJobs: 1,
  idleSince: null, resources: { memory: "2g", cpus: 2, pidsLimit: 512 },
  root: { requested: false, effective: false, hostAllowed, ...(hostAllowed ? {} : { reason: "home_requires_nosuid" }) } });

/** Workers: worker-1 is assigned to alice's Agent, worker-2 is connected but not assigned. */
function fakeGateway(hostAllowed = true) {
  const calls: string[] = [];
  const opened: { workerId: string; request: ContainerStreamRequest; handlers: ContainerStreamHandlers; closed: boolean }[] = [];
  const gateway = {
    list: () => ["worker-1", "worker-2"].map(workerId => ({ workerId, connected: true, revoked: false, health: { capabilities: ["container-streams-v1"] } })),
    resetError: undefined as ExecutionError | undefined,
    scheduler: {
      config: { environmentId: "luna", mode: "shared" as const, runtimeId: "runtime", resources: { memory: "2g", cpus: 2, pidsLimit: 512 }, sharedProject: undefined },
      placements: {
        route: (_scope: unknown, allowed: readonly string[]) => {
          if (!allowed.length) throw new ExecutionError(409, "agent_workers_not_configured");
          return { workerId: allowed[0]!, generation: 1 };
        },
      },
      workers: {
        imageDigest: () => `sha256:${"a".repeat(64)}`,
        client: (workerId: string) => ({ call: async (method: string, path: string, body?: unknown) => {
          if (method === "POST") {
            calls.push(`${workerId} POST ${path} ${JSON.stringify(body)}`);
            if (gateway.resetError) throw gateway.resetError;
            if (path === "/v1/containers/provision") return { container: summary("env_provisioned", (body as { spec: { scope: { shadowId: string } } }).spec.scope.shadowId, hostAllowed) };
            return undefined;
          }
          calls.push(`${workerId} ${path}`);
          return { containers: workerId === "worker-1" ? [summary("env_shadow", shadowId, hostAllowed), summary("env_default", alice.shadowId, hostAllowed)] : [summary("env_other", "x", hostAllowed)] };
        } }),
      },
    },
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

const fakeBuilder = {
  capture: (_actor: string, scope: { agentId: string; shadowId: string }) => ({
    protocolVersion: 2 as const, scope, files: [],
    selection: { protocolVersion: 2 as const, publicRevision: "a".repeat(64), agentToolsRevision: "b".repeat(64), digest: "c".repeat(64) },
  }),
};

function app(actor: string, gateway: WorkerGateway) {
  return new Hono().use("*", async (c, next) => {
    (c as any).set("dashboardAuthSession", { authenticated: true, account: { id: actor, name: actor, provider: "test" } });
    (c as any).set("lunaRequestAuthKind", "dashboard-cookie"); (c as any).set("lunaAuthorizationDb", connection.db); await next();
  }).route("/", createAgentContainerRoutes(connection.db, () => gateway, () => fakeBuilder as never));
}

test("lists only the owner's assigned Workers, scoped to the Agent, with Shadow names", async () => {
  const fake = fakeGateway();
  const response = await app("alice", fake.gateway).request(`/${alice.agentId}/containers`);
  expect(response.status).toBe(200);
  const body = await response.json() as { containers: { environmentId: string; shadowName: string | null; workerId: string; supported: boolean }[]; workers: unknown[] };
  expect(body.containers.map(item => [item.environmentId, item.shadowName, item.workerId, item.supported])).toEqual([
    ["env_shadow", "研究员", "worker-1", true], ["env_default", expect.any(String), "worker-1", true]]);
  expect(body.workers).toEqual([{ workerId: "worker-1", supported: true, imageDigest: `sha256:${"a".repeat(64)}` }]);
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

test("cold-start provision, desktop stop, and host nosuid root-terminal gate enforce owner and host boundaries", async () => {
  const deniedHost = fakeGateway(false);
  const listed = await (await app("alice", deniedHost.gateway).request(`/${alice.agentId}/containers`)).json() as { shadows: { shadowId: string }[] };
  expect(listed.shadows.map(item => item.shadowId)).toContain(shadowId);

  // When hostAllowed is false (Linux without nosuid), root terminal is rejected with 403 while runner terminal proceeds to WS check (426).
  const headers = { origin: "http://luna.test", host: "luna.test" };
  const rootAttempt = await app("alice", deniedHost.gateway).request(new Request(`http://luna.test/${alice.agentId}/containers/worker-1/env_shadow/stream?kind=terminal&user=root`, { headers }));
  expect(rootAttempt.status).toBe(403);
  expect(await rootAttempt.json()).toMatchObject({ code: "home_requires_nosuid" });
  const runnerAttempt = await app("alice", deniedHost.gateway).request(new Request(`http://luna.test/${alice.agentId}/containers/worker-1/env_shadow/stream?kind=terminal&user=runner`, { headers }));
  expect(runnerAttempt.status).toBe(426);

  // Provisioning a cold Shadow container requires ownership and an assigned Worker.
  const fake = fakeGateway(true);
  const json = { "content-type": "application/json" };
  expect((await app("bob", fake.gateway).request(`/${alice.agentId}/containers`, { method: "POST", headers: json, body: JSON.stringify({ shadowId }) })).status).toBe(403);
  expect((await app("alice", fake.gateway).request(`/${alice.agentId}/containers`, { method: "POST", headers: json, body: JSON.stringify({ shadowId, workerId: "worker-2" }) })).status).toBe(404);
  const provisioned = await app("alice", fake.gateway).request(`/${alice.agentId}/containers`, { method: "POST", headers: json, body: JSON.stringify({ shadowId }) });
  expect(provisioned.status).toBe(200);
  expect(await provisioned.json()).toMatchObject({ container: { environmentId: "env_provisioned", shadowId, workerId: "worker-1", shadowName: "研究员" } });

  // Stopping desktop background processes is owner-only and scoped to assigned Workers.
  expect((await app("bob", fake.gateway).request(`/${alice.agentId}/containers/worker-1/env_shadow/desktop/stop`, { method: "POST" })).status).toBe(403);
  expect((await app("alice", fake.gateway).request(`/${alice.agentId}/containers/worker-2/env_other/desktop/stop`, { method: "POST" })).status).toBe(404);
  expect((await app("alice", fake.gateway).request(`/${alice.agentId}/containers/worker-1/env_shadow/desktop/stop`, { method: "POST" })).status).toBe(200);
  expect(fake.calls.at(-1)).toBe(`worker-1 POST /v1/environments/env_shadow/desktop-stop ${JSON.stringify({ agentId: alice.agentId })}`);
});

test("uploads go to an assigned upload-capable Worker for a live Shadow, as base64 pieces", async () => {
  const fake = fakeGateway();
  const gateway = fake.gateway as unknown as { list: () => unknown[]; scheduler: { workers: { client: (id: string) => unknown } } };
  const sent: { workerId: string; path: string; body: Record<string, unknown> }[] = [];
  let capabilities = ["container-streams-v1"];
  gateway.list = () => ["worker-1", "worker-2"].map(workerId => ({ workerId, connected: true, revoked: false, health: { capabilities } }));
  gateway.scheduler.workers.client = (workerId: string) => ({ call: async (_method: string, path: string, body: Record<string, unknown>) => {
    sent.push({ workerId, path, body });
    return { done: true, path: "/home/x/uploads/a.txt", size: 3 };
  } });
  const uploadId = "00000000-0000-4000-8000-000000000001";
  const upload = (actor: string, worker: string, shadow: string, bytes: Uint8Array = new TextEncoder().encode("abc")) =>
    app(actor, fake.gateway).request(`/${alice.agentId}/containers/${worker}/env_shadow/upload?${new URLSearchParams({ shadowId: shadow, uploadId, dir: "~/uploads", name: "a.txt", offset: "0", final: "1" })}`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });

  // An older Worker cannot take uploads.
  const old = await upload("alice", "worker-1", shadowId);
  expect(old.status).toBe(409);
  expect(await old.json()).toMatchObject({ code: "worker_upload_unsupported" });
  capabilities = ["container-streams-v1", "home-upload-v1"];

  expect((await upload("bob", "worker-1", shadowId)).status).not.toBe(200);
  expect((await upload("alice", "worker-2", shadowId)).status).toBe(404);
  expect((await upload("alice", "worker-1", shadowId, new Uint8Array(4 * 1024 * 1024 + 1))).status).toBe(413);
  expect(sent).toEqual([]);

  const ok = await upload("alice", "worker-1", shadowId);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ done: true, path: "/home/x/uploads/a.txt", size: 3 });
  expect(sent).toEqual([{ workerId: "worker-1", path: "/v1/environments/env_shadow/upload", body: {
    agentId: alice.agentId, shadowId, uploadId, dir: "~/uploads", name: "a.txt", offset: 0, content: Buffer.from("abc").toString("base64"), final: true } }]);

  // A deleted Shadow takes no new files.
  connection.db.update(schema.agentShadows).set({ status: "deleted" }).where(eq(schema.agentShadows.id, shadowId)).run();
  expect((await upload("alice", "worker-1", shadowId)).status).toBe(409);
  expect(sent).toHaveLength(1);
});

test("pty-sessions resolves Feishu group names, topic titles, and P2P user names for live and dormant contexts", async () => {
  const nowIso = new Date(1_795_348_600_000).toISOString();
  const nowMs = 1_795_348_600_000;
  const db = connection.db;
  const ownership = fixtureSessionOwnership(db, "feishu", "feishu-default", "alice");
  new AgentWorkerAccessStore(db).setOwned("alice", ownership.agent_id, "worker-1", "active");
  const ownerUserId = new AgentStore(db).ownerUserId(ownership.agent_id);

  db.insert(schema.channelSurfaces).values([
    {
      id: "surf-group",
      channelType: "feishu",
      channelId: "feishu-default",
      externalId: "oc_group_ops",
      surfaceKind: "group",
      displayName: "【广州】支付值班群",
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "surf-p2p",
      channelType: "feishu",
      channelId: "feishu-default",
      externalId: "oc_p2p_zhangsan",
      surfaceKind: "p2p",
      displayName: null,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ]).run();

  db.insert(schema.channelIdentities).values({
    id: "ident-zhangsan",
    channelType: "feishu",
    channelId: "feishu-default",
    externalId: "ou_zhangsan",
    identityKind: "user",
    displayName: "张三",
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  db.insert(schema.sessions).values([
    {
      id: "sess-group-main",
      ...ownership,
      channel_type: "feishu",
      channel_id: "feishu-default",
      group_id: "oc_group_ops",
      title: null,
      status: "active",
      kind: "main",
      created_at: nowMs,
      updated_at: nowMs,
    },
    {
      id: "sess-group-topic",
      ...ownership,
      channel_type: "feishu",
      channel_id: "feishu-default",
      group_id: "oc_group_ops",
      thread_key: "omt_1",
      parent_session_id: "sess-group-main",
      title: "排查 OOM",
      status: "active",
      kind: "main",
      created_at: nowMs,
      updated_at: nowMs,
    },
    {
      id: "sess-p2p-main",
      ...ownership,
      channel_type: "feishu",
      channel_id: "feishu-default",
      group_id: "oc_p2p_zhangsan",
      title: null,
      status: "active",
      kind: "main",
      created_at: nowMs,
      updated_at: nowMs,
    },
    {
      id: "sess-p2p-work",
      ...ownership,
      channel_type: "feishu",
      channel_id: "feishu-default",
      group_id: "oc_p2p_zhangsan",
      thread_key: "omt_work_1",
      title: null,
      status: "active",
      kind: "work",
      created_at: nowMs,
      updated_at: nowMs,
    },
  ]).run();

  db.insert(schema.messages).values({
    id: "msg-p2p-1",
    agentId: ownership.agent_id,
    shadowId: ownership.shadow_id,
    bindingId: ownership.binding_id,
    ownerSessionId: "sess-p2p-main",
    channelType: "feishu",
    channelId: "feishu-default",
    externalMessageId: "om_p2p_1",
    senderUserId: ownerUserId,
    senderIdentityId: "ident-zhangsan",
    role: "user",
    contentKind: "text",
    presentationKind: "plain",
    contentJson: [{ type: "text", text: "你好" }],
    occurredAt: nowMs,
    createdAt: nowMs,
  }).run();

  db.insert(schema.sessionTimelineEntries).values({
    id: "ste-p2p-1",
    sessionId: "sess-p2p-main",
    messageId: "msg-p2p-1",
    entryKind: "message",
    createdAt: nowMs,
  }).run();

  db.insert(schema.runnerContexts).values([
    {
      id: "ctx-group-main",
      agent_id: ownership.agent_id,
      shadow_id: ownership.shadow_id,
      owner_type: "session",
      owner_id: "sess-group-main",
      runner_type: "codex",
      runner_session_id: "rs-1",
      runner_root_path: "/tmp/r1",
      created_at: nowMs,
      updated_at: nowMs,
    },
    {
      id: "ctx-group-topic",
      agent_id: ownership.agent_id,
      shadow_id: ownership.shadow_id,
      owner_type: "session",
      owner_id: "sess-group-topic",
      runner_type: "claude",
      runner_session_id: "rs-2",
      runner_root_path: "/tmp/r2",
      created_at: nowMs,
      updated_at: nowMs,
    },
    {
      id: "ctx-p2p-work",
      agent_id: ownership.agent_id,
      shadow_id: ownership.shadow_id,
      owner_type: "session",
      owner_id: "sess-p2p-work",
      runner_type: "codex",
      runner_session_id: "rs-3",
      runner_root_path: "/tmp/r3",
      created_at: nowMs,
      updated_at: nowMs,
    },
    {
      id: "ctx-p2p-dormant",
      agent_id: ownership.agent_id,
      shadow_id: ownership.shadow_id,
      owner_type: "session",
      owner_id: "sess-p2p-main",
      runner_type: "claude",
      runner_session_id: "rs-4",
      runner_root_path: "/tmp/r4",
      created_at: nowMs,
      updated_at: nowMs,
    },
  ]).run();

  const fake = fakeGateway();
  const gateway = fake.gateway as unknown as { scheduler: { workers: { client: (id: string) => unknown } } };
  gateway.scheduler.workers.client = () => ({
    call: async () => ({
      sessions: [
        {
          environmentId: "env_shadow",
          shadowId: ownership.shadow_id,
          contextId: "ctx-group-main",
          runnerType: "codex",
          model: "gpt-5.4",
          sessionId: "rs-1",
          busy: true,
          privileged: true,
          pid: 101,
          startedAt: nowMs,
          lastActiveAt: nowMs,
        },
        {
          environmentId: "env_shadow",
          shadowId: ownership.shadow_id,
          contextId: "ctx-group-topic",
          runnerType: "claude",
          sessionId: "rs-2",
          busy: false,
          privileged: false,
          pid: 102,
          startedAt: nowMs,
          lastActiveAt: nowMs - 1000,
        },
        {
          environmentId: "env_shadow",
          shadowId: ownership.shadow_id,
          contextId: "ctx-p2p-work",
          runnerType: "codex",
          sessionId: "rs-3",
          busy: false,
          privileged: true,
          pid: 103,
          startedAt: nowMs,
          lastActiveAt: nowMs - 2000,
        },
      ],
    }),
  });

  const res = await app("alice", fake.gateway).request(`/${ownership.agent_id}/pty-sessions`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    sessions: Array<{ contextId: string; title: string | null; runnerKind: string }>;
    dormantContexts: Array<{ contextId: string; title: string | null; runnerKind: string }>;
  };

  expect(body.sessions.map(item => [item.contextId, item.runnerKind, item.title])).toEqual([
    ["ctx-group-main", "main", "【广州】支付值班群"],
    ["ctx-group-topic", "main", "【广州】支付值班群 · # 排查 OOM"],
    ["ctx-p2p-work", "work", "张三"],
  ]);
  expect(body.dormantContexts.map(item => [item.contextId, item.runnerKind, item.title])).toEqual([
    ["ctx-p2p-dormant", "main", "张三"],
  ]);
});
