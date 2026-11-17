import { useAgentBasePath } from "@/lib/agent-route";
import { DeleteRecordButton } from "@/components/delete-record-button";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Bot, UserIcon } from "lucide-react";
import { useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDashboardAuthSession,
  useGroups,
  useOperations,
  useUser,
  useUserOperationGrantBatchMutation,
  useUserOperationGrantDeleteMutation,
  useUserGroupMembershipDeleteMutation,
  useUserGroupMembershipMutation,
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
  const { data: authSession, isError: authError } = useDashboardAuthSession();
  const currentUserId = !authError && authSession?.authenticated ? authSession.user?.id : undefined;
  const resolvedUserId = user?.id ?? userId;
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
    window.location.replace(`${base}/users/${encodeURIComponent(user.id)}`);
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
        {user?.status === "deleted" ? <Badge variant="secondary">已删除</Badge> : null}
        {user?.canDeleteUsers === true && user.status !== "deleted" && user.kind !== "system" && currentUserId !== undefined && user.id !== currentUserId ? <DeleteRecordButton kind="users" id={user.id} name={user.displayName} onDeleted={() => { window.location.assign(`${base}/users`); }} /> : null}
      </header>

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
