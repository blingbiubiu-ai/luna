import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MemorySourceLine } from "../src/components/memory-source-line";
import { SessionDetailView } from "../src/app/sessions/session-detail-view";
import { DashboardAgentContext } from "../src/lib/agent-route";
import type { DashboardSessionMessage } from "../src/lib/api";

const source = { sessionId: "2381282e-f1e4-4f81-b614-8bd983c0deb3", entryId: "530cc717-b85e", messageId: "m-1", at: Date.UTC(2026, 10, 19, 4, 6, 40) };

test("a memory version's source links to its message in the conversation", () => {
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(DashboardAgentContext.Provider, { value: { id: "agent-1", name: "Luna" } as never },
      createElement(MemorySourceLine, { agentId: "agent-1", source }))));
  expect(html).toContain("来源：会话 2381282e");
  expect(html).toContain("查看原文");
  expect(html).toContain(`href="/agent/agent-1/sessions/${source.sessionId}?entry=530cc717-b85e"`);
});

const message = {
  id: "m-1", entryId: "530cc717-b85e", session_id: "s", owning_session_id: "s", channel_message_key: "k", senderUserId: "u",
  senderUser: { id: "u", kind: "human", displayName: "王华杰", avatarUrl: null, status: "active", profileSource: "channel" },
  role: "user", content: [{ type: "text", text: "frida 再装一次" }], mentions: [], linked_tasks: [], linkedTasks: [], created_at: 1,
} as unknown as DashboardSessionMessage;
const view = (focusMissing: boolean) => renderToStaticMarkup(createElement(SessionDetailView, {
  sessionId: "s", session: undefined, messages: [message], loading: false, error: null, showNotFound: false,
  focusEntryId: "530cc717-b85e", focusMissing,
}));

test("each message carries its timeline entry, so a link can open the session at it", () => {
  expect(view(false)).toContain('data-entry-id="530cc717-b85e"');
  expect(view(false)).not.toContain("已不在这个会话里");
});

test("a link to a message that is gone says so instead of silently showing the latest", () => {
  expect(view(true)).toContain("要定位的那条消息已不在这个会话里");
});
