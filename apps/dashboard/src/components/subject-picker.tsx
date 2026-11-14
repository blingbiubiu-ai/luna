import { UserIcon, UsersIcon } from "lucide-react";

import { MultiEntityPicker } from "@/components/multi-entity-picker";
import { SingleEntityPicker } from "@/components/single-entity-picker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type {
  AuthorizationSubjectType,
  OperationGrant,
  DashboardGroup,
  DashboardUser,
} from "@/lib/api";

export interface AuthorizationSubjectOption {
  readonly subjectType: AuthorizationSubjectType;
  readonly subjectId: string;
  readonly displayName: string;
  readonly kind: string;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly secondaryLabel?: string;
  readonly searchText?: string;
  readonly directGrants: readonly OperationGrant[];
}

export function SubjectPicker({
  allowedSubjectTypes,
  emptyText = "No matching subjects",
  excludedSubjectKeys = [],
  groups,
  label,
  onSelectedSubjectKeyChange,
  placeholder = "Search users or groups",
  selectedSubjectKey,
  users,
}: {
  readonly allowedSubjectTypes?: readonly AuthorizationSubjectType[];
  readonly emptyText?: string;
  readonly excludedSubjectKeys?: readonly string[];
  readonly groups: readonly DashboardGroup[];
  readonly label: string;
  readonly onSelectedSubjectKeyChange: (subjectKey: string) => void;
  readonly placeholder?: string;
  readonly selectedSubjectKey: string;
  readonly users: readonly DashboardUser[];
}) {
  const subjects = subjectsFromUsersAndGroups(users, groups);
  return (
    <SingleEntityPicker
      dataTestId="subject-picker"
      emptyText={emptyText}
      getItemId={(subject) =>
        subjectKey(subject.subjectType, subject.subjectId)}
      getItemTitle={(subject) =>
        `${subject.subjectType}:${subject.subjectId}`}
      items={subjects}
      label={label}
      onSelectedItemIdChange={onSelectedSubjectKeyChange}
      placeholder={placeholder}
      renderOption={(subject) => <SubjectOptionLabel subject={subject} />}
      renderToken={(subject) => <SelectedSubjectToken subject={subject} />}
      searchItems={(items, query) =>
        filterSubjectsForPicker(
          items,
          query,
          allowedSubjectTypes,
          excludedSubjectKeys,
        )}
      selectedItemId={selectedSubjectKey}
    />
  );
}

export function SubjectMultiPicker({
  allowedSubjectTypes,
  emptyText = "No matching subjects",
  excludedSubjectKeys = [],
  groups,
  label,
  onSelectedSubjectKeysChange,
  placeholder = "Search users or groups",
  selectedSubjectKeys,
  users,
}: {
  readonly allowedSubjectTypes?: readonly AuthorizationSubjectType[];
  readonly emptyText?: string;
  readonly excludedSubjectKeys?: readonly string[];
  readonly groups: readonly DashboardGroup[];
  readonly label: string;
  readonly onSelectedSubjectKeysChange: (subjectKeys: string[]) => void;
  readonly placeholder?: string;
  readonly selectedSubjectKeys: readonly string[];
  readonly users: readonly DashboardUser[];
}) {
  const subjects = subjectsFromUsersAndGroups(users, groups);
  return (
    <MultiEntityPicker
      dataTestId="subject-picker"
      emptyText={emptyText}
      getItemId={(subject) =>
        subjectKey(subject.subjectType, subject.subjectId)}
      getItemTitle={(subject) =>
        `${subject.subjectType}:${subject.subjectId}`}
      items={subjects}
      label={label}
      onSelectedItemIdsChange={onSelectedSubjectKeysChange}
      placeholder={placeholder}
      renderOption={(subject) => <SubjectOptionLabel subject={subject} />}
      renderToken={(subject) => <SelectedSubjectToken subject={subject} />}
      searchItems={(items, query) =>
        filterSubjectsForPicker(
          items,
          query,
          allowedSubjectTypes,
          excludedSubjectKeys,
        )}
      selectedItemIds={selectedSubjectKeys}
    />
  );
}

export function subjectsFromUsersAndGroups(
  users: readonly DashboardUser[],
  groups: readonly DashboardGroup[],
): AuthorizationSubjectOption[] {
  return [
    ...users.map((user) => ({
      subjectType: "user" as const,
      subjectId: user.id,
      displayName: user.displayName,
      kind: user.kind,
      avatarUrl: user.avatarUrl,
      status: user.status,
      secondaryLabel: preferredUserIdentity(user),
      searchText: userSearchText(user),
      directGrants: user.directGrants,
    })),
    ...groups.map((group) => ({
      subjectType: "group" as const,
      subjectId: group.id,
      displayName: group.displayName,
      kind: "group",
      avatarUrl: group.avatarUrl,
      status: group.status,
      secondaryLabel: group.slug,
      searchText: [
        group.id,
        group.slug,
        group.displayName,
        group.description ?? "",
        group.status,
      ].join(" "),
      directGrants: group.directGrants,
    })),
  ];
}

export function filterSubjectsForPicker(
  subjects: readonly AuthorizationSubjectOption[],
  query: string,
  allowedSubjectTypes?: readonly AuthorizationSubjectType[],
  excludedSubjectKeys: readonly string[] = [],
): AuthorizationSubjectOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const allowedTypeSet = allowedSubjectTypes === undefined
    ? null
    : new Set(allowedSubjectTypes);
  const excludedSet = new Set(excludedSubjectKeys);
  return subjects.filter((subject) => {
    if (excludedSet.has(subjectKey(subject.subjectType, subject.subjectId))) {
      return false;
    }
    if (allowedTypeSet !== null && !allowedTypeSet.has(subject.subjectType)) {
      return false;
    }
    if (normalizedQuery.length === 0) {
      return true;
    }
    return searchableSubjectText(subject).includes(normalizedQuery);
  });
}

export function subjectKey(
  subjectType: AuthorizationSubjectType,
  subjectId: string,
): string {
  return `${subjectType}:${subjectId}`;
}

export function parseSubjectKey(
  value: string,
): { subjectType: AuthorizationSubjectType; subjectId: string } | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const subjectType = value.slice(0, separatorIndex);
  const subjectId = value.slice(separatorIndex + 1);
  if (
    subjectId.length === 0 ||
    (subjectType !== "user" && subjectType !== "group")
  ) {
    return null;
  }
  return { subjectType, subjectId };
}

function SubjectOptionLabel({
  subject,
}: {
  readonly subject: AuthorizationSubjectOption;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <SubjectAvatar subject={subject} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-medium">
            {subject.displayName}
          </span>
          <Badge variant="outline">{subject.subjectType}</Badge>
        </div>
        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {subject.subjectType}:{subject.subjectId}
        </div>
      </div>
    </div>
  );
}

function SelectedSubjectToken({
  subject,
}: {
  readonly subject: AuthorizationSubjectOption;
}) {
  return <SubjectTokenContent subject={subject} />;
}

export function SubjectTokenContent({
  subject,
}: {
  readonly subject: AuthorizationSubjectOption;
}) {
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-2"
      data-testid="subject-token-content"
    >
      <SubjectAvatar subject={subject} size="sm" />
      <span className="min-w-0 flex-1 truncate font-medium">
        {subject.displayName}
        {subject.secondaryLabel ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            ({subject.secondaryLabel})
          </span>
        ) : null}
      </span>
    </span>
  );
}

function SubjectAvatar({
  subject,
  size = "default",
}: {
  readonly subject: AuthorizationSubjectOption;
  readonly size?: "default" | "sm";
}) {
  const label = subject.displayName.trim() || subject.subjectType;
  const Icon = subject.subjectType === "group" ? UsersIcon : UserIcon;
  return (
    <Avatar className={size === "sm" ? "size-5" : "mt-0.5 size-6"} size="sm">
      {subject.avatarUrl ? (
        <img alt={label} className="aspect-square size-full" src={subject.avatarUrl} />
      ) : (
        <AvatarFallback>
          {subject.subjectType === "user"
            ? subjectInitial(label)
            : <Icon aria-hidden="true" className="size-3" />}
        </AvatarFallback>
      )}
    </Avatar>
  );
}

function searchableSubjectText(subject: AuthorizationSubjectOption): string {
  return [
    subject.subjectType,
    subject.subjectId,
    subject.displayName,
    subject.kind,
    subject.status,
    subject.secondaryLabel ?? "",
    subject.searchText ?? "",
  ].join(" ").toLowerCase();
}

function userSearchText(user: DashboardUser): string {
  return [
    user.id,
    user.displayName,
    user.kind,
    user.status,
    ...user.linkedIdentities.flatMap((identity) => [
      identity.identityNamespace,
      identity.identityKind,
      identity.identityValue,
      identity.identityScope,
      identity.channelIdentity?.externalId ?? "",
    ]),
  ].join(" ");
}

function preferredUserIdentity(user: DashboardUser): string {
  const preferred = user.linkedIdentities.find((identity) =>
    identity.identityKind === "user_id" || identity.identityKind === "email"
  ) ?? user.linkedIdentities.find((identity) => identity.isPrimary);
  return preferred?.identityValue ?? "";
}

function subjectInitial(label: string): string {
  const trimmed = label.trim();
  return trimmed.length === 0 ? "?" : trimmed.slice(0, 2).toUpperCase();
}
