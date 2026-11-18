import { createBrowserHistory, createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import type { MouseEvent } from "react";

/** One browser history for the Agent router and the platform pages, so switching never reloads. */
export const appHistory = typeof window === "undefined" ? createMemoryHistory() : createBrowserHistory();

/**
 * The same history for the Agent router, which is only told about `/agent/*` locations:
 * leaving for a platform page must not make it load that path as an Agent route.
 */
export const agentRouterHistory: RouterHistory = Object.assign(Object.create(appHistory) as RouterHistory, {
  subscribe: (listener: Parameters<RouterHistory["subscribe"]>[0]) =>
    appHistory.subscribe(event => { if (event.location.pathname.startsWith("/agent/")) listener(event); }),
});

/** Follows an in-app link without a page load; modified clicks keep browser behaviour. */
export function navigateInApp(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (currentHref() !== href) appHistory.push(href);
}

/**
 * The in-app location a link click should go to without a page load, or undefined when the
 * browser should follow it: another site, a new window, a download, an API or file URL, or
 * a `#` anchor on the current page.
 */
export function inAppLinkTarget(anchor: HTMLAnchorElement, current: URL): string | undefined {
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download") || !anchor.getAttribute("href")) return undefined;
  const url = new URL(anchor.href, current);
  if (url.origin !== current.origin || !(url.pathname === "/" || url.pathname.startsWith("/agent/") || url.pathname.startsWith("/platform/"))) return undefined;
  if (url.hash && url.pathname === current.pathname && url.search === current.search) return undefined;
  return url.pathname + url.search + url.hash;
}

/** Every in-app link inside the frame navigates without a page load, wherever it is written. */
export function followInAppLink(event: MouseEvent<HTMLElement>) {
  const anchor = event.target instanceof Element ? event.target.closest("a") : null;
  const href = anchor && inAppLinkTarget(anchor, new URL(window.location.href));
  if (href) navigateInApp(event as MouseEvent<HTMLAnchorElement>, href);
}

function currentHref(): string {
  const { pathname, search, hash } = appHistory.location;
  return pathname + search + hash;
}
