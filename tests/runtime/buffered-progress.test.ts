import { expect, test } from "bun:test";
import { BufferedProgress, RECENT_PROGRESS_STEPS } from "../../src/messaging/notifications/buffered-progress";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("many tool calls stay in memory until an ordered public summary flush", async () => {
  const persisted: string[] = [];
  const batches: string[][] = [];
  const progress = new BufferedProgress({
    persist: text => { persisted.push(text); return text; },
    send: async entries => { batches.push([...entries]); },
    onError: error => { throw error; },
  });
  try {
    for (let i = 0; i < 10_000; i++) { progress.toolStart(`tool-${i}`, "Read"); progress.toolResult(`tool-${i}`, i === 9_999); }
    expect(persisted).toEqual([]);
    progress.summary("已查完日志，现在修复代码。");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain("调用 10000 次");
    expect(persisted[0]).toContain("收到 10000 次结果");
    expect(persisted[0]).toContain("1 次明确失败");
    expect(persisted[0]!.indexOf("工具进度")).toBeLessThan(persisted[0]!.indexOf("已查完日志"));
    await tick();
    expect(batches).toEqual([persisted]);
  } finally { await progress.close(); }
});

test("slow delivery does not block producers and later batches remain ordered and bounded", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const batches: string[][] = [];
  let saved = 0;
  const progress = new BufferedProgress({
    persist: text => { saved++; return text; },
    send: async entries => { batches.push([...entries]); if (batches.length === 1) await gate; },
    onError: error => { throw error; },
  });
  try {
    progress.summary("最早的公开进度");
    await tick();
    for (let i = 0; i < 1_000; i++) progress.summary(`阶段 ${i}`);
    expect(saved).toBe(1_001);
    expect(batches).toHaveLength(1);
    release(); await tick(); await tick();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(RECENT_PROGRESS_STEPS);
    expect(batches[1]![0]).toBe(`阶段 ${1_000 - RECENT_PROGRESS_STEPS}`);
    expect(batches[1]!.at(-1)).toBe("阶段 999");
    expect(saved).toBe(1_001);
  } finally { release(); await progress.close(); }
});

test("closing persists a final tool window without sending a late active update", async () => {
  const persisted: string[] = [], sent: string[][] = [];
  const progress = new BufferedProgress({persist: text => {persisted.push(text); return text;},
    send: async entries => {sent.push([...entries]);}, onError: error => {throw error;}});
  progress.toolStart("tool", "Read");
  await progress.close(); await tick();
  expect(persisted).toHaveLength(1);
  expect(sent).toEqual([]);
  progress.summary("结束之后"); progress.flush();
  expect(persisted).toHaveLength(1);
});
