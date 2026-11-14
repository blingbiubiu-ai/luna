import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { UsersIcon } from "lucide-react";

import { CreateGroupDialog } from "@/components/create-group-dialog";
import { Badge } from "@/components/ui/badge";
import type { DashboardGroup } from "@/lib/api";

export function GroupsDashboard({
  canCreateGroup = true,
  createError,
  groups,
  listError,
  isCreatingGroup = false,
  onCreateGroup,
}: {
  readonly canCreateGroup?: boolean;
  readonly createError?: unknown;
  readonly groups: readonly DashboardGroup[];
  readonly listError?: Error | null;
  readonly isCreatingGroup?: boolean;
  readonly onCreateGroup?: ((input: {
    slug: string;
    displayName: string;
    description?: string;
  }) => Promise<unknown> | unknown) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <UsersIcon className="size-4" />{t("Group Directory")}</div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{t("Groups")}</h1>
          {canCreateGroup ? (
            <div className="flex flex-wrap items-center gap-2">
              <CreateGroupDialog
                error={createError}
                isSubmitting={isCreatingGroup}
                onCreate={onCreateGroup}
              />
            </div>
          ) : null}
        </div>
      </header>
      <section className="min-h-0 flex-1 p-5">
        <article className="min-w-0 rounded-md border">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-medium">{t("Group directory")}</h2>
            <span className="text-xs text-muted-foreground">
              {groups.length}{t("groups")}</span>
          </div>
          <div className="grid gap-3 p-3">
            {listError ? (
              <p role="alert" className="text-sm text-destructive">{listError.message}</p>
            ) : groups.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">{t("No groups yet.")}</div>
            ) : (
              groups.map((group) => (
                <GroupCard
                  group={group}
                  key={group.id}

                />
              ))
            )}
          </div>
        </article>
      </section>
    </main>
  );
}

export function GroupsDashboardForTest(
  props: Parameters<typeof GroupsDashboard>[0],
) {
  return <GroupsDashboard {...props} />;
}

function GroupCard({
  group,
}: {
  readonly group: DashboardGroup;
}) {
  const base = useAgentBasePath();
  return (
    <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {renderGroupLink(group, base)}
            <Badge variant="outline"><UiText>{group.status}</UiText></Badge>
          </div>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {group.slug} · {group.id}
          </div>
          {group.description ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {group.description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge variant="secondary">
            <UiText>{formatCount(group.memberCount, "member")}</UiText>
          </Badge>
          <Badge variant="secondary">
            <UiText>{formatCount(group.directGrants.length, "direct grant")}</UiText>
          </Badge>
        </div>
      </div>
    </div>
  );
}

function renderGroupLink(group: DashboardGroup, base: string) {
  const content = (
    <span className="break-words font-medium">{group.displayName}</span>
  );
  return <a href={`${base}/groups/${group.id}`}>{content}</a>;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
