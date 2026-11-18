import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { botStatus } from "../src/lib/bot-status";
import { ShadowBotRow } from "../src/components/shadow-card";

const runtime = (state: string, extra: Record<string, unknown> = {}) => ({ id: "c", type: "feishu", inbound: { state, ...extra } });

test("the bot status follows its switch first, then its Shadow, then the live connection", () => {
  expect(botStatus({ enabled: false, shadowActive: true, runtime: runtime("connected") })).toMatchObject({ label: "机器人已停用", action: "enable" });
  expect(botStatus({ enabled: true, shadowActive: false, runtime: undefined })).toMatchObject({ label: "机器人未连接", tone: "off" });
  expect(botStatus({ enabled: true, shadowActive: true, runtime: runtime("connected") })).toMatchObject({ label: "机器人已连接", tone: "ok" });
  expect(botStatus({ enabled: true, shadowActive: true, runtime: runtime("reconnecting", { reconnectAttempts: 3 }) }).label).toBe("机器人重连中（第 3 次）");
  expect(botStatus({ enabled: true, shadowActive: true, runtime: runtime("failed", { lastError: "app disabled" }) })).toMatchObject({ action: "retry", detail: "app disabled" });
  expect(botStatus({ enabled: true, shadowActive: true, runtime: runtime("credentials_invalid") })).toMatchObject({ label: "机器人凭据无效", action: "resecret" });
  expect(botStatus({ enabled: true, shadowActive: true, runtime: undefined }).label).toBe("机器人未连接");
});

test("every bot status names the bot, so it is never read as the Shadow's status", () => {
  for (const state of ["connected", "reconnecting", "failed", "credentials_invalid", "connecting"])
    expect(botStatus({ enabled: true, shadowActive: true, runtime: runtime(state) }).label.startsWith("机器人")).toBe(true);
  const html = renderToStaticMarkup(createElement(ShadowBotRow, { channel: "飞书", name: "悟空",
    status: botStatus({ enabled: false, shadowActive: true, runtime: undefined }), onAction: () => {} }));
  expect(html).toContain("渠道机器人");
  expect(html).toContain("飞书 · 悟空");
  expect(html).toContain("机器人已停用");
  expect(html).toContain("启用机器人");
  expect(renderToStaticMarkup(createElement(ShadowBotRow, { channel: "飞书", name: null }))).toContain("未绑定");
});
