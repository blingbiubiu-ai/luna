import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { agentsLandingHref, NoAgents, PlatformShell } from "../src/platform-shell";
import { PlatformRailView } from "../src/components/platform-rail";

const rail = (isAdmin: boolean, path = "/") =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(PlatformRailView, { path, isAdmin })));

function settingsShell(client: QueryClient, pathname = "/platform/settings") {
  // Other UI tests install a lightweight browser stub; this is an SSR assertion.
  const descriptors = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key] of descriptors) Reflect.deleteProperty(globalThis, key);
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(PlatformShell, { pathname })));
  } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  }
}

test("platform rail shows plugin management only to platform administrators", () => {
  const user = rail(false);
  expect(user).toContain("Agents");
  expect(user).not.toContain("/platform/plugins");
  const admin = rail(true, "/platform/plugins");
  expect(admin).not.toContain("luna-rail-label");
  expect(admin).toMatch(/href="\/platform\/plugins" aria-current="page"/);
});

test("platform rail keeps the Agent entry active inside an Agent", () => {
  expect(rail(false, "/agent/a1/sessions")).toMatch(/href="\/" aria-current="page"/);
});

test("the Agents entry lands on the first Agent", () => {
  const agent = (id: string) => ({ id, name: id, ownerUserId: "u", defaultShadowId: "s", status: "active" });
  expect(agentsLandingHref([agent("a 1"), agent("b")])).toBe("/agent/a%201");
  expect(agentsLandingHref([])).toBeNull();
});

test("with no Agent the landing offers to create one", () => {
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NoAgents)));
  expect(html).toContain("还没有 Agent");
  expect(html).toContain("新建 Agent");
});

test("the platform plugin page explains a missing plugin source", async () => {
  const { PluginSourceUnconfigured } = await import("../src/platform-shell");
  const html = renderToStaticMarkup(createElement(PluginSourceUnconfigured));
  expect(html).toContain("未配置插件源");
  expect(html).toContain("/platform/settings");
});

test("a direct platform-settings URL denies members without mounting the settings query", () => {
  const client = new QueryClient();
  client.setQueryData(["luna", "auth", "me"], { isPlatformAdmin: false });
  const html = settingsShell(client);
  expect(html).toContain("平台设置需要平台管理员权限");
  expect(html).not.toContain("对整个平台生效");
  expect(client.getQueryState(["/platform-settings"])).toBeUndefined();
});

test("a revoked administrator cannot render previously cached settings", () => {
  const client = new QueryClient();
  client.setQueryData(["luna", "auth", "me"], { isPlatformAdmin: false });
  client.setQueryData(["/platform-settings"], { canEdit: true, platform: { general: { publicBaseUrl: "https://private-setting.example" } } });
  const html = settingsShell(client, "/platform/settings/");
  expect(html).toContain("平台设置需要平台管理员权限");
  expect(html).not.toContain("private-setting.example");
});

test("platform administrators can open the settings workspace", () => {
  const client = new QueryClient();
  client.setQueryData(["luna", "auth", "me"], { isPlatformAdmin: true });
  const html = settingsShell(client);
  expect(html).toContain("对整个平台生效");
  expect(html).not.toContain("平台设置需要平台管理员权限");
});
