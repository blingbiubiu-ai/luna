import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, CopyIcon, ShieldCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  publicBaseUrl: string;
}

interface PlatformSettings {
  orphanCleanup: OrphanCleanup;
  feishuAuth: FeishuAuthSettings;
  canEdit: boolean;
}

const PATH = "/platform-settings";
const DEFAULT_FEISHU_HOST = "https://open.feishu.cn";

/** Platform-wide settings; every account sees them, platform administrators change them. */
export function PlatformSettingsPage() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [PATH],
    queryFn: ({ signal }) => apiFetch<PlatformSettings>(PATH, { signal }),
  });
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
        <p className="text-muted-foreground">对整个平台生效。</p>
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
          <FeishuAuthForm
            key={JSON.stringify(query.data.feishuAuth)}
            settings={query.data.feishuAuth}
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

export function FeishuAuthForm({
  settings,
  canEdit,
  saving,
  clearing,
  error,
  saved,
  onSave,
  onClear,
}: {
  readonly settings: FeishuAuthSettings;
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
  const [feishuHost, setFeishuHost] = useState(settings.feishuHost || DEFAULT_FEISHU_HOST);
  const [publicBaseUrl, setPublicBaseUrl] = useState(settings.publicBaseUrl);
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);

  const busy = saving || clearing;
  const disabled = !canEdit || busy;
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTouched(true);
  };

  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8090";
  const effectiveOrigin = (publicBaseUrl.trim() || currentOrigin).replace(/\/+$/, "");
  const callbackUrl = `${effectiveOrigin}/api/auth/feishu/callback`;

  const trimmedAppId = appId.trim();
  const trimmedSecret = appSecret.trim();
  const canReuseStoredSecret =
    settings.source === "database" &&
    settings.hasSecret &&
    !settings.secretUnreadable &&
    trimmedAppId === settings.appId;
  const formValid =
    trimmedAppId.length > 0 &&
    (trimmedSecret.length > 0 || canReuseStoredSecret) &&
    feishuHost.trim().length > 0;

  const statusBadge = settings.enabled
    ? {
        label: settings.source === "environment" ? "已启用（环境变量）" : "已启用",
        className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      }
    : settings.source === "database"
      ? {
          label: "已停用",
          className: "bg-muted text-muted-foreground",
        }
      : {
          label: "未配置",
          className: "bg-muted text-muted-foreground",
        };

  const secretPlaceholder = canReuseStoredSecret
    ? "已加密保存，留空保持不变"
    : settings.source === "environment" && settings.hasSecret
      ? "当前使用环境变量，填写后保存可覆盖落库"
      : "输入飞书自建应用 App Secret";

  async function handleCopyCallback() {
    if (await copyTextToClipboard(callbackUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

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
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge.className}`}
              data-testid="feishu-auth-status-badge"
            >
              {statusBadge.label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            使用飞书自建应用登录控制台。请在飞书开放平台「安全设置 → 重定向 URL」中添加下方回调地址；基础身份登录无需额外申请通讯录敏感权限。
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
          已保存的 App Secret 无法使用当前主密钥解密，请重新输入 App Secret 后保存。
        </p>
      )}

      <div className="space-y-1.5 text-sm">
        <span className="font-medium">OAuth 重定向回调地址（Redirect URI）</span>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground"
            data-testid="feishu-auth-callback-url"
          >
            {callbackUrl}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopyCallback}
            aria-label="复制回调地址"
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            <span>{copied ? "已复制" : "复制"}</span>
          </Button>
        </div>
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
          <span className="block text-xs text-muted-foreground">
            飞书自建应用的凭证 App ID。
          </span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">App Secret</span>
          <Input
            type="password"
            autoComplete="new-password"
            value={appSecret}
            disabled={disabled}
            placeholder={secretPlaceholder}
            data-testid="feishu-auth-app-secret"
            onChange={(event) => edit(setAppSecret)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            使用平台主密钥加密存储，保存时自动向飞书开放平台校验凭据。
          </span>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
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
        <label className="space-y-1 text-sm">
          <span className="font-medium">对外访问地址（可选）</span>
          <Input
            value={publicBaseUrl}
            disabled={disabled}
            placeholder={currentOrigin}
            data-testid="feishu-auth-public-base-url"
            onChange={(event) => edit(setPublicBaseUrl)(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            反向代理或公网域名访问时填写（如 https://luna.example.com），留空使用当前访问地址。
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
                appId: trimmedAppId,
                ...(trimmedSecret ? { appSecret: trimmedSecret } : {}),
                feishuHost: feishuHost.trim() || DEFAULT_FEISHU_HOST,
                publicBaseUrl: publicBaseUrl.trim(),
              })
            }
          >
            {saving ? "正在验证并保存…" : "保存"}
          </Button>
          {settings.source === "database" && (
            <Button
              type="button"
              variant="outline"
              data-testid="feishu-auth-clear"
              disabled={busy}
              onClick={onClear}
            >
              {clearing ? "正在清除…" : "清除平台配置"}
            </Button>
          )}
        </div>
      )}
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
          disabled={saving || !touched || !intervalValid || !retentionValid}
          onClick={() =>
            onSave({ enabled, intervalMinutes: minutes, retentionDays: days })
          }
        >
          {saving ? "正在保存…" : "保存"}
        </Button>
      )}
    </section>
  );
}
