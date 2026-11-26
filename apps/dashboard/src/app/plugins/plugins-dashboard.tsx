import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { useMemo, useState } from "react";
import {
  BlocksIcon,
  ChevronRightIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  DashboardPlugin,
  DashboardPluginInstallation,
  DashboardPluginMarketplaceSummary,
  DashboardPluginRelease,
} from "@/lib/api";

interface PluginActions {
  readonly onDisablePlugin?: (pluginId: string) => void;
  readonly onEnablePlugin?: (pluginId: string, version: string) => void;
  readonly onRollbackPlugin?: (pluginId: string, version: string) => void;
  readonly onUpgradePlugin?: (pluginId: string, version: string) => void;
  readonly pendingPluginId?: string | undefined;
}

export function PluginsDashboard({
  error, actionError, isLoading = false, isRefreshing = false,
  onRefreshMarketplace, plugins, modelConfigHref, ...actions
}: PluginActions & {
  readonly error?: unknown;
  readonly actionError?: unknown;
  readonly isLoading?: boolean;
  readonly isRefreshing?: boolean;
  readonly onRefreshMarketplace?: () => void;
  readonly plugins: readonly DashboardPluginMarketplaceSummary[];
  readonly modelConfigHref?:string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const loadError = error ?? undefined;
  const query = search.trim().toLowerCase();
  const visible = plugins.filter(item =>
    `${item.displayName} ${item.id}`.toLowerCase().includes(query));
  const activeCount = plugins.filter(item => item.installation?.activeState === "enabled").length;
  const pendingCount = plugins.filter(item => needsRestart(item.installation)).length;

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-6 px-5 py-7 sm:px-8">
          <header className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t("Plugins")}</h1>
            <p className="text-sm leading-6 text-muted-foreground">{t("Manage your plugins, review versions, and choose what runs in Luna.")}</p>
            {modelConfigHref?<Button asChild variant="outline"><a href={modelConfigHref}>模型账号登录与 API</a></Button>:null}
          </header>

          {!isLoading && loadError === undefined ? (
            <section aria-label={t("Plugin overview")} className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-4 py-3 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className={`size-1.5 rounded-full ${activeCount ? "bg-emerald-500" : "bg-muted-foreground"}`} />{t("Running")}<strong className="font-semibold text-foreground">{activeCount}</strong>
              </div>
              <div className="text-muted-foreground">{t("Available")}<strong className="ml-1 font-semibold text-foreground">{plugins.length}</strong></div>
              <div className="text-muted-foreground">{t("Pending restart")}<strong className="ml-1 font-semibold text-foreground">{pendingCount}</strong></div>
              <span className="text-muted-foreground sm:ml-auto">{t("Changes take effect after a service restart.")}</span>
            </section>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:max-w-md">
              <SearchIcon className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input type="search" aria-label={t("Search plugins")} placeholder={t("Search plugins by name or ID...")}
                value={search} onChange={event => setSearch(event.target.value)} className="h-10 rounded-lg pl-9" />
            </div>
            {onRefreshMarketplace ? (
              <Button variant="outline" className="h-10 rounded-lg" disabled={isRefreshing || actions.pendingPluginId !== undefined}
                onClick={onRefreshMarketplace}>
                <RefreshCwIcon className={`size-4 ${isRefreshing ? "animate-spin" : ""}`} />
                {isRefreshing ? t("Refreshing...") : t("Refresh")}
              </Button>
            ) : null}
          </div>

          {actionError != null ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{formatPluginError(actionError)}</div> : null}
          {loadError !== undefined ? (
            <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">{t("Failed to load plugins:")}{" "}{formatPluginError(loadError)}
            </div>
          ) : isLoading ? (
            <div role="status" className="rounded-xl border p-8 text-sm text-muted-foreground">{t("Loading plugins...")}</div>
          ) : plugins.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <PuzzleIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("No plugins available")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("Refresh to check for available plugins.")}</p>
            </div>
          ) : visible.length === 0 ? (
            <div role="status" className="rounded-xl border border-dashed p-10 text-center">
              <p className="text-sm font-medium">{t("No plugins match your search")}</p>
              <Button variant="link" onClick={() => setSearch("")}>{t("Clear search")}</Button>
            </div>
          ) : (
            <section aria-label={t("Plugins")} className="grid gap-3">
              {visible.map(item => <PluginCard key={item.id} item={item} {...actions} />)}
            </section>
          )}
        </div>
      </ScrollArea>
    </main>
  );
}

function needsRestart(installation: DashboardPluginInstallation | null | undefined): boolean {
  return installation != null && ["enable", "disable", "upgrade", "rollback"].includes(installation.pendingAction);
}

function PluginCard({ item, ...actions }: PluginActions & { readonly item: DashboardPluginMarketplaceSummary }) {
  const { t } = useTranslation();
  const installation = item.installation ?? undefined;
  const release = item.latestRelease;
  const selected = installation?.desiredState === "enabled";
  const active = installation?.activeState === "enabled";
  const action = marketplaceReleaseAction(release, installation);
  const busy = actions.pendingPluginId !== undefined;
  const pending = needsRestart(installation);
  const failure = item.latestLoadError || installation?.lastError || release.validationError;
  const version = installation?.activeVersion ?? installation?.desiredVersion ?? item.latestVersion;
  // Turning on restores the selected release; upgrades remain an explicit action.
  const enableVersion = installation?.desiredVersion ?? release.version;
  const canEnable = release.validationStatus === "valid" && actions.onEnablePlugin !== undefined;
  const updateAction = action === "upgrade" || action === "rollback";

  return (
    <article className="rounded-xl border bg-card px-5 py-5 shadow-xs transition-colors hover:border-foreground/20">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/30 text-muted-foreground">
          <PuzzleIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{item.displayName}</h2>
            <Badge variant="outline" className={active ? "border-emerald-600/15 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
              {active ? t("Running") : installation ? t("Disabled") : t("Not installed")}
            </Badge>
            {pending ? <Badge variant="secondary">{t(installation!.pendingAction!)}{" "}{t("pending restart")}</Badge> : null}
            {installation?.pendingAction === "activation_failed" ? <Badge variant="destructive">{t("Activation failed")}</Badge> : null}
            {release.validationStatus === "invalid" ? <Badge variant="destructive">{t("invalid")}</Badge> : null}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.id}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">v{version}</span>
            {version !== item.latestVersion ? <span>{t("Latest v")}{item.latestVersion}</span> : null}
            {pending && installation?.desiredVersion && installation.desiredVersion !== version ? <span>{t("Selected v")}{installation.desiredVersion}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch aria-label={`${selected ? t("Disable") : t("Enable")} ${item.displayName}`} checked={selected}
            disabled={busy || (selected ? actions.onDisablePlugin === undefined : !canEnable)}
            onCheckedChange={checked => checked ? actions.onEnablePlugin?.(item.id, enableVersion) : actions.onDisablePlugin?.(item.id)} />
          {updateAction ? (
            <Button size="sm" disabled={busy || release.validationStatus !== "valid" || (action === "upgrade" ? actions.onUpgradePlugin === undefined : actions.onRollbackPlugin === undefined)}
              onClick={() => action === "upgrade" ? actions.onUpgradePlugin?.(item.id, release.version) : actions.onRollbackPlugin?.(item.id, release.version)}>
              {action === "upgrade" ? t("Upgrade") : t("Rollback")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" asChild>
            <a href={`/platform/plugins/${encodeURIComponent(item.id)}`} aria-label={`${t("Details for")} ${item.displayName}`}>{t("Details")}<ChevronRightIcon className="size-3.5" />
            </a>
          </Button>
          {actions.pendingPluginId === item.id ? <span role="status" className="text-xs text-muted-foreground">{t("Saving...")}</span> : null}
        </div>
      </div>
      {failure ? <p role="alert" className="mt-4 rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{failure}</p> : null}
    </article>
  );
}

function marketplaceReleaseAction(
  release: DashboardPluginRelease,
  installation: DashboardPluginInstallation | undefined,
): "enable" | "disable" | "upgrade" | "rollback" {
  if (installation?.desiredState !== "enabled") {
    return "enable";
  }
  if (installation.desiredVersion === release.version) {
    return "disable";
  }
  const baseline = installation.desiredVersion ?? installation.activeVersion;
  return compareVersions(release.version, baseline) < 0 ? "rollback" : "upgrade";
}

function compareVersions(left: string, right: string | undefined): number {
  if (right === undefined) {
    return 1;
  }
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => {
    const parsed = Number(part.replace(/[^0-9].*$/, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function formatPluginError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "unknown error";
}

export function PluginDetailDashboard({
  onDisablePlugin,
  onEnablePlugin,
  onRollbackPlugin,
  onUpgradePlugin,
  plugin,
}: {
  readonly onDisablePlugin?: (pluginId: string) => void;
  readonly onEnablePlugin?: (pluginId: string, version: string) => void;
  readonly onRollbackPlugin?: (pluginId: string, version: string) => void;
  readonly onUpgradePlugin?: (pluginId: string, version: string) => void;
  readonly plugin: DashboardPlugin | undefined;
}) {
  const { t } = useTranslation();
  const marketplaceVersions = useMemo(
    () => (plugin?.marketplaceVersions ?? []).toSorted((left, right) =>
      compareVersions(right.version, left.version)
    ),
    [plugin?.marketplaceVersions],
  );
  const initialVersion = marketplaceVersions[0]?.version ?? plugin?.version ?? "";
  const [selectedVersionState, setSelectedVersion] = useState(initialVersion);
  const [selectedTab, setSelectedTab] = useState<ContributionTab>("operations");

  if (plugin === undefined) {
    return (
      <main className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="p-5 text-sm text-muted-foreground">{t("Loading plugin...")}</div>
      </main>
    );
  }

  const selectedVersion = marketplaceVersions.some((release) =>
      release.version === selectedVersionState
    )
    ? selectedVersionState
    : initialVersion;
  const selectedRelease = marketplaceVersions.find((release) =>
    release.version === selectedVersion
  );
  const selectedManifest = selectedRelease?.manifest ??
    (selectedVersion === plugin.version ? plugin : undefined);
  const contributionSource = selectedManifest ?? emptyPluginVersion(plugin, selectedVersion);
  const selectedManifestMissing = selectedRelease !== undefined &&
    selectedRelease.manifest === undefined &&
    selectedVersion !== plugin.version;
  const latestVersion = marketplaceVersions[0]?.version ?? plugin.version;
  const activeVersion = plugin.installation?.activeVersion;
  const desiredVersion = plugin.installation?.desiredVersion;
  const pendingAction = plugin.installation?.pendingAction;
  const stableDisplayName = plugin.displayName;

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <BlocksIcon className="size-4" />
          {plugin.source} plugin
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{stableDisplayName}</h1>
          <Badge variant={plugin.status === "disabled" ? "secondary" : "outline"}>
            {plugin.status ?? "enabled"}
          </Badge>
          <Badge variant="outline">{t("latest")}{" "}{latestVersion}</Badge>
          {activeVersion ? (
            <Badge variant="secondary">{t("active")}{" "}{activeVersion}</Badge>
          ) : null}
        </div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          {plugin.id}
        </div>
        {plugin.installation ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{t("desired")}{" "}{t(plugin.installation.desiredState)} {desiredVersion ?? ""}
            </span>
            <span>{t("active")}{" "}{t(plugin.installation.activeState)} {activeVersion ?? ""}
            </span>
            <span>{t("pending")}{" "}{pendingAction}</span>
          </div>
        ) : null}
        {plugin.latestLoadError ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {plugin.latestLoadError}
          </div>
        ) : null}
      </header>
      <section
        className="flex gap-2 overflow-x-auto border-b px-5 py-3"
        data-testid="plugin-version-strip"
      >
        <div className="flex shrink-0 items-center pr-1 text-xs font-medium text-muted-foreground">{t("Versions")}</div>
        {marketplaceVersions.map((release) => {
          const selected = release.version === selectedVersion;
          const desired = plugin.installation?.desiredState === "enabled" &&
            plugin.installation.desiredVersion === release.version;
          const active = plugin.installation?.activeState === "enabled" &&
            plugin.installation.activeVersion === release.version;
          const invalid = release.validationStatus === "invalid";
          return (
            <button
              key={release.id}
              className={`flex shrink-0 items-center rounded-full border px-3 py-1.5 text-xs transition-colors ${
                selected
                  ? "bg-muted text-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted/50"
              } ${active ? "ring-1 ring-primary/35" : ""} ${
                desired ? "border-foreground/30" : ""
              } ${invalid ? "border-destructive/60 text-destructive" : ""}`}
              data-testid={`plugin-version-${release.version}`}
              type="button"
              onClick={() => setSelectedVersion(release.version)}
            >
              <span className="font-mono font-medium">{release.version}</span>
            </button>
          );
        })}
      </section>
      <section className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="text-xs text-muted-foreground">{t("Viewing version")}{" "}
          <span className="font-mono text-foreground">{selectedVersion}</span>
          {activeVersion && activeVersion !== selectedVersion ? (
            <>
              {" "}{t("· active version is")}{" "}
              <span className="font-mono text-foreground">{activeVersion}</span>
            </>
          ) : null}
        </div>
        <VersionActionButton
          action={selectedVersionAction(selectedRelease, plugin.installation)}
          disabled={selectedRelease?.validationStatus !== "valid"}
          onDisablePlugin={onDisablePlugin}
          onEnablePlugin={onEnablePlugin}
          onRollbackPlugin={onRollbackPlugin}
          onUpgradePlugin={onUpgradePlugin}
          pluginId={plugin.id}
          version={selectedVersion}
        />
      </section>
      {selectedRelease?.validationError ? (
        <div className="border-b px-5 py-3 text-xs text-destructive">
          {selectedRelease.validationError}
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <section className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid min-w-0 gap-5">
            {selectedManifestMissing ? (
              <div className="rounded-md border border-muted bg-muted/20 p-4 text-sm text-muted-foreground">{t("No manifest details available for this version.")}</div>
            ) : null}
            <ContributionTabs
              plugin={contributionSource}
              selectedTab={selectedTab}
              onSelectTab={setSelectedTab}
            />
          </div>
          <aside className="grid h-fit gap-4">
            <SelectedVersionPermissionsPanel plugin={contributionSource} />
          </aside>
        </section>
      </ScrollArea>
    </main>
  );
}

function selectedVersionAction(
  release: DashboardPluginRelease | undefined,
  installation: DashboardPluginInstallation | null | undefined,
): "enable" | "disable" | "upgrade" | "rollback" | "invalid" {
  if (release?.validationStatus === "invalid") {
    return "invalid";
  }
  if (installation?.desiredState !== "enabled") {
    return "enable";
  }
  if (installation.desiredVersion === release?.version) {
    return "disable";
  }
  const baseline = installation.desiredVersion ?? installation.activeVersion;
  return compareVersions(release?.version ?? "", baseline) < 0
    ? "rollback"
    : "upgrade";
}

function VersionActionButton({
  action,
  disabled,
  onDisablePlugin,
  onEnablePlugin,
  onRollbackPlugin,
  onUpgradePlugin,
  pluginId,
  version,
}: {
  readonly action: "enable" | "disable" | "upgrade" | "rollback" | "invalid";
  readonly disabled: boolean;
  readonly onDisablePlugin?: (pluginId: string) => void;
  readonly onEnablePlugin?: (pluginId: string, version: string) => void;
  readonly onRollbackPlugin?: (pluginId: string, version: string) => void;
  readonly onUpgradePlugin?: (pluginId: string, version: string) => void;
  readonly pluginId: string;
  readonly version: string;
}) {
  const { t } = useTranslation();
  if (action === "invalid") {
    return (
      <Button disabled size="sm" variant="outline">{t("Unavailable")}</Button>
    );
  }
  if (action === "disable") {
    return (
      <Button
        disabled={onDisablePlugin === undefined}
        size="sm"
        variant="outline"
        onClick={() => onDisablePlugin?.(pluginId)}
      >{t("Disable")}</Button>
    );
  }
  if (action === "rollback") {
    return (
      <Button
        disabled={disabled || onRollbackPlugin === undefined}
        size="sm"
        variant="outline"
        onClick={() => onRollbackPlugin?.(pluginId, version)}
      >{t("Rollback to this version")}</Button>
    );
  }
  if (action === "upgrade") {
    return (
      <Button
        disabled={disabled || onUpgradePlugin === undefined}
        size="sm"
        onClick={() => onUpgradePlugin?.(pluginId, version)}
      >{t("Upgrade to this version")}</Button>
    );
  }
  return (
    <Button
      disabled={disabled || onEnablePlugin === undefined}
      size="sm"
      onClick={() => onEnablePlugin?.(pluginId, version)}
    >{t("Enable this version")}</Button>
  );
}

function emptyPluginVersion(
  plugin: DashboardPlugin,
  version: string,
): DashboardPlugin {
  return {
    id: plugin.id,
    displayName: plugin.displayName,
    version,
    source: plugin.source,
    requestedHostPermissions: [],
    operations: [],
    commands: [],
    tools: [],
    skills: [],
  };
}

function VersionListPanel({
  installation,
  onSelectVersion,
  releases,
  selectedVersion,
}: {
  readonly installation: DashboardPluginInstallation | null | undefined;
  readonly onSelectVersion: (version: string) => void;
  readonly releases: readonly DashboardPluginRelease[];
  readonly selectedVersion: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border p-4">
      <h2 className="text-sm font-medium">{t("Versions")}</h2>
      <div className="mt-3 grid gap-2">
        {releases.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t("No marketplace versions indexed.")}</div>
        ) : (
          releases.map((release) => {
            const selected = release.version === selectedVersion;
            const desired = installation?.desiredState === "enabled" &&
              installation.desiredVersion === release.version;
            const active = installation?.activeState === "enabled" &&
              installation.activeVersion === release.version;
            return (
              <button
                key={release.id}
                className={`grid gap-2 rounded-md border p-3 text-left text-xs transition-colors ${
                  selected ? "bg-muted text-foreground" : "bg-background hover:bg-muted/50"
                }`}
                data-testid={`plugin-version-${release.version}`}
                type="button"
                onClick={() => onSelectVersion(release.version)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{release.version}</span>
                  <Badge
                    variant={release.validationStatus === "valid"
                      ? "outline"
                      : "destructive"}
                  >
                    {release.validationStatus}
                  </Badge>
                  {selected ? <Badge variant="secondary">{t("selected")}</Badge> : null}
                  {desired ? <Badge variant="secondary">{t("desired")}</Badge> : null}
                  {active ? <Badge variant="outline">{t("active")}</Badge> : null}
                </div>
                <div className="break-all text-muted-foreground">
                  {release.releasePath}
                </div>
                {release.validationError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                    {release.validationError}
                  </div>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function SelectedVersionPermissionsPanel({
  plugin,
}: {
  readonly plugin: DashboardPlugin;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <PuzzleIcon className="size-4" />{t("Selected version permissions")}</h2>
      <div className="mt-3 grid gap-3 text-sm">
        <div>
          <div className="text-xs font-medium text-muted-foreground">{t("Host permissions")}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {plugin.requestedHostPermissions.length === 0 ? (
              <span className="text-xs text-muted-foreground">{t("None")}</span>
            ) : (
              plugin.requestedHostPermissions.map((permission) => (
                <Badge key={permission} variant="secondary">
                  {permission}
                </Badge>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type ContributionTab = "operations" | "commands" | "tools" | "skills";

function ContributionTabs({
  onSelectTab,
  plugin,
  selectedTab,
}: {
  readonly onSelectTab: (tab: ContributionTab) => void;
  readonly plugin: DashboardPlugin;
  readonly selectedTab: ContributionTab;
}) {
  const tabs: readonly { id: ContributionTab; label: string; count: number }[] = [
    {
      id: "operations",
      label: "Operations",
      count: plugin.operations?.length ?? 0,
    },
    {
      id: "commands",
      label: "Commands",
      count: plugin.commands?.length ?? 0,
    },
    {
      id: "tools",
      label: "Tools",
      count: plugin.tools?.length ?? 0,
    },
    {
      id: "skills",
      label: "Skills",
      count: plugin.skills?.length ?? 0,
    },
  ];
  return (
    <section className="rounded-md border">
      <div className="flex flex-wrap gap-1 border-b p-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
              selectedTab === tab.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            data-testid={`plugin-tab-${tab.id}`}
            type="button"
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label} <span className="font-mono">{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="p-3">
        <ContributionTabContent plugin={plugin} selectedTab={selectedTab} />
      </div>
    </section>
  );
}

function ContributionTabContent({
  plugin,
  selectedTab,
}: {
  readonly plugin: DashboardPlugin;
  readonly selectedTab: ContributionTab;
}) {
  const { t } = useTranslation();
  if (selectedTab === "operations") {
    return (
      <ContributionList
        emptyText={t("No operations contributed.")}
        values={(plugin.operations ?? []).map((operation) => ({
          key: operation.id,
          title: operation.title ?? operation.id,
          description: operation.description ?? operation.id,
          meta: [
            operation.riskLevel,
            operation.artifactPolicy,
          ].filter(Boolean).join(" · "),
        }))}
      />
    );
  }
  if (selectedTab === "commands") {
    return (
      <ContributionList
        emptyText={t("No commands contributed.")}
        values={(plugin.commands ?? []).map((command) => ({
          key: command.path.join(" "),
          title: command.path.join(" "),
          description: command.help ?? command.operationId,
          meta: command.operationId,
        }))}
      />
    );
  }
  if (selectedTab === "tools") {
    return (
      <ContributionList
        emptyText={t("No runner tools contributed.")}
        values={(plugin.tools ?? []).map((tool) => ({
          key: tool.name,
          title: tool.name,
          description: tool.description ?? tool.operationId,
          meta: tool.operationId,
        }))}
      />
    );
  }
  return (
    <ContributionList
      emptyText={t("No skills contributed.")}
      values={(plugin.skills ?? []).map((skill) => ({
        key: skill.id,
        title: skill.title ?? skill.id,
        description: skill.description ?? skill.path ?? skill.id,
        meta: skill.path,
      }))}
    />
  );
}

function ContributionList({
  emptyText,
  values,
}: {
  readonly emptyText: string;
  readonly values: readonly {
    key: string;
    title: string;
    description: string;
    meta?: string;
  }[];
}) {
  return (
    <div className="grid gap-2">
      {values.length === 0 ? (
        <div className="text-sm text-muted-foreground"><UiText>{emptyText}</UiText></div>
      ) : (
        values.map((item) => (
          <div key={item.key} className="min-w-0 rounded-md border bg-muted/20 p-3">
            <div className="break-all font-mono text-xs font-medium">
              {item.title}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {item.description}
            </div>
            {item.meta ? (
              <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                {item.meta}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
