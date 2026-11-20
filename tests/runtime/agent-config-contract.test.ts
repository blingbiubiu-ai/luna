import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AppConfig } from "../../src/shared/config/schema";

const minimalConfig = {};

describe("dashboard-managed configuration contract", () => {
  test("accepts an empty bootstrap config", () => {
    const parsed = AppConfig.parse(minimalConfig);
    expect("agents" in parsed).toBe(false);
    expect("git" in parsed).toBe(false);
    expect("auth" in parsed).toBe(false);
    expect("messaging" in parsed).toBe(false);
    expect("memory" in parsed).toBe(false);
    expect("plugins" in parsed).toBe(false);
  });

  test("rejects removed legacy and dashboard-managed sections in config.yaml", () => {
    for (const removed of [
      { agents: { default: { type: "claude", model: "claude-sonnet-4-6" } } },
      { git: { authorName: "Luna", authorEmail: "luna@example.com" } },
      { auth: { feishu: { appId: "cli_1" } } },
      { messaging: { default_channel_id: "", channels: [] } },
      { service: { publicUrl: "https://luna.example.com" } },
      { timezone: "Asia/Shanghai" },
    ]) {
      expect(AppConfig.safeParse(removed).success).toBe(false);
    }
  });

  test("boot loader generated yaml contains only bootstrap settings", () => {
    const source = readFileSync(
      new URL("../../src/boot-loader/boot-loader.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("\nagents:\n");
    expect(source).not.toContain("\nmessaging:\n");
    expect(source).not.toContain("\nplugins:\n");
  });
});
