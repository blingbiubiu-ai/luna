import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentExecutionSnapshot } from "./active-agent-config-service";
import type { ExecutionDriver } from "./types";

const EXPECTED_REPLY = "LUNA_AGENT_PROFILE_OK";
const CONNECTION_TEST_RUNNER_ROOT = "/luna-runner/agent-profile-test";
const CONNECTION_TEST_RUNTIME_MOUNT = "/opt/luna-runtime/current";

export interface AgentConnectionTestRequest {
  readonly image: "luna-runner:latest";
  readonly runnerType: string;
  readonly model: string;
  readonly executionDriver?: ExecutionDriver;
  readonly prompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: 60_000;
}

export interface AgentConnectionTestExecutor {
  execute(request: AgentConnectionTestRequest): Promise<{
    readonly success: boolean;
    readonly output: string;
  }>;
}

export class AgentProfileConnectionTester {
  private readonly executor: AgentConnectionTestExecutor;

  constructor(executor: AgentConnectionTestExecutor = new DockerConnectionTestExecutor()) {
    this.executor = executor;
  }

  async testSnapshot(
    snapshot: Omit<AgentExecutionSnapshot, "executionDriver"> & { readonly executionDriver?: ExecutionDriver },
  ): Promise<{
    readonly success: boolean;
    readonly message: string;
  }> {
    const result = await this.executor.execute({
      image: "luna-runner:latest",
      runnerType: snapshot.agentType,
      model: snapshot.model,
      ...(snapshot.executionDriver === "pty" ? { executionDriver: "pty" } : {}),
      prompt: `Reply with exactly ${EXPECTED_REPLY} and nothing else.`,
      env: snapshot.env,
      timeoutMs: 60_000,
    });
    if (result.success && result.output.includes(EXPECTED_REPLY)) {
      return { success: true, message: "Connection succeeded" };
    }
    return {
      success: false,
      message: scrub(
        extractFailureMessage(result.output) || "Agent connection test did not return the expected reply",
        Object.values(snapshot.env),
      ),
    };
  }
}

class DockerConnectionTestExecutor implements AgentConnectionTestExecutor {
  async execute(request: AgentConnectionTestRequest): Promise<{
    readonly success: boolean;
    readonly output: string;
  }> {
    const name = `luna-agent-test-${crypto.randomUUID()}`;
    const proc = Bun.spawn(buildConnectionTestDockerArgs(name, request), {
      stdin: new TextEncoder().encode(JSON.stringify({
        prompt: request.prompt,
        runnerType: request.runnerType,
        ...(request.executionDriver && request.executionDriver !== "stdio" ? { executionDriver: request.executionDriver } : {}),
        model: request.model,
        env: request.env,
      })),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, request.timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    const output = `${stdout}\n${stderr}`.trim().slice(-4000);
    return {
      success: !timedOut && exitCode === 0 && output.includes(EXPECTED_REPLY),
      output: timedOut ? "Agent connection test timed out" : output,
    };
  }
}

export function buildConnectionTestDockerArgs(
  name: string,
  request: AgentConnectionTestRequest,
  runtimeDistDir: string | undefined = request.executionDriver === "pty" ? resolveLocalExecutorDistDir() : undefined,
): string[] {
  const mountArgs = runtimeDistDir
    ? ["--mount", `type=bind,src=${runtimeDistDir},dst=${CONNECTION_TEST_RUNTIME_MOUNT},readonly`]
    : [];
  const entryScript = runtimeDistDir
    ? `${CONNECTION_TEST_RUNTIME_MOUNT}/job-main.js`
    : "/app/agent-runner/dist/job-main.js";
  return [
      "docker",
      "run",
      "-i",
      "--rm",
      "--name",
      name,
      "--network",
      "bridge",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--tmpfs",
      `${CONNECTION_TEST_RUNNER_ROOT}:rw,size=256m,uid=1000,gid=1000`,
      ...mountArgs,
      "-e",
      `HOME=${CONNECTION_TEST_RUNNER_ROOT}`,
      "-e",
      `LUNA_RUNNER_HOME=${CONNECTION_TEST_RUNNER_ROOT}`,
      "-w",
      CONNECTION_TEST_RUNNER_ROOT,
      "--entrypoint",
      "bun",
      request.image,
      entryScript,
    ];
}

function resolveLocalExecutorDistDir(): string | undefined {
  const workerHome = process.env.LUNA_WORKER_HOME ?? join(process.env.HOME ?? homedir(), ".luna-worker");
  const candidates = [
    resolve(import.meta.dir, "..", "..", "apps", "executor", "dist"),
    resolve(dirname(process.execPath), "..", "apps", "executor", "dist"),
    resolve(process.cwd(), "apps", "executor", "dist"),
    join(workerHome, "runner-runtime", "current"),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (existsSync(join(resolved, "job-main.js"))) return resolved;
    } catch { /* try next candidate */ }
  }
  return undefined;
}

function extractFailureMessage(output: string): string {
  const envelopePattern = /---LUNA_OUTPUT_START---\s*([\s\S]*?)\s*---LUNA_OUTPUT_END---/g;
  let lastError: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = envelopePattern.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? "") as Record<string, unknown>;
      if (parsed.status === "error" && typeof parsed.error === "string" && parsed.error.trim()) {
        lastError = parsed.error.trim();
      }
    } catch { /* ignore non-JSON frames */ }
  }
  return lastError ?? output;
}

function scrub(message: string, values: readonly string[]): string {
  let result = message;
  for (const value of values) {
    if (value.length > 0) result = result.split(value).join("[REDACTED]");
  }
  return result.slice(-2000);
}
