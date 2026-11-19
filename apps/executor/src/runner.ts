import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { runnerAssetPaths, runnerResourcesPath } from "@luna/runner-protocol/runner-assets";
import { join } from "node:path";
import type { ContainerInput } from "./types";
import { buildChildEnvironment } from "./job-env";
import { writeOutput } from "./protocol";
import {
  resolveContainerRunnerProvider,
  type ParsedRunnerLine,
  type RunnerFailure,
} from "./providers/index";
import { claudeContainerRunnerProvider } from "./providers/claude";
import { prepareCodexSkills } from "./providers/codex-skills";
import type { ContainerRunnerProvider } from "./providers/types";

export interface RunnerResult {
  readonly newSessionId?: string;
}

export function parseRunnerStreamLine(
  line: string,
  runnerType: string,
): ParsedRunnerLine | null {
  return _resolveRunnerProvider(runnerType)?.parseStreamLine(line) ??
    claudeContainerRunnerProvider.parseStreamLine(line);
}

export async function runQuery(
  input: ContainerInput,
  sessionId?: string,
): Promise<RunnerResult> {
  const provider = _resolveRunnerProvider(input.runnerType);
  const runnerRootPath = process.env.LUNA_RUNNER_HOME;
  if (runnerRootPath === undefined || runnerRootPath.length === 0) {
    throw new Error("LUNA_RUNNER_HOME is required");
  }
  const env = buildChildEnvironment(process.env, input.env);
  const args = buildCliArgs(input, sessionId);
  const command = args.shift();
  if (!command) throw new Error(`No CLI command configured for runner type "${input.runnerType}".`);
  if (env.HOME) {
    const { skillPlugin } = runnerAssetPaths(env.HOME);
    if (provider?.family === "claude" && existsSync(join(skillPlugin, ".claude-plugin", "plugin.json"))) {
      args.unshift("--plugin-dir", skillPlugin);
    }
    if (provider?.family === "codex" && existsSync(join(skillPlugin, ".codex-plugin", "plugin.json"))) {
      await prepareCodexSkills(env, runnerResourcesPath(env.HOME), env.CODEX_HOME || join(env.HOME, ".codex"));
    }
  }
  const proc = spawn(command, args, {
    cwd: runnerRootPath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let newSessionId: string | undefined = sessionId;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let candidateText = "";
  let finalText = "";
  let completed = false;
  const complete = (parsed: Extract<ParsedRunnerLine, { kind: "complete" }>) => { finalText = parsed.finalText ?? candidateText; completed = true; };
  let runnerError: RunnerFailure | undefined;

  const emitEvents = (parsed: Extract<ParsedRunnerLine, {kind: "events"}>) => {
    for (const event of parsed.events) {
      if (event.kind === "text") { candidateText = event.text; writeOutput({status: "stream", text: event.text}); }
      else {
        if (event.kind === "tool_start") candidateText = "";
        const {kind, ...payload} = event;
        writeOutput({status: kind, ...payload});
        if (event.kind === "tool_result") writeOutput({status: "checkpoint"});
      }
    }
  };
  return new Promise<RunnerResult>((resolve, reject) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parseRunnerStreamLine(trimmed, input.runnerType);
        if (parsed === null) continue;

        if (parsed.kind === "complete") { complete(parsed); } else if (parsed.kind === "events") { emitEvents(parsed); } else if (parsed.kind === "init") {
          newSessionId = parsed.sessionId;
          writeOutput({ status: "init", sessionId: parsed.sessionId });
        } else if (parsed.kind === "text") {
          candidateText = parsed.text;
          writeOutput({ status: "stream", text: parsed.text });
        } else if (parsed.kind === "checkpoint") {
          writeOutput({ status: "checkpoint" });
        } else if (parsed.kind === "error") {
          runnerError = provider?.normalizeFailure(parsed.message) ?? {
            kind: "unknown",
            provider: "claude",
            message: parsed.message,
          };
          writeOutput({
            status: "error",
            error: parsed.message,
            failure: runnerError,
            ...(parsed.code === undefined
              ? runnerError.providerCode === undefined
                ? {}
                : { code: runnerError.providerCode }
              : { code: parsed.code }),
          });
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        stderrBuffer = stderrBuffer.length === 0 ? text : `${stderrBuffer}\n${text}`;
        writeOutput({ status: "stderr", text });
      }
    });

    proc.on("close", (code: number | null) => {
      // Flush remaining buffer
      if (stdoutBuffer.trim()) {
        const parsed = parseRunnerStreamLine(stdoutBuffer.trim(), input.runnerType);
        if (parsed?.kind === "complete") { complete(parsed); } else if (parsed?.kind === "events") { emitEvents(parsed); } else if (parsed?.kind === "text") {
          candidateText = parsed.text;
          writeOutput({ status: "stream", text: parsed.text });
        } else if (parsed?.kind === "init") {
          newSessionId = parsed.sessionId;
          writeOutput({ status: "init", sessionId: parsed.sessionId });
        } else if (parsed?.kind === "checkpoint") {
          writeOutput({ status: "checkpoint" });
        } else if (parsed?.kind === "error") {
          runnerError = provider?.normalizeFailure(parsed.message) ?? {
            kind: "unknown",
            provider: "claude",
            message: parsed.message,
          };
          writeOutput({
            status: "error",
            error: parsed.message,
            failure: runnerError,
            ...(parsed.code === undefined
              ? runnerError.providerCode === undefined
                ? {}
                : { code: runnerError.providerCode }
              : { code: parsed.code }),
          });
        }
      }

      if (runnerError !== undefined) {
        // The runner already emitted a structured failure event. Do not follow
        // it with a success marker just because the CLI process exited 0.
      } else if (code !== 0 && code !== null) {
        const message = stderrBuffer || `Process exited with code ${code}`;
        const failure = provider?.normalizeFailure(message);
        const normalizedCode =
          failure?.providerCode ?? provider?.normalizeErrorCode(message);
        writeOutput({
          status: "error",
          error: message,
          exitCode: code,
          ...(failure === undefined ? {} : { failure }),
          ...(normalizedCode === undefined ? {} : { code: normalizedCode }),
        });
      } else if (!completed) {
        writeOutput({ status: "error", error: "Provider exited without a successful completion event" });
      } else {
        writeOutput({
          status: "success",
          result: finalText,
          ...(newSessionId ? { newSessionId } : {}),
        });
      }
      resolve(newSessionId ? { newSessionId } : {});
    });

    proc.on("error", (err: Error) => {
      writeOutput({ status: "error", error: err.message });
      reject(err);
    });

    if (writesPromptToStdin(input.runnerType)) {
      proc.stdin.write(input.prompt);
    }
    proc.stdin.end();
  });
}

export function buildCliArgs(input: ContainerInput, sessionId?: string): string[] {
  const provider = _resolveRunnerProvider(input.runnerType);
  if (provider === undefined) {
    return [input.runnerType];
  }
  return provider.buildCliArgs(input, sessionId);
}

function writesPromptToStdin(runnerType: string): boolean {
  return _resolveRunnerProvider(runnerType)?.writesPromptToStdin() ?? true;
}

function _resolveRunnerProvider(
  runnerType: string,
): ContainerRunnerProvider | undefined {
  try {
    return resolveContainerRunnerProvider(runnerType);
  } catch {
    return undefined;
  }
}
