import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, CopyIcon, ShieldCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client";
import { copyTextToClipboard } from "@/lib/clipboard";

export interface OrphanCleanup {
  enabled: boolean;
  intervalMinutes: number;
  retentionDays: number;
}

export interface FeishuAuthSettings {
  enabled: boolean;
  configured: boolean;
  source: "database" | "environment" | "none";
  appId: string;
  hasSecret: boolean;
  secretUnreadable: boolean;
  feishuHost: string;
  publicBaseUrl: string;
}

export interface FeishuAuthUpdate {
  enabled: boolean;
  appId: string;
  appSecret?: string;
  feishuHost: string;
}

export interface PlatformGeneralSettings {
  publicBaseUrl: string;
  timezone: string;
  artifactSignedUrlTtlMs: number;
}

export interface PlatformExecutionSettings {
  containerTimeoutMs: number;
  taskTimeoutMs: number;
  maxTransientRetries: number;
}

export interface PlatformMemorySettings {
  reflectionIdleMs: number;
  consolidationIntervalMs: number;
  forgetUnusedMs: number;
  episodeRetentionMs: number;
  recallLimit: number;
  coreLimit: number;
  shadowCoreLimit: number;
  personaLimit: number;
}

export interface PlatformMarketplaceSettings {
  gitUrl: string;
  branch: string;
}

export interface PlatformMessagingSettings {
  maxVisibleSteps: number;
  feishuDevelopers: Record<string, string>;
}

export interface QuietHoursWindow {
  start: string;
  end: string;
}

export interface PlatformProactivitySettings {
  heartbeatIntervalMs: number;
  outboundPerSessionPerHour: number;
  outboundPerRecipientPerDay: number;
  outboundDedupWindowMs: number;
  quietHours: QuietHoursWindow | null;
  askDefaultExpiresMs: number;
  scheduleFailureNotifyIntervalMs: number;
}

export interface PlatformRuntimeSettings {
  general: PlatformGeneralSettings;
  execution: PlatformExecutionSettings;
  memory: PlatformMemorySettings;
  marketplace: PlatformMarketplaceSettings;
  messaging: PlatformMessagingSettings;
  proactivity?: PlatformProactivitySettings;
}

export interface PlatformRuntimeSettingsPatch {
  general?: Partial<PlatformGeneralSettings>;
  execution?: Partial<PlatformExecutionSettings>;
  memory?: Partial<PlatformMemorySettings>;
  marketplace?: Partial<PlatformMarketplaceSettings>;
  messaging?: Partial<PlatformMessagingSettings>;
  proactivity?: Partial<PlatformProactivitySettings>;
}

const DEFAULT_PLATFORM_PROACTIVITY: PlatformProactivitySettings = {
  heartbeatIntervalMs: 30 * 60_000,
  outboundPerSessionPerHour: 3,
  outboundPerRecipientPerDay: 10,
  outboundDedupWindowMs: 24 * 3_600_000,
  quietHours: null,
  askDefaultExpiresMs: 120 * 60_000,
  scheduleFailureNotifyIntervalMs: 24 * 3_600_000,
};

interface PlatformSettings {
  platform: PlatformRuntimeSettings;
  orphanCleanup: OrphanCleanup;
  feishuAuth: FeishuAuthSettings;
  canEdit: boolean;
}

const PATH = "/platform-settings";
const DEFAULT_FEISHU_HOST = "https://open.feishu.cn";

function isValidRootUrl(raw: string): boolean {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return parsed.pathname === "/" || parsed.pathname === "";
  } catch {
    return false;
  }
}

function isValidTimezone(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

function intInRange(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

function formatDeveloperMap(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([appId, devId]) => `${appId}=${devId}`)
    .join("\n");
}

function parseDeveloperMap(text: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) return null;
    const appId = line.slice(0, eqIndex).trim();
    const developerId = line.slice(eqIndex + 1).trim();
    if (!appId || !developerId || appId.length > 128 || developerId.length > 128) {
      return null;
    }
    result[appId] = developerId;
  }
  return result;
}

/** Platform-wide settings; every account sees them, platform administrators change them. */
export function PlatformSettingsPage() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [PATH],
    queryFn: ({ signal }) => apiFetch<PlatformSettings>(PATH, { signal }),
  });
  const usePatchSection = () =>
    useMutation({
      mutationFn: (patch: PlatformRuntimeSettingsPatch) =>
        apiFetch<{ platform: PlatformRuntimeSettings; feishuAuth: FeishuAuthSettings }>(PATH, {
          method: "PUT",
          body: JSON.stringify(patch),
        }),
      onSuccess: () => client.invalidateQueries({ queryKey: [PATH] }),
    });
  const saveGeneral = usePatchSection();
  const saveMarketplace = usePatchSection();
  const saveExecution = usePatchSection();
  const saveMemory = usePatchSection();
  const saveProactivity = usePatchSection();
  const saveMessaging = usePatchSection();
  const saveOrphan = useMutation({
    mutationFn: (value: OrphanCleanup) =>
      apiFetch<{ orphanCleanup: OrphanCleanup }>(`${PATH}/orphan-cleanup`, {
        method: "PUT",
        body: JSON.stringify(value),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: [PATH] }),
  });
  const saveFeishu = useMutation({
    mutationFn: (value: FeishuAuthUpdate) =>
      apiFetch<{ feishuAuth: FeishuAuthSettings }>(`${PATH}/feishu-auth`, {
        method: "PUT",
        body: JSON.stringify(value),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: [PATH] }),
  });
  const clearFeishu = useMutation({
    mutationFn: () =>
      apiFetch<{ feishuAuth: FeishuAuthSettings }>(`${PATH}/feishu-auth`, {
        method: "DELETE",
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: [PATH] }),
  });

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">设置</h1>
        <p className="text-muted-foreground">对整个平台生效，保存后立即生效，无需重启服务。</p>
      </div>
      {query.error && (
        <p role="alert" className="text-destructive">
          无法加载设置。{query.error.message}
        </p>
      )}
      {query.isLoading && <p role="status">正在加载…</p>}
      {query.data && (
        <>
          {query.data.canEdit && (
            <section
              className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              aria-labelledby="platform-accounts-entry-title"
              data-testid="platform-accounts-entry-card"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <ShieldCheckIcon className="size-4 text-muted-foreground" />
                  <h2 id="platform-accounts-entry-title" className="font-medium">
                    账号与管理员
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  查看所有登录过平台的飞书账号与内置超级管理员，授予或撤销平台管理员权限，或停用、删除账号。
                </p>
              </div>
              <Button asChild variant="outline" className="shrink-0">
                <a href="/platform/accounts" data-testid="platform-accounts-entry-link">
                  <span>进入账号管理</span>
                  <ArrowRightIcon className="size-4" />
                </a>
              </Button>
            </section>
          )}
          <GeneralSettingsForm
            key={JSON.stringify(query.data.platform.general)}
            settings={query.data.platform.general}
            canEdit={query.data.canEdit}
            saving={saveGeneral.isPending}
            error={saveGeneral.error}
            saved={saveGeneral.isSuccess}
            onSave={(general) => saveGeneral.mutate({ general })}
          />
          <FeishuAuthForm
            key={JSON.stringify(query.data.feishuAuth)}
            settings={query.data.feishuAuth}
            publicBaseUrl={query.data.platform.general.publicBaseUrl}
            canEdit={query.data.canEdit}
            saving={saveFeishu.isPending}
            clearing={clearFeishu.isPending}
            error={saveFeishu.error ?? clearFeishu.error}
            saved={saveFeishu.isSuccess || clearFeishu.isSuccess}
            onSave={(value) => {
              clearFeishu.reset();
              saveFeishu.mutate(value);
            }}
            onClear={() => {
              saveFeishu.reset();
              clearFeishu.mutate();
            }}
          />
          <MarketplaceSettingsForm
            key={JSON.stringify(query.data.platform.marketplace)}
            settings={query.data.platform.marketplace}
            canEdit={query.data.canEdit}
            saving={saveMarketplace.isPending}
            error={saveMarketplace.error}
            saved={saveMarketplace.isSuccess}
            onSave={(marketplace) => saveMarketplace.mutate({ marketplace })}
          />
          <ExecutionSettingsForm
            key={JSON.stringify(query.data.platform.execution)}
            settings={query.data.platform.execution}
            canEdit={query.data.canEdit}
            saving={saveExecution.isPending}
            error={saveExecution.error}
            saved={saveExecution.isSuccess}
            onSave={(execution) => saveExecution.mutate({ execution })}
          />
          <MemorySettingsForm
            key={JSON.stringify(query.data.platform.memory)}
            settings={query.data.platform.memory}
            canEdit={query.data.canEdit}
            saving={saveMemory.isPending}
            error={saveMemory.error}
            saved={saveMemory.isSuccess}
            onSave={(memory) => saveMemory.mutate({ memory })}
          />
          <ProactivitySettingsForm
            key={JSON.stringify(query.data.platform.proactivity ?? DEFAULT_PLATFORM_PROACTIVITY)}
            settings={query.data.platform.proactivity ?? DEFAULT_PLATFORM_PROACTIVITY}
            canEdit={query.data.canEdit}
            saving={saveProactivity.isPending}
            error={saveProactivity.error}
            saved={saveProactivity.isSuccess}
            onSave={(proactivity) => saveProactivity.mutate({ proactivity })}
          />
          <FeishuMessagingSettingsForm
            key={JSON.stringify(query.data.platform.messaging)}
            settings={query.data.platform.messaging}
            canEdit={query.data.canEdit}
            saving={saveMessaging.isPending}
            error={saveMessaging.error}
            saved={saveMessaging.isSuccess}
            onSave={(messaging) => saveMessaging.mutate({ messaging })}
          />
          <OrphanCleanupForm
            key={JSON.stringify(query.data.orphanCleanup)}
            settings={query.data.orphanCleanup}
            canEdit={query.data.canEdit}
            saving={saveOrphan.isPending}
            error={saveOrphan.error}
            saved={saveOrphan.isSuccess}
            onSave={(value) => saveOrphan.mutate(value)}
          />
        </>
      )}
    </main>
  );
}

export function GeneralSettingsForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: PlatformGeneralSettings;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: PlatformGeneralSettings) => void;
}) {
  const [publicBaseUrl, setPublicBaseUrl] = useState(settings.publicBaseUrl);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [artifactTtlHours, setArtifactTtlHours] = useState(
    String(Math.max(1, Math.round(settings.artifactSignedUrlTtlMs / 3_600_000))),
  );
  const [touched, setTouched] = useState(false);

  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8090";
  const urlValid = isValidRootUrl(publicBaseUrl);
  const tzValid = isValidTimezone(timezone);
  const parsedTtlHours = intInRange(artifactTtlHours, 1, 8760);
  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="platform-general-title"
      data-testid="platform-general-settings-card"
    >
      <div className="space-y-1">
        <h2 id="platform-general-title" className="font-medium">
          常规与对外访问
        </h2>
        <p className="text-sm text-muted-foreground">
          设置平台对外访问根地址（用于飞书消息附件预览链接、飞书 OAuth 登录回调）、产物签名链接有效期与 Runner 默认时区。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">对外访问地址</span>
          <Input
            value={publicBaseUrl}
            disabled={disabled}
            placeholder={currentOrigin}
            aria-invalid={!urlValid}
            data-testid="platform-public-base-url"
            onChange={(event) => edit(setPublicBaseUrl)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            填写飞书客户端与浏览器可访问的 http(s) 根地址（如 https://luna.example.com 或 http://10.37.108.127:8090）。
            {canEdit && !publicBaseUrl.trim() && (
              <>
                {" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={() => edit(setPublicBaseUrl)(currentOrigin)}
                >
                  填入当前地址
                </button>
              </>
            )}
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">默认时区</span>
          <Input
            value={timezone}
            disabled={disabled}
            placeholder="Asia/Shanghai"
            aria-invalid={!tzValid}
            data-testid="platform-timezone"
            onChange={(event) => edit(setTimezone)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            IANA 时区名称（如 Asia/Shanghai、Asia/Singapore、UTC），用于会话与任务时间信封。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">产物签名链接有效期（小时）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={8760}
            value={artifactTtlHours}
            disabled={disabled}
            aria-invalid={parsedTtlHours === null}
            data-testid="platform-artifact-signed-url-ttl-hours"
            onChange={(event) => edit(setArtifactTtlHours)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            1～8760 小时（最长 365 天），默认 2 小时（如 24 = 1 天，168 = 7 天）。
          </span>
        </label>
      </div>
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={urlValid && tzValid && parsedTtlHours !== null}
        error={error}
        saved={saved}
        testId="platform-general-save"
        onSave={() =>
          onSave({
            publicBaseUrl: publicBaseUrl.trim().replace(/\/+$/, ""),
            timezone: timezone.trim(),
            artifactSignedUrlTtlMs: parsedTtlHours! * 3_600_000,
          })
        }
      />
    </section>
  );
}

export function FeishuAuthForm({
  settings,
  publicBaseUrl = "",
  canEdit,
  saving,
  clearing,
  error,
  saved,
  onSave,
  onClear,
}: {
  readonly settings: FeishuAuthSettings;
  readonly publicBaseUrl?: string;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly clearing: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: FeishuAuthUpdate) => void;
  readonly onClear: () => void;
}) {
  const [enabled, setEnabled] = useState(
    settings.source === "none" ? true : settings.enabled,
  );
  const [appId, setAppId] = useState(settings.appId);
  const [appSecret, setAppSecret] = useState("");
  const [feishuHost, setFeishuHost] = useState(
    settings.feishuHost || DEFAULT_FEISHU_HOST,
  );
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);

  const busy = saving || clearing;
  const disabled = !canEdit || busy;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8090";
  const effectiveOrigin = (
    publicBaseUrl.trim() ||
    settings.publicBaseUrl.trim() ||
    currentOrigin
  ).replace(/\/+$/, "");
  const callbackUrl = `${effectiveOrigin}/api/auth/feishu/callback`;

  const canReuseStoredSecret =
    settings.source === "database" &&
    settings.hasSecret &&
    !settings.secretUnreadable &&
    appId.trim() === settings.appId;
  const secretValid = appSecret.trim().length > 0 || canReuseStoredSecret;
  const appIdValid = appId.trim().length > 0;
  const hostValid = feishuHost.trim().startsWith("http://") || feishuHost.trim().startsWith("https://");
  const formValid = appIdValid && secretValid && hostValid;

  const statusBadge = (() => {
    if (settings.secretUnreadable) {
      return { label: "密钥不可读", className: "bg-destructive/10 text-destructive border-destructive/30" };
    }
    if (settings.enabled) {
      return {
        label: settings.source === "environment" ? "已启用（环境变量）" : "已启用",
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
      };
    }
    if (settings.configured) {
      return { label: "已停用", className: "bg-muted text-muted-foreground border-border" };
    }
    return { label: "未配置", className: "bg-muted text-muted-foreground border-border" };
  })();

  const handleCopyCallback = async () => {
    const ok = await copyTextToClipboard(callbackUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="feishu-auth-title"
      data-testid="feishu-auth-settings-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="feishu-auth-title" className="font-medium">
              飞书登录
            </h2>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge.className}`}
              data-testid="feishu-auth-status-badge"
            >
              {statusBadge.label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            配置飞书网页应用 OAuth 凭据，启用后成员可在登录页使用飞书账号一键登录 Dashboard。
          </p>
        </div>
        <Switch
          aria-label="启用飞书登录"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={edit(setEnabled)}
        />
      </div>

      {settings.secretUnreadable && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          已保存的 App Secret 无法用当前主密钥解密，飞书登录已暂停。请重新输入 App Secret 并保存。
        </p>
      )}

      <div className="space-y-1 rounded-md bg-muted/50 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">飞书后台重定向 URL（网页安全设置）</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => void handleCopyCallback()}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            <span>{copied ? "已复制" : "复制"}</span>
          </Button>
        </div>
        <code className="block break-all text-xs text-muted-foreground" data-testid="feishu-auth-callback-url">
          {callbackUrl}
        </code>
        <span className="block text-xs text-muted-foreground">
          请在飞书开放平台应用的「安全设置 → 重定向 URL」中添加上述完整地址（可在上方「常规与对外访问」修改根地址）。
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">App ID</span>
          <Input
            value={appId}
            disabled={disabled}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            data-testid="feishu-auth-app-id"
            onChange={(event) => edit(setAppId)(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">App Secret</span>
          <Input
            type="password"
            autoComplete="new-password"
            value={appSecret}
            disabled={disabled}
            placeholder={canReuseStoredSecret ? "已加密保存，留空保持不变" : "输入飞书应用 App Secret"}
            data-testid="feishu-auth-app-secret"
            onChange={(event) => edit(setAppSecret)(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">飞书开放平台地址</span>
          <Input
            value={feishuHost}
            disabled={disabled}
            placeholder={DEFAULT_FEISHU_HOST}
            data-testid="feishu-auth-host"
            onChange={(event) => edit(setFeishuHost)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            飞书默认 {DEFAULT_FEISHU_HOST}，Lark 国际版可填 https://open.larksuite.com。
          </span>
        </label>
      </div>

      {!canEdit && (
        <p className="text-sm text-muted-foreground">只有平台管理员可以修改。</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          保存失败。{error.message}
        </p>
      )}
      {saved && !touched && (
        <p role="status" className="text-sm text-muted-foreground">
          已保存。
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="feishu-auth-save"
            disabled={busy || !touched || !formValid}
            onClick={() =>
              onSave({
                enabled,
                appId: appId.trim(),
                ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
                feishuHost: feishuHost.trim(),
              })
            }
          >
            {saving ? "正在验证并保存…" : "保存飞书登录设置"}
          </Button>
          {settings.source === "database" && (
            <Button
              type="button"
              variant="outline"
              data-testid="feishu-auth-clear"
              disabled={busy}
              onClick={onClear}
            >
              {clearing ? "正在清除…" : "清除数据库配置"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function MarketplaceSettingsForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: PlatformMarketplaceSettings;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: PlatformMarketplaceSettings) => void;
}) {
  const [gitUrl, setGitUrl] = useState(settings.gitUrl);
  const [branch, setBranch] = useState(settings.branch);
  const [touched, setTouched] = useState(false);

  const disabled = !canEdit || saving;
  const branchValid = branch.trim().length > 0 && branch.trim().length <= 256;
  const urlValid = gitUrl.trim().length <= 2048;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="platform-marketplace-title"
      data-testid="platform-marketplace-settings-card"
    >
      <div className="space-y-1">
        <h2 id="platform-marketplace-title" className="font-medium">
          插件市场源
        </h2>
        <p className="text-sm text-muted-foreground">
          配置受信任插件市场的 Git 仓库地址与分支；保存后可直接在「插件管理」页面刷新和安装插件。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Git 仓库地址</span>
          <Input
            value={gitUrl}
            disabled={disabled}
            placeholder="https://git.example.com/luna-plugins.git"
            aria-invalid={!urlValid}
            data-testid="platform-marketplace-git-url"
            onChange={(event) => edit(setGitUrl)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            支持 HTTPS 或 SSH Git 地址；留空表示未配置插件源。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">分支</span>
          <Input
            value={branch}
            disabled={disabled}
            placeholder="main"
            aria-invalid={!branchValid}
            data-testid="platform-marketplace-branch"
            onChange={(event) => edit(setBranch)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">默认 main。</span>
        </label>
      </div>
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={urlValid && branchValid}
        error={error}
        saved={saved}
        testId="platform-marketplace-save"
        onSave={() =>
          onSave({
            gitUrl: gitUrl.trim(),
            branch: branch.trim(),
          })
        }
      />
    </section>
  );
}

export function ExecutionSettingsForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: PlatformExecutionSettings;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: PlatformExecutionSettings) => void;
}) {
  const [timeoutMin, setTimeoutMin] = useState(String(Math.round(settings.containerTimeoutMs / 60_000)));
  const [taskMin, setTaskMin] = useState(String(Math.round(settings.taskTimeoutMs / 60_000)));
  const [retries, setRetries] = useState(String(settings.maxTransientRetries));
  const [touched, setTouched] = useState(false);

  const parsedTimeoutMin = intInRange(timeoutMin, 1, 10080);
  const parsedTaskMin = intInRange(taskMin, 1, 10080);
  const parsedRetries = intInRange(retries, 0, 10);
  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="platform-execution-title"
      data-testid="platform-execution-settings-card"
    >
      <div className="space-y-1">
        <h2 id="platform-execution-title" className="font-medium">
          运行与重试
        </h2>
        <p className="text-sm text-muted-foreground">
          统一控制全平台 Main / Work 会话单轮执行超时、后台 Task 单次运行时长上限，以及模型提供方瞬时错误自动重试次数。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">会话单轮超时（分钟）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={10080}
            value={timeoutMin}
            disabled={disabled}
            aria-invalid={parsedTimeoutMin === null}
            data-testid="platform-container-timeout-minutes"
            onChange={(event) => edit(setTimeoutMin)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            Main / Work，1～10080 分钟，默认 30。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Task 单次上限（分钟）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={10080}
            value={taskMin}
            disabled={disabled}
            aria-invalid={parsedTaskMin === null}
            data-testid="platform-task-timeout-minutes"
            onChange={(event) => edit(setTaskMin)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            后台任务，1～10080 分钟，默认 600（10 小时）。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">瞬时故障最大重试次数</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={10}
            value={retries}
            disabled={disabled}
            aria-invalid={parsedRetries === null}
            data-testid="platform-max-transient-retries"
            onChange={(event) => edit(setRetries)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            0～10 次，默认 5 次。
          </span>
        </label>
      </div>
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={parsedTimeoutMin !== null && parsedTaskMin !== null && parsedRetries !== null}
        error={error}
        saved={saved}
        testId="platform-execution-save"
        onSave={() =>
          onSave({
            containerTimeoutMs: parsedTimeoutMin! * 60_000,
            taskTimeoutMs: parsedTaskMin! * 60_000,
            maxTransientRetries: parsedRetries!,
          })
        }
      />
    </section>
  );
}

export function MemorySettingsForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: PlatformMemorySettings;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: PlatformMemorySettings) => void;
}) {
  const [reflectionMin, setReflectionMin] = useState(String(Math.round(settings.reflectionIdleMs / 60_000)));
  const [consolidationHours, setConsolidationHours] = useState(String(Math.round(settings.consolidationIntervalMs / 3_600_000)));
  const [forgetDays, setForgetDays] = useState(String(Math.round(settings.forgetUnusedMs / 86_400_000)));
  const [episodeDays, setEpisodeDays] = useState(String(Math.round(settings.episodeRetentionMs / 86_400_000)));
  const [recallLimit, setRecallLimit] = useState(String(settings.recallLimit));
  const [coreLimit, setCoreLimit] = useState(String(settings.coreLimit));
  const [shadowCoreLimit, setShadowCoreLimit] = useState(String(settings.shadowCoreLimit));
  const [personaLimit, setPersonaLimit] = useState(String(settings.personaLimit));
  const [touched, setTouched] = useState(false);

  const pReflection = intInRange(reflectionMin, 0, 43200);
  const pConsolidation = intInRange(consolidationHours, 0, 8760);
  const pForget = intInRange(forgetDays, 0, 3650);
  const pEpisode = intInRange(episodeDays, 0, 3650);
  const pRecall = intInRange(recallLimit, 0, 100);
  const pCore = intInRange(coreLimit, 1, 500);
  const pShadowCore = intInRange(shadowCoreLimit, 0, 500);
  const pPersona = intInRange(personaLimit, 1, 50);

  const valid =
    pReflection !== null &&
    pConsolidation !== null &&
    pForget !== null &&
    pEpisode !== null &&
    pRecall !== null &&
    pCore !== null &&
    pShadowCore !== null &&
    pPersona !== null;

  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="platform-memory-title"
      data-testid="platform-memory-settings-card"
    >
      <div className="space-y-1">
        <h2 id="platform-memory-title" className="font-medium">
          记忆维护与配额
        </h2>
        <p className="text-sm text-muted-foreground">
          管理后台自动反思、记忆整合、过期归档周期（填 0 关闭对应后台任务）以及各类型记忆条数上限。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">会话反思静置时间（分钟）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={43200}
            value={reflectionMin}
            disabled={disabled}
            aria-invalid={pReflection === null}
            onChange={(event) => edit(setReflectionMin)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">默认 30 分钟，0 关闭自动反思。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">记忆整合最小间隔（小时）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={8760}
            value={consolidationHours}
            disabled={disabled}
            aria-invalid={pConsolidation === null}
            onChange={(event) => edit(setConsolidationHours)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">默认 24 小时，0 关闭自动整合。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">长期未读记忆归档天数（天）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={3650}
            value={forgetDays}
            disabled={disabled}
            aria-invalid={pForget === null}
            onChange={(event) => edit(setForgetDays)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">默认 180 天，0 不自动归档。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">事件时间线保留天数（天）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={3650}
            value={episodeDays}
            disabled={disabled}
            aria-invalid={pEpisode === null}
            onChange={(event) => edit(setEpisodeDays)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">默认 90 天，0 永久保留。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">单轮自动召回上限（条）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={recallLimit}
            disabled={disabled}
            aria-invalid={pRecall === null}
            onChange={(event) => edit(setRecallLimit)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">0 到 100，默认 8。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Agent 共享核心记忆上限（条）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            value={coreLimit}
            disabled={disabled}
            aria-invalid={pCore === null}
            onChange={(event) => edit(setCoreLimit)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">1 到 500，默认 30。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">分身私有核心记忆上限（条）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={500}
            value={shadowCoreLimit}
            disabled={disabled}
            aria-invalid={pShadowCore === null}
            onChange={(event) => edit(setShadowCoreLimit)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">0 到 500，默认 10。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">分身人设条数上限（条）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            value={personaLimit}
            disabled={disabled}
            aria-invalid={pPersona === null}
            onChange={(event) => edit(setPersonaLimit)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">1 到 50，默认 5。</span>
        </label>
      </div>
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={valid}
        error={error}
        saved={saved}
        testId="platform-memory-save"
        onSave={() =>
          onSave({
            reflectionIdleMs: pReflection! * 60_000,
            consolidationIntervalMs: pConsolidation! * 3_600_000,
            forgetUnusedMs: pForget! * 86_400_000,
            episodeRetentionMs: pEpisode! * 86_400_000,
            recallLimit: pRecall!,
            coreLimit: pCore!,
            shadowCoreLimit: pShadowCore!,
            personaLimit: pPersona!,
          })
        }
      />
    </section>
  );
}

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export function ProactivitySettingsForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: PlatformProactivitySettings;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: PlatformProactivitySettings) => void;
}) {
  const [heartbeatMin, setHeartbeatMin] = useState(
    String(Math.round(settings.heartbeatIntervalMs / 60_000)),
  );
  const [perSessionHour, setPerSessionHour] = useState(
    String(settings.outboundPerSessionPerHour),
  );
  const [perRecipientDay, setPerRecipientDay] = useState(
    String(settings.outboundPerRecipientPerDay),
  );
  const [dedupHours, setDedupHours] = useState(
    String(Math.round(settings.outboundDedupWindowMs / 3_600_000)),
  );
  const [askExpiresMin, setAskExpiresMin] = useState(
    String(Math.round(settings.askDefaultExpiresMs / 60_000)),
  );
  const [failNotifyHours, setFailNotifyHours] = useState(
    String(Math.round(settings.scheduleFailureNotifyIntervalMs / 3_600_000)),
  );
  const [quietEnabled, setQuietEnabled] = useState(settings.quietHours !== null);
  const [quietStart, setQuietStart] = useState(
    settings.quietHours?.start ?? "23:00",
  );
  const [quietEnd, setQuietEnd] = useState(settings.quietHours?.end ?? "08:00");
  const [touched, setTouched] = useState(false);

  const pHeartbeat = intInRange(heartbeatMin, 0, 43200);
  const pPerSession = intInRange(perSessionHour, 0, 1000);
  const pPerRecipient = intInRange(perRecipientDay, 0, 1000);
  const pDedup = intInRange(dedupHours, 0, 720);
  const pAskExpires = intInRange(askExpiresMin, 1, 43200);
  const pFailNotify = intInRange(failNotifyHours, 0, 720);
  const quietValid =
    !quietEnabled || (HHMM_REGEX.test(quietStart) && HHMM_REGEX.test(quietEnd));

  const valid =
    pHeartbeat !== null &&
    pPerSession !== null &&
    pPerRecipient !== null &&
    pDedup !== null &&
    pAskExpires !== null &&
    pFailNotify !== null &&
    quietValid;

  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="platform-proactivity-title"
      data-testid="platform-proactivity-settings-card"
    >
      <div className="space-y-1">
        <h2 id="platform-proactivity-title" className="font-medium">
          主动行为与外发调控（平台默认）
        </h2>
        <p className="text-sm text-muted-foreground">
          控制各分身自驱心跳间隔、主动消息频控/去重/免打扰窗口、提问默认超时以及定时任务失败告警冷却时间。各 Agent 可在自身设置中覆盖这些默认值。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">分身心跳间隔（分钟）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={43200}
            value={heartbeatMin}
            disabled={disabled}
            aria-invalid={pHeartbeat === null}
            data-testid="platform-heartbeat-interval-minutes"
            onChange={(event) => edit(setHeartbeatMin)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            默认 30 分钟（仅在分身有新活动时唤醒），填 0 关闭平台默认心跳。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">单会话每小时主动发言上限（条）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={perSessionHour}
            disabled={disabled}
            aria-invalid={pPerSession === null}
            data-testid="platform-outbound-per-session-hour"
            onChange={(event) => edit(setPerSessionHour)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            默认 3 条，0 不限制（被动回复不受影响）。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">单接收人每日主动发言上限（条）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={perRecipientDay}
            disabled={disabled}
            aria-invalid={pPerRecipient === null}
            data-testid="platform-outbound-per-recipient-day"
            onChange={(event) => edit(setPerRecipientDay)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            默认 10 条，0 不限制。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">相同主动消息去重窗口（小时）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            value={dedupHours}
            disabled={disabled}
            aria-invalid={pDedup === null}
            data-testid="platform-outbound-dedup-hours"
            onChange={(event) => edit(setDedupHours)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            默认 24 小时，0 关闭去重。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">主动提问（Ask）默认过期（分钟）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={43200}
            value={askExpiresMin}
            disabled={disabled}
            aria-invalid={pAskExpires === null}
            data-testid="platform-ask-expires-minutes"
            onChange={(event) => edit(setAskExpiresMin)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            默认 120 分钟（2 小时）。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">定时失败通知最小间隔（小时）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            value={failNotifyHours}
            disabled={disabled}
            aria-invalid={pFailNotify === null}
            data-testid="platform-schedule-failure-notify-hours"
            onChange={(event) => edit(setFailNotifyHours)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            默认 24 小时，0 关闭自动私信告警。
          </span>
        </label>
      </div>
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">平台默认免打扰时段</p>
            <p className="text-xs text-muted-foreground">
              开启后，免打扰窗口内的主动通知自动延后（deferred）至窗口结束后投递。
            </p>
          </div>
          <Switch
            aria-label="启用平台默认免打扰时段"
            checked={quietEnabled}
            disabled={disabled}
            onCheckedChange={edit(setQuietEnabled)}
          />
        </div>
        {quietEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">开始时间</span>
              <Input
                type="time"
                value={quietStart}
                disabled={disabled}
                aria-invalid={!HHMM_REGEX.test(quietStart)}
                data-testid="platform-quiet-hours-start"
                onChange={(event) => edit(setQuietStart)(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">结束时间</span>
              <Input
                type="time"
                value={quietEnd}
                disabled={disabled}
                aria-invalid={!HHMM_REGEX.test(quietEnd)}
                data-testid="platform-quiet-hours-end"
                onChange={(event) => edit(setQuietEnd)(event.target.value)}
              />
            </label>
          </div>
        )}
      </div>
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={valid}
        error={error}
        saved={saved}
        testId="platform-proactivity-save"
        onSave={() =>
          onSave({
            heartbeatIntervalMs: pHeartbeat! * 60_000,
            outboundPerSessionPerHour: pPerSession!,
            outboundPerRecipientPerDay: pPerRecipient!,
            outboundDedupWindowMs: pDedup! * 3_600_000,
            quietHours: quietEnabled
              ? { start: quietStart, end: quietEnd }
              : null,
            askDefaultExpiresMs: pAskExpires! * 60_000,
            scheduleFailureNotifyIntervalMs: pFailNotify! * 3_600_000,
          })
        }
      />
    </section>
  );
}

export function FeishuMessagingSettingsForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: PlatformMessagingSettings;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: PlatformMessagingSettings) => void;
}) {
  const [maxSteps, setMaxSteps] = useState(String(settings.maxVisibleSteps));
  const [developersText, setDevelopersText] = useState(formatDeveloperMap(settings.feishuDevelopers));
  const [touched, setTouched] = useState(false);

  const parsedSteps = intInRange(maxSteps, 1, 200);
  const parsedDevelopers = parseDeveloperMap(developersText);
  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="platform-messaging-title"
      data-testid="platform-messaging-settings-card"
    >
      <div className="space-y-1">
        <h2 id="platform-messaging-title" className="font-medium">
          飞书卡片与开发者映射
        </h2>
        <p className="text-sm text-muted-foreground">
          控制飞书进度卡片折叠面板最多展示的步骤条数，以及多应用共享同一开发者主体时的 union_id 映射。
        </p>
      </div>
      <div className="space-y-4">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">状态卡片最多显示步骤数</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={maxSteps}
            disabled={disabled}
            aria-invalid={parsedSteps === null}
            data-testid="platform-max-visible-steps"
            onChange={(event) => edit(setMaxSteps)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">1 到 200 条，默认 32。</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">飞书开发者主体映射（可选）</span>
          <Textarea
            rows={3}
            value={developersText}
            disabled={disabled}
            placeholder={"cli_a1b2c3d4=developer_main\ncli_e5f6g7h8=developer_main"}
            aria-invalid={parsedDevelopers === null}
            data-testid="platform-feishu-developers"
            onChange={(event) => edit(setDevelopersText)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            每行一条 <code>app_id=developer_id</code>，用于同一飞书开放平台开发者名下多个应用按 union_id 识别同一成员。
          </span>
        </label>
      </div>
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={parsedSteps !== null && parsedDevelopers !== null}
        error={error}
        saved={saved}
        testId="platform-messaging-save"
        onSave={() =>
          onSave({
            maxVisibleSteps: parsedSteps!,
            feishuDevelopers: parsedDevelopers!,
          })
        }
      />
    </section>
  );
}

export function OrphanCleanupForm({
  settings,
  canEdit,
  saving,
  error,
  saved,
  onSave,
}: {
  readonly settings: OrphanCleanup;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly onSave: (value: OrphanCleanup) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [interval, setIntervalText] = useState(String(settings.intervalMinutes));
  const [retention, setRetention] = useState(String(settings.retentionDays));
  const [touched, setTouched] = useState(false);
  const minutes = Number(interval);
  const days = Number(retention);
  const intervalValid = Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440;
  const retentionValid = Number.isInteger(days) && days >= 1 && days <= 365;
  const disabled = !canEdit || saving;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };
  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="orphan-cleanup-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id="orphan-cleanup-title" className="font-medium">
            自动清理孤儿数据
          </h2>
          <p className="text-sm text-muted-foreground">
            Service 定期询问每台 Worker 上有哪些分身。分身或其 Agent 已删除、或 Service 不认识的，先删除容器；
            保留期满仍不认识时，再删除它的 /data 卷和 HOME。期间 Service 重新认出它，就保留不删。
          </p>
        </div>
        <Switch
          aria-label="自动清理孤儿数据"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={edit(setEnabled)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">对账周期（分钟）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={5}
            max={1440}
            value={interval}
            disabled={disabled || !enabled}
            aria-invalid={!intervalValid}
            onChange={(event) => edit(setIntervalText)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            5 到 1440 分钟，默认 60。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">数据保留期（天）</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            value={retention}
            disabled={disabled || !enabled}
            aria-invalid={!retentionValid}
            onChange={(event) => edit(setRetention)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            1 到 365 天，默认 7。
          </span>
        </label>
      </div>
      {!enabled && (
        <p className="text-sm text-muted-foreground">
          已关闭：Service 不再对账，Worker 上的数据都不会被自动删除。
        </p>
      )}
      <FormFooter
        canEdit={canEdit}
        saving={saving}
        touched={touched}
        valid={intervalValid && retentionValid}
        error={error}
        saved={saved}
        onSave={() =>
          onSave({ enabled, intervalMinutes: minutes, retentionDays: days })
        }
      />
    </section>
  );
}

function FormFooter({
  canEdit,
  saving,
  touched,
  valid,
  error,
  saved,
  testId,
  onSave,
}: {
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly touched: boolean;
  readonly valid: boolean;
  readonly error: Error | null;
  readonly saved: boolean;
  readonly testId?: string;
  readonly onSave: () => void;
}) {
  return (
    <>
      {!canEdit && (
        <p className="text-sm text-muted-foreground">只有平台管理员可以修改。</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          保存失败。{error.message}
        </p>
      )}
      {saved && !touched && (
        <p role="status" className="text-sm text-muted-foreground">
          已保存。
        </p>
      )}
      {canEdit && (
        <Button
          data-testid={testId}
          disabled={saving || !touched || !valid}
          onClick={onSave}
        >
          {saving ? "正在保存…" : "保存"}
        </Button>
      )}
    </>
  );
}
