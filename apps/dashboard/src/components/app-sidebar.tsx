import { useTranslation } from "@/lib/i18n";
import { useMatch } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import {
  LayoutDashboardIcon,
  CalendarClockIcon,
  BlocksIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  BriefcaseBusinessIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LogOutIcon,
  MessagesSquareIcon,
  MoonStarIcon,
  SettingsIcon,
  BotIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarSeparator,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  logoutDashboard,
  useDashboardAuthSession,
  type DashboardAuthSession,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const navGroups = [
  { title: "Operate", items: [
    { title: "Overview", icon: LayoutDashboardIcon, to: "/" },
    { title: "Sessions", icon: MessagesSquareIcon, to: "/sessions" },
    { title: "Tasks", icon: BriefcaseBusinessIcon, to: "/tasks" },
    { title: "Schedules", icon: CalendarClockIcon, to: "/schedules" },
  ] },
  { title: "Workspace", items: [
    { title: "Knowledge", icon: BookOpenIcon, to: "/knowledge" },
    { title: "Skills", icon: SparklesIcon, to: "/skills" },
    { title: "Memory", icon: BrainCircuitIcon, to: "/memory" },
    { title: "Plugins", icon: BlocksIcon, to: "/plugins" },
  ] },
  { title: "Control", items: [
    { title: "Users", icon: UsersIcon, to: "/users" },
    { title: "Groups", icon: UsersIcon, to: "/groups" },
    { title: "Tokens", icon: KeyRoundIcon, to: "/settings/tokens" },
    { title: "Model Configuration", icon: BotIcon, to: "/settings/agents" },
    { title: "Workers", icon: BotIcon, to: "/settings/workers" },
    { title: "Digital Shadows", icon: BotIcon, to: "/settings/channels" },
  ] },
] as const;

interface SidebarUserInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly avatarUrl: string | null;
}

function NavSidebarGroup() {
  const { t } = useTranslation();
  const agent = useMatch({ from: "/$agentId", shouldThrow: false });
  if (!agent) return null;
  const base = `/agent/${encodeURIComponent(agent.params.agentId)}`;
  const currentPath = window.location.pathname.replace(/\/$/, "");
  return (
    <>
      {navGroups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{t(group.title)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const href = item.to === "/" ? base : base + item.to;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={currentPath === href || (item.to !== "/" && currentPath.startsWith(href + "/"))}
                      tooltip={t(item.title)}
                    >
                      <a href={href}>
                        <item.icon />
                        <span>{t(item.title)}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function SidebarUserMenu() {
  const { data: session } = useDashboardAuthSession();

  return <SidebarUserMenuContent session={session} />;
}

function SidebarUserMenuContent({
  session,
}: {
  readonly session: DashboardAuthSession | undefined;
}) {
  const { t } = useTranslation();
  async function handleLogout() {
    try {
      await logoutDashboard();
    } finally {
      window.location.assign("/login");
    }
  }

  const userInfo = sidebarUserInfo(session);

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            className="group-data-[collapsible=icon]:justify-center"
            data-testid="sidebar-user-menu-trigger"
            size="lg"
            tooltip={userInfo.name}
          >
            <SidebarUserIdentity
              avatarSize={32}
              showId={false}
              userInfo={userInfo}
            />
            <ChevronsUpDownIcon className="ml-auto text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 rounded-xl p-2 shadow-lg"
          side="top"
          sideOffset={10}
        >
          <div
            className="flex items-center gap-3 rounded-lg px-2 py-2"
            data-testid="sidebar-user-menu-profile"
          >
            <SidebarUserIdentity
              avatarSize={36}
              showId
              userInfo={userInfo}
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="sidebar-settings-menu-item">
            <SettingsIcon />
            <span>{t("Settings")}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="sidebar-logout-button"
            onClick={handleLogout}
          >
            <LogOutIcon />
            <span>{t("Log out")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function SidebarUserIdentity({
  avatarSize,
  showId,
  userInfo,
}: {
  readonly avatarSize: number;
  readonly showId: boolean;
  readonly userInfo: SidebarUserInfo;
}) {
  return (
    <>
      <SidebarUserAvatar
        avatarUrl={userInfo.avatarUrl}
        name={userInfo.name}
        size={avatarSize}
      />
      <div className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-semibold">{userInfo.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {userInfo.provider}
        </span>
        {showId ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {userInfo.id}
          </span>
        ) : null}
      </div>
    </>
  );
}

function SidebarUserAvatar({
  avatarUrl,
  name,
  size,
}: {
  readonly avatarUrl: string | null;
  readonly name: string;
  readonly size: number;
}) {
  if (avatarUrl) {
    return (
      <img
        alt={name}
        className="aspect-square rounded-full object-cover"
        height={size}
        src={avatarUrl}
        width={size}
      />
    );
  }
  return <Avatar name={name} variant="beam" size={size} />;
}

function sidebarUserInfo(
  session: DashboardAuthSession | undefined,
): SidebarUserInfo {
  const user = session?.authenticated === true ? session.user : null;
  return {
    id: user?.id ?? "unknown-dashboard-user",
    name: user?.name ?? "Dashboard user",
    provider: user?.provider ?? "Unknown provider",
    avatarUrl: user?.avatarUrl ?? null,
  };
}

export function SidebarUserMenuForTest({
  session,
}: {
  readonly session: DashboardAuthSession;
}) {
  return <SidebarUserMenuContent session={session} />;
}

export function SidebarUserMenuProfileForTest({
  session,
}: {
  readonly session: DashboardAuthSession;
}) {
  return (
    <SidebarUserIdentity
      avatarSize={36}
      showId
      userInfo={sidebarUserInfo(session)}
    />
  );
}

function SidebarBrand({ open }: { readonly open: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-sidebar-foreground">
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-linear-to-br from-amber-100 via-emerald-100 to-sky-300 text-slate-700 shadow-xs ring-1 ring-black/5"
        data-testid="luna-brand-icon"
        aria-hidden="true"
      >
        <MoonStarIcon className="size-5" strokeWidth={1.6} />
      </span>
      <span className={cn("min-w-0 text-left leading-tight", open ? "" : "sr-only")}>
        <span className="block text-sm font-semibold tracking-tight">Luna</span>
        <span className="mt-0.5 block truncate text-[10px] font-normal text-muted-foreground">{t("Agent management console")}</span>
      </span>
    </div>
  );
}

export function SidebarBrandForTest({ open }: { readonly open: boolean }) {
  return <SidebarBrand open={open} />;
}

/**
 * Main application sidebar with navigation and user info.
 */
export function AppSidebar() {
  const { open } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="py-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="h-10 group-data-[collapsible=icon]:justify-center" asChild>
              <a href="/">
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
                  <SidebarBrand open={open} />
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator className="data-[orientation=horizontal]:w-auto" />

      <SidebarContent>
        <NavSidebarGroup />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarUserMenu />
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
