import {
  AlertCircle,
  Check,
  CircleHelp,
  Clock3,
  Loader2,
  Minus,
} from "lucide-react";

import { avatarColorForKey } from "@/app/sessions/session-avatar";
import type { DashboardIdentity } from "@/components/identity-link";
import type { DashboardCanonicalUser } from "@/lib/api";
import { UiText } from "@/lib/i18n";
import { isActiveTaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export type TaskEffectiveState =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "new";

export interface ParsedTaskContext {
  readonly latestUserMessage: string;
  readonly knownFacts: string[];
  readonly assumptions: string[];
  readonly pendingQuestions: string[];
  readonly hasContent: boolean;
}

export function parseTaskContext(value: unknown): ParsedTaskContext {
  const record = isPlainRecord(value) ? value : {};
  const latestUserMessage = readString(record.latestUserMessage);
  const knownFacts = readStringList(record.knownFacts);
  const assumptions = readStringList(record.assumptions);
  const pendingQuestions = readStringList(record.pendingQuestions);
  return {
    latestUserMessage,
    knownFacts,
    assumptions,
    pendingQuestions,
    hasContent:
      latestUserMessage.length > 0 ||
      knownFacts.length > 0 ||
      assumptions.length > 0 ||
      pendingQuestions.length > 0,
  };
}

export function resolveTaskEffectiveState(input: {
  readonly status: string;
  readonly taskContext?: unknown;
}): TaskEffectiveState {
  if (isActiveTaskStatus(input.status)) {
    return "running";
  }
  if (input.status === "waiting") {
    return "waiting";
  }
  if (input.status === "failed") {
    return "failed";
  }
  if (input.status === "cancelled" || input.status === "canceled") {
    return "cancelled";
  }
  const { pendingQuestions } = parseTaskContext(input.taskContext);
  if (pendingQuestions.length > 0) {
    return "waiting";
  }
  if (input.status === "new" || input.status === "pending" || input.status === "queued") {
    return "new";
  }
  return "completed";
}

export function taskStateClasses(state: TaskEffectiveState): {
  readonly pillClass: string;
  readonly dotClass: string;
  readonly calloutClass: string;
} {
  switch (state) {
    case "running":
      return {
        pillClass:
          "bg-[#b07d4f]/14 text-[#b07d4f] border-[#b07d4f]/28 dark:bg-[#d1a273]/16 dark:text-[#d1a273] dark:border-[#d1a273]/30",
        dotClass: "bg-[#b07d4f] dark:bg-[#d1a273]",
        calloutClass:
          "bg-[#b07d4f]/12 text-[#b07d4f] border-[#b07d4f]/25 dark:bg-[#d1a273]/14 dark:text-[#d1a273] dark:border-[#d1a273]/28",
      };
    case "waiting":
    case "new":
      return {
        pillClass:
          "bg-[#5c7c99]/14 text-[#5c7c99] border-[#5c7c99]/28 dark:bg-[#86a3be]/16 dark:text-[#86a3be] dark:border-[#86a3be]/30",
        dotClass: "bg-[#5c7c99] dark:bg-[#86a3be]",
        calloutClass:
          "bg-[#5c7c99]/12 text-[#5c7c99] border-[#5c7c99]/25 dark:bg-[#86a3be]/14 dark:text-[#86a3be] dark:border-[#86a3be]/28",
      };
    case "failed":
      return {
        pillClass:
          "bg-[#b5544a]/13 text-[#b5544a] border-[#b5544a]/28 dark:bg-[#dc7a70]/16 dark:text-[#dc7a70] dark:border-[#dc7a70]/30",
        dotClass: "bg-[#b5544a] dark:bg-[#dc7a70]",
        calloutClass:
          "bg-[#b5544a]/11 text-[#b5544a] border-[#b5544a]/25 dark:bg-[#dc7a70]/14 dark:text-[#dc7a70] dark:border-[#dc7a70]/28",
      };
    case "cancelled":
      return {
        pillClass:
          "bg-muted text-muted-foreground border-border",
        dotClass: "bg-muted-foreground",
        calloutClass: "bg-muted text-muted-foreground border-border",
      };
    case "completed":
    default:
      return {
        pillClass:
          "bg-[#5b8a72]/14 text-[#5b8a72] border-[#5b8a72]/28 dark:bg-[#7fb096]/16 dark:text-[#7fb096] dark:border-[#7fb096]/30",
        dotClass: "bg-[#5b8a72] dark:bg-[#7fb096]",
        calloutClass:
          "bg-[#5b8a72]/12 text-[#5b8a72] border-[#5b8a72]/25 dark:bg-[#7fb096]/14 dark:text-[#7fb096] dark:border-[#7fb096]/28",
      };
  }
}

export function TaskStateIcon({
  state,
  size = "md",
}: {
  readonly state: TaskEffectiveState;
  readonly size?: "sm" | "md";
}) {
  const boxClass = size === "sm" ? "size-5" : "size-6";
  const iconClass = size === "sm" ? "size-3" : "size-3.5";

  if (state === "running") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-[#b07d4f]/14 text-[#b07d4f] dark:bg-[#d1a273]/16 dark:text-[#d1a273]",
          boxClass,
        )}
      >
        <Loader2 className={cn(iconClass, "animate-spin")} />
      </span>
    );
  }
  if (state === "waiting") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-[#5c7c99]/14 text-[#5c7c99] dark:bg-[#86a3be]/16 dark:text-[#86a3be]",
          boxClass,
        )}
      >
        <CircleHelp className={iconClass} />
      </span>
    );
  }
  if (state === "new") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-[#5c7c99]/14 text-[#5c7c99] dark:bg-[#86a3be]/16 dark:text-[#86a3be]",
          boxClass,
        )}
      >
        <Clock3 className={iconClass} />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-[#b5544a]/13 text-[#b5544a] dark:bg-[#dc7a70]/16 dark:text-[#dc7a70]",
          boxClass,
        )}
      >
        <AlertCircle className={iconClass} />
      </span>
    );
  }
  if (state === "cancelled") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground",
          boxClass,
        )}
      >
        <Minus className={iconClass} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full bg-[#5b8a72]/14 text-[#5b8a72] dark:bg-[#7fb096]/16 dark:text-[#7fb096]",
        boxClass,
      )}
    >
      <Check className={iconClass} />
    </span>
  );
}

export function TaskStatusPill({
  status,
  effectiveState,
  showDot = false,
  className,
}: {
  readonly status: string;
  readonly effectiveState?: TaskEffectiveState;
  readonly showDot?: boolean;
  readonly className?: string;
}) {
  const state = effectiveState ?? resolveTaskEffectiveState({ status });
  const styles = taskStateClasses(state);
  const displayLabel = state === "waiting" ? "Waiting" : status;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] leading-none font-medium",
        styles.pillClass,
        className,
      )}
    >
      {showDot ? (
        <span className={cn("size-1.5 shrink-0 rounded-full", styles.dotClass)} />
      ) : null}
      <UiText>{displayLabel}</UiText>
    </span>
  );
}

export function TaskTypePill({
  type,
  className,
}: {
  readonly type: string;
  readonly className?: string;
}) {
  const dotColor = taskTypeDotColor(type);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[11px] leading-none font-medium text-secondary-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <UiText>{type}</UiText>
    </span>
  );
}

export function TaskPriorityPill({
  priority,
  alwaysShow = false,
  className,
}: {
  readonly priority: string | null | undefined;
  readonly alwaysShow?: boolean;
  readonly className?: string;
}) {
  if (!priority) {
    return null;
  }
  const normalized = priority.toLowerCase();
  const isUrgent = normalized === "urgent";
  const isHigh = normalized === "high";
  if (!alwaysShow && !isUrgent && !isHigh) {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-[5px] px-1.5 py-0.5 text-[11px] leading-none font-medium",
        isUrgent
          ? "bg-[#b5544a]/13 text-[#b5544a] dark:bg-[#dc7a70]/16 dark:text-[#dc7a70]"
          : isHigh
            ? "bg-[#b07d4f]/14 text-[#b07d4f] dark:bg-[#d1a273]/16 dark:text-[#d1a273]"
            : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <UiText>{priority}</UiText>
    </span>
  );
}

export function taskTypeDotColor(type: string): string {
  switch (type.toLowerCase()) {
    case "question":
      return "#5b8a72";
    case "approval":
      return "#b07d4f";
    case "handoff":
      return "#7d6b91";
    case "task":
    default:
      return "#5c7c99";
  }
}

export function MiniUserBadgeAvatar({
  name,
  avatarUrl,
  kind,
  colorKey,
  className,
}: {
  readonly name: string;
  readonly avatarUrl?: string | null;
  readonly kind?: string;
  readonly colorKey: string;
  readonly className?: string;
}) {
  const isBot = kind === "bot" || kind === "system" || kind === "agent";
  if (avatarUrl) {
    return (
      <span
        className={cn(
          "inline-flex size-6 shrink-0 overflow-hidden rounded-full bg-muted ring-2 ring-card",
          className,
        )}
        title={name}
      >
        <img alt={name} className="size-full object-cover" loading="lazy" src={avatarUrl} />
      </span>
    );
  }
  if (isBot) {
    return (
      <span
        className={cn(
          "inline-grid size-6 shrink-0 select-none place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground ring-2 ring-card",
          className,
        )}
        title={name}
      >
        AI
      </span>
    );
  }
  const initial = Array.from(name.trim() || "?")[0]?.toUpperCase() ?? "?";
  return (
    <span
      className={cn(
        "inline-grid size-6 shrink-0 select-none place-items-center rounded-full text-[11px] font-semibold text-white ring-2 ring-card",
        className,
      )}
      style={{ backgroundColor: avatarColorForKey(colorKey || name) }}
      title={name}
    >
      {initial}
    </span>
  );
}

export function identityForCanonicalUser(
  user: DashboardCanonicalUser | null | undefined,
): DashboardIdentity | null {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    channel: { type: "luna", id: "canonical" },
    externalId: user.id,
    identityKind: canonicalUserIdentityKind(user.kind),
    displayName: user.displayName,
    status: user.status,
    avatarUrl: user.avatarUrl,
    providerIds: {},
  };
}

export function canonicalUserIdentityKind(
  kind: string,
): DashboardIdentity["identityKind"] {
  switch (kind) {
    case "bot":
      return "bot";
    case "system":
      return "system";
    case "human":
    case "service":
    default:
      return "user";
  }
}

export function formatTaskRelativeTime(
  timestamp: number,
  locale: "en" | "zh-CN" = "zh-CN",
): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - timestamp) / 1000);

  if (diffSec >= 0 && diffSec < 45) {
    return locale === "zh-CN" ? "刚刚" : "Just now";
  }
  if (diffSec >= 45 && diffSec < 3600) {
    const mins = Math.max(1, Math.floor(diffSec / 60));
    return locale === "zh-CN" ? `${mins} 分钟前` : `${mins}m ago`;
  }

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);

  if (dayDiff === 0) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  if (dayDiff === 1) {
    return locale === "zh-CN" ? "昨天" : "Yesterday";
  }
  if (dayDiff > 1 && dayDiff < 7) {
    return locale === "zh-CN"
      ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]!
      : new Intl.DateTimeFormat("en", { weekday: "short" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${m}/${d}`;
  }
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function formatTaskFullTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatRunDuration(
  startedAt: number,
  finishedAt: number | null | undefined,
): string | null {
  if (!startedAt || startedAt <= 0) {
    return null;
  }
  const end = finishedAt && finishedAt > 0 ? finishedAt : Date.now();
  const totalSec = Math.max(0, Math.round((end - startedAt) / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
