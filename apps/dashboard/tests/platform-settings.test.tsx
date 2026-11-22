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
} from "../src/app/platform-settings";

const noop = () => {};

test("platform settings forms render all migrated runtime sections for admins and read-only viewers", () => {
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
});
