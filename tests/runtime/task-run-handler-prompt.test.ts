import { describe, expect, test } from "bun:test";

import { buildTaskRunPrompt } from "../../src/kernel/task-run-handler";

describe("Task Runner prompt builder", () => {
  test("renders generic execution requirements for task type task", () => {
    const prompt = buildTaskRunPrompt({
      taskType: "task",
      title: "编写实现计划",
      summary: "用户希望为 Task 分发策略编写实现计划。",
      reason: "initial",
      pendingText: "请按中文 spec 写 plan。",
      facts: ["用户确认 spec 使用中文。"],
      assumptions: ["计划文件写入 docs/superpowers/plans。"],
    });

    expect(prompt).toContain("You are handling a Luna task Task.");
    expect(prompt).toContain("Confirmed facts:");
    expect(prompt).toContain("- 用户确认 spec 使用中文。");
    expect(prompt).toContain("Launch assumptions:");
    expect(prompt).toContain("- 计划文件写入 docs/superpowers/plans。");
    expect(prompt).toContain("Completed work");
    expect(prompt).toContain("Verification");
    expect(prompt).not.toContain("You are handling a Luna investigation task.");
    expect(prompt).not.toContain("Likely cause");
  });

  test("renders troubleshooting work as generic task requirements", () => {
    const prompt = buildTaskRunPrompt({
      taskType: "task",
      title: "播放失败排查",
      summary: "用户反馈播放失败。",
      reason: "initial",
      pendingText: "did=123，10:00",
      facts: ["did=123"],
      assumptions: ["时间使用北京时间。"],
    });

    expect(prompt).toContain("You are handling a Luna task Task.");
    expect(prompt).toContain("Completed work");
    expect(prompt).toContain("Verification");
    expect(prompt).not.toContain("You are handling a Luna investigation Task.");
    expect(prompt).not.toContain("Likely cause");
    expect(prompt).toContain("- 时间使用北京时间。");
  });

  test("renders question requirements for question tasks", () => {
    const prompt = buildTaskRunPrompt({
      taskType: "question",
      title: "调研 A 和 B 的差异",
      summary: "用户需要 A 和 B 的差异结论。",
      reason: "initial",
      pendingText: "请给出依据。",
      facts: ["A 和 B 是用户给出的两个候选方案。"],
      assumptions: [],
    });

    expect(prompt).toContain("You are handling a Luna question Task.");
    expect(prompt).toContain("Direct answer");
    expect(prompt).toContain("Supporting evidence");
    expect(prompt).toContain("Remaining uncertainty");
    expect(prompt).not.toContain("Launch assumptions:");
  });
});
