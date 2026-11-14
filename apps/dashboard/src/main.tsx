import { LocaleProvider } from "@/lib/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { dashboardTheme, ThemeProvider } from "@/components/theme-provider";

import { AgentHome } from "./agent-home";
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
  defaultViewTransition: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider {...dashboardTheme}>
        <LocaleProvider>{location.pathname === "/" ? <AgentHome /> : <RouterProvider router={router} />}</LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
