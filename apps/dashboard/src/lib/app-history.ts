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
  if (appHistory.location.pathname !== href) appHistory.push(href);
}
