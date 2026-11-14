import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { Search, UsersIcon } from "lucide-react";
import { useMemo } from "react";
import type { ReactNode } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { IdentityAvatar } from "@/components/identity-link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardUser } from "@/lib/api";

export function UsersList({
  users,
  query,
  setQuery,
  loading,
  error,
}: {
  readonly users: readonly DashboardUser[];
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const filtered = useMemo(() => filterUsers(users, query), [users, query]);

  return (
    <div className="flex h-full flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-xl">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(readInputValue(event))}
            placeholder={t("Search users")}
            className="h-9 pl-9"
          />
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length}{t("users")}</div>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        {error ? (
          <DashboardErrorState title={t("Users failed to load")} error={error} />
        ) : loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>{t("No users")}</EmptyTitle>
              <EmptyDescription>{t("Luna channel users will appear here after messages arrive.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>{t("User")}</TableHead>
                <TableHead>{t("Channel")}</TableHead>
                <TableHead>{t("Messages")}</TableHead>
                <TableHead>{t("Sessions")}</TableHead>
                <TableHead>{t("Latest session")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="max-w-[22rem]">
                    <div
                      className="flex min-w-0 items-center gap-2"
                      data-testid={`user-list-identity-${user.id}`}
                    >
                      <IdentityAvatar
                        className="size-8"
                        identity={avatarIdentityForUser(user)}
                      />
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          {renderUserLink(user, base)}
                          <Badge variant="outline"><UiText>{user.kind}</UiText></Badge>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {identitySummary(user)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          <UiText>{formatCount(
                            user.linkedIdentities.length,
                            "identity",
                          )}</UiText>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {channelSummary(user)}
                  </TableCell>
                  <TableCell><UiText>{formatCount(user.messageCount, "message")}</UiText></TableCell>
                  <TableCell>
                    <UiText>{formatCount(user.sessionCount, "session")}</UiText>
                  </TableCell>
                  <TableCell className="max-w-[24rem]">
                    {latestSessionLink(user, base)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <UiText>{user.status}</UiText>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>
    </div>
  );
}

export function UsersListForTest({
  users,
  query,
  loading,
  error,
}: {
  readonly users: readonly DashboardUser[];
  readonly query: string;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  return (
    <UsersList
      users={users}
      query={query}
      setQuery={() => {}}
      loading={loading}
      error={error}

    />
  );
}

function DashboardErrorState({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : t("Unknown error")}
      </p>
    </div>
  );
}

function latestSessionLink(
  user: DashboardUser, base: string): ReactNode {
  const latestSessionId = user.latestSessionId;
  const latestSessionTitle = user.latestSessionTitle;
  if (latestSessionId === null) {
    return <span className="text-muted-foreground">-</span>;
  }
  const label = latestSessionTitle ?? latestSessionId;
  return <a href={`${base}/sessions/${encodeURIComponent(latestSessionId)}`}
      className="block truncate font-medium hover:underline"
    >
      {label}
    </a>;
}

function renderUserLink(
  user: DashboardUser, base: string): ReactNode {
  return <a href={`${base}/users/${encodeURIComponent(user.id)}`}
      title={user.displayNameSource === "mention" ? "Name from message mentions; official profile unavailable" : undefined}
      className="block truncate font-medium text-primary hover:underline"
    >
      {user.displayName}
    </a>;
}

function formatCount(count: number, singular: string): string {
  const plural = singular.endsWith("y")
    ? `${singular.slice(0, -1)}ies`
    : `${singular}s`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function filterUsers(users: readonly DashboardUser[], query: string): DashboardUser[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...users];
  }
  return users.filter((user) => {
    const haystack = [
      user.id,
      user.displayName,
      user.kind,
      user.status,
      user.profileSource,
      ...user.linkedIdentities.flatMap((identity) => [
        identity.identityNamespace,
        identity.identityKind,
        identity.identityValue,
        identity.identityScope,
        identity.channelIdentity?.channelType ?? "",
        identity.channelIdentity?.channelId ?? "",
        identity.channelIdentity?.externalId ?? "",
      ]),
      user.latestSessionId ?? "",
      user.latestSessionTitle ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function readInputValue(event: unknown): string {
  if (typeof event !== "object" || event === null) {
    return "";
  }
  const target = (event as { readonly target?: unknown }).target;
  if (typeof target !== "object" || target === null) {
    return "";
  }
  const value = (target as { readonly value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

function primaryLinkedIdentity(user: DashboardUser) {
  return user.linkedIdentities.find((identity) => identity.isPrimary) ??
    user.linkedIdentities[0] ??
    null;
}

function identitySummary(user: DashboardUser): string {
  const identity = primaryLinkedIdentity(user);
  if (identity === null) {
    return user.kind;
  }
  return [
    user.kind,
    `${identity.identityNamespace}:${identity.identityKind}`,
    identity.identityValue,
  ].join(" · ");
}

function channelSummary(user: DashboardUser): string {
  const channelIdentity = primaryLinkedIdentity(user)?.channelIdentity;
  return channelIdentity === undefined || channelIdentity === null
    ? "-"
    : `${channelIdentity.channelType}/${channelIdentity.channelId}`;
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
