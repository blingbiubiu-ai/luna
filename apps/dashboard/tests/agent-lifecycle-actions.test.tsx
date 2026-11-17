import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DeleteWarning } from "../src/app/agents/agent-lifecycle-actions";

const warning = (wholeAgent: boolean) => renderToStaticMarkup(createElement(DeleteWarning, {
  name: "桑果", entity: wholeAgent ? "Agent" : "分身", wholeAgent, confirmName: "", onConfirmName: () => {},
}));

test("Shadow deletion warns that Worker data is removed for good and history stays", () => {
  const html = warning(false);
  expect(html).toContain("此操作不可恢复");
  expect(html).toContain("该分身在 Worker 上的数据");
  expect(html).toContain("HOME 目录");
  expect(html).toContain("历史记录会保留");
  expect(html).toContain("输入分身名称");
  expect(html).toContain("桑果");
});

test("Agent deletion warns about every Shadow's data", () => {
  expect(warning(true)).toContain("该 Agent 所有分身在 Worker 上的数据");
});
