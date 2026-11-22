import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash } from "@luna/execution-store";
import { ProviderOutput } from "@luna/runner-protocol";
import { StreamEventParser } from "@luna/runner-protocol/stream-parser";
import type { ExecutionContext } from "./contexts";
import { processStartTime } from "./process-cleanup";
import { splitStaticAndTurnEnv } from "../pty/pty-session";
import type { PtyHostCommand, PtySessionSummary } from "../pty/types";

export interface PtyViewerHandlers {
  readonly onData: (bytes: Uint8Array) => void;
  readonly onClose: (reason: string) => void;
}

export interface PtyTurnAttemptResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly succeeded: boolean;
  readonly unsafeFailure: boolean;
}

interface ActiveTurnHandler {
  readonly turnId: string;
  readonly onOutput: (output: ProviderOutput) => void;
  readonly onStderr: (text: string) => void;
  readonly finish: (result: PtyTurnAttemptResult) => void;
}

class WarmPtyHost {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly startTime: string;
  readonly startedAt = Date.now();
  readonly runnerType: "claude" | "codex";
  readonly model: string | undefined;
  private currentSessionId: string | undefined;
  private lastActiveAt = Date.now();
  private readonly readyPromise: Promise<void>;
  private activeTurn: ActiveTurnHandler | null = null;
  private readonly viewers = new Map<string, PtyViewerHandlers & { replayed: boolean }>();
  private closed = false;
  private closePromise: Promise<void>;
  private unsafeFailure = false;

  constructor(
    readonly context: ExecutionContext,
    readonly fingerprint: string,
    readonly privileged: boolean,
    jobProcessPath: string,
    ptyEntryPath: string,
    containerEnv: NodeJS.ProcessEnv,
    initCmd: Extract<PtyHostCommand, { type: "init" }>,
    private readonly onEvict: (host: WarmPtyHost) => void,
  ) {
    this.runnerType = initCmd.runnerType;
    this.model = initCmd.model;
    this.currentSessionId = initCmd.sessionId;
    this.child = spawn(
      process.execPath,
      [
        jobProcessPath,
        String(context.uid),
        String(context.gid),
        context.cwd,
        ptyEntryPath,
        privileged ? "sudo" : "restricted",
      ],
      { cwd: "/", env: containerEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    if (!this.child.pid) {
      throw new Error("PTY host PID missing after spawn");
    }
    this.pid = this.child.pid;
    this.startTime = processStartTime(this.pid);

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    let resolveClosed!: () => void;
    this.closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const parser = new StreamEventParser();
    let frameBytes = 0;

    const triggerUnsafeFailure = () => {
      this.unsafeFailure = true;
      this.child.kill("SIGTERM");
    };

    this.child.stdout!.on("data", (chunk: Buffer) => {
      frameBytes += chunk.length;
      if (frameBytes > 8 * 1024 * 1024) triggerUnsafeFailure();
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      try {
        if (frameBytes > 8 * 1024 * 1024) throw new Error("PTY host protocol frame exceeds limit");
        for (const event of parser.feedLine(line)) {
          frameBytes = 0;
          if (event.status === "host_ready") {
            if (typeof event.data.sessionId === "string" && event.data.sessionId) {
              this.currentSessionId = event.data.sessionId;
            }
            if (!readySettled) {
              readySettled = true;
              resolveReady();
            }
            continue;
          }
          if (event.status === "pty_replay") {
            const viewerId = typeof event.data.viewerId === "string" ? event.data.viewerId : "";
            const viewer = this.viewers.get(viewerId);
            if (typeof event.data.sessionId === "string" && event.data.sessionId) {
              this.currentSessionId = event.data.sessionId;
            }
            if (viewer) {
              const raw = typeof event.data.data === "string" && event.data.data
                ? Buffer.from(event.data.data, "base64")
                : Buffer.alloc(0);
              if (raw.length > 0) viewer.onData(raw);
              viewer.replayed = true;
            }
            continue;
          }
          if (event.status === "pty_data") {
            this.lastActiveAt = Date.now();
            if (this.viewers.size > 0 && typeof event.data.data === "string" && event.data.data) {
              const raw = Buffer.from(event.data.data, "base64");
              if (raw.length > 0) {
                for (const viewer of this.viewers.values()) {
                  if (viewer.replayed) viewer.onData(raw);
                }
              }
            }
            continue;
          }
          if (event.status === "turn_output") {
            this.lastActiveAt = Date.now();
            const turnId = typeof event.data.turnId === "string" ? event.data.turnId : "";
            if (this.activeTurn && this.activeTurn.turnId === turnId) {
              const output = ProviderOutput.parse(event.data.output);
              if (output.status === "init") this.currentSessionId = output.sessionId;
              if (output.status === "success" && output.newSessionId) this.currentSessionId = output.newSessionId;
              this.activeTurn.onOutput(output);
            }
            continue;
          }
          if (event.status === "turn_done") {
            this.lastActiveAt = Date.now();
            const turnId = typeof event.data.turnId === "string" ? event.data.turnId : "";
            const outcome = event.data.outcome;
            if (typeof event.data.sessionId === "string" && event.data.sessionId) {
              this.currentSessionId = event.data.sessionId;
            }
            if (this.activeTurn && this.activeTurn.turnId === turnId) {
              const handler = this.activeTurn;
              this.activeTurn = null;
              const succeeded = outcome === "succeeded";
              handler.finish({
                code: succeeded ? 0 : 1,
                signal: null,
                succeeded,
                unsafeFailure: false,
              });
            }
            continue;
          }
          if (event.status === "session_closed") {
            const reason = typeof event.data.reason === "string" ? event.data.reason : "pty_session_closed";
            for (const viewer of this.viewers.values()) {
              viewer.onClose(reason);
            }
            this.viewers.clear();
            if (!readySettled) {
              readySettled = true;
              rejectReady(new Error(reason));
            }
            continue;
          }
        }
      } catch {
        triggerUnsafeFailure();
      }
    });

    this.child.stderr!.on("data", (chunk: Buffer) => {
      try {
        this.activeTurn?.onStderr(chunk.toString("utf8"));
      } catch {
        triggerUnsafeFailure();
      }
    });

    this.child.stdin!.on("error", () => {
      if (this.activeTurn) triggerUnsafeFailure();
    });

    this.child.once("error", (err) => {
      this.unsafeFailure = true;
      if (!readySettled) {
        readySettled = true;
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.child.once("close", (code, signal) => {
      this.closed = true;
      rl.close();
      this.onEvict(this);
      for (const viewer of this.viewers.values()) {
        viewer.onClose(`exited:${code ?? 0}`);
      }
      this.viewers.clear();
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(`PTY host exited before ready with code ${code ?? "null"}`));
      }
      if (this.activeTurn) {
        const handler = this.activeTurn;
        this.activeTurn = null;
        handler.finish({
          code,
          signal,
          succeeded: false,
          unsafeFailure: this.unsafeFailure,
        });
      }
      resolveClosed();
    });

    this.sendCommand(initCmd);
  }

  isAlive(): boolean {
    return !this.closed;
  }

  summary(): PtySessionSummary {
    return {
      contextId: this.context.id,
      runnerType: this.runnerType,
      ...(this.model ? { model: this.model } : {}),
      ...(this.currentSessionId ? { sessionId: this.currentSessionId } : {}),
      busy: this.activeTurn !== null,
      privileged: this.privileged,
      pid: this.pid,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  attachViewer(handlers: PtyViewerHandlers, size?: { cols: number; rows: number }): () => void {
    if (this.closed) {
      handlers.onClose("pty_session_closed");
      return () => {};
    }
    const viewerId = randomUUID();
    this.viewers.set(viewerId, { ...handlers, replayed: false });
    this.sendCommand({
      type: "attach_viewer",
      viewerId,
      ...(size ? { cols: size.cols, rows: size.rows } : {}),
    });
    return () => {
      if (this.viewers.delete(viewerId) && !this.closed) {
        this.sendCommand({ type: "detach_viewer", viewerId });
      }
    };
  }

  writeInput(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return;
    this.lastActiveAt = Date.now();
    this.sendCommand({ type: "pty_input", data: Buffer.from(bytes).toString("base64") });
  }

  resizePty(cols: number, rows: number): void {
    if (this.closed || cols < 1 || rows < 1) return;
    this.sendCommand({ type: "pty_resize", cols, rows });
  }

  setIdleTimeout(idleTimeoutMs: number): void {
    if (this.closed) return;
    this.sendCommand({ type: "set_idle_timeout", idleTimeoutMs });
  }

  async waitReady(): Promise<void> {
    await this.readyPromise;
  }

  runTurn(input: {
    readonly turnId: string;
    readonly prompt: string;
    readonly sessionId?: string | undefined;
    readonly turnEnv: Record<string, string>;
    readonly idleTimeoutMs?: number | undefined;
    readonly onOutput: (output: ProviderOutput) => void;
    readonly onStderr: (text: string) => void;
  }): Promise<PtyTurnAttemptResult> {
    if (this.closed) {
      return Promise.resolve({ code: 1, signal: null, succeeded: false, unsafeFailure: true });
    }
    return new Promise<PtyTurnAttemptResult>((resolve) => {
      this.activeTurn = {
        turnId: input.turnId,
        onOutput: input.onOutput,
        onStderr: input.onStderr,
        finish: resolve,
      };
      this.sendCommand({
        type: "run_turn",
        turnId: input.turnId,
        prompt: input.prompt,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        turnEnv: input.turnEnv,
        ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
      });
    });
  }

  updateCredentials(turnId: string, turnEnv: Record<string, string>): void {
    if (this.closed || this.activeTurn?.turnId !== turnId) return;
    this.sendCommand({ type: "update_credentials", turnId, turnEnv });
  }

  cancelTurn(turnId: string): void {
    if (this.closed) return;
    if (this.activeTurn?.turnId === turnId) {
      this.sendCommand({ type: "cancel_turn", turnId });
      const timer = setTimeout(() => {
        if (!this.closed && this.activeTurn?.turnId === turnId) {
          this.child.kill("SIGTERM");
        }
      }, 2_500);
      timer.unref?.();
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.sendCommand({ type: "shutdown" });
      const graceful = await Promise.race([
        this.closePromise.then(() => true),
        delay(1_500).then(() => false),
      ]);
      if (!graceful && !this.closed) {
        this.child.kill("SIGTERM");
        await this.closePromise;
      }
    }
    await this.closePromise;
  }

  private sendCommand(cmd: PtyHostCommand): void {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
    } catch {
      this.unsafeFailure = true;
      this.child.kill("SIGTERM");
    }
  }
}

export class PtyContextPool {
  private readonly hosts = new Map<string, WarmPtyHost>();

  constructor(
    private readonly jobProcessPath: string,
    private readonly ptyEntryPath: string,
  ) {}

  async acquire(input: {
    readonly context: ExecutionContext;
    readonly runnerType: "claude" | "codex";
    readonly model?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly forceReset: boolean;
    readonly privileged: boolean;
    readonly resourceRevision: string;
    readonly containerEnv: NodeJS.ProcessEnv;
    readonly suppliedEnv: Record<string, string>;
    readonly idleTimeoutMs?: number | undefined;
  }): Promise<{ readonly host: WarmPtyHost; readonly turnEnv: Record<string, string> }> {
    const cleanSupplied = { ...input.suppliedEnv };
    for (const key of ["HOME", "PATH", "LUNA_HOME", "LUNA_RUNNER_HOME", "LUNA_IPC_DIR"]) {
      delete cleanSupplied[key];
    }
    const { staticEnv, turnEnv } = splitStaticAndTurnEnv(cleanSupplied);
    const fingerprint = contentHash({
      runnerType: input.runnerType,
      model: input.model ?? null,
      privileged: input.privileged,
      resourceRevision: input.resourceRevision,
      staticEnv,
    });

    const existing = this.hosts.get(input.context.id);
    if (existing) {
      if (!existing.isAlive() || existing.fingerprint !== fingerprint || input.forceReset) {
        this.hosts.delete(input.context.id);
        await existing.close();
      } else {
        await existing.waitReady();
        return { host: existing, turnEnv };
      }
    }

    const host = new WarmPtyHost(
      input.context,
      fingerprint,
      input.privileged,
      this.jobProcessPath,
      this.ptyEntryPath,
      input.containerEnv,
      {
        type: "init",
        runnerType: input.runnerType,
        ...(input.model ? { model: input.model } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        staticEnv,
        ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
      },
      (evicted) => {
        if (this.hosts.get(input.context.id) === evicted) {
          this.hosts.delete(input.context.id);
        }
      },
    );
    this.hosts.set(input.context.id, host);
    await host.waitReady();
    return { host, turnEnv };
  }

  notifyCredentials(contextId: string, turnId: string, suppliedEnv: Record<string, string>): void {
    const host = this.hosts.get(contextId);
    if (!host) return;
    const { turnEnv } = splitStaticAndTurnEnv(suppliedEnv);
    host.updateCredentials(turnId, turnEnv);
  }

  listSessions(): PtySessionSummary[] {
    const out: PtySessionSummary[] = [];
    for (const host of this.hosts.values()) {
      if (host.isAlive()) out.push(host.summary());
    }
    return out;
  }

  attachViewer(contextId: string, handlers: PtyViewerHandlers, size?: { cols: number; rows: number }): (() => void) | null {
    const host = this.hosts.get(contextId);
    if (!host || !host.isAlive()) return null;
    return host.attachViewer(handlers, size);
  }

  writeInput(contextId: string, bytes: Uint8Array): boolean {
    const host = this.hosts.get(contextId);
    if (!host || !host.isAlive()) return false;
    host.writeInput(bytes);
    return true;
  }

  resizePty(contextId: string, cols: number, rows: number): boolean {
    const host = this.hosts.get(contextId);
    if (!host || !host.isAlive()) return false;
    host.resizePty(cols, rows);
    return true;
  }

  setIdleTimeoutAll(idleTimeoutMs: number): void {
    for (const host of this.hosts.values()) {
      if (host.isAlive()) host.setIdleTimeout(idleTimeoutMs);
    }
  }

  async closeAll(): Promise<void> {
    const current = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(current.map((host) => host.close()));
  }
}
