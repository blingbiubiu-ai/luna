import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "bun";
import { ExecutionError, openExecutionDatabase, type SqlDatabase } from "@luna/execution-store";
import { TokenAuthority } from "@luna/execution-transport";
import { CONTAINER_STREAM_PATH, CONTAINER_STREAM_TOKEN_HEADER } from "@luna/runner-protocol";
import { RuntimeConfig } from "../../src/runtime/config";
import { RuntimeScheduler } from "../../src/runtime/scheduler";
import { WorkerGateway, type ContainerStreamHandle, type WorkerSocketData, type WorkerStreamSocketData } from "../../src/runtime/worker-gateway";
import { WorkerConfig } from "../../apps/worker/src/config";
import { DockerEnvironmentDriver } from "../../apps/worker/src/docker-driver";
import { EnvironmentManager } from "../../apps/worker/src/environment-manager";
import { EnvironmentStore } from "../../apps/worker/src/environment-store";
import { ServiceLink } from "../../apps/worker/src/service-link";

// A fake `docker` on PATH records its arguments and stands in for the container side:
// the terminal echoes each line with the PTY size, the VNC bridge echoes bytes.
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *"luna-desktop start"*) exit 0 ;;
  *"luna-desktop bridge"*) exec cat ;;
  *"bash -l"*) while read -r line; do [ "$line" = quit ] && exit 3; echo "got:$line size:$(stty size)"; done ;;
  *) exit 0 ;;
esac
`;

let root: string, serviceDb: SqlDatabase, workerDb: SqlDatabase, gateway: WorkerGateway, server: Server<WorkerSocketData | WorkerStreamSocketData>;
let link: ServiceLink, manager: EnvironmentManager, targets: { id: string; agentId: string }[], originalPath: string | undefined;
const workerId = "worker-1", token = "w".repeat(43);

async function until(predicate: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await delay(20); }
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "luna-container-streams-")));
  writeFileSync(join(root, "docker"), FAKE_DOCKER); chmodSync(join(root, "docker"), 0o755);
  originalPath = process.env.PATH; process.env.PATH = `${root}:${process.env.PATH}`; process.env.DOCKER_LOG = join(root, "docker.log");
  serviceDb = openExecutionDatabase(":memory:"); workerDb = openExecutionDatabase(":memory:");
  const config = RuntimeConfig.parse({ runtimeId: "runtime", serviceId: "service", environmentId: "environment", dataRoot: join(root, "runtime"), homeWorkerId: workerId, serviceToken: "s".repeat(43), adminToken: "a".repeat(43) });
  gateway = new WorkerGateway(serviceDb, new RuntimeScheduler(serviceDb, config, new TokenAuthority(serviceDb)));
  gateway.registerLocal({ workerId, controlToken: token, port: 8092, executorPortStart: 41000, executorPortEnd: 41100 });
  // Same dispatch as HonoServer.start for the Worker control link and stream data sockets.
  server = Bun.serve<WorkerSocketData | WorkerStreamSocketData>({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    const pathname = new URL(request.url).pathname;
    try {
      const data = pathname.startsWith(CONTAINER_STREAM_PATH)
        ? gateway.authenticateStream(request, pathname.slice(CONTAINER_STREAM_PATH.length))
        : { workerId: gateway.authenticate(request), gateway };
      if (server.upgrade(request, { data })) return;
    } catch { return new Response("Unauthorized", { status: 401 }); }
    return new Response("WebSocket required", { status: 400 });
  }, websocket: {
    open: ws => "kind" in ws.data ? gateway.streamOpened(ws as never) : gateway.open(ws as never),
    message: (ws, raw) => "kind" in ws.data ? gateway.streamMessage(ws as never, raw) : gateway.message(ws as never, raw),
    close: ws => "kind" in ws.data ? gateway.streamClosed(ws as never) : gateway.closed(ws as never),
  } });
  const workerConfig = WorkerConfig.parse({ workerId, runtimeId: "runtime", dataRoot: join(root, "worker"), runtimeEndpoint: "http://127.0.0.1:8092", controlToken: token,
    imageDigest: `sha256:${"a".repeat(64)}`, runnerUid: 1234, runnerGid: 5678 });
  manager = new EnvironmentManager(new EnvironmentStore(workerDb), new DockerEnvironmentDriver(workerDb, workerConfig));
  targets = [];
  manager.streamTarget = async (id, agentId) => {
    targets.push({ id, agentId });
    if (agentId !== "agent-a") throw new ExecutionError(403, "environment_agent_mismatch");
    return { containerId: "container-1", home: "/data/agents/agent-a/shadows/shadow-a" };
  };
  manager.driver.health = async () => {}; // Streams are under test, not Docker health.
  link = new ServiceLink(manager, new TokenAuthority(workerDb), server.url.origin, token);
  link.start();
  // Ready implies the local health check settled, so teardown cannot race it.
  await until(() => gateway.list()[0]?.health?.ready === true && gateway.list()[0]?.health?.capabilities?.includes("container-streams-v1") === true);
});

afterEach(async () => {
  link.stop(); gateway.close(); void server.stop(true); // Like remote-worker.test: Bun does not settle stop() promptly here.
  serviceDb.close(); workerDb.close();
  process.env.PATH = originalPath; delete process.env.DOCKER_LOG;
  rmSync(root, { recursive: true, force: true });
});

function open(request: Partial<{ kind: "terminal" | "vnc"; user: "runner" | "root"; agentId: string }> = {}) {
  const received: string[] = []; const closed: string[] = [];
  const handle: ContainerStreamHandle = gateway.openStream(workerId, { environmentId: "env_1", agentId: request.agentId ?? "agent-a", kind: request.kind ?? "terminal",
    user: request.user ?? "runner", cols: 100, rows: 30 }, { data: bytes => received.push(Buffer.from(bytes).toString()), close: reason => closed.push(reason) });
  return { handle, output: () => received.join(""), closed };
}
const dockerCalls = () => existsSync(join(root, "docker.log")) ? readFileSync(join(root, "docker.log"), "utf8").trim().split("\n").filter(line => line.startsWith("exec")) : [];
const send = (handle: ContainerStreamHandle, text: string) => handle.write(new TextEncoder().encode(text));

test("terminal runs as the Runner in a PTY, relays input, output and resizes over its own socket", async () => {
  const stream = open();
  send(stream.handle, "hello\n"); // Queued until the Worker's data socket attaches.
  await until(() => stream.output().includes("got:hello size:30 100"));
  stream.handle.resize(120, 40); await delay(100);
  send(stream.handle, "again\n");
  await until(() => stream.output().includes("got:again size:40 120"));
  expect(targets).toEqual([{ id: "env_1", agentId: "agent-a" }]);
  expect(dockerCalls()).toEqual(["exec -it -u 1234:5678 -w /data/agents/agent-a/shadows/shadow-a -e HOME=/data/agents/agent-a/shadows/shadow-a -e LANG=C.UTF-8 -e TERM=xterm-256color container-1 bash -l"]);
  send(stream.handle, "quit\n");
  await until(() => stream.closed.length > 0);
  expect(stream.closed).toEqual(["exited:3"]);
  await until(() => link.streams.size === 0);
});

test("root terminal keeps root dotfiles out of the Shadow HOME", async () => {
  const stream = open({ user: "root" });
  send(stream.handle, "x\n");
  await until(() => stream.output().includes("got:x"));
  expect(dockerCalls()[0]).toBe("exec -it -u 0:0 -w /data/agents/agent-a/shadows/shadow-a -e HOME=/tmp -e LANG=C.UTF-8 -e TERM=xterm-256color container-1 bash -l");
  stream.handle.close();
  await until(() => link.streams.size === 0);
  expect(stream.closed).toEqual([]); // A caller-initiated close does not echo back.
});

test("VNC starts the desktop as the Runner, then pipes raw bytes even when root was requested", async () => {
  const stream = open({ kind: "vnc", user: "root" });
  send(stream.handle, "RFB 003.008\n");
  await until(() => stream.output() === "RFB 003.008\n");
  const env = "-e HOME=/data/agents/agent-a/shadows/shadow-a -e LANG=C.UTF-8";
  expect(dockerCalls()).toEqual([`exec -u 1234:5678 ${env} container-1 luna-desktop start`, `exec -i -u 1234:5678 ${env} container-1 luna-desktop bridge`]);
  stream.handle.close();
});

test("Worker refusals reach the caller as close reasons", async () => {
  const stream = open({ agentId: "agent-b" });
  await until(() => stream.closed.length > 0);
  expect(stream.closed).toEqual(["environment_agent_mismatch"]);
  expect(dockerCalls()).toEqual([]);
});

test("data sockets require the Worker credential and the stream's one-time token", async () => {
  const stream = open({ kind: "vnc" });
  await until(() => link.streams.size === 1);
  const streamId = (gateway as unknown as { streams: Map<string, unknown> }).streams.keys().next().value as string;
  const url = new URL(CONTAINER_STREAM_PATH + streamId, server.url); url.protocol = "ws:";
  const attempt = (headers: Record<string, string>) => new Promise<number>(resolve => {
    const socket = new WebSocket(url, { headers });
    socket.onopen = () => { socket.close(); resolve(101); };
    socket.onerror = () => resolve(401);
  });
  expect(await attempt({ authorization: `Bearer ${token}`, [CONTAINER_STREAM_TOKEN_HEADER]: "x".repeat(43) })).toBe(401);
  expect(await attempt({ authorization: `Bearer ${"z".repeat(43)}`, [CONTAINER_STREAM_TOKEN_HEADER]: "x".repeat(43) })).toBe(401);
  // Already attached: even the right credentials cannot take over the stream.
  expect(await attempt({ authorization: `Bearer ${token}` })).toBe(401);
  stream.handle.close();
});

test("streams are only offered to Workers that advertise support", () => {
  const record = gateway.scheduler.workers.require(workerId);
  gateway.scheduler.workers.heartbeat(workerId, { ...record.health!, capabilities: ["shadow-scope-v2"] });
  expect(() => open()).toThrow("worker_streams_unsupported");
});
