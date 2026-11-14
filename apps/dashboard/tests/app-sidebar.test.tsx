import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SidebarBrandForTest,
  SidebarUserMenuForTest,
  SidebarUserMenuProfileForTest,
} from "../src/components/app-sidebar";
import { SidebarProvider } from "../src/components/ui/sidebar";

test("sidebar user menu renders the authenticated dashboard user", () => {
  const session = {
    authenticated: true,
    user: {
      id: "user-actual-dashboard",
      name: "Actual Dashboard User",
      provider: "company-sso",
      avatarUrl: "https://avatar.example/actual.png",
    },
  } as const;
  const html = renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(SidebarUserMenuForTest, {
        session,
      }),
    ),
  );
  const profileHtml = renderToStaticMarkup(
    createElement(SidebarUserMenuProfileForTest, { session }),
  );

  expect(html).toContain("Actual Dashboard User");
  expect(html).toContain("company-sso");
  expect(html).toContain("https://avatar.example/actual.png");
  expect(profileHtml).toContain("Actual Dashboard User");
  expect(profileHtml).toContain("company-sso");
  expect(profileHtml).toContain("user-actual-dashboard");
  expect(profileHtml).toContain("https://avatar.example/actual.png");
  expect(html).not.toContain("Henry Li");
  expect(html).not.toContain("Super Individual");
  expect(profileHtml).not.toContain("Henry Li");
  expect(profileHtml).not.toContain("Super Individual");
});

test("sidebar brand uses the Luna moon icon instead of an emoji", () => {
  const html = renderToStaticMarkup(
    createElement(SidebarBrandForTest, { open: true }),
  );

  expect(html).toContain('data-testid="luna-brand-icon"');
  expect(html).toContain("lucide-moon-star");
  expect(html).toContain("Luna");
  expect(html).not.toContain("📯");
});
