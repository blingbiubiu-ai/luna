import { LocaleProvider } from "@/lib/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { PlatformRail } from "@/components/platform-rail";
import { dashboardTheme, ThemeProvider } from "@/components/theme-provider";
import { agentRouterHistory, appHistory, followInAppLink } from "@/lib/app-history";

import { PlatformShell } from "./platform-shell";
import { routeTree } from "./routeTree.gen";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createRouter({
  routeTree,
  basepath: "/agent",
  history: agentRouterHistory,
  defaultViewTransition: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** The platform rail stays mounted; only the area beside it switches between Agent and platform pages. */
function AppFrame() {
  const pathname = useSyncExternalStore(appHistory.subscribe, () => appHistory.location.pathname);
  return (
    <div className="flex min-h-svh w-full" onClick={followInAppLink}>
      <PlatformRail path={pathname} />
      {pathname.startsWith("/agent/") ? <RouterProvider router={router} /> : <PlatformShell pathname={pathname} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider {...dashboardTheme}>
        <LocaleProvider><AppFrame /></LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
