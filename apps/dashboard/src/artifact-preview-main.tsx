import { LocaleProvider } from "@/lib/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ArtifactPreviewPage } from "@/app/artifacts/artifact-preview-page";
import { dashboardTheme, ThemeProvider } from "@/components/theme-provider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("artifact-preview-root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider {...dashboardTheme}>
        <LocaleProvider><ArtifactPreviewPage /></LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
