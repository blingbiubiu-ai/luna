import { expect, test } from "bun:test";

import { inAppLinkTarget } from "../src/lib/app-history";

/** The anchor attributes inAppLinkTarget reads, as a browser would resolve them. */
function anchor(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  const all: Record<string, string> = { href, ...attributes };
  return { href: new URL(href, current).href, target: all.target ?? "", hasAttribute: (name: string) => name in all, getAttribute: (name: string) => all[name] ?? null } as unknown as HTMLAnchorElement;
}
const current = new URL("http://luna.test/agent/a1/sessions?tab=all");

test("links to Dashboard pages navigate in the app", () => {
  expect(inAppLinkTarget(anchor("/agent/a1/sessions/s1"), current)).toBe("/agent/a1/sessions/s1");
  expect(inAppLinkTarget(anchor("/agent/a1/tasks?status=open#top"), current)).toBe("/agent/a1/tasks?status=open#top");
  expect(inAppLinkTarget(anchor("/platform/plugins/p1"), current)).toBe("/platform/plugins/p1");
  expect(inAppLinkTarget(anchor("/"), current)).toBe("/");
  expect(inAppLinkTarget(anchor("http://luna.test/agent/a2"), current)).toBe("/agent/a2");
});

test("the browser keeps other sites, new windows, downloads, API files and same-page anchors", () => {
  expect(inAppLinkTarget(anchor("https://example.com/agent/a1"), current)).toBeUndefined();
  expect(inAppLinkTarget(anchor("/agent/a1/tasks", { target: "_blank" }), current)).toBeUndefined();
  expect(inAppLinkTarget(anchor("/agent/a1/report.md", { download: "" }), current)).toBeUndefined();
  expect(inAppLinkTarget(anchor("/api/artifacts/x/download"), current)).toBeUndefined();
  expect(inAppLinkTarget(anchor("/login"), current)).toBeUndefined();
  expect(inAppLinkTarget(anchor("#artifact-1"), current)).toBeUndefined();
  expect(inAppLinkTarget(anchor("/agent/a1/sessions?tab=all#artifact-1"), current)).toBeUndefined();
});
