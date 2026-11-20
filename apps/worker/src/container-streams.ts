import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionError } from "@luna/execution-store";
import { ContainerStreamOpen, ContainerStreamResize } from "@luna/runner-protocol";
import type { EnvironmentManager } from "./environment-manager";

const execute = promisify(execFile);
const MAX_STREAMS = 32;
const MAX_BUFFERED = 16 * 1024 * 1024;
const MAX_PENDING_INPUT = 1024 * 1024;

export interface StreamProcess {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly exited: Promise<number>;
}
export type StreamSpawner = (command: string[], options: { tty?: { cols: number; rows: number }; onData(bytes: Uint8Array): void }) => StreamProcess;
export type CommandRunner = (args: string[]) => Promise<void>;
/** Opens the dedicated data socket for one stream (see CONTAINER_STREAM_PATH). */
export type StreamDialer = (streamId: string, token: string) => WebSocket;

/** Dashboard terminal/VNC streams into this Worker's Shadow containers. */
export class ContainerStreams {
  private readonly sockets = new Map<WebSocket, string>();

  constructor(
    private readonly manager: Pick<EnvironmentManager, "streamTarget"> & Partial<Pick<EnvironmentManager, "ptyStreamTarget" | "acquireStream" | "releaseStream" | "setStreamCloser">>,
    private readonly runner: { runnerUid: number; runnerGid: number },
    private readonly dial: StreamDialer,
    private readonly spawn: StreamSpawner = bunSpawner,
    private readonly run: CommandRunner = runDocker,
  ) {
    this.manager.setStreamCloser?.((environmentId, reason) => this.closeEnvironment(environmentId, reason));
  }

  get size(): number { return this.sockets.size; }

  /** Handle a `stream.open` control message; everything else happens on the data socket. */
  open(input: unknown): void {
    const command = ContainerStreamOpen.parse(input);
    const socket = this.dial(command.streamId, command.token);
    if (this.sockets.size >= MAX_STREAMS) { socket.onopen = () => { socket.send(JSON.stringify({ type: "end", reason: "stream_limit" })); socket.close(4000); }; return; }
    socket.binaryType = "arraybuffer";
    this.sockets.set(socket, command.environmentId);
    this.manager.acquireStream?.(command.environmentId);
    let released = false;
    const release = () => { if (!released) { released = true; this.manager.releaseStream?.(command.environmentId); } };
    let process: StreamProcess | undefined;
    let ended = false;
    // Input and resizes can arrive while the container is still starting.
    let pending: Uint8Array[] = []; let pendingBytes = 0; let size: { cols: number; rows: number } | undefined;
    const end = (reason: string) => {
      if (ended) return; ended = true;
      release();
      process?.kill();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end", reason: reason.slice(0, 100) }));
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(4000);
    };
    socket.onclose = () => { this.sockets.delete(socket); ended = true; release(); process?.kill(); };
    socket.onerror = () => end("stream_socket_failed");
    socket.onmessage = event => {
      if (typeof event.data !== "string") {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (process) { process.write(bytes); return; }
        pendingBytes += bytes.length;
        if (pendingBytes > MAX_PENDING_INPUT) end("stream_buffer_full"); else pending.push(bytes);
        return;
      }
      const resize = ContainerStreamResize.safeParse(safeJson(event.data));
      if (!resize.success) return;
      if (process) process.resize(resize.data.cols, resize.data.rows); else size = resize.data;
    };
    socket.onopen = () => {
      void this.start(command, bytes => {
        if (socket.bufferedAmount > MAX_BUFFERED) { end("backpressure"); return; }
        socket.send(bytes);
      }).then(started => {
        if (ended) { started.kill(); return; }
        process = started;
        if (size) started.resize(size.cols, size.rows);
        for (const bytes of pending) started.write(bytes);
        pending = []; pendingBytes = 0;
        void started.exited.then(code => end(`exited:${code}`));
      }, error => end(error instanceof ExecutionError ? error.code : "stream_open_failed"));
    };
  }

  closeEnvironment(environmentId: string, reason: string): void {
    for (const [socket, targetId] of this.sockets) {
      if (targetId !== environmentId) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end", reason }));
      socket.close(4000);
    }
  }

  closeAll(): void {
    for (const socket of this.sockets.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end", reason: "worker_stopping" }));
      socket.close(4000);
    }
  }

  private async start(command: ContainerStreamOpen, onData: (bytes: Uint8Array) => void): Promise<StreamProcess> {
    if (command.kind === "pty") {
      if (!command.contextId) throw new ExecutionError(400, "invalid_request");
      if (!this.manager.ptyStreamTarget) throw new ExecutionError(409, "worker_streams_unsupported");
      const target = await this.manager.ptyStreamTarget(command.environmentId, command.agentId);
      return openExecutorPtyStream(target.endpoint, target.token, command.contextId, onData);
    }
    const root = command.kind === "terminal" && command.user === "root";
    const target = await this.manager.streamTarget(command.environmentId, command.agentId, root ? { root: true } : undefined);
    const runner = `${this.runner.runnerUid}:${this.runner.runnerGid}`;
    const runnerEnv = ["-e", `HOME=${target.home}`, "-e", "LANG=C.UTF-8"];
    if (command.kind === "terminal") {
      // Root keeps its own HOME so its dotfiles never become root-owned files in the Shadow HOME.
      return this.spawn(["docker", "exec", "-it", "-u", root ? "0:0" : runner, "-w", target.home,
        "-e", `HOME=${root ? "/tmp" : target.home}`, "-e", "LANG=C.UTF-8", "-e", "TERM=xterm-256color",
        target.containerId, "bash", "-l"], { tty: { cols: command.cols, rows: command.rows }, onData });
    }
    // The desktop always runs as the Runner so browser profiles stay usable by Jobs.
    await this.run(["exec", "-u", runner, ...runnerEnv, target.containerId, "luna-desktop", "start"]);
    return this.spawn(["docker", "exec", "-i", "-u", runner, ...runnerEnv, target.containerId, "luna-desktop", "bridge"], { onData });
  }
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

async function runDocker(args: string[]): Promise<void> {
  try { await execute("docker", args, { timeout: 30000 }); }
  catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new ExecutionError(503, code === 127 ? "desktop_unavailable" : "desktop_start_failed");
  }
}

/**
 * Terminal streams get a local PTY so `docker exec -it` forwards resizes; VNC is a plain byte pipe.
 * The explicit env resolves `docker` like the driver's execFile does (Bun.spawn otherwise uses the startup env).
 */
export const bunSpawner: StreamSpawner = (command, { tty, onData }) => {
  if (tty) {
    const child = Bun.spawn(command, { env: process.env, terminal: { cols: tty.cols, rows: tty.rows, data: (_terminal, bytes) => onData(bytes) } });
    return {
      write: bytes => { child.terminal?.write(bytes); },
      resize: (cols, rows) => { child.terminal?.resize(cols, rows); },
      kill: () => { child.kill(); },
      exited: child.exited,
    };
  }
  const child = Bun.spawn(command, { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  void (async () => { for await (const bytes of child.stdout) onData(bytes); })().catch(() => {});
  return {
    write: bytes => { child.stdin.write(bytes); void child.stdin.flush(); },
    resize: () => {},
    kill: () => { child.kill(); },
    exited: child.exited,
  };
};

async function openExecutorPtyStream(
  endpoint: string,
  token: string,
  contextId: string,
  onData: (bytes: Uint8Array) => void,
): Promise<StreamProcess> {
  const abort = new AbortController();
  const baseUrl = `${endpoint.replace(/\/$/, "")}/v1/pty-sessions/${encodeURIComponent(contextId)}`;
  const response = await fetch(`${baseUrl}/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  if (!response.ok || !response.body) {
    abort.abort();
    throw new ExecutionError(
      response.status || 503,
      response.status === 404 ? "pty_session_not_found" : "stream_open_failed",
    );
  }

  let controlChain: Promise<void> = Promise.resolve();
  const sendControl = (payload: Record<string, unknown>) => {
    if (abort.signal.aborted) return;
    controlChain = controlChain
      .then(async () => {
        if (abort.signal.aborted) return;
        await fetch(`${baseUrl}/control`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
      })
      .catch(() => {});
  };

  const reader = response.body.getReader();
  const exited = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) onData(value);
      }
      return 0;
    } catch {
      return 0;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    write: (bytes) => {
      if (bytes.byteLength === 0) return;
      sendControl({ kind: "write", data: Buffer.from(bytes).toString("base64") });
    },
    resize: (cols, rows) => {
      sendControl({ kind: "resize", cols, rows });
    },
    kill: () => {
      abort.abort();
    },
    exited,
  };
}
