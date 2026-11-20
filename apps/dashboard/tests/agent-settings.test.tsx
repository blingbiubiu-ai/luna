import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentSettingsForm } from "../src/app/settings/general";

describe("AgentSettingsForm", () => {
  test("renders TUI idle keep-alive selector and task run limit without a manual save button", () => {
    const html = renderToStaticMarkup(
      createElement(AgentSettingsForm, {
        settings: {
          inbound: { processingReaction: true },
          work: { progressCard: { show: true, style: "card" } },
          main: { taskProgressCard: { send: true, style: "native" } },
          task: { runLimitHours: 12 },
          pty: { idleTimeoutMinutes: 30 },
        },
        error: null,
        onChange: () => {},
      }),
    );

    expect(html).toContain("TUI 伪终端");
    expect(html).toContain("空闲保活时长");
    expect(html).toContain("30 分钟");
    expect(html).toContain("任务运行时长");
    expect(html).not.toContain(">保存<");
  });
});
