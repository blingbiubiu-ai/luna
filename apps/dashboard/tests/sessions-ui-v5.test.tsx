import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionComposer } from "../src/app/sessions/session-composer";
import { SelectField } from "../src/components/ui/select-field";
import { SessionDetailView } from "../src/app/sessions/session-detail-view";
import { SessionMoreMenu } from "../src/app/sessions/session-more-menu";
import { SessionsList } from "../src/app/sessions/sessions-list";
import { DashboardAgentContext } from "../src/lib/agent-route";
import type {
  DashboardSession,
  DashboardSessionMessage,
  DashboardSessionTimelineItem,
} from "../src/lib/api";

const baseTime = Date.UTC(2026, 10, 20, 2, 30, 0);

function makeSession(overrides: Partial<DashboardSession> & { id: string }): DashboardSession {
  return {
    status: "active",
    kind: "main",
    shadowId: "shadow-1",
    shadowName: "Luna",
    bindingStatus: "active",
    channel_type: "feishu",
    channelType: "feishu",
    channel_id: "feishu-default",
    group_id: "oc_group_1",
    thread_id: null,
    root_message_id: null,
    parent_session_id: null,
    parentSessionId: null,
    parentSession: null,
    title: null,
    display_title: overrides.id,
    displayTitle: overrides.id,
    avatarUrl: null,
    listening: null,
    attentionState: "idle",
    surface: null,
    message_count: 1,
    thread_anchor_preview: null,
    threadAnchorPreview: null,
    latest_message_preview: null,
    latestMessagePreview: null,
    latestSenderUserId: null,
    latestSenderUser: null,
    latest_message_at: baseTime,
    latestMessageAt: baseTime,
    linked_tasks: [],
    linkedTasks: [],
    contextPacks: [],
    launchContextPacks: [],
    seedRecords: [],
    created_at: baseTime,
    updated_at: baseTime,
    ...overrides,
  };
}

async function flushReact(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("Sessions UI v5 redesign", () => {
  test("left sidebar mixes groups, direct chats, and local sessions with filter tabs and inline topic pagination", async () => {
    const group = makeSession({
      id: "group-1",
      display_title: "【广州】支付值班群",
      displayTitle: "【广州】支付值班群",
      listening: true,
      latest_message_preview: "已回滚配置",
      latestMessagePreview: "已回滚配置",
      latest_message_at: baseTime + 5000,
      surface: {
        id: "surf-g1",
        externalId: "oc_group_1",
        kind: "group",
        displayName: "【广州】支付值班群",
        avatarUrl: null,
        memberCount: 48,
      },
    });
    const direct = makeSession({
      id: "direct-1",
      group_id: "oc_p2p_1",
      display_title: "张三",
      displayTitle: "张三",
      avatarUrl: "https://avatar.example/zhangsan.png",
      latest_message_preview: "好的，明早九点提醒你",
      latestMessagePreview: "好的，明早九点提醒你",
      latest_message_at: baseTime + 3000,
      surface: {
        id: "surf-p1",
        externalId: "oc_p2p_1",
        kind: "p2p",
        displayName: "张三",
        avatarUrl: null,
      },
    });
    const local = makeSession({
      id: "local-1",
      channel_type: "dashboard",
      channelType: "dashboard",
      channel_id: "luna-dashboard",
      group_id: null,
      display_title: "本地调试",
      displayTitle: "本地调试",
      latest_message_preview: "测试旁听阈值",
      latestMessagePreview: "测试旁听阈值",
      latest_message_at: baseTime + 1000,
    });

    const topics: DashboardSession[] = Array.from({ length: 15 }, (_, idx) =>
      makeSession({
        id: `topic-${idx}`,
        thread_id: `omt_${idx}`,
        root_message_id: `om_${idx}`,
        parent_session_id: "group-1",
        parentSessionId: "group-1",
        title: `排查话题 ${idx}`,
        display_title: "【广州】支付值班群",
        displayTitle: "【广州】支付值班群",
        attentionState:
          idx === 4 ? "run" : idx === 8 ? "wait" : idx === 2 ? "fail" : "idle",
        latest_message_at: baseTime - idx * 1000,
      }),
    );

    const { document, window } = parseHTML("<!doctype html><html><body></body></html>") as unknown as {
      document: Document;
      window: Window & typeof globalThis;
    };
    (window as unknown as { location?: { href: string; origin: string } }).location ??= {
      href: "http://localhost",
      origin: "http://localhost",
    };
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = document;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      const renderList = (query = "", selectedSessionId?: string) =>
        root.render(
          createElement(
            DashboardAgentContext.Provider,
            {
              value: {
                id: "agent-1",
                name: "Luna",
                ownerAccountId: "acc-1",
                ownerUserId: "user-1",
                defaultShadowId: "shadow-1",
                status: "active",
              },
            },
            createElement(SessionsList, {
              sessions: [group, direct, local, ...topics],
              query,
              setQuery: () => {},
              selectedSessionId,
              loading: false,
              error: null,
            }),
          ),
        );

      renderList("", "topic-12");
      await flushReact();

      // Total count includes group + direct + local + 15 topics = 18
      expect(container.textContent).toContain("18 个会话");
      // Green listening badge and direct badge in "全部"
      expect(container.textContent).toContain("旁听");
      expect(container.textContent).toContain("私聊");
      // Direct session uses real avatar image; group uses 2x2 stripped text avatar ("广州" / "支付")
      expect(container.querySelector('img[src="https://avatar.example/zhangsan.png"]')).not.toBeNull();
      expect(container.innerHTML).toContain("<span>广州</span><span><br>支付</span>");

      // Selected topic-12 auto-expands group-1; run (topic-4), wait (topic-8), fail (topic-2) rank first,
      // and active topic-12 stays in the list even though ranked > 3!
      expect(container.textContent).toContain("排查话题 4");
      expect(container.textContent).toContain("进行中");
      expect(container.textContent).toContain("排查话题 8");
      expect(container.textContent).toContain("待回答");
      expect(container.textContent).toContain("排查话题 2");
      expect(container.textContent).toContain("失败");
      expect(container.textContent).toContain("排查话题 12");
      expect(container.textContent).toContain("再显示 10 个（共 15）");

      // Click "再显示 10 个（共 15）" -> expands to 13 topics, leaving 2
      const moreBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
        btn.textContent?.includes("再显示 10 个"),
      );
      expect(moreBtn).toBeTruthy();
      moreBtn!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
      expect(container.textContent).toContain("再显示 2 个（共 15）");

      // Collapse topics -> shows "15 个话题 · 3 个需关注", while active topic-12 stays visible
      const collapseBtn = Array.from(container.querySelectorAll("button")).find(
        (btn) => btn.textContent?.trim() === "收起",
      );
      expect(collapseBtn).toBeTruthy();
      collapseBtn!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
      expect(container.textContent).toContain("15 个话题 · 3 个需关注");
      expect(container.textContent).toContain("排查话题 12");

      // Filter by "旁听中" -> keeps group-1, hides direct-1 and local-1
      const listeningTab = Array.from(container.querySelectorAll("button")).find(
        (btn) => btn.textContent?.trim() === "旁听中",
      );
      listeningTab!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
      expect(container.textContent).toContain("【广州】支付值班群");
      expect(container.textContent).not.toContain("张三");
      expect(container.textContent).not.toContain("本地调试");
    } finally {
      root.unmount();
    }
  });

  test("detail view renders topic breadcrumb, member count, ambient batch, reply quote, and preserves debug copy controls", () => {
    const topicSession = makeSession({
      id: "topic-502",
      thread_id: "omt_502",
      root_message_id: "om_502",
      parent_session_id: "group-1",
      parentSessionId: "group-1",
      parentSession: {
        id: "group-1",
        displayTitle: "支付 oncall 群",
        avatarUrl: null,
        memberCount: 48,
      },
      title: "退款接口 502 排查",
      display_title: "支付 oncall 群",
      displayTitle: "支付 oncall 群",
      linked_tasks: [{ id: "task-hdr-hidden", title: "顶部不再重复展示的任务", status: "completed", priority: null }],
      linkedTasks: [{ id: "task-hdr-hidden", title: "顶部不再重复展示的任务", status: "completed", priority: null }],
      workerId: "hostA-1",
    });

    const overheard1: DashboardSessionMessage = {
      id: "msg-amb-1",
      entryId: "entry-amb-1",
      session_id: "topic-502",
      owning_session_id: "topic-502",
      channel_message_key: "om_a1",
      senderUserId: "u-lisi",
      senderUser: {
        id: "u-lisi",
        kind: "human",
        displayName: "李四",
        avatarUrl: null,
        status: "active",
        profileSource: "channel",
      },
      role: "user",
      content: [{ type: "text", text: "是不是昨天那个配置发布" }],
      mentions: [],
      turnReason: "ambient",
      linked_tasks: [],
      linkedTasks: [],
      created_at: baseTime + 1000,
    };

    const ambientReply: DashboardSessionMessage = {
      id: "msg-amb-reply",
      entryId: "entry-amb-reply",
      session_id: "topic-502",
      owning_session_id: "topic-502",
      channel_message_key: "command:1",
      senderUserId: "u-luna",
      senderUser: {
        id: "u-luna",
        kind: "shadow",
        displayName: "Luna",
        avatarUrl: null,
        status: "active",
        profileSource: "dashboard",
      },
      role: "assistant",
      content: [{ type: "text", text: "是昨天 18:20 的配置发布，已回滚。" }],
      mentions: [],
      replyQuote: {
        messageId: "msg-amb-1",
        senderName: "李四",
        preview: "是不是昨天那个配置发布",
      },
      turnReason: "ambient",
      linked_tasks: [],
      linkedTasks: [],
      created_at: baseTime + 2000,
    };

    const timeline: DashboardSessionTimelineItem[] = [
      {
        type: "turn",
        turn: {
          id: "turn-ambient-1",
          status: "completed",
          reason: "ambient",
          materializedPrompt: "# Ambient Listening Prompt",
          runnerAttempts: [],
          entryIds: ["entry-amb-1", "entry-amb-reply"],
          entryRoles: ["trigger", "output"],
          messageIds: ["msg-amb-1", "msg-amb-reply"],
          latestMessageId: "msg-amb-reply",
          messageCount: 2,
          visibleMessageCount: 2,
          startedAt: baseTime + 1000,
          completedAt: baseTime + 2000,
          error: null,
        },
        messages: [overheard1, ambientReply],
      },
    ];

    const html = renderToStaticMarkup(
      createElement(
        DashboardAgentContext.Provider,
        {
          value: {
            id: "agent-1",
            name: "Luna",
            ownerAccountId: "acc-1",
            ownerUserId: "user-1",
            defaultShadowId: "shadow-1",
            status: "active",
          },
        },
        createElement(SessionDetailView, {
          sessionId: "topic-502",
          session: topicSession,
          timeline,
          loading: false,
          error: null,
          showNotFound: false,
        }),
      ),
    );

    const { document } = parseHTML(html) as unknown as { document: Document };
    // Topic breadcrumb links back to parent group
    const groupCrumb = document.querySelector('a[href="/agent/agent-1/sessions/group-1"]');
    expect(groupCrumb?.textContent).toBe("支付 oncall 群");
    expect(document.querySelector("h1")?.textContent).toContain("# 退款接口 502 排查");
    expect(document.querySelector("h1")?.textContent).toContain("48");
    expect(html).toContain("分身 Luna");
    expect(html).toContain("hostA-1");
    expect(document.querySelector("header")?.textContent).not.toContain("顶部不再重复展示的任务");

    // Ambient batch card + Luna reply with 机器人 badge, 旁听后主动回复, and inline quote block
    expect(document.querySelector('[data-testid="ambient-turn-batch"]')?.textContent).toContain(
      "旁听到 1 条消息",
    );
    expect(document.querySelector('[data-testid="ambient-turn-batch"]')?.textContent).toContain(
      "Luna 引用消息主动回复",
    );
    expect(html).toContain("机器人");
    expect(html).toContain("旁听后主动回复");
    expect(html).toContain("李四：是不是昨天那个配置发布");

    // Debug copy controls (entry id & turn prompt) remain present
    expect(document.querySelectorAll('[data-testid="message-debug-id"]').length).toBe(2);
    expect(document.querySelector('[data-testid="turn-prompt-badge"]')?.textContent).toBe(
      "prompt",
    );
  });

  test("More menu requires secondary confirmation before deleting a session, and composer sends on Enter", async () => {
    const { document, window } = parseHTML("<!doctype html><html><body></body></html>") as unknown as {
      document: Document;
      window: Window & typeof globalThis;
    };
    (window as unknown as { location?: { href: string; origin: string } }).location ??= {
      href: "http://localhost",
      origin: "http://localhost",
    };
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = document;

    let deletedCalled = false;
    const originalFetch = globalThis.fetch;
    const requests: { url: string; method: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/messages")) {
        return new Response(JSON.stringify({ messageId: "m-sent-1" }), { status: 202 });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    try {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            "div",
            null,
            createElement(SessionMoreMenu, {
              agentId: "agent-1",
              sessionId: "sess-del-1",
              hasContext: true,
              onOpenContext: () => {},
              onDeleted: () => {
                deletedCalled = true;
              },
            }),
            createElement(SessionComposer, {
              agentId: "agent-1",
              sessionId: "sess-del-1",
              disabled: false,
            }),
          ),
        ),
      );
      await flushReact();

      // Open More menu -> click "删除会话…" -> shows confirmation without calling DELETE yet
      const moreBtn = container.querySelector('[aria-label="更多操作"]')!;
      moreBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
      expect(container.textContent).toContain("复制会话 ID");
      expect(container.textContent).toContain("查看 Runner 上下文");
      const askDelBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("删除会话…"),
      )!;
      askDelBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
      expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
      expect(container.textContent).toContain("删除后时间线和工作目录都会清除");

      // Confirm deletion -> sends DELETE
      const confirmBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "删除会话",
      )!;
      confirmBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flushReact();
      expect(requests.some((r) => r.method === "DELETE" && r.url.includes("/sessions/sess-del-1"))).toBe(true);
      expect(deletedCalled).toBe(true);

      // Composer hint shows Enter 发送 · Shift+Enter 换行
      expect(container.textContent).toContain("Enter 发送 · Shift+Enter 换行");
    } finally {
      globalThis.fetch = originalFetch;
      root.unmount();
    }
  });

  test("SelectField renders unified dropdown trigger and updates value on selection", async () => {
    const { document, window } = parseHTML("<!doctype html><html><body></body></html>") as unknown as {
      document: Document;
      window: Window & typeof globalThis;
    };
    (window as unknown as { location?: { href: string; origin: string } }).location ??= {
      href: "http://localhost",
      origin: "http://localhost",
    };
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = document;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let chosen = "all";

    try {
      root.render(
        createElement(SelectField, {
          "aria-label": "Status filter",
          value: chosen,
          onValueChange: (next) => {
            chosen = next;
          },
          options: [
            { value: "all", label: "Status" },
            { value: "running", label: "Running" },
            { value: "draft", label: "Draft", disabled: true },
          ],
        }),
      );
      await flushReact();

      const trigger = container.querySelector('button[aria-label="Status filter"]')!;
      expect(trigger.textContent).toContain("Status");

      // Backing select preserves options and disabled state for form semantics
      const backing = container.querySelector('select[aria-hidden="true"]')!;
      expect(backing.querySelector('option[value="draft"]')?.hasAttribute("disabled")).toBe(true);
      (backing.querySelector('option[value="running"]') as HTMLOptionElement).selected = true;
      backing.dispatchEvent(new window.Event("change", { bubbles: true }));
      await flushReact();
      expect(chosen).toBe("running");
    } finally {
      root.unmount();
    }
  });
});
