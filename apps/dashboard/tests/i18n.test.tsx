import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider, UiText, translate } from "../src/lib/i18n";
import { AgentConfigDashboardView } from "../src/app/settings/agent-config-dashboard";

test("Chinese presentation translates labels and counts while preserving user data", () => {
  expect(translate("zh-CN", "3 messages")).toBe("3 条消息");
  expect(translate("en", "Agents")).toBe("Agents");
  expect(translate("zh-CN", "examplecli.settings.*")).toBe("examplecli.settings.*");
  const html = renderToStaticMarkup(<LocaleProvider initialLocale="zh-CN">
    <AgentConfigDashboardView status={{status: "setup_required", active: null}} types={[]} profiles={[]}
      onCreate={async () => {}} onTest={async () => {}} onActivate={async () => {}} onDelete={async () => {}} />
    <UiText>My custom model</UiText>
  </LocaleProvider>);
  expect(html).toContain("智能体");
  expect(html).not.toContain("New Profile");
  expect(html).toContain("My custom model");
});
