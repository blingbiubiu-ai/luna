import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentSwitcherView } from "../src/components/app-sidebar";
import {
  RailBrandForTest,
  RailUserMenuForTest,
  RailUserProfileForTest,
} from "../src/components/platform-rail";
import { SidebarProvider } from "../src/components/ui/sidebar";

test("rail user menu renders the authenticated dashboard user", () => {
  const session = {
    authenticated: true,
    user: {
      id: "user-actual-dashboard",
      name: "Actual Dashboard User",
      provider: "company-sso",
      avatarUrl: "https://avatar.example/actual.png",
    },
  } as const;
  const html = renderToStaticMarkup(createElement(RailUserMenuForTest, { session }));
  const profileHtml = renderToStaticMarkup(createElement(RailUserProfileForTest, { session }));

  expect(html).toContain("Actual Dashboard User");
  expect(html).toContain("https://avatar.example/actual.png");
  expect(profileHtml).toContain("Actual Dashboard User");
  expect(profileHtml).toContain("company-sso");
  expect(profileHtml).toContain("user-actual-dashboard");
  expect(profileHtml).toContain("https://avatar.example/actual.png");
  expect(html).not.toContain("Henry Li");
  expect(profileHtml).not.toContain("Super Individual");
});

test("rail brand uses the Luna moon icon instead of an emoji", () => {
  const html = renderToStaticMarkup(createElement(RailBrandForTest));

  expect(html).toContain('data-testid="luna-brand-icon"');
  expect(html).toContain("lucide-moon-star");
  expect(html).toContain("Luna");
  expect(html).not.toContain("📯");
});

test("Agent sidebar header shows the current Agent as a switcher", () => {
  const agent = { id: "agent-1", name: "容器测试", ownerUserId: "u", defaultShadowId: "s", status: "active" };
  const html = renderToStaticMarkup(createElement(SidebarProvider, null,
    createElement(AgentSwitcherView, { current: agent, agentId: agent.id, agents: [agent] })));
  expect(html).toContain("容器测试");
  expect(html).toContain('aria-label="Switch Agent"');
});
