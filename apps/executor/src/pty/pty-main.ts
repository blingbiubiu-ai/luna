import { createInterface } from "node:readline";
import { buildChildEnvironment } from "../job-env";
import { prepareRunnerEnvironment } from "../executor/runner-environment";
import { writeOutput } from "../protocol";
import type { ContainerInput } from "../types";
import type { RunnerResult } from "../runner";
import { PtySessionController, splitStaticAndTurnEnv } from "./pty-session";
import type { PtyHostCommand, PtyHostEvent } from "./types";

function emitHostEvent(event: PtyHostEvent): void {
  writeOutput(event as unknown as Record<string, unknown>);
}

/** One-shot PTY execution used by `job-main.js` (e.g. connection tests and single-turn invocations). */
export async function runPtyQuery(
  input: ContainerInput,
  sessionId?: string,
): Promise<RunnerResult> {
  const runnerRootPath = process.env.LUNA_RUNNER_HOME;
  if (!runnerRootPath) {
    throw new Error("LUNA_RUNNER_HOME is required");
  }
  const childEnv = buildChildEnvironment(process.env, input.env);
  const home = childEnv.HOME;
  if (!home) {
    throw new Error("Runner HOME is required");
  }
  const { staticEnv, turnEnv } = splitStaticAndTurnEnv(childEnv);
  const controller = new PtySessionController({
    runnerType: input.runnerType,
    cwd: runnerRootPath,
    home,
    model: input.model,
    staticEnv,
    initialSessionId: sessionId,
  });
  let latestSessionId = sessionId;
  try {
    const result = await controller.runTurn({
      prompt: input.prompt,
      sessionId,
      turnEnv,
      onOutput: (output) => {
        if (output.status === "init") latestSessionId = output.sessionId;
        if (output.status === "success" && output.newSessionId) latestSessionId = output.newSessionId;
        writeOutput(output as unknown as Record<string, unknown>);
      },
    });
    if (result.sessionId) latestSessionId = result.sessionId;
    return latestSessionId ? { newSessionId: latestSessionId } : {};
  } finally {
    await controller.close();
  }
}

/**
 * Long-lived unprivileged PTY session host (launched under `job-process.js` subreaper + `setpriv`).
 * Accepts `PtyHostCommand` JSON lines on stdin and emits framed `PtyHostEvent` messages on stdout.
 */
export async function runPtyHostLoop(): Promise<void> {
  const runnerRootPath = process.env.LUNA_RUNNER_HOME;
  if (!runnerRootPath) throw new Error("LUNA_RUNNER_HOME is required");

  let controller: PtySessionController | null = null;
  let activeTurnId: string | null = null;
  let shuttingDown = false;

  const closeAndExit = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await controller?.close();
    emitHostEvent({ status: "session_closed", reason });
    process.exit(0);
  };

  process.once("SIGTERM", () => { void closeAndExit("sigterm"); });
  process.once("SIGINT", () => { void closeAndExit("sigint"); });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("close", () => { void closeAndExit("stdin_closed"); });

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let cmd: PtyHostCommand;
    try {
      cmd = JSON.parse(trimmed) as PtyHostCommand;
    } catch {
      continue;
    }

    if (cmd.type === "init") {
      const preparedEnv = prepareRunnerEnvironment(buildChildEnvironment(process.env, cmd.staticEnv));
      const home = preparedEnv.HOME;
      if (!home) throw new Error("Runner HOME is required");
      controller = new PtySessionController({
        runnerType: cmd.runnerType,
        cwd: runnerRootPath,
        home,
        model: cmd.model,
        staticEnv: preparedEnv,
        initialSessionId: cmd.sessionId,
        idleTimeoutMs: cmd.idleTimeoutMs,
        onIdleExpired: () => {
          void closeAndExit("idle_timeout");
        },
      });
      emitHostEvent({ status: "host_ready", ...(cmd.sessionId ? { sessionId: cmd.sessionId } : {}) });
      continue;
    }

    if (cmd.type === "update_credentials") {
      if (controller && activeTurnId === cmd.turnId) {
        controller.writeTurnEnv(cmd.turnEnv);
      }
      continue;
    }

    if (cmd.type === "cancel_turn") {
      if (controller && activeTurnId === cmd.turnId) {
        controller.cancelActiveTurn();
      }
      continue;
    }

    if (cmd.type === "shutdown") {
      await closeAndExit("shutdown");
      return;
    }

    if (cmd.type === "run_turn") {
      if (!controller) {
        emitHostEvent({
          status: "turn_output",
          turnId: cmd.turnId,
          output: { status: "error", error: "PTY host received run_turn before init" },
        });
        emitHostEvent({ status: "turn_done", turnId: cmd.turnId, outcome: "failed" });
        continue;
      }
      activeTurnId = cmd.turnId;
      void (async () => {
        try {
          const result = await controller!.runTurn({
            prompt: cmd.prompt,
            sessionId: cmd.sessionId,
            turnEnv: cmd.turnEnv,
            onOutput: (output) => {
              emitHostEvent({ status: "turn_output", turnId: cmd.turnId, output });
            },
          });
          emitHostEvent({
            status: "turn_done",
            turnId: cmd.turnId,
            outcome: result.outcome,
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          });
        } catch (error) {
          emitHostEvent({
            status: "turn_output",
            turnId: cmd.turnId,
            output: { status: "error", error: error instanceof Error ? error.message : String(error) },
          });
          emitHostEvent({ status: "turn_done", turnId: cmd.turnId, outcome: "failed" });
        } finally {
          if (activeTurnId === cmd.turnId) activeTurnId = null;
        }
      })();
    }
  }
}

if (import.meta.main) {
  runPtyHostLoop().catch((error) => {
    emitHostEvent({ status: "session_closed", reason: error instanceof Error ? error.message : "pty_host_failed" });
    process.exit(1);
  });
}
