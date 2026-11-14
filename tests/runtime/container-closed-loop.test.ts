import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DataConnection } from "../../src/data";
import * as lunaSchema from "../../src/data/schema";
import { FakeFeishuChannel } from "../../extensions/channels/fake/fake-feishu-channel";
import { LunaMessageIngress, commandRunner } from "./support/main-command-harness";
import { MainRunner } from "../../src/main-runner/main-runner";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { TaskResultEventPublisher } from "../../src/main-runner/task-result-events";
import { TaskRunSupervisor } from "../../src/tasks/task-run-supervisor";
import type { TestMainPlan } from "./support/main-command-plan";
import type { NormalizedInboundMessage } from "../../src/channels";
import { config, setLunaHome } from "../../src/shared";

import { fixtureObserveFeishuSender, fixtureFeishuSender, fixtureSessionOwnership } from "../helpers/platform-fixtures";

let testHome: string, previousHome: string;
let database: DataConnection<typeof lunaSchema>;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-container-closed-loop-"));
  mkdirSync(join(testHome, "data"), { recursive: true });
  setLunaHome(testHome);
  database = new DataConnection(lunaSchema);
  const owner = "closed-loop-owner";
  fixtureSessionOwnership(database.db, "feishu", "feishu-test", owner);
  fixtureObserveFeishuSender(database.db, "feishu-test", "user-test");
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

describe("container closed-loop E2E", () => {
  test("full cycle: Feishu msg -> create_task -> task runs -> message.result -> reply to channel", async () => {
    // Two-step scripted runner:
    // Turn 1: task.create (triggered by user message)
    // Turn 2: message.result (triggered by task_result event)
    const secondAction: TestMainPlan = {
      operation: "message.result",
      taskId: "", // patched dynamically once task is created
      reply: "广州今天晴，气温28°C，湿度65%。",
      cardSummary: "广州晴 28°C",
      followUpSuggestions: [],
      reason: "task resolved with weather data",
    };

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
      secondAction,
    ]);

    const channel = new FakeFeishuChannel("feishu-test");

    // TaskRunSupervisor uses default mock runner, wires onTaskResult
    // to TaskResultEventPublisher which feeds the result back to
    // the scripted MainRunner for the second turn.
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
      onTaskResult: async (result) => {
        // Patch the second action with the real taskId
        (secondAction as { taskId: string }).taskId = result.taskId;

        await new TaskResultEventPublisher({
          db: database.db,
          runnerType: "mock",
          mainRunner: commandRunner(scriptedRunner.asMainRunner(), database.db)!,
          channelForSubscription: (subscription) => {
            if (subscription.channel_id === channel.id) return channel;
            return undefined;
          },
        }).publish(result);
      },
    });

    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: commandRunner(scriptedRunner.asMainRunner(), database.db)!,
      taskRunSupervisor: supervisor,
    });

    await ingress.registerChannel(channel);
    await ingress.start();

    // Send Feishu message to trigger the full cycle
    await channel.emitNormalizedInbound(
      fakeInbound({ id: "msg-guangzhou-weather", text: "帮我查一下广州的天气" }),
    );
    await ingress.waitForIdle();

    // Turn 1: user_messages -> task.create
    expect(scriptedRunner.calls.length).toBeGreaterThanOrEqual(1);
    expect(scriptedRunner.calls[0]?.input.type).toBe("user_messages");

    // Task was created and resolved
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
    expect(readFileSync(join(runnerRootPath!, "AGENTS.md"), "utf-8")).not.toContain(
      "@.luna-prompts/task-runner/instructions.md",
    );

    // Turn 2: task_result -> message.result
    expect(scriptedRunner.calls.length).toBeGreaterThanOrEqual(2);
    expect(scriptedRunner.calls[1]?.input.type).toBe("task_result");

    // Dispatch reply was sent
    const dispatchReply = channel.outbound.find(
      (o) => o.content === "好的，我来帮你查一下广州的天气。",
    );
    expect(dispatchReply).toBeDefined();

    // Task result was published to channel
    const resultReply = channel.outbound.find(
      (o) =>
        o.content?.includes("广州晴 28°C") ||
        o.content?.includes("广州今天晴"),
    );
    expect(resultReply).toBeDefined();

    await ingress.stop();
  });

  test("task dispatch creates task in database even without onTaskResult", async () => {
    const scriptedRunner = new ScriptedMainRunner([
      {
        operation: "task.create",
        taskType: "task" as const,
        title: "查询深圳天气",
        summary: "用户需要查询深圳的天气情况",
        facts: ["城市：深圳", "请求：天气查询"],
        dispatchReply: "好的，我来查一下深圳天气。",
        reason: "user asked for weather in Shenzhen",
      },
    ]);

    const channel = new FakeFeishuChannel("feishu-test");
    const supervisor = new TaskRunSupervisor({
      db: database.db,
      runnerType: "mock",
    });

    const ingress = new LunaMessageIngress({
      db: database.db,
      runnerType: "mock",
      mainRunner: commandRunner(scriptedRunner.asMainRunner(), database.db)!,
      taskRunSupervisor: supervisor,
    });

    await ingress.registerChannel(channel);
    await ingress.start();

    await channel.emitNormalizedInbound(
      fakeInbound({ id: "msg-shenzhen-weather", text: "帮我查一下深圳的天气" }),
    );
    await ingress.waitForIdle();

    expect(scriptedRunner.calls.length).toBe(1);
    const taskRows = database.db.select().from(lunaSchema.tasks).all();
    expect(taskRows.length).toBeGreaterThanOrEqual(1);
    expect(taskRows[0]?.title).toBe("查询深圳天气");
    expect(taskRows[0]?.status).toBe("completed");

    const runnerContexts = database.db
      .select()
      .from(lunaSchema.runnerContexts)
      .all();
    expect(runnerContexts.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(runnerContexts[0]!.runner_root_path, ".luna-prompts"))).toBe(false);

    await ingress.stop();
  });
});
