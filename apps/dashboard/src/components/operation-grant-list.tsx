import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { ShieldCheckIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  RelationCard,
  RelationCardList,
} from "@/components/relation-card-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  OperationGrant,
  DashboardIndirectOperationGrant,
} from "@/lib/api";

export function OperationGrantList({
  emptyText,
  grants,
  onRemoveGrant,
  relationKind = "authorization-rules",
}: {
  readonly emptyText: string;
  readonly grants: readonly OperationGrant[];
  readonly onRemoveGrant?: ((grantId: string) => Promise<unknown> | unknown) | undefined;
  readonly relationKind?: string;
}) {
  return (
    <RelationCardList
      columns="one"
      emptyText={emptyText}
      items={grants}
      relationKind={relationKind}
      renderItem={(grant) => (
        <OperationGrantRow
          grant={grant}
          key={grant.id}
          onRemoveGrant={onRemoveGrant}
        />
      )}
    />
  );
}

export function IndirectOperationGrantList({
  emptyText,
  grants,
  relationKind = "indirect-authorization-rules",
}: {
  readonly emptyText: string;
  readonly grants: readonly DashboardIndirectOperationGrant[];
  readonly relationKind?: string;
}) {
  const base = useAgentBasePath();
  return (
    <RelationCardList
      columns="one"
      emptyText={emptyText}
      items={grants}
      relationKind={relationKind}
      renderItem={(grant) => (
        <OperationGrantRow
          grant={grant}
          key={grant.id}
          source={renderGroupSourceLink(grant.sourceGroup, base)}
        />
      )}
    />
  );
}

export function OperationGrantRow({
  grant,
  onRemoveGrant,
  source,
  subjectLabel,
}: {
  readonly grant: OperationGrant;
  readonly onRemoveGrant?: ((grantId: string) => Promise<unknown> | unknown) | undefined;
  readonly source?: ReactNode | undefined;
  readonly subjectLabel?: ReactNode | undefined;
}) {
  const { t } = useTranslation();
  const title = subjectLabel ? (
    <span className="min-w-0 break-words font-medium">{subjectLabel}</span>
  ) : (
    <span className="min-w-0 break-all font-mono text-xs font-medium">
      {`${grant.target}${grant.matchType === "prefix" ? ".*" : ""}`}
    </span>
  );
  const subtitle = subjectLabel ? `${grant.target}${grant.matchType === "prefix" ? ".*" : ""}` : undefined;
  return (
    <RelationCard
      action={onRemoveGrant ? (
        <Button
          aria-label={`Remove grant ${`${grant.target}${grant.matchType === "prefix" ? ".*" : ""}`}`}
          onClick={() => {
            void onRemoveGrant(grant.id);
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </Button>
      ) : null}
      avatarAlt={`${grant.target}${grant.matchType === "prefix" ? ".*" : ""}`}
      avatarUrl={null}
      badge={
        <Badge variant={grant.effect === "allow" ? "outline" : "destructive"}>
          <UiText>{grant.effect}</UiText>
        </Badge>
      }
      fallbackIcon={<ShieldCheckIcon className="size-4" />}
      subtitle={subtitle}
      title={title}
    >
      {source ? (
        <div className="text-xs text-muted-foreground">{source}</div>
      ) : null}
      {grant.expiresAt ? (
        <div className="mt-2 text-xs text-muted-foreground">{t("Expires at")}{grant.expiresAt}
        </div>
      ) : null}
    </RelationCard>
  );
}

function renderGroupSourceLink(
  group: DashboardIndirectOperationGrant["sourceGroup"], base: string) {
  const content = <span className="font-medium"><UiText>via</UiText> {group.displayName}</span>;
  return <a href={`${base}/groups/${encodeURIComponent(group.id)}`}>{content}</a>;
}
