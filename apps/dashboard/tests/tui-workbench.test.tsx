import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ContainerList, PtySessionsResponse } from "../src/lib/containers";

test("TuiWorkbench renders group/user PTY titles and omits Shadow environment section", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    navigator: g.navigator,
    MutationObserver: g.MutationObserver,
  };
  const { window, document, navigator } = parseHTML("<!doctype html><html><body></body></html>");
  g.window = window;
  g.document = document;
  g.navigator = navigator;
  g.MutationObserver = window.MutationObserver ?? class { observe() {} disconnect() {} };

  try {
    const { TuiWorkbench } = await import("../src/app/terminals/tui-workbench");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData<PtySessionsResponse>(["/agents/agent-1/pty-sessions"], {
      sessions: [
        {
          workerId: "worker-1",
          environmentId: "env-1",
          shadowId: "shadow-1",
          shadowName: "本体",
          contextId: "ctx-group",
          runnerType: "codex",
          model: "gpt-5.4",
          sessionId: "rs-1",
          busy: true,
          privileged: true,
          pid: 123,
          startedAt: Date.now() - 5000,
          lastActiveAt: Date.now() - 1000,
          ownerType: "session",
          ownerId: "sess-group",
          runnerKind: "main",
          title: "【广州】支付值班群",
          channelType: "feishu",
        },
        {
          workerId: "worker-1",
          environmentId: "env-1",
          shadowId: "shadow-1",
          shadowName: "本体",
          contextId: "ctx-user",
          runnerType: "claude",
          sessionId: "rs-2",
          busy: false,
          privileged: true,
          pid: 124,
          startedAt: Date.now() - 10_000,
          lastActiveAt: Date.now() - 3000,
          ownerType: "session",
          ownerId: "sess-user",
          runnerKind: "main",
          title: "王华杰",
          channelType: "feishu",
        },
      ],
      dormantContexts: [],
    });
    queryClient.setQueryData<ContainerList>(["/agents/agent-1/containers"], {
      containers: [],
      workers: [{ workerId: "worker-1", supported: true }],
      shadows: [{ shadowId: "shadow-1", shadowName: "本体" }],
    });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TuiWorkbench, { agentId: "agent-1" }),
      ),
    );

    expect(html).toContain("TUI 驾驶舱");
    expect(html).toContain("活跃 AI 伪终端（PTY）");
    expect(html).toContain("【广州】支付值班群");
    expect(html).toContain("王华杰");
    expect(html).not.toContain("分身运行环境");
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete g[key];
      else g[key] = val;
    }
  }
});
