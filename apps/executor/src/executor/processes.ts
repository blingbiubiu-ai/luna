import { sanitizeHome } from "./runner-sudo";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ExecutorStore } from "./store";
import { ExecutorContexts } from "./contexts";
import { processStartTime } from "./process-cleanup";
import { PtyContextPool, type PtyViewerHandlers } from "./pty-driver";
import type { PtySessionSummary } from "../pty/types";
import { transaction } from "@luna/execution-store";
import { EXECUTION_CONTINUATION_PROMPT, executionRetryDelay, isTransientProviderFailure, isTerminal, ProviderOutput, type JobRequest } from "@luna/runner-protocol";
import { runnerAssetPaths } from "@luna/runner-protocol/runner-assets";
import { StreamEventParser } from "@luna/runner-protocol/stream-parser";

interface Running { contextId: string; turnId?: string; cancel: () => void; done: Promise<void>; }
const jobProcess = fileURLToPath(new URL(import.meta.file.endsWith(".ts") ? "./job-process.ts" : "./job-process.js", import.meta.url));
const defaultPtyEntry = fileURLToPath(new URL(import.meta.file.endsWith(".ts") ? "../pty/pty-main.ts" : "./pty-main.js", import.meta.url));

/** Owns local processes. Network detach never calls cancel(). */
export class ExecutorProcesses {
  private readonly running = new Map<string, Running>();
  private readonly ptyPool: PtyContextPool;
  private stopped = false;
  constructor(private readonly store: ExecutorStore, private readonly contexts: ExecutorContexts,
    private readonly runnerEntry: string, private readonly capacity: number, private readonly runnerSudo = false, ptyEntry = defaultPtyEntry) {
    if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Executor requires Linux root with limited container capabilities");
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid Executor capacity");
    this.ptyPool = new PtyContextPool(jobProcess, ptyEntry);
  }

  /** Docker stops the previous process tree when the Executor container exits. */
  async recover(): Promise<void> {
    for (const snapshot of this.store.list(true)) {
      const job = this.store.request(snapshot.jobId);
      if (job && !isTerminal(snapshot.state)) {
        this.store.retries.initialize(job.jobId, job.retryPolicy, snapshot.createdAt + job.timeoutMs);
        this.store.retries.finish(job.jobId, Date.now(), "executor_restarted");
      }
    }
    this.store.recoverInterrupted();
  }

  tick(): void {
    if (this.stopped) return;
    const lanes = new Set([...this.running.values()].map((running) => running.contextId));
    for (const snapshot of this.store.list(true)) {
      if (!["queued", "retry_wait"].includes(snapshot.state)) continue;
      const job = this.store.request(snapshot.jobId);
      if (!job) continue;
      const retry = this.store.retries.initialize(job.jobId, job.retryPolicy, snapshot.createdAt + job.timeoutMs);
      if (Date.now() >= retry.deadlineAt) {
        transaction(this.store.db, () => {
          this.store.retries.finish(job.jobId, Date.now(), "deadline_exceeded");
          this.store.transition(job.jobId, "failed", { code: "execution_timeout", message: "Job execution deadline exceeded" });
        });
        continue;
      }
      if (lanes.has(job.runnerContextId)) continue;
      lanes.add(job.runnerContextId); // Later Jobs cannot overtake one awaiting credentials/backoff.
      if (this.running.size >= this.capacity) continue;
      if (retry.nextRetryAt !== null && Date.now() < retry.nextRetryAt) continue;
      const credentials = this.contexts.credentials(job);
      if (!credentials) continue; // Renewed credentials may arrive until the fixed Job deadline.
      this.launch(job, credentials.env);
    }
  }

  async cancel(id: string): Promise<void> {
    const snapshot = this.store.snapshot(id);
    if (isTerminal(snapshot.state)) return;
    const job = this.store.request(id);
    if (job) {
      this.store.retries.initialize(id, job.retryPolicy, snapshot.createdAt + job.timeoutMs);
      this.store.retries.cancel(id);
    }
    if (["queued", "retry_wait"].includes(snapshot.state)) {
      if (job) this.store.retries.finish(id, Date.now(), "cancelled");
      this.store.transition(id, "cancelled"); return;
    }
    const running = this.running.get(id);
    if (!running) throw new Error("Active process ownership missing");
    if (snapshot.state !== "cancelling") this.store.transition(id, "cancelling");
    running.cancel();
    await running.done;
  }

  notifyCredentials(jobId: string, env: Record<string, string>): void {
    const running = this.running.get(jobId);
    if (running?.turnId) {
      this.ptyPool.notifyCredentials(running.contextId, running.turnId, env);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.running.keys()].map((id) => this.cancel(id)));
    await this.ptyPool.closeAll();
  }
  activeCount(): number { return this.store.list(true).filter(job => !isTerminal(job.state) && this.store.request(job.jobId)).length; }
  listPtySessions(): PtySessionSummary[] { return this.ptyPool.listSessions(); }
  attachPtyViewer(contextId: string, handlers: PtyViewerHandlers): (() => void) | null { return this.ptyPool.attachViewer(contextId, handlers); }
  writePtyInput(contextId: string, bytes: Uint8Array): boolean { return this.ptyPool.writeInput(contextId, bytes); }
  resizePtySession(contextId: string, cols: number, rows: number): boolean { return this.ptyPool.resizePty(contextId, cols, rows); }
  setPtyIdleTimeout(idleTimeoutMs: number): void { this.ptyPool.setIdleTimeoutAll(idleTimeoutMs); }

  private launch(job: JobRequest, suppliedEnv: Record<string, string>): void {
    const context = this.contexts.get(job.runnerContextId);
    if (context.project?.projectId !== job.projectId) {
      this.store.retries.finish(job.jobId, Date.now(), "context_project_conflict");
      this.store.transition(job.jobId, "failed", { code: "context_project_conflict", message: "Job project does not match the registered context" });
      return;
    }
    const retry = transaction(this.store.db, () => {
      const claimed = this.store.retries.claim(job.jobId, Date.now());
      if (claimed) this.store.retryState(job.jobId, claimed, "starting");
      return claimed;
    });
    if (!retry) return;
    const environment: NodeJS.ProcessEnv = { PATH: `${runnerAssetPaths(context.home).commands}:${context.home}/.local/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/30.0.3:/opt/android-sdk/cmake/3.22.1/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: context.home,
      LUNA_RUNNER_HOME: context.cwd, LUNA_HOME: context.home, IS_SANDBOX: "1", LANG: "C.UTF-8" };
    environment.JAVA_TOOL_OPTIONS = `-Djava.net.preferIPv4Stack=true -Duser.home=${context.home}`;
    for (const key of ["JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_NDK_HOME", "CHROME_BIN", "PUPPETEER_EXECUTABLE_PATH"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    if (job.runnerKind === "work") {
      environment.GRADLE_OPTS = "-Dorg.gradle.workers.max=6";
      environment.CMAKE_BUILD_PARALLEL_LEVEL = "6";
    }
    const effectivePrivileged = this.runnerSudo && job.privileged === true;
    if (job.input.executionDriver === "pty") {
      this.launchPty(job, context, retry, environment, suppliedEnv, effectivePrivileged);
      return;
    }
    const child = spawn(process.execPath, [jobProcess, String(context.uid), String(context.gid), context.cwd, this.runnerEntry, effectivePrivileged ? "sudo" : "restricted"],
      { cwd: "/", env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let finish!: () => void;
    const running: Running = { contextId: context.id, cancel: () => { child.kill("SIGTERM"); }, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.running.set(job.jobId, running);
    let failed = false; let succeeded = false; let finished = false;
    let providerError: Extract<ProviderOutput, { status: "error" }> | undefined;
    let checkpoint = false; let unsafeFailure = false; let timedOut = false;
    const parser = new StreamEventParser();
    let outputBytes = 0;
    const outputFailure = () => {
      failed = true; unsafeFailure = true; child.kill("SIGTERM");
    };
    child.stdout!.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 8 * 1024 * 1024) outputFailure(); });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        if (outputBytes > 8 * 1024 * 1024) throw new Error("Runner protocol frame exceeds limit");
        for (const event of parser.feedLine(line)) {
          const output = ProviderOutput.parse({ status: event.status, ...event.data });
          if (event.status === "checkpoint") checkpoint = true;
          if (output.status === "error") { failed = true; providerError = output; }
          if (output.status !== "error") this.store.output(job.jobId, output);
          if (event.status === "success") succeeded = true;
          outputBytes = 0;
        }
      } catch { outputFailure(); }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      try { this.store.output(job.jobId, { status: "stderr", text: chunk.toString("utf8") }); }
      catch { outputFailure(); }
    });
    const timeout = setTimeout(() => { timedOut = true; failed = true; unsafeFailure = true; child.kill("SIGTERM"); }, Math.max(1, retry.deadlineAt - Date.now()));
    const complete = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return; finished = true; clearTimeout(timeout); lines.close();
      try {
        if (code === 125) throw new Error("Job subprocess could not confirm cleanup");
        const state = this.store.snapshot(job.jobId).state;
        transaction(this.store.db, () => {
          this.store.retries.recordExit(job.jobId, retry.attempt, { code, signal });
          const failure = providerError?.failure;
          const snapshot = this.store.snapshot(job.jobId);
          // Only Work can replay its unchanged input after a definitively rejected resume.
          // Main must rebuild business context; Task must not replay completed execution.
          const resetSession = job.runnerKind === "work" && retry.attempt === 1 && !!job.input.sessionId
            && !snapshot.providerCheckpoint && (providerError?.code === "runner_session_not_found" || failure?.kind === "session_unusable");
          const transient = failure && isTransientProviderFailure(failure.kind)
            && (job.runnerKind !== "task" || (snapshot.providerCheckpoint && snapshot.providerSessionId));
          const mayRetry = state !== "cancelling" && !unsafeFailure && (resetSession || transient);
          if (mayRetry && this.store.retries.schedule(job.jobId, retry.attempt, { now: Date.now(),
            delayMs: executionRetryDelay(retry.policy, checkpoint ? 1 : retry.consecutiveRetries + 1, failure?.retryAfterMs),
            checkpoint, reason: resetSession ? "session_unusable" : failure!.kind, resetSession })) {
            this.store.retryState(job.jobId, this.store.retries.require(job.jobId), "retry_wait"); return;
          }
          this.store.retries.finish(job.jobId, Date.now(), state === "cancelling" ? "cancelled" : timedOut ? "deadline_exceeded" : !failed && code === 0 && succeeded ? "completed" : "runner_failed");
          if (state === "cancelling") this.store.transition(job.jobId, "cancelled");
          else if (!isTerminal(state)) {
            if (providerError) this.store.output(job.jobId, providerError);
            const completed = !failed && code === 0 && succeeded;
            const terminalError = timedOut ? { code: "execution_timeout", message: "Job execution deadline exceeded" } : {
              code: providerError?.code ?? (providerError?.failure?.kind === "session_unusable" ? "runner_session_not_found" : "runner_failed"),
              message: providerError?.error.slice(0, 4096) ?? "Runner did not complete successfully",
            };
            this.store.transition(job.jobId, completed ? "succeeded" : "failed", completed ? undefined : terminalError);
          }
        });
        this.running.delete(job.jobId);
      } catch { this.stopped = true; /* Keep ownership and nonterminal state when cleanup/persistence fails. */ }
      finally { finish(); }
    };
    child.once("error", () => { failed = true; unsafeFailure = true; });
    // Root may have left setuid or root-owned files in the host-backed HOME.
    child.once("close", (code, signal) => { if (this.runnerSudo && job.privileged === true) sanitizeHome(context.home, context.uid, context.gid); void complete(code, signal); });
    child.once("spawn", () => {
      try {
        if (!child.pid) throw new Error("Runner PID missing after spawn");
        this.store.retries.recordProcess(job.jobId, retry.attempt, { pid: child.pid, startTime: processStartTime(child.pid), uid: context.uid });
        this.store.transition(job.jobId, "running");
        const env = { ...suppliedEnv };
        for (const key of ["HOME", "PATH", "LUNA_HOME", "LUNA_RUNNER_HOME", "LUNA_IPC_DIR"]) delete env[key];
        const resume = retry.attempt > 1 ? this.store.snapshot(job.jobId).providerSessionId : undefined;
        const input = { ...job.input };
        if (retry.sessionReset) delete input.sessionId;
        child.stdin!.end(JSON.stringify({ ...input, ...(resume ? { sessionId: resume, ...(this.store.snapshot(job.jobId).providerCheckpoint ? { prompt: EXECUTION_CONTINUATION_PROMPT } : {}) } : {}), env }));
      } catch { outputFailure(); }
    });
    child.stdin!.on("error", outputFailure);
  }

  private launchPty(
    job: JobRequest,
    context: ReturnType<ExecutorContexts["get"]>,
    retry: NonNullable<ReturnType<ExecutorStore["retries"]["claim"]>>,
    environment: NodeJS.ProcessEnv,
    suppliedEnv: Record<string, string>,
    effectivePrivileged: boolean,
  ): void {
    const turnId = `${job.jobId}:${retry.attempt}`;
    let finish!: () => void;
    let cancelHook: () => void = () => {};
    let cancelledEarly = false;
    const running: Running = {
      contextId: context.id,
      turnId,
      cancel: () => {
        cancelledEarly = true;
        cancelHook();
      },
      done: new Promise<void>((resolve) => { finish = resolve; }),
    };
    this.running.set(job.jobId, running);

    let failed = false;
    let succeeded = false;
    let finished = false;
    let providerError: Extract<ProviderOutput, { status: "error" }> | undefined;
    let checkpoint = false;
    let unsafeFailure = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      failed = true;
      unsafeFailure = true;
      cancelledEarly = true;
      cancelHook();
    }, Math.max(1, retry.deadlineAt - Date.now()));

    const complete = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try {
        if (code === 125) throw new Error("Job subprocess could not confirm cleanup");
        const state = this.store.snapshot(job.jobId).state;
        transaction(this.store.db, () => {
          this.store.retries.recordExit(job.jobId, retry.attempt, { code, signal });
          const failure = providerError?.failure;
          const snapshot = this.store.snapshot(job.jobId);
          const resetSession = job.runnerKind === "work" && retry.attempt === 1 && !!job.input.sessionId
            && !snapshot.providerCheckpoint && (providerError?.code === "runner_session_not_found" || failure?.kind === "session_unusable");
          const transient = failure && isTransientProviderFailure(failure.kind)
            && (job.runnerKind !== "task" || (snapshot.providerCheckpoint && snapshot.providerSessionId));
          const mayRetry = state !== "cancelling" && !unsafeFailure && (resetSession || transient);
          if (mayRetry && this.store.retries.schedule(job.jobId, retry.attempt, {
            now: Date.now(),
            delayMs: executionRetryDelay(retry.policy, checkpoint ? 1 : retry.consecutiveRetries + 1, failure?.retryAfterMs),
            checkpoint,
            reason: resetSession ? "session_unusable" : failure!.kind,
            resetSession,
          })) {
            this.store.retryState(job.jobId, this.store.retries.require(job.jobId), "retry_wait");
            return;
          }
          this.store.retries.finish(
            job.jobId,
            Date.now(),
            state === "cancelling" ? "cancelled" : timedOut ? "deadline_exceeded" : !failed && code === 0 && succeeded ? "completed" : "runner_failed",
          );
          if (state === "cancelling") {
            this.store.transition(job.jobId, "cancelled");
          } else if (!isTerminal(state)) {
            if (providerError) this.store.output(job.jobId, providerError);
            const ok = !failed && code === 0 && succeeded;
            const terminalError = timedOut
              ? { code: "execution_timeout", message: "Job execution deadline exceeded" }
              : {
                  code: providerError?.code ?? (providerError?.failure?.kind === "session_unusable" ? "runner_session_not_found" : "runner_failed"),
                  message: providerError?.error.slice(0, 4096) ?? "Runner did not complete successfully",
                };
            this.store.transition(job.jobId, ok ? "succeeded" : "failed", ok ? undefined : terminalError);
          }
        });
        this.running.delete(job.jobId);
      } catch {
        this.stopped = true;
      } finally {
        finish();
      }
    };

    void (async () => {
      const priorSnapshot = this.store.snapshot(job.jobId);
      const resumeSid = retry.sessionReset
        ? undefined
        : (retry.attempt > 1 ? priorSnapshot.providerSessionId : undefined) ?? job.input.sessionId;
      const effectivePrompt = retry.attempt > 1 && resumeSid && priorSnapshot.providerCheckpoint
        ? EXECUTION_CONTINUATION_PROMPT
        : job.input.prompt;

      try {
        const { host, turnEnv } = await this.ptyPool.acquire({
          context,
          runnerType: job.input.runnerType,
          model: job.input.model,
          sessionId: resumeSid,
          forceReset: retry.sessionReset === true || (retry.attempt === 1 && !job.input.sessionId),
          privileged: effectivePrivileged,
          resourceRevision: job.resourceRevision,
          containerEnv: environment,
          suppliedEnv,
          idleTimeoutMs: job.input.ptyIdleTimeoutMs,
        });

        cancelHook = () => {
          host.cancelTurn(turnId);
        };

        this.store.retries.recordProcess(job.jobId, retry.attempt, {
          pid: host.pid,
          startTime: host.startTime,
          uid: context.uid,
        });
        if (this.store.snapshot(job.jobId).state === "starting") {
          this.store.transition(job.jobId, "running");
        }

        if (cancelledEarly || this.store.snapshot(job.jobId).state === "cancelling") {
          complete(1, "SIGTERM");
          return;
        }

        const result = await host.runTurn({
          turnId,
          prompt: effectivePrompt,
          sessionId: resumeSid,
          turnEnv,
          idleTimeoutMs: job.input.ptyIdleTimeoutMs,
          onOutput: (output) => {
            if (output.status === "checkpoint") checkpoint = true;
            if (output.status === "error") {
              failed = true;
              providerError = output;
            } else {
              this.store.output(job.jobId, output);
            }
            if (output.status === "success") succeeded = true;
          },
          onStderr: (text) => {
            this.store.output(job.jobId, { status: "stderr", text });
          },
        });

        if (result.unsafeFailure) unsafeFailure = true;
        if (!result.succeeded) failed = true;
        complete(result.code, result.signal);
      } catch (error) {
        failed = true;
        providerError ??= {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
        complete(1, null);
      }
    })();
  }
}
