import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AppConfig } from "../../src/shared/config/schema";

const minimalConfig = {
  messaging: { default_channel_id: "", channels: [] },
};

describe("dashboard-managed agent configuration contract", () => {
  test("accepts a config without an agents section", () => {
    const parsed = AppConfig.parse(minimalConfig);
    expect("agents" in parsed).toBe(false);
  });

  test("rejects the removed agents section", () => {
    const parsed = AppConfig.safeParse({
      ...minimalConfig,
      agents: { default: { type: "claude", model: "claude-sonnet-4-6" } },
    });
    expect(parsed.success).toBe(false);
  });

  test("boot loader generated yaml omits agent settings", () => {
    const source = readFileSync(
      new URL("../../src/boot-loader/boot-loader.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("\nagents:\n");
  });
});
