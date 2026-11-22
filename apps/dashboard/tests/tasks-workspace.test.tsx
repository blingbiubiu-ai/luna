import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { filterTasks, TasksWorkspaceView } from "../src/app/tasks/index";
import { TaskDetailView, type TaskDetailData } from "../src/app/tasks/task-detail-view";
import type { DashboardTask } from "../src/lib/api";
import { LocaleProvider } from "../src/lib/i18n";

function makeTask(overrides: Partial<DashboardTask> & { id: string; title: string }): DashboardTask {
  return {
    type: "task",
    status: "completed",
    priority: "medium",
    severity: null,
    summary: "Default summary",
    creatorUserId: "user-1",
    creatorUser: {
      id: "user-1",
      kind: "human",
      displayName: "王华杰",
      status: "active",
      avatarUrl: null,
    },
    participants: [
      {
        userId: "user-1",
        role: "requester",
        user: {
          id: "user-1",
          kind: "human",
          displayName: "王华杰",
          status: "active",
          avatarUrl: null,
        },
      },
      {
        userId: "bot-1",
        role: "agent",
        user: {
          id: "bot-1",
          kind: "bot",
          displayName: "Luna Bot",
          status: "active",
          avatarUrl: null,
        },
      },
    ],
    linked_session_count: 1,
    linked_sessions: [
      {
        id: "ses-1",
        title: "EU 502 排查",
        display_title: "SRE 生产值班群",
        displayTitle: "SRE 生产值班群",
        channel_type: "feishu",
        channelType: "feishu",
        channel_id: "chat",
        group_id: "oc_sre",
        thread_id: "th_1",
      },
    ],
    linkedSessions: [],
    taskContext: {
      latestUserMessage: "请排查原因",
      knownFacts: [],
      assumptions: [],
      pendingQuestions: [],
    },
    contextPacks: [],
    seedRecords: [],
    runContextSummaries: [],
    sourceMessages: [],
    sourceTurnMessages: [],
    runs: [
      {
        id: `run-${overrides.id}`,
        task_id: overrides.id,
        taskId: overrides.id,
        run_index: 1,
        runIndex: 1,
        status: overrides.status ?? "completed",
        reason: "initial",
        input_snapshot: "check logs",
        inputSnapshot: "check logs",
        materialized_prompt: null,
        materializedPrompt: null,
        runner_type: "claude",
        runnerType: "claude",
        runner_context_id: "ctx-1",
        runnerContextId: "ctx-1",
        source_message_id: null,
        sourceMessageId: null,
        started_at: 1_000,
        startedAt: 1_000,
        finished_at: 49_000,
        finishedAt: 49_000,
        cancel_reason: null,
        cancelReason: null,
        error: null,
        final_report_artifact_id: null,
        finalReportArtifactId: null,
        contextPackIds: [],
        contextPacks: [],
        hasMaterializedPrompt: false,
        seedRecords: [],
      },
    ],
    timeline: [],
    artifacts: [],
    subscriptions: [],
    workSession: null,
    created_at: 1_000,
    updated_at: 50_000,
    last_activity_at: 50_000,
    ...overrides,
  };
}

const fixtureTasks: DashboardTask[] = [
  makeTask({
    id: "task-running",
    title: "排查欧洲区 CDN 边缘 502",
    status: "running",
    priority: "urgent",
    type: "question",
    last_activity_at: 90_000,
  }),
  makeTask({
    id: "task-waiting",
    title: "PG 只读副本扩容审批",
    status: "completed",
    priority: "high",
    type: "approval",
    taskContext: {
      pendingQuestions: ["确认今晚 02:00 还是明早 10:00 执行？"],
    },
    last_activity_at: 80_000,
  }),
  makeTask({
    id: "task-failed",
    title: "回归压测执行异常",
    status: "failed",
    runs: [
      {
        id: "run-failed",
        task_id: "task-failed",
        taskId: "task-failed",
        run_index: 2,
        runIndex: 2,
        status: "failed",
        reason: "retry",
        input_snapshot: "run test",
        inputSnapshot: "run test",
        materialized_prompt: null,
        materializedPrompt: null,
        runner_type: "codex",
        runnerType: "codex",
        runner_context_id: "ctx-2",
        runnerContextId: "ctx-2",
        source_message_id: null,
        sourceMessageId: null,
        started_at: 10_000,
        startedAt: 10_000,
        finished_at: 25_000,
        finishedAt: 25_000,
        cancel_reason: null,
        cancelReason: null,
        error: "EACCES: permission denied in /tmp",
        final_report_artifact_id: null,
        finalReportArtifactId: null,
        contextPackIds: [],
        contextPacks: [],
        hasMaterializedPrompt: false,
        seedRecords: [],
      },
    ],
    last_activity_at: 70_000,
  }),
  makeTask({
    id: "task-done",
    title: "整理双语 Release Notes",
    status: "completed",
    artifacts: [
      {
        id: "art-1",
        task_id: "task-done",
        type: "final_report",
        name: "release-notes.md",
        mime_type: "text/markdown",
        mimeType: "text/markdown",
        path: null,
        content: "# Release Notes",
        metadata: null,
        status: "active",
        created_at: 60_000,
        href: "/artifacts/art-1/preview?expires=1&sig=abc",
      },
    ],
    last_activity_at: 60_000,
  }),
];

describe("TasksWorkspaceView", () => {
  test("groups running, waiting, and failed tasks ahead of finished tasks and renders Chinese labels", () => {
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(TasksWorkspaceView, {
          tasks: fixtureTasks,
          loading: false,
          error: null,
        }),
      ),
    );

    expect(html).toContain("进行中与需关注");
    expect(html).toContain("近期已结束");
    expect(html).toContain("1 个运行中 · 1 个待反馈");
    expect(html).toContain("待确认问题");
    expect(html).toContain("确认今晚 02:00 还是明早 10:00 执行？");
    expect(html).toContain("EACCES: permission denied in /tmp");
    expect(html).toContain("SRE 生产值班群 · # EU 502 排查");
    expect(html).toContain("1 个产物");
    expect(html).not.toContain("队列空闲");
  });

  test("filters by status tabs and opens the quick-peek inspector on row click", async () => {
    const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
    (window as unknown as { location?: { href: string } }).location ??= {
      href: "http://localhost",
    };
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = document;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container as never);

    try {
      root.render(
        createElement(
          LocaleProvider,
          { initialLocale: "zh-CN" },
          createElement(TasksWorkspaceView, {
            tasks: fixtureTasks,
            loading: false,
            error: null,
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(document.querySelector('[data-testid="task-quick-peek"]')).toBeNull();

      const waitingRow = document.querySelector('[data-testid="task-row-task-waiting"]');
      expect(waitingRow).not.toBeNull();
      waitingRow!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const drawer = document.querySelector('[data-testid="task-quick-peek"]');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent ?? "").toContain("PG 只读副本扩容审批");
      expect(drawer?.textContent ?? "").toContain("完整详情");

      const completedTab = Array.from(document.querySelectorAll('[role="tab"]')).find((node) =>
        (node.textContent ?? "").includes("已完成"),
      );
      expect(completedTab).toBeTruthy();
      completedTab!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(document.querySelector('[data-testid="task-row-task-done"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="task-row-task-running"]')).toBeNull();
    } finally {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  test("filterTasks matches session titles, statuses, and priorities", () => {
    expect(
      filterTasks(fixtureTasks, {
        query: "sre 生产值班群",
        typeFilter: "all",
        statusFilter: "all",
        priorityFilter: "all",
      }),
    ).toHaveLength(4);

    expect(
      filterTasks(fixtureTasks, {
        query: "",
        typeFilter: "all",
        statusFilter: "waiting",
        priorityFilter: "all",
      }).map((t) => t.id),
    ).toEqual(["task-waiting"]);

    expect(
      filterTasks(fixtureTasks, {
        query: "",
        typeFilter: "all",
        statusFilter: "attention",
        priorityFilter: "all",
      }).map((t) => t.id),
    ).toEqual(["task-failed"]);
  });

  test("TaskDetailView renders persistent inspector rail alongside timeline and unified header slots", () => {
    const sample = fixtureTasks[0]! as unknown as TaskDetailData;
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { initialLocale: "zh-CN" },
        createElement(TaskDetailView, {
          taskDetail: sample,
          runs: sample.runs,
          timeline: sample.timeline,
          artifacts: sample.artifacts,
          backSlot: createElement("a", { href: "/tasks" }, "返回任务列表"),
          actionsSlot: createElement("button", { type: "button" }, "打开 TUI"),
          loading: {
            taskDetail: false,
            runs: false,
            timeline: false,
            artifacts: false,
          },
        }),
      ),
    );

    expect(html).toContain('data-testid="task-inspector-rail"');
    expect(html).toContain("任务概览");
    expect(html).toContain("关联会话");
    expect(html).toContain("返回任务列表");
    expect(html).toContain("打开 TUI");
  });
});
