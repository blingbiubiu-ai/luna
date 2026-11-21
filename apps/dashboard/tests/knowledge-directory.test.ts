import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KnowledgeDirectoryBrowser } from "../src/app/knowledge/directory-browser";

test("Knowledge directory requests only expanded levels and reuses cached children", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { window, document });
  const requested: string[] = [];
  const selected: string[] = [];
  const directory = (path: string) => ({ type: "directory", path, name: path.split("/").at(-1) });
  const entries: Record<string, unknown[]> = {
    "": [directory("wiki"), directory("archive")],
    wiki: [directory("wiki/domains")],
    "wiki/domains": [{ type: "file", path: "wiki/domains/example.md", name: "example.md", sizeBytes: 10, kind: "markdown", modifiedAt: "2026-11-21T00:00:00Z" }],
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    expect(url.pathname).toBe("/api/workspaces/knowledge/directory");
    expect(url.searchParams.get("agentId")).toBe("test-agent");
    const path = url.searchParams.get("path")!;
    requested.push(path);
    return Response.json({ workspaceId: "knowledge", path, entries: entries[path] });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
  const root = createRoot(document.body);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const click = async (selector: string) => {
    const button = document.querySelector(selector);
    expect(button).toBeTruthy();
    button!.dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush();
  };
  try {
    root.render(createElement(QueryClientProvider, { client }, createElement(KnowledgeDirectoryBrowser, {
      agentId: "test-agent", selectedPath: null, onSelectPath: path => selected.push(path),
    })));
    await flush();
    expect(requested).toEqual([""]);
    await click('[aria-label="wiki"]');
    expect(requested).toEqual(["", "wiki"]);
    await click('[aria-label="wiki/domains"]');
    expect(requested).toEqual(["", "wiki", "wiki/domains"]);
    await click('[title="wiki/domains/example.md"]');
    expect(selected).toEqual(["wiki/domains/example.md"]);
    await click('[aria-label="wiki"]');
    expect(document.querySelector('[aria-label="wiki/domains"]')).toBeNull();
    await click('[aria-label="wiki"]');
    await click('[aria-label="wiki/domains"]');
    expect(requested).toEqual(["", "wiki", "wiki/domains"]);
  } finally {
    root.unmount();
    await flush();
    client.clear();
    Object.assign(globalThis, { window: originalWindow, document: originalDocument, fetch: originalFetch });
  }
});
