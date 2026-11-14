/**
 * Real Docker closed-loop E2E test with actual claude CLI execution.
 *
 * Uses caller-provided DeepSeek API credentials to run claude inside the Docker
 * container, proving the full sandbox pipeline works end-to-end.
 *
 * Requires: Docker daemon running, luna-runner:latest image built, and either
 * DEEPSEEK_ANTHROPIC_AUTH_TOKEN or ANTHROPIC_AUTH_TOKEN set in the environment.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { StreamEventParser } from "@luna/runner-protocol/stream-parser";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress } from "./support/main-command-harness";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import type { TestMainPlan } from "./support/main-command-plan";
import type { NormalizedInboundMessage } from "../../src/channels";
import { config, setLunaHome } from "../../src/shared";

import { fixtureObserveFeishuSender, fixtureFeishuSender, fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-docker-closed-loop-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
});

afterEach(() => {
  database.close();
  setLunaHome(previousHome);
  rmSync(testHome, { recursive: true, force: true });
});

class ScriptedMainRunner {
  readonly calls: MainRunnerRunInput[] = [];
  private _nextAction = 0;
  constructor(private readonly _actions: readonly TestMainPlan[]) {}
  async run(input: MainRunnerRunInput): Promise<TestMainPlan> {
    this.calls.push(input);
    const action = this._actions[this._nextAction] ?? this._actions.at(-1);
    this._nextAction += 1;
    if (action === undefined) throw new Error("ScriptedMainRunner has no action to return.");
    return action;
  }
  asMainRunner(): MainRunner { return this as unknown as MainRunner; }
}

function fakeInbound(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: { type: "feishu", id: "feishu-test" },
    surface: { externalId: "group-test", kind: "group" },
    sender: {...fixtureFeishuSender("feishu-test", "user-test"), displayName: "TestUser"},
    text: "hello from test",
    mentions: [],
    addressing: { addressedToBot: true, reason: "mention" },
    ...overrides,
  };
}

const LUNA_RUNNER_IMAGE = "luna-runner:latest";

const DEEPSEEK_AUTH_TOKEN =
  process.env.DEEPSEEK_ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;

const DEEPSEEK_ENV: Record<string, string> | undefined = DEEPSEEK_AUTH_TOKEN
  ? {
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  ANTHROPIC_AUTH_TOKEN: DEEPSEEK_AUTH_TOKEN,
  ANTHROPIC_MODEL: "deepseek-v4-flash",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
}
  : undefined;

function dockerAvailable(): boolean {
  try {
    const result = Bun.spawnSync(["docker", "images", "-q", LUNA_RUNNER_IMAGE], {
      stdout: "pipe", stderr: "pipe",
    });
    return result.stdout.toString().trim().length > 0;
  } catch { return false; }
}

const dockerIt = dockerAvailable() ? test : test.skip;
const deepseekDockerIt = dockerAvailable() && DEEPSEEK_ENV !== undefined
  ? test
  : test.skip;

function requireDeepseekEnv(): Record<string, string> {
  if (DEEPSEEK_ENV === undefined) {
    throw new Error(
      "DEEPSEEK_ANTHROPIC_AUTH_TOKEN or ANTHROPIC_AUTH_TOKEN is required.",
    );
  }
  return DEEPSEEK_ENV;
}

function envToDockerArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }
  return args;
}

async function runJobProcessInDocker(
  input: object,
  extraArgs: string[] = [],
  timeoutMs = 30_000,
): Promise<{ stdout: string; exitCode: number; outputs: ReturnType<StreamEventParser["feedLine"]>[number][] }> {
  const proc = spawn("docker", ["run", "--rm", "-i", "-e", "LUNA_RUNNER_HOME=/tmp", "-e", "HOME=/tmp", ...extraArgs, "--entrypoint", "bun", LUNA_RUNNER_IMAGE, "/app/agent-runner/dist/job-main.js"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();

  let stdout = "";
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });

  const exitCode = await Promise.race([
    new Promise<number>((resolve) => { proc.on("exit", (code) => resolve(code ?? -1)); }),
    new Promise<number>((resolve) => setTimeout(() => { proc.kill(); resolve(-1); }, timeoutMs)),
  ]);

  const parser = new StreamEventParser();
  const outputs: ReturnType<StreamEventParser["feedLine"]>[number][] = [];
  for (const line of stdout.split("\n")) {
    outputs.push(...parser.feedLine(line));
  }
  return { stdout, exitCode, outputs };
}

describe("real Docker closed-loop", () => {
  deepseekDockerIt("docker run with DeepSeek API: claude CLI executes, returns output, exits cleanly", async () => {
    const { stdout, outputs, exitCode } = await runJobProcessInDocker(
      { prompt: "Say hello in exactly 5 words, nothing else.", runnerType: "claude" },
      envToDockerArgs(requireDeepseekEnv()),
      30_000,
    );

    expect(stdout).toContain("---LUNA_OUTPUT_START---");
    expect(stdout).toContain("---LUNA_OUTPUT_END---");
    expect(outputs.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);

    // Should have stream events with actual LLM content
    const streamEvents = outputs.filter((o) => o.status === "stream");
    expect(streamEvents.length).toBeGreaterThan(0);

  }, { timeout: 45_000 });

  deepseekDockerIt("Guangzhou weather query: claude responds in Docker container", async () => {
    const { stdout, outputs, exitCode } = await runJobProcessInDocker(
      { prompt: "帮我查一下广州的天气，用一句话回答", runnerType: "claude" },
      envToDockerArgs(requireDeepseekEnv()),
      30_000,
    );

    expect(stdout).toContain("---LUNA_OUTPUT_START---");
    expect(outputs.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);

    // Stream events contain actual LLM output
    const streamEvents = outputs.filter((o) => o.status === "stream");
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify the response is non-empty
    const allText = streamEvents
      .map((o) => {
        const data = o.data as { readonly rawOutput?: unknown; readonly text?: unknown };
        return String(data.rawOutput ?? data.text ?? "");
      })
      .join("");
    expect(allText.length).toBeGreaterThan(0);
  }, { timeout: 45_000 });

  dockerIt("container runs as UID 1000", async () => {
    const proc = spawn("docker", ["run", "--rm", "--entrypoint", "", LUNA_RUNNER_IMAGE, "id", "-u"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    await new Promise<number>((resolve) => { proc.on("exit", (code) => resolve(code ?? -1)); });
    expect(stdout.trim()).toBe("1000");
  }, { timeout: 15_000 });

  dockerIt("closed-loop pipeline: Feishu msg -> create_task -> task dispatch -> result", async () => {
    const scriptedRunner = new ScriptedMainRunner([
      {
        operation: "task.create",
        taskType: "task" as const,
        title: "查询广州天气",
        summary: "用户需要查询广州的天气情况",
        facts: ["城市：广州", "请求：天气查询"],
        dispatchReply: "好的，我来帮你查一下广州的天气。",
        reason: "user asked for weather in Guangzhou",
      },
    ]);

    const channel = new FakeFeishuChannel("feishu-test");
    const owner = "docker-closed-loop-owner";
    const {agent_id: agentId} = fixtureSessionOwnership(database.db, "feishu", channel.id, owner);
    fixtureObserveFeishuSender(database.db, channel.id, "user-test");
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });
    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: scriptedRunner.asMainRunner(),
      taskRunSupervisor: supervisor,
    });

    await ingress.registerChannel(channel);
    await ingress.start();

    await channel.emitNormalizedInbound(
      fakeInbound({ id: "msg-docker-guangzhou", text: "帮我查一下广州的天气" }),
    );
    await ingress.waitForIdle();

    expect(scriptedRunner.calls.length).toBe(1);
    expect(scriptedRunner.calls[0]?.input.type).toBe("user_messages");

    const taskRows = database.db.select().from(lunaSchema.tasks).all();
    expect(taskRows.length).toBeGreaterThanOrEqual(1);
    expect(taskRows[0]?.title).toBe("查询广州天气");
    expect(taskRows[0]?.status).toBe("completed");

    const runnerContexts = database.db
      .select()
      .from(lunaSchema.runnerContexts)
      .all();
    expect(runnerContexts.length).toBeGreaterThanOrEqual(1);
    const runnerRootPath = runnerContexts[0]?.runner_root_path;
    expect(runnerRootPath).toBeDefined();
    expect(existsSync(join(runnerRootPath!, ".luna-prompts"))).toBe(false);
    expect(readFileSync(join(runnerRootPath!, "CLAUDE.md"), "utf-8")).not.toContain(
      "@.luna-prompts/task-runner/instructions.md",
    );

    const dispatchReply = channel.outbound.find(
      (o) => o.content === "好的，我来帮你查一下广州的天气。",
    );
    expect(dispatchReply).toBeDefined();

    await ingress.stop();
  }, { timeout: 15_000 });
});
