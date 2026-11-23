import { useTranslation } from "@/lib/i18n";
import { Link, useMatch, useMatchRoute } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import {
  SlidersHorizontalIcon,
  LayoutDashboardIcon,
  CalendarClockIcon,
  BlocksIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  BriefcaseBusinessIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  HeartPulseIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  PlusIcon,
  BotIcon,
  SparklesIcon,
  TerminalSquareIcon,
  UsersIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarSeparator,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState } from "react";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { useDashboardAgent, useDashboardAgents } from "@/lib/api";
import type { DashboardAgentChoice } from "@/lib/api/hooks";

const navGroups = [
  { title: "Operate", items: [
    { title: "Overview", icon: LayoutDashboardIcon, to: "/$agentId/" },
    { title: "Proactivity", icon: HeartPulseIcon, to: "/$agentId/proactivity" },
    { title: "Sessions", icon: MessagesSquareIcon, to: "/$agentId/sessions" },
    { title: "Terminals", icon: TerminalSquareIcon, to: "/$agentId/terminals" },
    { title: "Tasks", icon: BriefcaseBusinessIcon, to: "/$agentId/tasks" },
    { title: "Schedules", icon: CalendarClockIcon, to: "/$agentId/schedules" },
  ] },
  { title: "Workspace", items: [
    { title: "Knowledge", icon: BookOpenIcon, to: "/$agentId/knowledge" },
    { title: "Skills", icon: SparklesIcon, to: "/$agentId/skills" },
    { title: "Memory", icon: BrainCircuitIcon, to: "/$agentId/memory" },
    { title: "Plugins", icon: BlocksIcon, to: "/$agentId/plugins" },
  ] },
  { title: "Access", items: [
    { title: "Users", icon: UsersIcon, to: "/$agentId/users" },
    { title: "Groups", icon: UsersIcon, to: "/$agentId/groups" },
    { title: "Tokens", icon: KeyRoundIcon, to: "/$agentId/settings/tokens" },
  ] },
  { title: "Runtime", items: [
    { title: "Agent Settings", icon: SlidersHorizontalIcon, to: "/$agentId/settings/general" },
    { title: "Model Configuration", icon: BotIcon, to: "/$agentId/settings/agents" },
    { title: "Workers", icon: BotIcon, to: "/$agentId/settings/workers" },
    { title: "Digital Shadows", icon: BotIcon, to: "/$agentId/settings/channels" },
  ] },
] as const;

/** Router path (under the `/agent` basepath) for an Agent page. */
function agentPath(route: string, agentId: string): string {
  return route.replace("$agentId", encodeURIComponent(agentId));
}

function NavSidebarGroup({ agentId }: { readonly agentId: string }) {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  return (
    <>
      {navGroups.map((group) => (
        <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{t(group.title)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const to = agentPath(item.to, agentId);
                return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={Boolean(matchRoute({ to, fuzzy: item.to !== "/$agentId/" }))}
                    tooltip={t(item.title)}
                  >
                    <Link to={to}>
                      <item.icon />
                      <span>{t(item.title)}</span>
                    </Link>
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

function AgentMark({ name, size }: { readonly name: string; readonly size: number }) {
  return (
    <span className="flex shrink-0 overflow-hidden rounded-md ring-1 ring-black/5" aria-hidden="true">
      <Avatar name={name} variant="marble" size={size} square />
    </span>
  );
}

function AgentSwitcher({ agentId }: { readonly agentId: string }) {
  const agent = useDashboardAgent(agentId);
  const agents = useDashboardAgents();
  return <AgentSwitcherView
    current={agent.data?.agent}
    agentId={agentId}
    agents={agents.data?.agents ?? []}
  />;
}

export function AgentSwitcherView({ current, agentId, agents }: {
  readonly current: DashboardAgentChoice | undefined;
  readonly agentId: string;
  readonly agents: readonly DashboardAgentChoice[];
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const name = current?.name ?? "Agent";
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg" tooltip={name} aria-label={t("Switch Agent")}
            className="border border-sidebar-border bg-background group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent">
            <AgentMark name={agentId} size={28} />
            <span className="min-w-0 flex-1 truncate text-left font-semibold">{name}</span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-xl p-1.5" sideOffset={6}>
          <DropdownMenuLabel className="text-xs text-muted-foreground">{t("Switch Agent")}</DropdownMenuLabel>
          {agents.map(item => (
            <DropdownMenuItem key={item.id} asChild>
              <Link to={agentPath("/$agentId/", item.id)}>
                <AgentMark name={item.id} size={20} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.id === agentId && <CheckIcon className="text-muted-foreground" />}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon /><span>{t("New Agent")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateAgentDialog open={creating} onOpenChange={setCreating} />
    </SidebarMenuItem>
  );
}

/** Agent-level sidebar, shown beside the platform rail on Agent pages. */
export function AppSidebar({ className }: { readonly className?: string } = {}) {
  const agent = useMatch({ from: "/$agentId", shouldThrow: false });
  const agentId = agent?.params.agentId;
  return (
    <Sidebar collapsible="icon" className={className}>
      <SidebarHeader className="py-3">
        <SidebarMenu>
          {agentId && <AgentSwitcher agentId={agentId} />}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator className="data-[orientation=horizontal]:w-auto" />

      <SidebarContent>
        {agentId && <NavSidebarGroup agentId={agentId} />}
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
