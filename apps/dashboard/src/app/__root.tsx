import { useTranslation } from "@/lib/i18n";
import { LanguageToggle } from "@/components/language-toggle";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createRootRoute, Outlet } from "@tanstack/react-router";

import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import type { CSSProperties } from "react";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return (
    <SidebarProvider className="min-w-0 flex-1" style={{ "--sidebar-width": "14rem" } as CSSProperties}>
      <AppSidebar className="md:left-(--rail-width)" />
      <SidebarInset className="luna-shell h-svh min-w-0">
        <header className="luna-header flex shrink-0 items-center gap-2">
          <SidebarTrigger className="-ml-1" />
          <AppBreadcrumb />
          <div className="luna-header-actions ml-auto">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Refresh dashboard")}
              onClick={() => void queryClient.invalidateQueries()}
            >
              <RefreshCw className="size-4" />
            </Button>
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>
        <div className="luna-content flex flex-1 min-h-0 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
      <Toaster position="top-center" />
    </SidebarProvider>
  );
}
