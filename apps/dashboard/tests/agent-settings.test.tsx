import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentSettingsForm } from "../src/app/settings/general";

describe("AgentSettingsForm", () => {
  test("renders TUI idle keep-alive selector without task run limit or manual save button", () => {
    const html = renderToStaticMarkup(
      createElement(AgentSettingsForm, {
        settings: {
          inbound: { processingReaction: true },
          work: { progressCard: { show: true, style: "card" } },
          main: { taskProgressCard: { send: true, style: "native" } },
          pty: { idleTimeoutMinutes: 30 },
        },
        error: null,
        onChange: () => {},
      }),
    );

    expect(html).toContain("TUI 伪终端");
    expect(html).toContain("空闲保活时长");
    expect(html).toContain("30 分钟");
    expect(html).not.toContain("任务运行时长");
    expect(html).not.toContain(">保存<");
  });

  test("shows each message setting with the Service default until the Agent sets its own", () => {
    const html = renderToStaticMarkup(
      createElement(AgentSettingsForm, {
        settings: {
          inbound: { processingReaction: true },
          work: { progressCard: { show: true, style: "card" } },
          main: { taskProgressCard: { send: true, style: "native" } },
          messages: { maxBatchSize: 3, groupBotAliases: ["小助手", "Luna"] },
        },
        messageDefaults: {
          coalesceIdleMs: 1200, coalesceMaxWaitMs: 5000, maxBatchSize: 8, groupBotAliases: [],
          followupWindowMs: 300000, followupMaxMessages: 8, followupSenders: "requester_and_reporters",
          followupInterruptOnOtherUser: true, followupRecentMessages: 3,
          contextWindowMs: 300000, contextMaxMessages: 12, contextMaxChars: 6000, contextRecentUnprocessedMessages: 10,
        },
        error: null,
        onChange: () => {},
      }),
    );
    expect(html).toContain("消息处理");
    // Unset: the default is the placeholder, in the field's unit.
    expect(html).toMatch(/aria-label="合并等待（秒）"[^>]*placeholder="1.2"[^>]*value=""/);
    expect(html).toMatch(/aria-label="追问有效时长（分钟）"[^>]*placeholder="5"/);
    // Set: the Agent's own value.
    expect(html).toMatch(/aria-label="每轮最多几条"[^>]*value="3"/);
    expect(html).toContain('value="小助手，Luna"');
    expect(html).toContain("默认（叫分身的人和向它汇报的人）");
  });

  test("shows the listening settings in the units they are edited in", () => {
    const html = renderToStaticMarkup(
      createElement(AgentSettingsForm, {
        settings: {
          inbound: { processingReaction: true },
          work: { progressCard: { show: true, style: "card" } },
          main: { taskProgressCard: { send: true, style: "native" } },
          listening: { defaultEnabled: false, quietMs: 45000, batchSize: 10, maxWaitMs: 180000, backoffMaxMs: 600000, maxTurnsPerHour: 12 },
        },
        error: null,
        onChange: () => {},
      }),
    );
    expect(html).toContain("旁听");
    expect(html).toMatch(/aria-label="群里安静多久后看一批（秒）"[^>]*value="45"/);
    expect(html).toMatch(/aria-label="最长攒多久（分钟）"[^>]*value="3"/);
    expect(html).toMatch(/aria-label="连续沉默后的间隔上限（分钟）"[^>]*value="10"/);
    expect(html).toMatch(/aria-label="每个群每小时最多几轮"[^>]*value="12"/);
  });
});
