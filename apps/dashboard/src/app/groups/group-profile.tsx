import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { ArrowLeftIcon, UserIcon, UsersIcon, XIcon } from "lucide-react";

import { AddGroupMemberDialog } from "@/components/add-group-member-dialog";
import { OperationGrantList } from "@/components/operation-grant-list";
import { GrantOperationDialog } from "@/components/grant-operation-dialog";
import {
  RelationCard,
  RelationCardList,
  RelationSection,
} from "@/components/relation-card-list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  OperationPolicy,
  DashboardGroup,
  DashboardUser,
} from "@/lib/api";

export function GroupProfile({
  canManageGroup = true,
  addMemberError,
  operations = [],
  grantError,
  group,
  isAddingMember = false,
  isGrantingOperation = false,
  isRemovingMember = false,
  isLoading = false,
  error,
  onAddMember,
  onGrantOperations,
  onRemoveMember,
  onRemoveGrant,

  users = [],
}: {
  readonly canManageGroup?: boolean;
  readonly addMemberError?: unknown;
  readonly operations?: readonly OperationPolicy[];
  readonly grantError?: unknown;
  readonly group: DashboardGroup | null;
  readonly isAddingMember?: boolean;
  readonly isGrantingOperation?: boolean;
  readonly isRemovingMember?: boolean;
  readonly isLoading?: boolean;
  readonly error?: unknown;
  readonly onAddMember?: ((input: {
    userId: string;
    role: "member";
  }) => Promise<unknown> | unknown) | undefined;
  readonly onGrantOperations?: ((input: {
    rules: Array<{target: string; matchType: "exact" | "prefix"; effect: "allow" | "deny"; expiresAt?: number}>;
  }) => Promise<unknown> | unknown) | undefined;
  readonly onRemoveMember?: ((userId: string) => Promise<unknown> | unknown) | undefined;
  readonly onRemoveGrant?: ((grantId: string) => Promise<unknown> | unknown) | undefined;

  readonly users?: readonly DashboardUser[];
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <main className="space-y-4 p-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-48 w-full max-w-4xl" />
      </main>
    );
  }
  if (error) {
    return (
      <main className="p-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
          <h2 className="text-sm font-semibold">{t("Group failed to load")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {error instanceof Error ? error.message : t("Unknown error")}
          </p>
        </div>
      </main>
    );
  }
  if (group === null) {
    return (
      <main className="p-4">
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">{t("Group not found.")}</div>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-4">
      <section className="max-w-5xl rounded-md border">
        <div className="flex flex-wrap items-start gap-4 border-b p-4">
          {renderBackLink(base)}
          <Avatar className="size-12" size="lg">
            {group.avatarUrl ? (
              <img alt={group.displayName} src={group.avatarUrl} />
            ) : (
              <AvatarFallback>
                <UsersIcon className="size-4" />
              </AvatarFallback>
            )}
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold">
                {group.displayName}
              </h1>
              <Badge variant="outline"><UiText>{group.status}</UiText></Badge>
            </div>
            <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {group.slug}{t("· Group ID")}{group.id}
            </div>
          </div>
        </div>

        <div className="space-y-4 p-4">
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase text-muted-foreground">{t("Overview")}</h2>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <GroupMetric label={t("Status")} value={group.status} />
              <GroupMetric
                label={t("Members")}
                value={formatCount(group.memberCount, "member")}
              />
              <GroupMetric
                label={t("Direct grants")}
                value={formatCount(group.directGrants.length, "direct grant")}
              />
              <GroupMetric label={t("Updated")} value={group.updatedAt} monospace />
            </div>
            <GroupField label={t("Description")} value={group.description ?? "-"} />
            <GroupField label={t("Created")} value={group.createdAt} monospace />
          </section>

          <RelationSection
            action={canManageGroup ? (
              <AddGroupMemberDialog
                error={addMemberError}
                excludedUserIds={group.members.map((member) => member.userId)}
                isSubmitting={isAddingMember}
                onAddMember={onAddMember}
                users={users}
              />
            ) : undefined}
            dataTestId="group-members-section"
            title={t("Group members")}
          >
            <GroupMemberList
              isRemovingMember={isRemovingMember}
              members={group.members}
              onRemoveMember={canManageGroup ? onRemoveMember : undefined}

            />
          </RelationSection>

          <RelationSection
            action={canManageGroup ? (
              <GrantOperationDialog
                operations={operations}
                error={grantError}
                existingGrants={group.directGrants}
                groups={[]}
                isSubmitting={isGrantingOperation}
                onGrantBatch={(input) =>
                  onGrantOperations?.({
                    rules: input.items,
                  })
                }
                subject={{
                  type: "group",
                  id: group.id,
                  label: group.displayName,
                }}
                users={[]}
              />
            ) : undefined}
            dataTestId="group-direct-grants-section"
            title={t("Permissions")}
          >
            <OperationGrantList
              emptyText={t("No direct grants.")}
              grants={group.directGrants}
              onRemoveGrant={canManageGroup ? onRemoveGrant : undefined}
              relationKind="group-direct-grants"
            />
          </RelationSection>
        </div>
      </section>
    </main>
  );
}

export function GroupProfileForTest({
  operations = [],
  group,
  users = [],
}: {
  readonly operations?: readonly OperationPolicy[];
  readonly group: DashboardGroup;
  readonly users?: readonly DashboardUser[];
}) {
  return (
    <GroupProfile
      operations={operations}
      group={group}
      onRemoveMember={() => undefined}
      onRemoveGrant={() => undefined}

      users={users}
    />
  );
}

function GroupMetric({
  label,
  monospace = false,
  value,
}: {
  readonly label: string;
  readonly monospace?: boolean;
  readonly value: string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 text-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          monospace
            ? "mt-1 min-w-0 break-all font-mono text-xs"
            : "mt-1 min-w-0 break-words font-medium"
        }
      >
        {value}
      </div>
    </div>
  );
}

function GroupField({
  label,
  monospace = false,
  value,
}: {
  readonly label: string;
  readonly monospace?: boolean;
  readonly value: string;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-b py-2 text-sm last:border-b-0">
      <div className="text-muted-foreground">{label}</div>
      <div
        className={
          monospace ? "min-w-0 break-all font-mono" : "min-w-0 break-words"
        }
      >
        {value}
      </div>
    </div>
  );
}

function renderBackLink(base: string) {
  const content = <ArrowLeftIcon className="size-4" />;
    return (
    <Button variant="ghost" size="icon" asChild>
      <a href={`${base}/groups`}>{content}</a>
    </Button>
  );
}

function GroupMemberList({
  isRemovingMember,
  members,
  onRemoveMember,
}: {
  readonly isRemovingMember: boolean;
  readonly members: readonly DashboardGroup["members"][number][];
  readonly onRemoveMember?: ((userId: string) => Promise<unknown> | unknown) | undefined;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  return (
    <RelationCardList
      columns="three"
      emptyText={t("No members.")}
      items={members}
      relationKind="group-members"
      renderItem={(member) => (
        <RelationCard
          action={onRemoveMember ? (
            <Button
              aria-label={`Remove member ${member.displayName}`}
              disabled={isRemovingMember}
              onClick={() => {
                void onRemoveMember(member.userId);
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </Button>
          ) : null}
          avatarAlt={member.displayName}
          avatarUrl={member.avatarUrl}
          badge={<Badge variant="outline"><UiText>{member.role}</UiText></Badge>}
          fallbackIcon={<UserIcon className="size-4" />}
          key={member.id}
          subtitle={member.userId}
          title={renderMemberLink(member, base)}
        />
      )}
    />
  );
}

function renderMemberLink(
  member: DashboardGroup["members"][number], base: string) {
  const content = <span className="truncate font-medium">{member.displayName}</span>;
  return <a href={`${base}/users/${member.userId}`}>{content}</a>;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
