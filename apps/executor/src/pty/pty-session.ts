import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderOutput } from "@luna/runner-protocol";
import { claudePtyAdapter } from "./claude-pty-adapter";
import { codexPtyAdapter } from "./codex-pty-adapter";
import { PtyIdleDetector } from "./idle-detector";
import { drainJsonlLines, writePrivateJsonAtomic } from "./jsonl-cursor";
import { createTranscriptTerminalSettle } from "./terminal-settle";
import type { PtyCliAdapter, PtyWriteTarget } from "./types";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, HeadlessViewport, stripAnsiScreenText } from "./viewport";

const MAX_PTY_REPLAY_BYTES = 256 * 1024;

export interface LivePtyProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  kill(signal?: NodeJS.Signals | number): void;
}

export type PtyProcessSpawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cols: number;
    readonly rows: number;
    readonly onData: (bytes: Uint8Array) => void;
  },
) => LivePtyProcess;

export const bunPtySpawner: PtyProcessSpawner = (command, args, options) => {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data: (_terminal, bytes) => options.onData(bytes),
    },
  });
  return {
    pid: child.pid,
    exited: child.exited,
    write: (data: string | Uint8Array) => {
      child.terminal?.write(data);
    },
    resize: (cols: number, rows: number) => {
      child.terminal?.resize(cols, rows);
    },
    close: () => {
      try { child.terminal?.close(); } catch { /* ignore */ }
    },
    kill: (signal?: NodeJS.Signals | number) => {
      try { child.kill(signal); } catch { /* already exited */ }
    },
  };
};

const DYNAMIC_TURN_LUNA_KEYS = new Set([
  "LUNA_ACCESS_TOKEN",
  "LUNA_INVOCATION_ID",
  "LUNA_SERVICE_URL",
  "LUNA_AGENT_ID",
  "LUNA_ACTOR_KIND",
  "LUNA_ACTOR_ID",
  "LUNA_RUNNER_KIND",
  "LUNA_RUNNER_CONTEXT_ID",
  "LUNA_SESSION_ID",
  "LUNA_TASK_ID",
  "LUNA_TASK_RUN_ID",
]);

export function splitStaticAndTurnEnv(env: Readonly<NodeJS.ProcessEnv>): {
  readonly staticEnv: Record<string, string>;
  readonly turnEnv: Record<string, string>;
} {
  const staticEnv: Record<string, string> = {};
  const turnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (DYNAMIC_TURN_LUNA_KEYS.has(key)) {
      turnEnv[key] = value;
    } else {
      staticEnv[key] = value;
    }
  }
  return { staticEnv, turnEnv };
}

export function resolvePtyCliAdapter(runnerType: string): PtyCliAdapter {
  if (runnerType === "codex") return codexPtyAdapter;
  return claudePtyAdapter;
}

export interface PtySessionControllerOptions {
  readonly runnerType: string;
  readonly cwd: string;
  readonly home: string;
  readonly model?: string | undefined;
  readonly staticEnv: NodeJS.ProcessEnv;
  readonly initialSessionId?: string | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly spawner?: PtyProcessSpawner | undefined;
  readonly adapter?: PtyCliAdapter | undefined;
  readonly onIdleExpired?: (() => void) | undefined;
  readonly onLiveData?: ((bytes: Uint8Array) => void) | undefined;
}

export class PtySessionController {
  private readonly adapter: PtyCliAdapter;
  private readonly spawner: PtyProcessSpawner;
  private readonly controlDir: string;
  private readonly turnEnvFile: string;
  private idleTimeoutMs: number;
  private readonly startupTimeoutMs: number;

  private proc: LivePtyProcess | null = null;
  private viewport: HeadlessViewport | null = null;
  private currentCols = DEFAULT_PTY_COLS;
  private currentRows = DEFAULT_PTY_ROWS;
  private idleDetector: PtyIdleDetector | null = null;
  private hookPollTimer: ReturnType<typeof setInterval> | null = null;
  private hookEventsOffset = 0;
  private idleReapTimer: ReturnType<typeof setTimeout> | null = null;
  private ptyTextTail = "";
  private replayChunks: Buffer[] = [];
  private replayBytes = 0;
  private exitCode: number | null = null;
  private currentSessionId: string | undefined;
  private activeCancelAbort: AbortController | null = null;
  private closed = false;

  constructor(private readonly options: PtySessionControllerOptions) {
    this.adapter = options.adapter ?? resolvePtyCliAdapter(options.runnerType);
    this.spawner = options.spawner ?? bunPtySpawner;
    this.controlDir = join(tmpdir(), `luna-pty-${process.pid}-${randomUUID().slice(0, 8)}`);
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    this.turnEnvFile = join(this.controlDir, "turn-env.json");
    this.idleTimeoutMs = options.idleTimeoutMs ?? 600_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.currentSessionId = options.initialSessionId;
  }

  getSessionId(): string | undefined {
    return this.currentSessionId;
  }

  setIdleTimeoutMs(ms: number): void {
    this.idleTimeoutMs = Math.max(0, Math.trunc(ms));
    this.clearIdleReapTimer();
    if (!this.activeCancelAbort && this.isAlive()) {
      this.armIdleReapTimer();
    }
  }

  getTurnEnvFilePath(): string {
    return this.turnEnvFile;
  }

  isAlive(): boolean {
    return !this.closed && this.proc !== null && this.exitCode === null;
  }

  getReplayBuffer(): Buffer {
    if (this.replayChunks.length === 0) return Buffer.alloc(0);
    if (this.replayChunks.length === 1) return this.replayChunks[0]!;
    const merged = Buffer.concat(this.replayChunks, this.replayBytes);
    this.replayChunks = [merged];
    return merged;
  }

  async flushViewport(): Promise<void> {
    await this.viewport?.flush();
  }

  getReplaySnapshot(): Buffer {
    if (this.viewport) {
      return this.viewport.serializeAnsi();
    }
    return this.getReplayBuffer();
  }

  writeRaw(bytes: Uint8Array): void {
    if (!this.proc || this.exitCode !== null) return;
    this.proc.write(bytes);
    if (!this.activeCancelAbort) {
      this.armIdleReapTimer();
    }
  }

  resize(cols: number, rows: number): boolean {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return false;
    const clampedCols = Math.max(40, Math.min(400, Math.trunc(cols)));
    const clampedRows = Math.max(12, Math.min(200, Math.trunc(rows)));
    const changed = clampedCols !== this.currentCols || clampedRows !== this.currentRows;
    this.currentCols = clampedCols;
    this.currentRows = clampedRows;
    this.viewport?.resize(clampedCols, clampedRows);
    if (changed && this.proc && this.exitCode === null) {
      this.proc.resize(clampedCols, clampedRows);
    }
    return changed;
  }

  private appendReplay(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const copy = Buffer.from(bytes);
    this.replayChunks.push(copy);
    this.replayBytes += copy.length;
    while (this.replayBytes > MAX_PTY_REPLAY_BYTES && this.replayChunks.length > 0) {
      const head = this.replayChunks[0]!;
      const excess = this.replayBytes - MAX_PTY_REPLAY_BYTES;
      if (head.length <= excess) {
        this.replayChunks.shift();
        this.replayBytes -= head.length;
      } else {
        this.replayChunks[0] = head.subarray(excess);
        this.replayBytes -= excess;
        break;
      }
    }
  }

  writeTurnEnv(turnEnv: Readonly<Record<string, string>>): void {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(turnEnv)) {
      if (key.startsWith("LUNA_") && typeof value === "string") {
        filtered[key] = value;
      }
    }
    writePrivateJsonAtomic(this.turnEnvFile, filtered);
  }

  clearTurnEnv(): void {
    rmSync(this.turnEnvFile, { force: true });
  }

  async ensureStarted(resumeSessionId?: string): Promise<void> {
    if (this.closed) throw new Error("PTY session controller is closed");
    if (this.proc && this.exitCode === null) return;

    await this.teardownProcess();
    this.exitCode = null;
    this.ptyTextTail = "";
    this.replayChunks = [];
    this.replayBytes = 0;
    this.hookEventsOffset = 0;

    const effectiveResume = resumeSessionId ?? this.currentSessionId;
    const spec = await this.adapter.prepareSpawn({
      runnerType: this.options.runnerType,
      cwd: this.options.cwd,
      home: this.options.home,
      model: this.options.model,
      resumeSessionId: effectiveResume,
      baseEnv: this.options.staticEnv,
      controlDir: this.controlDir,
      turnEnvFile: this.turnEnvFile,
    });
    if (spec.initialSessionId) {
      this.currentSessionId = spec.initialSessionId;
    }

    const viewport = new HeadlessViewport(this.currentCols, this.currentRows);
    const detector = new PtyIdleDetector(this.adapter.idleConfig, () => ({
      full: viewport.readViewport(),
      bottom: viewport.readBottomProbeRegion(),
    }));
    this.viewport = viewport;
    this.idleDetector = detector;

    const decoder = new TextDecoder();
    const proc = this.spawner(spec.command, spec.args, {
      cwd: this.options.cwd,
      env: spec.env,
      cols: this.currentCols,
      rows: this.currentRows,
      onData: (bytes: Uint8Array) => {
        this.appendReplay(bytes);
        this.options.onLiveData?.(bytes);
        const chunk = decoder.decode(bytes, { stream: true });
        if (!chunk) return;
        this.ptyTextTail = (this.ptyTextTail + stripAnsiScreenText(chunk)).slice(-8192);
        viewport.feed(bytes);
        detector.feed(chunk);
      },
    });
    this.proc = proc;
    void proc.exited.then((code) => {
      if (this.proc === proc) {
        this.exitCode = code;
      }
    });

    if (spec.hookEventsFile) {
      const hookPath = spec.hookEventsFile;
      this.hookPollTimer = setInterval(() => {
        this.drainHookFile(hookPath);
      }, 60);
      this.hookPollTimer.unref?.();
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spec.hookEventsFile) this.drainHookFile(spec.hookEventsFile);
      if (this.exitCode !== null) {
        await viewport.flush();
        throw this.buildStartupExitError(this.exitCode);
      }
      await viewport.flush();
      detector.recheckViewport();
      if (detector.isStartupComplete()) {
        return;
      }
      await delay(80);
    }

    await this.teardownProcess();
    throw new Error(`Interactive ${this.adapter.family} CLI did not become ready within ${this.startupTimeoutMs}ms`);
  }

  async runTurn(input: {
    readonly prompt: string;
    readonly sessionId?: string | undefined;
    readonly turnEnv: Readonly<Record<string, string>>;
    readonly onOutput: (output: ProviderOutput) => void;
  }): Promise<{ readonly outcome: "succeeded" | "failed" | "cancelled"; readonly sessionId?: string | undefined }> {
    this.clearIdleReapTimer();
    const cancelAbort = new AbortController();
    this.activeCancelAbort = cancelAbort;
    this.writeTurnEnv(input.turnEnv);

    try {
      if (
        this.proc &&
        this.exitCode === null &&
        input.sessionId !== undefined &&
        this.currentSessionId !== undefined &&
        input.sessionId !== this.currentSessionId
      ) {
        await this.teardownProcess();
        this.currentSessionId = input.sessionId;
      }

      try {
        await this.ensureStarted(input.sessionId);
      } catch (error) {
        if (cancelAbort.signal.aborted) return { outcome: "cancelled", sessionId: this.currentSessionId };
        const message = error instanceof Error ? error.message : String(error);
        const normalized = this.adapter.normalizeExitFailure(message);
        input.onOutput({
          status: "error",
          error: message,
          ...(normalized.failure ? { failure: normalized.failure } : {}),
          ...(normalized.code ? { code: normalized.code } : {}),
        });
        return { outcome: "failed", sessionId: this.currentSessionId };
      }

      if (cancelAbort.signal.aborted) {
        return { outcome: "cancelled", sessionId: this.currentSessionId };
      }

      const proc = this.proc!;
      const detector = this.idleDetector!;
      detector.resetForTurn();

      let idleTriggered = false;
      detector.onIdle(() => {
        idleTriggered = true;
      });

      const turn = this.adapter.beginTurn({
        prompt: input.prompt,
        cwd: this.options.cwd,
        home: this.options.home,
        env: this.options.staticEnv,
        cliPid: proc.pid,
        currentSessionId: this.currentSessionId,
      });

      const ptyTarget: PtyWriteTarget = {
        pid: proc.pid,
        write: (data: string) => proc.write(data),
      };

      const submitResult = await turn.submit(ptyTarget);
      if (submitResult.sessionId) {
        this.currentSessionId = submitResult.sessionId;
      }

      if (cancelAbort.signal.aborted) {
        await this.interruptOrRecycleOnCancel();
        return { outcome: "cancelled", sessionId: this.currentSessionId };
      }

      if (!submitResult.submitted) {
        await this.teardownProcess();
        const message = submitResult.failureReason ?? "PTY prompt submission could not be confirmed";
        input.onOutput({ status: "error", error: message });
        return { outcome: "failed", sessionId: this.currentSessionId };
      }

      const emitDrained = (settleFallback = false) => {
        const drained = turn.bridge.drain(settleFallback ? { settleFallback: true } : undefined);
        if (drained.observedSessionId) {
          this.currentSessionId = drained.observedSessionId;
        }
        for (const out of drained.outputs) {
          input.onOutput(out);
        }
        return drained;
      };

      for (;;) {
        if (cancelAbort.signal.aborted) {
          await this.interruptOrRecycleOnCancel();
          return { outcome: "cancelled", sessionId: this.currentSessionId };
        }

        const drained = emitDrained(false);
        if (drained.terminal) {
          return this.finishTerminal(drained.terminal, input.onOutput);
        }

        if (idleTriggered) {
          idleTriggered = false;
          let settledTerminal: ReturnType<typeof emitDrained>["terminal"];
          await new Promise<void>((resolve) => {
            const settle = createTranscriptTerminalSettle({
              pollMs: 100,
              timeoutMs: 2_000,
              awaitingTerminal: () => {
                if (cancelAbort.signal.aborted || !detector.isIdle()) return false;
                const check = emitDrained(false);
                if (check.terminal) {
                  settledTerminal = check.terminal;
                  return false;
                }
                return true;
              },
            });
            settle.request(resolve);
          });

          if (cancelAbort.signal.aborted) {
            await this.interruptOrRecycleOnCancel();
            return { outcome: "cancelled", sessionId: this.currentSessionId };
          }
          if (settledTerminal) {
            return this.finishTerminal(settledTerminal, input.onOutput);
          }
          const fallbackDrained = emitDrained(true);
          if (fallbackDrained.terminal) {
            return this.finishTerminal(fallbackDrained.terminal, input.onOutput);
          }
          if (!detector.isIdle() && this.exitCode === null) {
            continue;
          }
          if (this.exitCode === null) {
            await this.viewport?.flush();
            const tail = this.ptyTextTail.trim().slice(-2000);
            const message = tail || "PTY session returned to idle without a confirmed completion event";
            const normalized = this.adapter.normalizeExitFailure(message);
            await this.teardownProcess();
            input.onOutput({
              status: "error",
              error: message,
              ...(normalized.failure ? { failure: normalized.failure } : {}),
              ...(normalized.code ? { code: normalized.code } : {}),
            });
            return { outcome: "failed", sessionId: this.currentSessionId };
          }
        }

        if (this.exitCode !== null) {
          await this.viewport?.flush();
          const finalDrain = emitDrained(true);
          if (finalDrain.terminal) {
            return this.finishTerminal(finalDrain.terminal, input.onOutput);
          }
          const code = this.exitCode;
          const tail = this.ptyTextTail.trim().slice(-2000);
          const message = code !== 0
            ? (tail || `Process exited with code ${code}`)
            : "Provider exited without a successful completion event";
          const normalized = this.adapter.normalizeExitFailure(message);
          await this.teardownProcess();
          input.onOutput({
            status: "error",
            error: message,
            exitCode: code,
            ...(normalized.failure ? { failure: normalized.failure } : {}),
            ...(normalized.code ? { code: normalized.code } : {}),
          });
          return { outcome: "failed", sessionId: this.currentSessionId };
        }

        await delay(80);
      }
    } finally {
      this.clearTurnEnv();
      this.activeCancelAbort = null;
      if (this.isAlive()) {
        this.armIdleReapTimer();
      }
    }
  }

  cancelActiveTurn(): void {
    this.clearTurnEnv();
    this.activeCancelAbort?.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleReapTimer();
    this.clearTurnEnv();
    this.activeCancelAbort?.abort();
    await this.teardownProcess();
    rmSync(this.controlDir, { recursive: true, force: true });
  }

  private finishTerminal(
    terminal: NonNullable<ReturnType<import("./types").PtyTurnBridge["drain"]>["terminal"]>,
    onOutput: (output: ProviderOutput) => void,
  ): { readonly outcome: "succeeded" | "failed" | "cancelled"; readonly sessionId?: string | undefined } {
    if (terminal.kind === "completed") {
      onOutput({
        status: "success",
        result: terminal.finalText,
        ...(this.currentSessionId ? { newSessionId: this.currentSessionId } : {}),
      });
      return { outcome: "succeeded", sessionId: this.currentSessionId };
    }
    if (terminal.kind === "error") {
      onOutput(terminal.output);
      return { outcome: "failed", sessionId: this.currentSessionId };
    }
    const message = terminal.reason ? `Turn aborted: ${terminal.reason}` : "Turn aborted";
    onOutput({ status: "error", error: message });
    return { outcome: "failed", sessionId: this.currentSessionId };
  }

  private async interruptOrRecycleOnCancel(): Promise<void> {
    if (!this.proc || this.exitCode !== null) return;
    try {
      this.proc.write("\x1b");
      await delay(50);
      this.proc.write("\x03");
    } catch { /* ignore write errors */ }

    const deadline = Date.now() + 1_200;
    while (Date.now() < deadline) {
      if (this.exitCode !== null) {
        await this.teardownProcess();
        return;
      }
      await this.viewport?.flush();
      this.idleDetector?.recheckViewport();
      if (this.idleDetector?.isIdle()) {
        return;
      }
      await delay(80);
    }
    await this.teardownProcess();
  }

  private drainHookFile(hookPath: string): void {
    const { lines, newOffset } = drainJsonlLines(hookPath, this.hookEventsOffset);
    this.hookEventsOffset = newOffset;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { event?: string };
        if (parsed.event === "SessionStart") {
          this.idleDetector?.notifyHookStartupReady();
        } else if (parsed.event === "Stop" || parsed.event === "StopFailure") {
          this.idleDetector?.notifyHookTurnStopped();
        }
      } catch { /* ignore malformed hook line */ }
    }
  }

  private buildStartupExitError(code: number): Error {
    const tail = this.ptyTextTail.trim().slice(-2000);
    return new Error(tail || `Interactive ${this.adapter.family} CLI exited during startup with code ${code}`);
  }

  private armIdleReapTimer(): void {
    this.clearIdleReapTimer();
    if (this.idleTimeoutMs <= 0) return;
    this.idleReapTimer = setTimeout(() => {
      this.idleReapTimer = null;
      void this.close().finally(() => {
        this.options.onIdleExpired?.();
      });
    }, this.idleTimeoutMs);
    this.idleReapTimer.unref?.();
  }

  private clearIdleReapTimer(): void {
    if (this.idleReapTimer) {
      clearTimeout(this.idleReapTimer);
      this.idleReapTimer = null;
    }
  }

  private async teardownProcess(): Promise<void> {
    if (this.hookPollTimer) {
      clearInterval(this.hookPollTimer);
      this.hookPollTimer = null;
    }
    this.idleDetector?.dispose();
    this.idleDetector = null;
    this.viewport?.dispose();
    this.viewport = null;

    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.close();
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      proc.exited.then(() => true),
      delay(1_500).then(() => false),
    ]);
    if (!exited) {
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, delay(500)]);
    }
  }
}
