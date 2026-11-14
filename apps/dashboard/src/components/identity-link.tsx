import { useAgentBasePath } from "@/lib/agent-route";
import { useTranslation } from "@/lib/i18n";
import { BotIcon, UserIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export interface DashboardIdentity {
  readonly id: string;
  readonly channel: { readonly type: string; readonly id: string };
  readonly externalId: string;
  readonly identityKind: "user" | "bot" | "system" | "unknown" | string;
  readonly displayName?: string | null;
  readonly status?: string;
  readonly avatarUrl?: string | null;
  readonly providerIds?: Record<string, string>;
}

export interface IdentityLinkProps {
  readonly identity: DashboardIdentity | null | undefined;
  readonly fallbackKind?: "user" | "bot" | "system" | "unknown";
  readonly className?: string;
  readonly label?: string;
  readonly showAvatar?: boolean;
  readonly showIcon?: boolean;
  readonly showKind?: boolean;
}

export function IdentityLink({
  identity,
  fallbackKind = "user",
  className,
  label,
  showAvatar = false,
  showIcon = true,
  showKind = true,
}: IdentityLinkProps) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  if (!identity) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        {unknownIdentityLabel(fallbackKind)}
      </span>
    );
  }

  if (identity.identityKind === "deleted" || (!identity.id && identity.status === "deleted")) return <span className={cn("text-muted-foreground", className)}>已删除消息</span>;

  const labelText =
    label?.trim() ||
    identity.displayName?.trim() ||
    unknownIdentityLabel(identity.identityKind);
  const Icon = ["bot", "system"].includes(identity.identityKind) ? BotIcon : UserIcon;

  return (
    <a
      className={cn(
        "inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline",
        className,
      )}
      href={`${base}/users/${encodeURIComponent(identity.id)}`}
      title={identityTitle(identity)}
    >
      {showAvatar ? (
        <IdentityAvatar
          className="size-5"
          identity={identity}
          fallbackKind={fallbackKind}
        />
      ) : showIcon ? (
        <Icon aria-hidden="true" className="size-3 shrink-0" />
      ) : null}
      <span className="truncate">{labelText}</span>
      {identity.status === "deleted" ? <span className="shrink-0 rounded-sm border px-1 py-0.5 text-[10px] font-normal text-muted-foreground">已删除</span> : null}
      {showKind && ["bot", "system"].includes(identity.identityKind) ? (
        <span className="rounded-sm border px-1 py-0.5 text-[10px] font-normal uppercase text-muted-foreground">{t(identity.identityKind)}</span>
      ) : null}
    </a>
  );
}

export interface IdentityAvatarProps {
  readonly identity: DashboardIdentity | null | undefined;
  readonly fallbackKind?: "user" | "bot" | "system" | "unknown";
  readonly className?: string;
  readonly size?: "default" | "sm" | "lg";
}

export function IdentityAvatar({
  identity,
  fallbackKind = "user",
  className,
  size = "default",
}: IdentityAvatarProps) {
  const effectiveKind = identity?.identityKind ?? fallbackKind;
  const label = identity
    ? identity.displayName?.trim() || unknownIdentityLabel(effectiveKind)
    : unknownIdentityLabel(fallbackKind);
  return (
    <Avatar className={className} size={size}>
      {identity?.avatarUrl ? (
        <img
          alt={label}
          className="aspect-square size-full"
          src={identity.avatarUrl}
        />
      ) : (
        <AvatarFallback>
          {["bot", "system"].includes(effectiveKind) ? (
            <BotIcon aria-hidden="true" className="size-3" />
          ) : (
            identityInitial(label)
          )}
        </AvatarFallback>
      )}
    </Avatar>
  );
}

export function identitySearchText(
  identity: DashboardIdentity | null | undefined,
): string {
  if (!identity) {
    return "";
  }
  return [
    identity.id,
    identity.externalId,
    identity.displayName ?? "",
    identity.identityKind,
    identity.channel.type,
    identity.channel.id,
  ].join(" ");
}

function identityTitle(identity: DashboardIdentity): string {
  return [
    identity.displayName?.trim() || unknownIdentityLabel(identity.identityKind),
    `${identity.channel.type}/${identity.channel.id}`,
    identity.externalId,
  ].join(" · ");
}

function identityInitial(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toUpperCase() : "?";
}

function unknownIdentityLabel(kind: string): string {
  if (kind === "bot") {
    return "Bot";
  }
  if (kind === "system") {
    return "System";
  }
  return "Unknown user";
}
