import { Monitor } from "lucide-react";
import { useState } from "react";

import type { DashboardSession } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Low-saturation palette shared with the Memory page (`TYPE_META`). */
export const SESSION_AVATAR_PALETTE = [
  "#b5544a",
  "#b07d4f",
  "#5c7c99",
  "#5b8a72",
  "#7d6b91",
] as const;

export function avatarColorForKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  const index = Math.abs(hash) % SESSION_AVATAR_PALETTE.length;
  return SESSION_AVATAR_PALETTE[index]!;
}

export function avatarLinesForName(name: string, maxChars = 4): string[] {
  const cleaned = name
    .replace(/^[#@]+/, "")
    .replace(/[【】[\]()（）<>《》「」『』·\s_-]+/g, "")
    .trim();
  const source = cleaned || name.trim() || "?";
  const chars = Array.from(source);
  if (maxChars <= 2 || chars.length <= 2) {
    return [chars.slice(0, Math.min(2, chars.length)).join("")];
  }
  return [chars.slice(0, 2).join(""), chars.slice(2, 4).join("")];
}

export function resolveSessionKindCategory(
  session: DashboardSession,
): "group" | "direct" | "local" {
  if (session.channel_type === "dashboard") {
    return "local";
  }
  if (session.surface?.kind === "p2p") {
    return "direct";
  }
  return "group";
}

export function resolveTopicTitle(
  session: DashboardSession,
  parentTitle?: string | null,
): string {
  const explicit = session.title?.trim();
  if (explicit) {
    return explicit;
  }
  const activeTask = (session.linkedTasks ?? session.linked_tasks ?? []).find(
    (task) => task.status !== "deleted" && task.title.trim().length > 0,
  );
  if (activeTask) {
    return activeTask.title.trim();
  }
  const anchor = (session.threadAnchorPreview ?? session.thread_anchor_preview)?.trim();
  if (anchor) {
    return anchor.replace(/^@\S+\s+/, "").trim() || anchor;
  }
  const display = (session.displayTitle || session.display_title || "").trim();
  if (
    display &&
    (!parentTitle || display.toLocaleLowerCase() !== parentTitle.trim().toLocaleLowerCase())
  ) {
    return display;
  }
  const latest = (session.latestMessagePreview ?? session.latest_message_preview)?.trim();
  if (latest) {
    return latest;
  }
  return session.thread_id || session.id;
}

export function SessionAvatar({
  name,
  avatarUrl,
  colorKey,
  kind = "group",
  size = "md",
  maxChars = 4,
  className,
}: {
  readonly name: string;
  readonly avatarUrl?: string | null | undefined;
  readonly colorKey: string;
  readonly kind?: "group" | "direct" | "local" | "bot";
  readonly size?: "md" | "lg";
  readonly maxChars?: 2 | 4;
  readonly className?: string;
}) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const sizeClass = size === "lg" ? "size-11" : "size-10";
  const validUrl = avatarUrl && avatarUrl !== brokenUrl ? avatarUrl : null;

  if (kind === "local") {
    return (
      <span
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground",
          sizeClass,
          className,
        )}
      >
        <Monitor className="size-[18px]" />
      </span>
    );
  }

  if (validUrl) {
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 overflow-hidden rounded-full bg-muted",
          sizeClass,
          className,
        )}
      >
        <img
          alt={name}
          className="size-full object-cover"
          loading="lazy"
          onError={() => setBrokenUrl(validUrl)}
          src={validUrl}
        />
      </span>
    );
  }

  if (kind === "bot") {
    const botLabel = Array.from(name.trim() || "Bot").slice(0, 4).join("");
    return (
      <span
        className={cn(
          "inline-grid shrink-0 select-none place-items-center rounded-full bg-primary text-center text-[11px] font-semibold leading-tight text-primary-foreground",
          sizeClass,
          className,
        )}
      >
        {botLabel}
      </span>
    );
  }

  const lines = avatarLinesForName(name, kind === "direct" ? Math.min(maxChars, 2) : maxChars);
  return (
    <span
      className={cn(
        "inline-grid shrink-0 select-none place-items-center rounded-full text-center font-semibold leading-[1.15] tracking-[0.02em] text-white",
        lines.length > 1 ? "text-[10.5px]" : "text-[13px]",
        sizeClass,
        className,
      )}
      style={{ backgroundColor: avatarColorForKey(colorKey) }}
    >
      <span>
        {lines.map((line, idx) => (
          <span key={idx}>
            {idx > 0 ? <br /> : null}
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}
