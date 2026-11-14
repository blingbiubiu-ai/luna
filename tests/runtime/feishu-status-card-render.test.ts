import { describe, expect, test } from "bun:test";
import { renderStatusCardSteps } from "../../extensions/channels/feishu/messaging/message-renderer";

describe("renderStatusCardSteps", () => {
  test("renders steps with status icons as DivElements", () => {
    const steps = [
      "✅ 分析需求",
      "🔄 设计方案 — 正在评估",
      "⏸ 实现代码",
      "⛔ 测试验证",
    ];
    const elements = renderStatusCardSteps(steps);
    expect(elements).toHaveLength(4);
    expect(elements[0]).toMatchObject({ tag: "div" });
    expect(elements[0]!.text).toMatchObject({ content: "✅ 分析需求" });
  });

  test("returns empty array for no steps", () => {
    expect(renderStatusCardSteps([])).toEqual([]);
  });

  test("renders single step", () => {
    const elements = renderStatusCardSteps(["✅ 完成"]);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.text!.content).toBe("✅ 完成");
  });

  test("preserves semantic line breaks inside one runner step", () => {
    const elements = renderStatusCardSteps([
      "Locate skill definition\n<Bash> find skills -type f",
    ]);

    expect(elements[0]!.text!.content).toBe(
      "Locate skill definition\n<Bash> find skills -type f",
    );
  });
});
