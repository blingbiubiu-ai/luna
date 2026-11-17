import Avatar from "boring-avatars";
import { BlocksIcon, BotIcon, LogOutIcon, MoonStarIcon, SettingsIcon } from "lucide-react";
import type { ComponentType } from "react";

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
  useDashboardMe,
  type DashboardAuthSession,
} from "@/lib/api";
import { navigateInApp } from "@/lib/app-history";
import { useTranslation } from "@/lib/i18n";

interface RailItem {
  readonly title: string;
  readonly href: string;
  readonly icon: ComponentType;
  readonly active: boolean;
}

/**
 * Platform-level navigation shown on every page: the Agent list and, for platform
 * administrators, platform management. Agent pages add their own sidebar beside it.
 */
export function PlatformRail({ path }: { readonly path: string }) {
  const me = useDashboardMe();
  return <PlatformRailView path={path} isAdmin={me.data?.isPlatformAdmin === true} />;
}

export function PlatformRailView({ path, isAdmin }: { readonly path: string; readonly isAdmin: boolean }) {
  const { t } = useTranslation();
  const current = path.replace(/\/$/, "") || "/";
  const agents: RailItem = {
    title: "Agents", href: "/", icon: BotIcon,
    active: current === "/" || current.startsWith("/agent/"),
  };
  const platform: RailItem[] = isAdmin ? [
    { title: t("Plugins"), href: "/platform/plugins", icon: BlocksIcon, active: current.startsWith("/platform/plugins") },
  ] : [];
  return (
    <nav className="luna-rail" aria-label={t("Platform navigation")}>
      <RailBrand />
      <div className="luna-rail-separator" />
      <RailLink item={agents} />
      {platform.length > 0 && <>
        <div className="luna-rail-separator" />
        {platform.map(item => <RailLink key={item.href} item={item} />)}
      </>}
      <div className="flex-1" />
      <RailUserMenu />
    </nav>
  );
}

function RailLink({ item }: { readonly item: RailItem }) {
  return (
    <a className="luna-rail-item" href={item.href} aria-current={item.active ? "page" : undefined}
      onClick={event => navigateInApp(event, item.href)}>
      <item.icon />
      <span>{item.title}</span>
    </a>
  );
}

function RailBrand() {
  const { t } = useTranslation();
  return (
    <a href="/" onClick={event => navigateInApp(event, "/")} className="flex flex-col items-center gap-1 py-1 text-[11px] font-semibold tracking-tight text-foreground"
      title={t("Agent management console")}>
      <span
        className="flex size-8 items-center justify-center rounded-lg bg-linear-to-br from-amber-100 via-emerald-100 to-sky-300 text-slate-700 shadow-xs ring-1 ring-black/5"
        data-testid="luna-brand-icon"
        aria-hidden="true"
      >
        <MoonStarIcon className="size-5" strokeWidth={1.6} />
      </span>
      Luna
    </a>
  );
}

export function RailBrandForTest() {
  return <RailBrand />;
}

interface RailUserInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly avatarUrl: string | null;
}

function RailUserMenu() {
  const { data: session } = useDashboardAuthSession();
  return <RailUserMenuContent session={session} />;
}

function RailUserMenuContent({ session }: { readonly session: DashboardAuthSession | undefined }) {
  const { t } = useTranslation();
  async function handleLogout() {
    try {
      await logoutDashboard();
    } finally {
      window.location.assign("/login");
    }
  }
  const userInfo = railUserInfo(session);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="mx-auto flex rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          data-testid="sidebar-user-menu-trigger"
          aria-label={userInfo.name}
          title={userInfo.name}
        >
          <UserAvatar avatarUrl={userInfo.avatarUrl} name={userInfo.name} size={34} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-xl p-2 shadow-lg" side="right" sideOffset={12}>
        <div className="flex items-center gap-3 rounded-lg px-2 py-2" data-testid="sidebar-user-menu-profile">
          <UserIdentity userInfo={userInfo} />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="sidebar-settings-menu-item">
          <SettingsIcon />
          <span>{t("Settings")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="sidebar-logout-button" onClick={handleLogout}>
          <LogOutIcon />
          <span>{t("Log out")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserIdentity({ userInfo }: { readonly userInfo: RailUserInfo }) {
  return (
    <>
      <UserAvatar avatarUrl={userInfo.avatarUrl} name={userInfo.name} size={36} />
      <div className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-semibold">{userInfo.name}</span>
        <span className="truncate text-xs text-muted-foreground">{userInfo.provider}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{userInfo.id}</span>
      </div>
    </>
  );
}

function UserAvatar({ avatarUrl, name, size }: { readonly avatarUrl: string | null; readonly name: string; readonly size: number }) {
  if (avatarUrl) {
    return <img alt={name} className="aspect-square rounded-full object-cover" height={size} src={avatarUrl} width={size} />;
  }
  return <Avatar name={name} variant="beam" size={size} />;
}

function railUserInfo(session: DashboardAuthSession | undefined): RailUserInfo {
  const user = session?.authenticated === true ? session.user : null;
  return {
    id: user?.id ?? "unknown-dashboard-user",
    name: user?.name ?? "Dashboard user",
    provider: user?.provider ?? "Unknown provider",
    avatarUrl: user?.avatarUrl ?? null,
  };
}

export function RailUserMenuForTest({ session }: { readonly session: DashboardAuthSession }) {
  return <RailUserMenuContent session={session} />;
}

export function RailUserProfileForTest({ session }: { readonly session: DashboardAuthSession }) {
  return <UserIdentity userInfo={railUserInfo(session)} />;
}
