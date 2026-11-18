import { useAgentBasePath } from "@/lib/agent-route";
import { appHistory } from "@/lib/app-history";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Bot, UserIcon } from "lucide-react";
import { useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGroups,
  useOperations,
  useUser,
  useUserOperationGrantBatchMutation,
  useUserOperationGrantDeleteMutation,
  useUserGroupMembershipDeleteMutation,
  useUserGroupMembershipMutation,
  useUserRemoveMutation,
  useUserUpdateMutation,
} from "@/lib/api";
import type { DashboardUser } from "@/lib/api";
import { UserProfile } from "./user-profile";

export const Route = createFileRoute("/$agentId/users/$userId")({
  component: UserDetailPage,
});

function UserDetailPage() {
  const { t } = useTranslation();
  const { agentId, userId } = Route.useParams();
  const base = useAgentBasePath();
  const { data: user, error, isError, isLoading } = useUser(userId, agentId);
  const resolvedUserId = user?.id ?? userId;
  const update = useUserUpdateMutation(resolvedUserId, agentId);
  const remove = useUserRemoveMutation(resolvedUserId, agentId);
  // Shadows, Luna's own authors and the owner are not managed from this page.
  const manageable = user?.canManageUsers === true && user.isOwner !== true && (user.kind === "human" || user.kind === "bot");
  const pending = update.isPending || remove.isPending;
  const actionError = update.error ?? remove.error;
  const canManageUsers = user?.canManageUsers === true;
  const groups = useGroups(agentId, canManageUsers);
  const membership = useUserGroupMembershipMutation(resolvedUserId);
  const removeMembership = useUserGroupMembershipDeleteMutation(resolvedUserId);
  const operations = useOperations(agentId, undefined, canManageUsers);
  const grant = useUserOperationGrantBatchMutation(resolvedUserId, agentId);
  const deleteGrant = useUserOperationGrantDeleteMutation(resolvedUserId, agentId);

  useEffect(() => {
    if (user === undefined || user.id === userId) {
      return;
    }
    appHistory.replace(`${base}/users/${encodeURIComponent(user.id)}`);
  }, [base, user, userId]);

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex min-h-16 items-center gap-3 border-b px-4">
        <Button variant="ghost" size="icon" asChild>
          <a href={`${base}/users`}>
            <ArrowLeft className="size-4" />
          </a>
        </Button>
        {user?.kind === "bot" || user?.kind === "system" ? (
          <Bot className="size-4 text-muted-foreground" />
        ) : (
          <UserIcon className="size-4 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {user ? userDisplayName(user) : userId}
          </h1>
          <div className="truncate text-xs text-muted-foreground">
            {user ? userSubtitle(user) : userId}
          </div>
        </div>
        {user ? (
          <Badge variant="outline" className="ml-auto">
            <UiText>{user.kind}</UiText>
          </Badge>
        ) : null}
        {user?.isOwner === true ? <Badge variant="secondary">所有者</Badge> : null}
        {user?.status === "blocked" ? <Badge variant="destructive">已拉黑</Badge> : null}
        {user && manageable ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => {
              const name = window.prompt("在此 Agent 中显示的名字", user.displayName)?.trim();
              if (name && name !== user.displayName) update.mutate({ displayName: name });
            }}>改名</Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => {
              const blocking = user.status !== "blocked";
              if (!blocking || window.confirm(`拉黑「${user.displayName}」？此 Agent 将不再接收和回复 TA 的消息。`)) update.mutate({ status: blocking ? "blocked" : "active" });
            }}>{user.status === "blocked" ? "取消拉黑" : "拉黑"}</Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={pending} onClick={() => {
              if (window.confirm(`把「${user.displayName}」从此 Agent 的用户列表移除？历史记录保留；TA 再发消息会重新出现。`)) {
                remove.mutate(undefined, { onSuccess: () => { appHistory.push(`${base}/users`); } });
              }
            }}>移除</Button>
          </div>
        ) : null}
      </header>
      {actionError ? <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{actionError instanceof Error ? actionError.message : String(actionError)}</p> : null}

      <main className="space-y-4 p-4">
        {isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
            <h2 className="text-sm font-semibold">{t("User failed to load")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {error instanceof Error ? error.message : t("Unknown error")}
            </p>
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-48 w-full max-w-3xl" />
          </div>
        ) : user ? (
          <UserProfile
            assignGroupError={membership.error}
            groups={groups.data?.groups ?? []}
            isAssigningGroup={membership.isPending}
            onAssignGroup={(input) =>
              membership.mutateAsync({
                groupId: input.groupId,
                role: input.role,
              })
            }
            onRemoveGroup={(groupId) => removeMembership.mutateAsync(groupId)}
            operations={operations.data ?? []}
            grantError={grant.error}
            isGrantingOperation={grant.isPending}
            onGrantOperations={(input) => grant.mutateAsync({ items: input.rules })}
            onRemoveGrant={(grantId) => deleteGrant.mutateAsync(grantId)}
            user={user}
          />
        ) : null}
      </main>
    </div>
  );
}

function userDisplayName(user: DashboardUser): string {
  return user.displayName;
}

function userSubtitle(user: DashboardUser): string {
  return `ID: ${user.id}`;
}
