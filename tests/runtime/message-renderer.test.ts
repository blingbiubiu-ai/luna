import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderMessageCard,
  renderTaskResultCard,
  renderStatusCard,
} from "../../extensions/channels/feishu/messaging/message-renderer";
import { config, reloadConfig, setLunaHome } from "../../src/shared";

let previousHome: string;
let testHome: string;

beforeEach(() => {
  previousHome = config.paths.home;
  testHome = mkdtempSync(join(tmpdir(), "luna-message-renderer-test-"));
  writeFileSync(
    join(testHome, "config.yaml"),
    "{}\n",
  );
  setLunaHome(testHome);
  reloadConfig();
});

afterEach(() => {
  setLunaHome(previousHome);
  try {
    reloadConfig();
  } catch {
    // Some test environments do not have a user-level config.
  }
  rmSync(testHome, { recursive: true, force: true });
});

test("task result card uses Feishu header field and no step panel", async () => {
  const card = await renderTaskResultCard(
    {
      taskId: "task-render-result",
      title: "播放页 502",
      summary: "用户反馈播放页 502，需要定位根因。",
      status: "completed",
      content: "排查完成：命中错误配置。",
    },
    {
      uploadImage: async () => "image-key",
    },
  );

  expect(card).toMatchObject({
    schema: "2.0",
    header: {
      title: { content: "播放页 502" },
      subtitle: { content: "用户反馈播放页 502，需要定位根因。" },
      template: "green",
    },
    body: {
      elements: [{ tag: "markdown", content: "排查完成：命中错误配置。" }],
    },
  });
  expect("head" in card).toBe(false);
  expect(card.body.elements).toHaveLength(1);
  expect(JSON.stringify(card)).not.toContain("Task 结论");
  expect(JSON.stringify(card)).not.toContain("下一步建议");
  expect(JSON.stringify(card)).not.toContain("如果复现");
  expect(
    card.body.elements.some((element) => element.tag === "collapsible_panel"),
  ).toBe(false);
});

test("message card renders uploaded markdown images as Feishu image elements", async () => {
  const uploadedPaths: string[] = [];
  const card = await renderMessageCard(
    [{ type: "text", text: "原图：\n\n![result](artifact:direct-image)" }],
    {
      streaming: false,
      uploadImage: async (path) => {
        uploadedPaths.push(path);
        return "uploaded-image-key";
      },
      resolveImagePath: (path) =>
        path === "artifact:direct-image" ? "/tmp/managed/direct.jpeg" : undefined,
    },
  );

  expect(uploadedPaths).toEqual(["/tmp/managed/direct.jpeg"]);
  expect(card.body.elements).toEqual([
    {
      tag: "markdown",
      content: "原图：\n\n",
    },
    {
      tag: "img",
      img_key: "uploaded-image-key",
      mode: "fit_horizontal",
      custom_width: 320,
      alt: {
        tag: "plain_text",
        content: "result",
      },
    },
  ]);
  expect(JSON.stringify(card)).not.toContain("![result]");
  expect(JSON.stringify(card)).not.toContain("uploaded-image-key)");
});

test("task result card renders uploaded markdown images as Feishu image elements", async () => {
  const card = await renderTaskResultCard(
    {
      taskId: "task-render-result-image",
      title: "图片分析",
      summary: "返回识别截图。",
      status: "completed",
      content: "结果如下：\n\n![image](artifact:task-result-image)",
    },
    {
      uploadImage: async () => "task-result-image-key",
      resolveImagePath: (path) =>
        path === "artifact:task-result-image"
          ? "/tmp/managed/result.jpeg"
          : undefined,
    },
  );

  expect(card.body.elements).toEqual([
    {
      tag: "markdown",
      content: "结果如下：\n\n",
    },
    {
      tag: "img",
      img_key: "task-result-image-key",
      mode: "fit_horizontal",
      custom_width: 320,
      alt: {
        tag: "plain_text",
        content: "image",
      },
    },
  ]);
  expect(JSON.stringify(card)).not.toContain("![image]");
  expect(JSON.stringify(card)).not.toContain("task-result-image-key)");
});


test("status card keeps explicit progress steps separate from body content", async () => {
  const card = await renderStatusCard(
    {
      title: "独立页 fallback 到转码页原因排查",
      summary: "查询独立页 fallback 到转码页的触发条件，并给出简洁结论。",
      status: "running",
      state: "active",
      content: "正在排查。",
      steps: ["Started codex runner.", "正在查询 Search Replay。"],
    },
    {
      uploadImage: async () => "image-key",
    },
  );

  expect(card).toMatchObject({
    schema: "2.0",
    header: {
      title: { content: "独立页 fallback 到转码页原因排查" },
      subtitle: { content: "查询独立页 fallback 到转码页的触发条件，并给出简洁结论。" },
      template: "blue",
    },
  });
  expect("head" in card).toBe(false);
  expect(JSON.stringify(card)).not.toContain("Task 状态");
  expect(card.body.elements).toMatchObject([
    {
      tag: "collapsible_panel",
      expanded: true,
      elements: [
        { text: { content: "Started codex runner." } },
        { text: { content: "正在查询 Search Replay。" } },
      ],
    },
    { tag: "markdown", content: "正在排查。" },
  ]);
});

test("status card can hide header for work sessions", async () => {
  const card = await renderStatusCard(
    {
      title: "工作会话",
      summary: "正在处理…",
      status: "in_progress",
      state: "active",
      hideHeader: true,
      content: "正在处理…",
      steps: ["工作会话执行已开始。"],
    },
    {
      uploadImage: async () => "image-key",
    },
  );

  expect("header" in card).toBe(false);
  expect(card.body.elements[0]?.tag).toBe("collapsible_panel");
});

test("terminal status card keeps body content outside its collapsed step panel", async () => {
  const card = await renderStatusCard(
    {
      status: "completed",
      state: "terminal",
      hideHeader: true,
      content: "最终正文",
      steps: ["已完成检索。"],
    },
    {
      uploadImage: async () => "image-key",
    },
  );

  expect(card.body.elements).toMatchObject([
    {
      tag: "collapsible_panel",
      expanded: false,
      elements: [{ text: { content: "已完成检索。" } }],
    },
    { tag: "markdown", content: "最终正文" },
  ]);
});
