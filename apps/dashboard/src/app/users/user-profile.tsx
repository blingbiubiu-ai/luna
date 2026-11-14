import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { UsersIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AssignGroupDialog } from "@/components/assign-group-dialog";
import {
  OperationGrantList,
  IndirectOperationGrantList,
} from "@/components/operation-grant-list";
import { IdentityAvatar } from "@/components/identity-link";
import {
  RelationCard,
  RelationCardList,
  RelationSection,
} from "@/components/relation-card-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  DashboardGroup,
  DashboardUser,
} from "@/lib/api";

export function UserProfile({
  groups = [],
  user,
  assignGroupError,
  isAssigningGroup = false,

  onAssignGroup,
  onRemoveGroup,
}: {
  readonly groups?: readonly DashboardGroup[];
  readonly user: DashboardUser;
  readonly assignGroupError?: unknown;
  readonly isAssigningGroup?: boolean;

  readonly onAssignGroup?: ((input: {
    groupId: string;
    role: "member";
  }) => Promise<unknown> | unknown) | undefined;
  readonly onRemoveGroup?: ((groupId: string) => Promise<unknown> | unknown) | undefined;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const deleted = user.status === "deleted";
  const canManageUsers = user.canManageUsers !== false;
  return (
    <section className="max-w-4xl rounded-md border" data-testid="user-profile">
      <div className="flex flex-wrap items-start gap-4 border-b p-4">
        <IdentityAvatar
          className="size-14"
          identity={avatarIdentityForUser(user)}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">
              {userDisplayName(user)}
            </h2>
            <Badge variant="outline"><UiText>{user.kind}</UiText></Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{t("Luna User ID:")}{" "}{user.id}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <Metric
              label={t("Messages")}
              value={formatCount(user.messageCount, "message")}
            />
            <Metric
              label={t("Sessions")}
              value={formatCount(user.sessionCount, "session")}
            />
            <Metric label={t("Status")} value={deleted ? "已删除" : user.status} />
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {deleted ? <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">此用户已删除。当前页面仅供查看历史信息，身份绑定和权限已清理，不能进行管理操作。</p> : null}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Activity")}</h3>
          <UserField
            label={t("Latest session")}
            value={latestSessionValue(user, base)}
          />
          <UserField label={t("Profile source")} value={<UiText>{user.profileSource}</UiText>} />
          {user.displayNameSource === "mention" ? <UserField label={t("Display name source")} value={t("Message mention (fallback)")} /> : null}
        </section>
        <section
          className="space-y-3"
          data-layout="standalone"
          data-testid="identities-section"
        >
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Identities")}</h3>
          <ChannelAccountList accounts={channelAccountsForUser(user)} />
        </section>
        {!deleted ? <section className="space-y-4">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Groups and permissions")}</h3>
          <UserField
            label={t("Luna User ID")}
            value={user.id}
            monospace
          />
          <RelationSection
            action={canManageUsers ? (
              <AssignGroupDialog
                error={assignGroupError}
                excludedGroupIds={user.groups.map((group) => group.id)}
                groups={groups}
                isSubmitting={isAssigningGroup}
                onAssignGroup={onAssignGroup}
              />
            ) : undefined}
            dataTestId="user-membership-section"
            title={t("Memberships")}
          >
            <UserGroupList
              groups={user.groups}
              onRemoveGroup={canManageUsers ? onRemoveGroup : undefined}

            />
          </RelationSection>
          <RelationSection
            dataTestId="user-direct-grants-section"
            title={t("Direct grants")}
          >
            <OperationGrantList
              emptyText={t("No direct grants.")}
              grants={user.directGrants}
              relationKind="user-direct-grants"
            />
          </RelationSection>
          <RelationSection
            dataTestId="user-indirect-grants-section"
            title={t("Indirect grants")}
          >
            <IndirectOperationGrantList
              emptyText={t("No indirect grants.")}
              grants={user.indirectGrants}
              relationKind="user-indirect-grants"

            />
          </RelationSection>
        </section> : null}
      </div>
    </section>
  );
}

export function UserProfileForTest({
  groups = [],
  user,
}: {
  readonly groups?: readonly DashboardGroup[];
  readonly user: DashboardUser;
}) {
  return (
    <UserProfile
      groups={groups}
      onRemoveGroup={() => undefined}

      user={user}
    />
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <span className="rounded-md border bg-muted/20 px-2 py-1">
      <span className="text-muted-foreground">{label}: </span>
      <UiText>{value}</UiText>
    </span>
  );
}

function UserField({
  label,
  value,
  monospace = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly monospace?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-b py-2 text-sm last:border-b-0">
      <div className="text-muted-foreground">{label}</div>
      <div
        className={
          monospace ? "min-w-0 break-all font-mono" : "min-w-0 break-words"
        }
      >
        {value ?? "-"}
      </div>
    </div>
  );
}

function ChannelAccountList({
  accounts,
}: {
  readonly accounts: readonly ChannelAccount[];
}) {
  const { t } = useTranslation();
  return (
    <RelationCardList
      columns="one"
      emptyText={t("No channel accounts.")}
      items={accounts}
      relationKind="channel-accounts"
      renderItem={(account) => (
        <RelationCard
          avatarAlt={channelAccountTitle(account)}
          avatarUrl={account.channelIdentity?.avatarUrl ?? null}
          badge={
            account.channelIdentity?.identityKind ? (
              <Badge variant="secondary">
                {account.channelIdentity.identityKind}
              </Badge>
            ) : null
          }
          fallbackIcon={<UsersIcon className="size-4" />}
          key={account.key}
          subtitle={channelAccountSubtitle(account)}
          title={
            <span className="font-medium">{channelAccountTitle(account)}</span>
          }
        >
          <details className="space-y-2" data-testid="channel-account-details">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              标识详情 · <UiText>{formatCount(account.claims.length, "claim")}</UiText>
            </summary>
          <div className="space-y-2" data-testid="channel-account-claims">
            {account.claims.map((identity) => (
              <div
                className="rounded-md border bg-background/60 p-2 text-sm"
                key={identity.id}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">
                    {identity.identityNamespace}:{identity.identityKind}
                  </span>
                  {identity.isPrimary ? (
                    <Badge variant="outline">{t("primary")}</Badge>
                  ) : null}
                </div>
                <div className="mt-1 min-w-0 break-all font-mono">
                  {identity.identityValue}
                  {identity.identityScope.length > 0 ? (
                    <span className="text-muted-foreground">
                      {" · "}
                      {identity.identityScope}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          </details>
        </RelationCard>
      )}
    />
  );
}

function userDisplayName(user: DashboardUser): string {
  return user.displayName;
}

function latestSessionValue(
  user: DashboardUser, base: string): ReactNode {
  if (user.latestSessionId === null) {
    return "-";
  }
  const label = user.latestSessionTitle ?? user.latestSessionId;
  return <a href={`${base}/sessions/${encodeURIComponent(user.latestSessionId)}`}
    >
      {label}
    </a>;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function UserGroupList({
  groups,
  onRemoveGroup,
}: {
  readonly groups: readonly DashboardUser["groups"][number][];
  readonly onRemoveGroup?: ((groupId: string) => Promise<unknown> | unknown) | undefined;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  return (
    <RelationCardList
      emptyText={t("No memberships.")}
      items={groups}
      relationKind="user-groups"
      renderItem={(group) => (
        <RelationCard
          action={onRemoveGroup ? (
            <Button
              aria-label={`Remove group ${group.displayName}`}
              onClick={() => {
                void onRemoveGroup(group.id);
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </Button>
          ) : null}
          avatarAlt={group.displayName}
          avatarUrl={group.avatarUrl}
          badge={<Badge variant="outline"><UiText>{group.status}</UiText></Badge>}
          fallbackIcon={<UsersIcon className="size-4" />}
          key={group.id}
          subtitle={group.slug}
          title={renderUserGroupLink(group, base)}
        />
      )}
    />
  );
}

function renderUserGroupLink(
  group: DashboardUser["groups"][number], base: string) {
  const content = <span className="truncate font-medium">{group.displayName}</span>;
  return <a href={`${base}/groups/${group.id}`}>{content}</a>;
}

function primaryLinkedIdentity(user: DashboardUser) {
  return user.linkedIdentities.find((identity) => identity.isPrimary) ??
    user.linkedIdentities[0] ??
    null;
}

function avatarIdentityForUser(user: DashboardUser) {
  const identity = primaryLinkedIdentity(user);
  const channelIdentity = identity?.channelIdentity ?? null;
  return {
    id: user.id,
    channel: {
      type: channelIdentity?.channelType ?? identity?.identityNamespace ?? "user",
      id: channelIdentity?.channelId ?? "",
    },
    externalId: channelIdentity?.externalId ?? identity?.identityValue ?? user.id,
    identityKind: user.kind === "human" ? "user" : user.kind,
    displayName: user.displayName,
    status: user.status,
    avatarUrl: user.avatarUrl,
    providerIds: {},
  };
}

type ChannelAccount = {
  readonly key: string;
  readonly namespace: string;
  readonly scope: string;
  readonly channelIdentity:
    DashboardUser["linkedIdentities"][number]["channelIdentity"];
  readonly claims: readonly DashboardUser["linkedIdentities"][number][];
};

function channelAccountsForUser(user: DashboardUser): ChannelAccount[] {
  const accountsByKey = new Map<string, ChannelAccount>();
  for (const identity of user.linkedIdentities) {
    const key = channelAccountKey(identity);
    const existing = accountsByKey.get(key);
    if (existing === undefined) {
      accountsByKey.set(key, {
        key,
        namespace: identity.identityNamespace,
        scope: identity.identityScope,
        channelIdentity: identity.channelIdentity,
        claims: [identity],
      });
      continue;
    }
    accountsByKey.set(key, {
      ...existing,
      claims: [...existing.claims, identity],
    });
  }
  return [...accountsByKey.values()].map((account) => ({
    ...account,
    claims: [...account.claims].sort(compareIdentityClaims),
  }));
}

function channelAccountKey(
  identity: DashboardUser["linkedIdentities"][number],
): string {
  if (identity.channelIdentityId !== null) {
    return `channel:${identity.channelIdentityId}`;
  }
  return [
    "claims",
    identity.identityNamespace,
    identity.identityScope,
    identity.channelIdentity?.channelType ?? "",
    identity.channelIdentity?.channelId ?? "",
  ].join(":");
}

function compareIdentityClaims(
  left: DashboardUser["linkedIdentities"][number],
  right: DashboardUser["linkedIdentities"][number],
): number {
  return (
    Number(right.isPrimary) - Number(left.isPrimary) ||
    left.identityNamespace.localeCompare(right.identityNamespace) ||
    left.identityKind.localeCompare(right.identityKind) ||
    left.identityValue.localeCompare(right.identityValue)
  );
}

function channelAccountTitle(account: ChannelAccount): string {
  return titleCase(account.namespace);
}

function channelAccountSubtitle(account: ChannelAccount): string {
  const channelIdentity = account.channelIdentity;
  const parts = [
    channelIdentity === null
      ? null
      : `${channelIdentity.channelType}/${channelIdentity.channelId}`,
    channelIdentity?.displayName ?? null,
    channelIdentity?.externalId ?? null,
    account.scope.length > 0 ? account.scope : null,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : account.namespace;
}

function titleCase(value: string): string {
  return value.length === 0
    ? value
    : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
