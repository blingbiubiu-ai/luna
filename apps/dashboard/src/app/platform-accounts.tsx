import { useState } from "react";
import Avatar from "boring-avatars";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";

export interface PlatformAccountItem {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly status: "active" | "disabled" | "deleted";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly isSuperAdmin: boolean;
  readonly isPlatformAdmin: boolean;
  readonly canPublishLineage?: boolean;
  readonly agentCount: number;
}

const ACCOUNTS_KEY = ["luna", "platform-accounts"] as const;

export function PlatformAccountsPage({ currentAccountId }: { readonly currentAccountId?: string | undefined }) {
  const client = useQueryClient();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: ({ signal }) => apiFetch<{ accounts: PlatformAccountItem[] }>("/accounts", { signal }),
  });

  const invalidateAll = () => {
    void client.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    void client.invalidateQueries({ queryKey: ["luna", "auth", "me"] });
  };

  const toggleAdmin = useMutation({
    mutationFn: ({ id, isPlatformAdmin }: { id: string; isPlatformAdmin: boolean }) =>
      apiFetch<{ account: PlatformAccountItem }>(`/accounts/${encodeURIComponent(id)}/admin`, {
        method: "PUT",
        body: JSON.stringify({ isPlatformAdmin }),
      }),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAll,
    onError: (err: Error) => setActionError(err.message),
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "disabled" }) =>
      apiFetch<{ account: PlatformAccountItem }>(`/accounts/${encodeURIComponent(id)}/status`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      }),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAll,
    onError: (err: Error) => setActionError(err.message),
  });

  const removeAccount = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ status: "ok" }>(`/accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setConfirmDeleteId(null);
      invalidateAll();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const toggleLineagePublish = useMutation({
    mutationFn: ({ id, canPublishLineage }: { id: string; canPublishLineage: boolean }) =>
      apiFetch<{ account: PlatformAccountItem }>(`/accounts/${encodeURIComponent(id)}/lineage-publish`, {
        method: "PUT",
        body: JSON.stringify({ canPublishLineage }),
      }),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAll,
    onError: (err: Error) => setActionError(err.message),
  });

  const busy = toggleAdmin.isPending || toggleStatus.isPending || toggleLineagePublish.isPending || removeAccount.isPending;

  return (
    <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 p-6" data-testid="platform-accounts-page">
      <div className="space-y-2">
        <a
          href="/platform/settings"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          data-testid="back-to-platform-settings"
        >
          <ArrowLeftIcon className="size-4" />
          <span>返回设置</span>
        </a>
        <div>
          <h1 className="text-2xl font-semibold">账号与管理员</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理通过飞书或访问令牌登录控制台的平台账号。访问令牌账号为内置超级管理员，不可被撤销、停用或删除；飞书账号默认仅能管理自己创建的 Agent，授予「平台管理员」后可管理平台设置、插件与账号。
          </p>
        </div>
      </div>

      {actionError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          操作失败：{actionError}
        </p>
      )}

      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          无法加载账号列表。{query.error.message}
        </p>
      )}
      {query.isLoading && <p role="status" className="text-sm text-muted-foreground">正在加载…</p>}

      {query.data && (
        <PlatformAccountsList
          accounts={query.data.accounts}
          currentAccountId={currentAccountId}
          busy={busy}
          confirmDeleteId={confirmDeleteId}
          onConfirmDeleteChange={setConfirmDeleteId}
          onToggleAdmin={(id, next) => toggleAdmin.mutate({ id, isPlatformAdmin: next })}
          onToggleLineagePublish={(id, next) => toggleLineagePublish.mutate({ id, canPublishLineage: next })}
          onToggleStatus={(id, next) => toggleStatus.mutate({ id, status: next })}
          onDelete={(id) => removeAccount.mutate(id)}
        />
      )}
    </main>
  );
}

export function PlatformAccountsList({
  accounts,
  currentAccountId,
  busy,
  confirmDeleteId,
  onConfirmDeleteChange,
  onToggleAdmin,
  onToggleLineagePublish,
  onToggleStatus,
  onDelete,
}: {
  readonly accounts: readonly PlatformAccountItem[];
  readonly currentAccountId?: string | undefined;
  readonly busy: boolean;
  readonly confirmDeleteId: string | null;
  readonly onConfirmDeleteChange: (id: string | null) => void;
  readonly onToggleAdmin: (id: string, isPlatformAdmin: boolean) => void;
  readonly onToggleLineagePublish?: (id: string, canPublishLineage: boolean) => void;
  readonly onToggleStatus: (id: string, status: "active" | "disabled") => void;
  readonly onDelete: (id: string) => void;
}) {
  if (accounts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        暂无平台账号记录。
      </div>
    );
  }

  return (
    <div className="divide-y rounded-lg border bg-card" data-testid="platform-accounts-list">
      {accounts.map((account) => {
        const isSelf = account.id === currentAccountId;
        const providerLabel = account.isSuperAdmin
          ? "访问令牌"
          : account.id.startsWith("feishu:")
            ? "飞书登录"
            : "外部账号";
        const confirmingDelete = confirmDeleteId === account.id;
        const canDelete = !account.isSuperAdmin && !isSelf && account.agentCount === 0;
        const deleteHint = isSelf
          ? "不能删除当前登录账号"
          : account.agentCount > 0
            ? `请先删除该账号拥有的 ${account.agentCount} 个 Agent`
            : undefined;

        return (
          <div
            key={account.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            data-testid={`platform-account-row-${account.id}`}
          >
            <div className="flex min-w-0 items-center gap-3">
              {account.avatarUrl ? (
                <img
                  alt={account.displayName}
                  src={account.avatarUrl}
                  className="size-10 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="shrink-0">
                  <Avatar name={account.displayName || account.id} variant="beam" size={40} />
                </div>
              )}
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">
                    {account.isSuperAdmin ? "内置超级管理员" : account.displayName}
                  </span>
                  {account.isSuperAdmin ? (
                    <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                      超级管理员
                    </span>
                  ) : account.isPlatformAdmin ? (
                    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      平台管理员
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      普通账号
                    </span>
                  )}
                  {account.status === "disabled" && (
                    <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                      已停用
                    </span>
                  )}
                  {account.canPublishLineage && (
                    <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                      可开启传承
                    </span>
                  )}
                  {isSelf && (
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                      当前登录
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{providerLabel}</span>
                  <code className="font-mono">{account.id}</code>
                  <span>拥有 {account.agentCount} 个 Agent</span>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {onToggleLineagePublish && !confirmingDelete && (
                <Button
                  size="sm"
                  variant={account.canPublishLineage ? "outline" : "secondary"}
                  disabled={busy || (!account.canPublishLineage && account.status !== "active")}
                  title={!account.canPublishLineage && account.status !== "active" ? "请先启用该账号" : undefined}
                  data-testid={`toggle-lineage-publish-${account.id}`}
                  onClick={() => onToggleLineagePublish(account.id, !account.canPublishLineage)}
                >
                  {account.canPublishLineage ? "关闭传承权限" : "允许开启传承"}
                </Button>
              )}
              {account.isSuperAdmin ? (
                <span className="text-xs text-muted-foreground">内置超级管理员</span>
              ) : confirmingDelete ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    data-testid={`confirm-delete-${account.id}`}
                    onClick={() => onDelete(account.id)}
                  >
                    确认删除
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onConfirmDeleteChange(null)}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <>
                  {account.isPlatformAdmin ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isSelf}
                      title={isSelf ? "不能撤销当前登录账号的管理员权限" : undefined}
                      data-testid={`revoke-admin-${account.id}`}
                      onClick={() => onToggleAdmin(account.id, false)}
                    >
                      <ShieldOffIcon className="size-3.5" />
                      <span>撤销管理员</span>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || account.status !== "active"}
                      title={account.status !== "active" ? "请先启用该账号" : undefined}
                      data-testid={`grant-admin-${account.id}`}
                      onClick={() => onToggleAdmin(account.id, true)}
                    >
                      <ShieldCheckIcon className="size-3.5" />
                      <span>设为管理员</span>
                    </Button>
                  )}

                  {account.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isSelf}
                      title={isSelf ? "不能停用当前登录账号" : undefined}
                      data-testid={`disable-account-${account.id}`}
                      onClick={() => onToggleStatus(account.id, "disabled")}
                    >
                      停用
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      data-testid={`enable-account-${account.id}`}
                      onClick={() => onToggleStatus(account.id, "active")}
                    >
                      启用
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy || !canDelete}
                    title={deleteHint}
                    data-testid={`delete-account-${account.id}`}
                    onClick={() => onConfirmDeleteChange(account.id)}
                  >
                    删除
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
