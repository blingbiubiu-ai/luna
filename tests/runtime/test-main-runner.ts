import type { TestMainPlan } from "./support/main-command-plan";
import { desc } from "drizzle-orm";

import type { TaskStatus } from "../../src/tasks/types";
import { REUSABLE_TASK_STATUSES } from "../../src/tasks/types";
import type { DrizzleDB } from "../../src/data";
import { tasks } from "../../src/data/schema";
import type { MainRunnerRunInput } from "../../src/main-runner/main-runner";
import { MainRunner } from "../../src/main-runner/main-runner";
import type {
  MainRunnerTaskIntent,
} from "../../src/main-runner/types";

type TaskRow = typeof tasks.$inferSelect;

export class DeterministicMainRunner {
  readonly calls: MainRunnerRunInput[] = [];

  constructor(private readonly _db: DrizzleDB) {}

  async run(input: MainRunnerRunInput): Promise<TestMainPlan> {
    this.calls.push(input);

    if (input.input.type === "session_trigger") return { operation: "message.send", reply: input.input.instruction, reason: "trigger" };
    if (input.input.type === "task_result") {
      return {
        operation: "message.result",
        taskId: input.input.taskId,
        reply: input.input.result.userVisibleReport,
        followUpSuggestions: input.input.result.nextActions,
        reason: "test main runner publishes task result",
      };
    }

    const message = input.input.latestMessage;
    if (isOrdinaryMessage(message.text)) {
      return {
        operation: "message.send",
        reply: "Luna received your message.",
        reason: "test main runner handles ordinary chat",
      };
    }

    const taskType = inferTaskType(message.text);
    const existingTask = this._findExistingTask(message.text, taskType);
    if (existingTask !== undefined) {
      return {
        operation: "task.update",
        taskId: existingTask.id,
        updateSummary: message.text,
        dispatchReply: attachReply(message.text, existingTask),
        reason: "test main runner attaches matching task",
      };
    }

    return {
      operation: "task.create",
      taskType,
      title: titleForMessage(message.text),
      summary: message.text,
      facts: [message.text],
      dispatchReply:
        taskType === "task"
          ? "已创建任务，会在这里同步关键进展。"
          : "已开始排查，请关注状态卡片。",
      reason: "test main runner creates persistent task",
    };
  }

  asMainRunner(): MainRunner {
    return this as unknown as MainRunner;
  }

  private _findExistingTask(
    text: string,
    taskType: MainRunnerTaskIntent,
  ): TaskRow | undefined {
    const rows = this._db
      .select()
      .from(tasks)
      .orderBy(desc(tasks.updated_at), desc(tasks.created_at))
      .all()
      .filter((row) => row.type === taskType);
    const explicit = rows.find((row) => text.includes(row.id));
    if (explicit !== undefined) {
      return explicit;
    }

    const activeMatch = rows.find(
      (row) =>
        isActiveStatus(row.status as TaskStatus) &&
        textMentionsTitle(text, row.title),
    );
    if (activeMatch !== undefined) {
      return activeMatch;
    }

    if (hasExplicitReopen(text)) {
      return rows.find((row) => textMentionsTitle(text, row.title));
    }

    return undefined;
  }
}

export function createDeterministicMainRunner(db: DrizzleDB): MainRunner {
  return new DeterministicMainRunner(db).asMainRunner();
}

function inferTaskType(text: string): MainRunnerTaskIntent {
  return "task";
}

function isOrdinaryMessage(text: string): boolean {
  return (
    !/任务|task|修复/u.test(text) &&
    !/排查|异常|错误|失败|故障|502|500|error|fail|reopen|重新打开|复现/iu.test(
      text,
    )
  );
}

function titleForMessage(text: string): string {
  const [title] = text.split(/[，,\n]/u);
  return (title?.trim() || text.trim()).slice(0, 80);
}

function textMentionsTitle(text: string, title: string): boolean {
  return text.includes(title) || title.includes(titleForMessage(text));
}

function isActiveStatus(status: TaskStatus): boolean {
  return REUSABLE_TASK_STATUSES.includes(status);
}

function hasExplicitReopen(text: string): boolean {
  return /reopen|重新打开|复现/iu.test(text);
}

function attachReply(text: string, existingTask: TaskRow): string {
  if (text.includes(existingTask.id)) {
    return existingTask.type === "task"
      ? "已关联到已有任务，会在这里同步关键进展。"
      : "已关联到已有排查，会在这里同步关键进展。";
  }
  return existingTask.type === "task"
    ? "已收到补充信息，正在合并到当前任务。"
    : "已收到补充信息，正在合并到当前排查。";
}
