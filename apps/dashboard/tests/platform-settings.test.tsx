import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ExecutionSettingsForm,
  FeishuAuthForm,
  FeishuMessagingSettingsForm,
  GeneralSettingsForm,
  MarketplaceSettingsForm,
  MemorySettingsForm,
  ProcessDataRetentionForm,
} from "../src/app/platform-settings";
import { TaskDetailView } from "../src/app/tasks/task-detail-view";
import { DashboardAgentContext } from "../src/lib/agent-route";
import { LocaleProvider } from "../src/lib/i18n";

const noop = () => {};

test("platform settings forms render all migrated sections and honor read-only state", () => {
  const generalHtml = renderToStaticMarkup(
    createElement(GeneralSettingsForm, {
      settings: {
        publicBaseUrl: "http://10.37.108.127:8090",
        timezone: "Asia/Singapore",
        artifactSignedUrlTtlMs: 24 * 3_600_000,
      },
      canEdit: true,
      saving: false,
      error: null,
      saved: false,
      onSave: noop,
    }),
  );
  expect(generalHtml).toContain("常规与对外访问");
  expect(generalHtml).toContain("http://10.37.108.127:8090");
  expect(generalHtml).toContain("Asia/Singapore");
  expect(generalHtml).toContain("产物签名链接有效期（小时）");
  expect(generalHtml).toContain('value="24"');

  const feishuHtml = renderToStaticMarkup(
    createElement(FeishuAuthForm, {
      settings: {
        enabled: true,
        configured: true,
        source: "database",
        appId: "cli_abc",
        hasSecret: true,
        secretUnreadable: false,
        feishuHost: "https://open.feishu.cn",
        publicBaseUrl: "http://10.37.108.127:8090",
      },
      publicBaseUrl: "http://10.37.108.127:8090",
      canEdit: false,
      saving: false,
      clearing: false,
      error: null,
      saved: false,
      onSave: noop,
      onClear: noop,
    }),
  );
  expect(feishuHtml).toContain("http://10.37.108.127:8090/api/auth/feishu/callback");
  expect(feishuHtml).toContain("只有平台管理员可以修改。");

  const marketplaceHtml = renderToStaticMarkup(
    createElement(MarketplaceSettingsForm, {
      settings: { gitUrl: "https://git.example.com/plugins.git", branch: "main" },
      canEdit: true,
      saving: false,
      error: null,
      saved: false,
      onSave: noop,
    }),
  );
  expect(marketplaceHtml).toContain("插件市场源");
  expect(marketplaceHtml).toContain("https://git.example.com/plugins.git");

  const executionHtml = renderToStaticMarkup(
    createElement(ExecutionSettingsForm, {
      settings: { containerTimeoutMs: 1_800_000, taskTimeoutMs: 36_000_000, maxTransientRetries: 5 },
      canEdit: true,
      saving: false,
      error: null,
      saved: false,
      onSave: noop,
    }),
  );
  expect(executionHtml).toContain("运行与重试");
  expect(executionHtml).toContain("Task 单次上限（分钟）");
  expect(executionHtml).toContain('value="30"');
  expect(executionHtml).toContain('value="600"');

  const memoryHtml = renderToStaticMarkup(
    createElement(MemorySettingsForm, {
      settings: {
        reflectionIdleMs: 1_800_000,
        consolidationIntervalMs: 86_400_000,
        forgetUnusedMs: 180 * 86_400_000,
        episodeRetentionMs: 90 * 86_400_000,
        recallLimit: 8,
        coreLimit: 30,
        shadowCoreLimit: 10,
        personaLimit: 5,
      },
      canEdit: true,
      saving: false,
      error: null,
      saved: false,
      onSave: noop,
    }),
  );
  expect(memoryHtml).toContain("记忆维护与配额");

  const messagingHtml = renderToStaticMarkup(
    createElement(FeishuMessagingSettingsForm, {
      settings: { maxVisibleSteps: 32, feishuDevelopers: { cli_1: "dev_1" } },
      canEdit: true,
      saving: false,
      error: null,
      saved: false,
      onSave: noop,
    }),
  );
  expect(messagingHtml).toContain("飞书卡片与开发者映射");
  expect(messagingHtml).toContain("cli_1=dev_1");

  const retentionHtml = renderToStaticMarkup(
    createElement(ProcessDataRetentionForm, {
      settings: { enabled: true, retentionDays: 30, intervalMinutes: 60 },
      canEdit: true,
      saving: false,
      error: null,
      saved: false,
      onSave: noop,
    }),
  );
  expect(retentionHtml).toContain("过期过程数据裁剪");
  expect(retentionHtml).toContain("过程数据保留期（天）");
  expect(retentionHtml).toContain('value="30"');
});

test("TaskDetailView timeline displays top notice and inline marker when expired tool events were pruned", () => {
  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      { initialLocale: "zh-CN" },
      createElement(
        DashboardAgentContext.Provider,
        {
          value: {
            id: "agent-1",
            name: "Luna",
            ownerAccountId: "owner-1",
            ownerUserId: "user-1",
            defaultShadowId: "shadow-1",
            status: "active",
          },
        },
        createElement(TaskDetailView, {
          taskDetail: {
            id: "task-1",
            title: "Historical task",
            summary: "Done",
            type: "task",
            status: "completed",
            priority: "medium",
            severity: null,
            creatorUserId: "user-1",
            created_at: 1000,
            updated_at: 2000,
            last_activity_at: 2000,
            participants: [],
            linked_session_count: 1,
            linked_sessions: [],
            linkedSessions: [],
            contextPacks: [],
            seedRecords: [],
            runContextSummaries: [],
            runs: [],
            timeline: [],
            artifacts: [],
            subscriptions: [],
          },
          runs: [
            {
              id: "run-1",
              task_id: "task-1",
              taskId: "task-1",
              run_index: 1,
              runIndex: 1,
              status: "completed",
              reason: "initial",
              input_snapshot: {},
              inputSnapshot: {},
              runner_type: "codex",
              runnerType: "codex",
              runner_context_id: null,
              runnerContextId: null,
              source_message_id: null,
              sourceMessageId: null,
              started_at: 1000,
              startedAt: 1000,
              finished_at: 2000,
              finishedAt: 2000,
              cancel_reason: null,
              cancelReason: null,
              error: null,
              final_report_artifact_id: null,
              finalReportArtifactId: null,
            },
          ],
          timeline: [
            {
              id: "ev-created",
              task_id: "task-1",
              session_id: null,
              message_id: null,
              type: "task.created",
              summary: "Task created",
              data: null,
              taskRunId: null,
              runIndex: null,
              runReason: null,
              runnerType: null,
              visibility: "public",
              created_at: 1000,
            },
            {
              id: "retention-pruned:task-1:run-1",
              task_id: "task-1",
              session_id: null,
              message_id: null,
              type: "timeline.tools_pruned",
              summary: "已按保留策略自动清理 38 条过期工具调用明细",
              data: { prunedToolCount: 38, taskRunId: "run-1", runIndex: 1 },
              taskRunId: "run-1",
              runIndex: 1,
              runReason: null,
              runnerType: null,
              visibility: "internal",
              created_at: 1500,
            },
            {
              id: "ev-done",
              task_id: "task-1",
              session_id: null,
              message_id: null,
              type: "task.completed",
              summary: "Task completed",
              data: null,
              taskRunId: "run-1",
              runIndex: 1,
              runReason: null,
              runnerType: null,
              visibility: "public",
              created_at: 2000,
            },
          ],
          prunedTools: { totalCount: 38, byRunIndex: { "1": 38 } },
          artifacts: [],
          loading: { taskDetail: false, runs: false, timeline: false, artifacts: false },
        }),
      ),
    ),
  );
  expect(html).toContain('data-testid="task-timeline-pruned-notice"');
  expect(html).toContain("已按平台保留策略自动清理 38 条过期工具调用明细（runner.tool）");
  expect(html).toContain('data-testid="task-timeline-pruned-marker-retention-pruned:task-1:run-1"');
  expect(html).toContain("此处原有的 38 条工具调用明细（runner.tool）已按保留策略自动清理");
});
