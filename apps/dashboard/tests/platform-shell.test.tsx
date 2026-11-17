import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AgentList, PlatformNav } from "../src/platform-shell";
import { SidebarProvider } from "../src/components/ui/sidebar";

const nav = (isAdmin: boolean, path = "/") =>
  renderToStaticMarkup(createElement(SidebarProvider, null, createElement(PlatformNav, { path, isAdmin })));

test("home sidebar shows plugin management only to platform administrators", () => {
  const user = nav(false);
  expect(user).toContain("我的 Agent");
  expect(user).not.toContain("插件管理");
  expect(user).not.toContain("/platform/plugins");
  const admin = nav(true, "/platform/plugins");
  expect(admin).toContain("平台管理");
  expect(admin).toContain('href="/platform/plugins"');
});

test("the home page lists Agents with a create action", () => {
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AgentList)));
  expect(html).toContain("我的 Agent");
  expect(html).toContain("新建 Agent");
});
