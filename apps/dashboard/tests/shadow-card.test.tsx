import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ShadowCard, type ShadowEnvironment } from "../src/components/shadow-card";
import { ShadowRootSwitchView } from "../src/components/shadow-root-access";
import { imageCurrent, primaryContainer, type ContainerRow } from "../src/lib/containers";

const card = (environment: ShadowEnvironment, extra: Partial<Parameters<typeof ShadowCard>[0]> = {}) => renderToStaticMarkup(createElement(ShadowCard, {
  id: "s1", name: "桑果", isBody: false, subtitle: "飞书 · 桑果机器人", environment,
  root: createElement("span", null, "ROOT"), menu: createElement("span", null, "MENU"),
  onOpen: () => {}, openBlocked: () => undefined, ...extra,
}));

test("a Shadow card shows identity, environment facts and console buttons", () => {
  const html = card({ state: "running", workerId: "local", cpus: 8, memory: "32g", imageCurrent: false, activeJobs: 1 });
  for (const text of ["桑果", "飞书 · 桑果机器人", "运行中", "Worker local", "8 CPU · 32g", "镜像待更新", "1 个任务进行中", "终端", "桌面", "Root 终端", "ROOT", "MENU"])
    expect(html).toContain(text);
});

test("a never-started Shadow says its container is created on first open", () => {
  const html = card({ state: "cold" });
  expect(html).toContain("未创建");
  expect(html).toContain("首次打开终端或桌面时自动创建");
  expect(html).not.toContain("空闲");
});

test("the compact card beside open consoles keeps only name, state and buttons", () => {
  const html = card({ state: "stopped", workerId: "local", cpus: 8, memory: "32g" }, { compact: true });
  expect(html).toContain("已停止");
  expect(html).toContain("终端");
  expect(html).not.toContain("Worker local");
  expect(html).not.toContain("ROOT");
});

test("the root switch says when root is on, and when the host refuses it", () => {
  const view = (enabled: boolean, hostRefusal?: string) => renderToStaticMarkup(createElement(ShadowRootSwitchView, { enabled, busy: false, hostRefusal, onToggle: () => {} }));
  expect(view(true)).toContain("root 已开启 · 需受信用户同意");
  expect(view(true, "nosuid")).toContain("root 未生效");
  expect(view(false)).not.toContain("已开启");
});

test("the primary container is the running one; image freshness compares with the Worker", () => {
  const row = (workerId: string, running: boolean, imageDigest = "sha256:a") => ({ shadowId: "s1", workerId, running, imageDigest } as ContainerRow);
  expect(primaryContainer([row("old", false), row("new", true)], "s1")?.workerId).toBe("new");
  expect(primaryContainer([row("old", false)], "s2")).toBeUndefined();
  expect(imageCurrent(row("w", true), [{ workerId: "w", supported: true, imageDigest: "sha256:a" }])).toBe(true);
  expect(imageCurrent(row("w", true), [{ workerId: "w", supported: true, imageDigest: "sha256:b" }])).toBe(false);
  expect(imageCurrent(row("w", true), [{ workerId: "w", supported: true }])).toBeUndefined();
});
