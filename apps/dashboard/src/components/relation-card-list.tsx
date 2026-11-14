import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import type { ReactNode } from "react";

import { InspectableText } from "@/components/inspectable-text";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type RelationCardListColumns = "one" | "two" | "three";

export function RelationSection({
  action,
  children,
  className,
  dataTestId,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly dataTestId?: string;
  readonly title: string;
}) {
  return (
    <section
      className={cn("grid gap-3 border-b pb-3 text-sm", className)}
      data-testid={dataTestId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-muted-foreground">{title}</h4>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function RelationCardList<T>({
  columns = "two",
  emptyText,
  items,
  relationKind,
  renderItem,
}: {
  readonly columns?: RelationCardListColumns;
  readonly emptyText: string;
  readonly items: readonly T[];
  readonly relationKind: string;
  readonly renderItem: (item: T) => ReactNode;
}) {
  if (items.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
        data-relation-columns={columns}
        data-relation-kind={relationKind}
        data-testid="relation-card-list"
      >
        <UiText>{emptyText}</UiText>
      </div>
    );
  }
  return (
    <div
      className={
        columns === "one"
          ? "grid gap-2"
          : columns === "three"
          ? "grid gap-2 md:grid-cols-2 xl:grid-cols-3"
          : "grid gap-2 md:grid-cols-2"
      }
      data-relation-columns={columns}
      data-relation-kind={relationKind}
      data-testid="relation-card-list"
    >
      {items.map(renderItem)}
    </div>
  );
}

export function RelationCard({
  action,
  avatarAlt,
  avatarUrl,
  badge,
  children,
  fallbackIcon,
  subtitle,
  title,
}: {
  readonly action?: ReactNode;
  readonly avatarAlt: string;
  readonly avatarUrl?: string | null;
  readonly badge?: ReactNode;
  readonly children?: ReactNode;
  readonly fallbackIcon: ReactNode;
  readonly subtitle?: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <div
      className="min-w-0 max-w-full space-y-3 rounded-md border bg-muted/20 p-3"
      data-testid="relation-card"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-9" size="default">
          {avatarUrl ? (
            <img alt={avatarAlt} src={avatarUrl} />
          ) : (
            <AvatarFallback>{fallbackIcon}</AvatarFallback>
          )}
        </Avatar>
        <div className="min-w-0 flex-1">
          {title}
          {subtitle ? <RelationCardSubtitle subtitle={subtitle} /> : null}
        </div>
        {badge}
        {action}
      </div>
      {children}
    </div>
  );
}

function RelationCardSubtitle({
  subtitle,
}: {
  readonly subtitle: ReactNode;
}) {
  const { t } = useTranslation();
  if (typeof subtitle === "string") {
    return (
      <InspectableText
        className="mt-1 font-mono text-xs text-muted-foreground"
        label={t("Metadata")}
        popoverClassName="data-contained-popover w-full min-w-0 max-w-full"
        previewClassName="break-all"
        previewLength={48}
        text={subtitle}
      />
    );
  }
  return (
    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
      {subtitle}
    </div>
  );
}
