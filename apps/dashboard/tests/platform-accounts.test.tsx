import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlatformAccountsList } from "../src/app/platform-accounts";

test("PlatformAccountsList renders super-admin, platform-admin, and regular Feishu accounts clearly", () => {
  const html = renderToStaticMarkup(
    createElement(PlatformAccountsList, {
      currentAccountId: "local-dashboard-user",
      busy: false,
      confirmDeleteId: null,
      onConfirmDeleteChange: () => {},
      onToggleAdmin: () => {},
      onToggleStatus: () => {},
      onDelete: () => {},
      accounts: [
        {
          id: "local-dashboard-user",
          displayName: "Local dashboard user",
          avatarUrl: null,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          isSuperAdmin: true,
          isPlatformAdmin: true,
          agentCount: 1,
        },
        {
          id: "feishu:on_user1",
          displayName: "张三",
          avatarUrl: "https://avatar.test/1.png",
          status: "active",
          createdAt: 2,
          updatedAt: 2,
          isSuperAdmin: false,
          isPlatformAdmin: false,
          agentCount: 0,
        },
      ],
    }),
  );
  expect(html).toContain(">内置超级管理员<");
  expect(html).toContain("超级管理员");
  expect(html).toContain("内置超级管理员（不可变更）");
  expect(html).toContain("张三");
  expect(html).toContain("设为管理员");
});
