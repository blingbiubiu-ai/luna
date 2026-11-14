import { useAgentBasePath } from "@/lib/agent-route";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { MessageSquare, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { IdentityLink } from "@/components/identity-link";
import type { DashboardIdentity } from "@/components/identity-link";
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
import type { DashboardCanonicalUser, DashboardSession } from "@/lib/api";

export function SessionsList({
  sessions,
  query,
  setQuery,
  loading,
  error,

  onCreate,
  creating = false,
  createDisabled = false,
  createScope,
}: {
  readonly onCreate?: () => void;
  readonly creating?: boolean;
  readonly createDisabled?: boolean;
  readonly createScope?: ReactNode;
  readonly sessions: readonly DashboardSession[];
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const [showHistory, setShowHistory] = useState(false);
  const historyCount = sessions.filter(session => session.bindingStatus === "retired").length;
  const filtered = useMemo(
    () => filterSessions(sessions.filter(session => (session.bindingStatus === "retired") === showHistory), query),
    [sessions, query, showHistory],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-4 md:p-7">
      <div className="flex items-start justify-between gap-4"><div>
        <h1 className="text-3xl font-semibold">{t("Sessions")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("Conversations, context, and the work they set in motion.")}</p>
      </div>{onCreate && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {createScope}
          <Button onClick={onCreate} disabled={creating || createDisabled}>{creating ? "正在创建…" : "新建对话"}</Button>
        </div>
      )}</div>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="会话范围" className="flex items-center gap-1 rounded-lg bg-muted p-1">
          <Button size="sm" variant={showHistory ? "ghost" : "outline"} aria-pressed={!showHistory}
            onClick={() => setShowHistory(false)}>当前会话</Button>
          <Button size="sm" variant={showHistory ? "outline" : "ghost"} aria-pressed={showHistory}
            onClick={() => setShowHistory(true)}>历史绑定{historyCount > 0 ? ` (${historyCount})` : ""}</Button>
        </div>
        <div className="relative w-full max-w-xl">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(readInputValue(event))}
            placeholder={t("Search sessions")}
            className="h-9 pl-9"
          />
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length}{t("sessions")}</div>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-2xl border bg-card">
        {error ? (
          <DashboardErrorState
            title={t("Sessions failed to load")}
            error={error}
          />
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
                <MessageSquare />
              </EmptyMedia>
              <EmptyTitle>{query.trim() ? "没有匹配的会话" : showHistory ? "暂无历史绑定会话" : t("No sessions")}</EmptyTitle>
              {!query.trim() && !showHistory && <EmptyDescription>{t("Luna sessions will appear here after messages arrive.")}</EmptyDescription>}
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>{t("Session")}</TableHead>
                <TableHead>{t("Messages")}</TableHead>
                <TableHead>{t("Tasks")}</TableHead>
                <TableHead>{t("Updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((session) => {
                const latestMessagePreview =
                  latestMessagePreviewContent(session);
                const kind = feishuSessionKind(session);
                return (
                  <TableRow key={session.id}>
                    <TableCell className="max-w-[28rem]">
                      <a href={`${base}/sessions/${encodeURIComponent(session.id)}`} className="block truncate font-medium hover:underline">
                        <SessionTitle session={session} />
                      </a>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {kind && <Badge variant="secondary" className="shrink-0">{kind}</Badge>}
                        <span className="truncate">{session.id}</span>
                      </div>
                      {latestMessagePreview ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {latestMessagePreview}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>{session.message_count}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {session.linked_tasks.map((taskBadge) => (
                          <Badge key={taskBadge.id} variant="outline" asChild>
                            {taskBadge.status === "deleted" ? <span className="text-muted-foreground">该任务已删除</span> : <a href={`${base}/tasks/${encodeURIComponent(taskBadge.id)}`}>
                                {taskBadge.title}
                              </a>}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(session.updated_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ScrollArea>
    </div>
  );
}

function feishuSessionKind(session: DashboardSession): string | null {
  if (session.channel_type !== "feishu") return null;
  if (session.surface?.kind === "p2p") return null;
  if (session.thread_id || session.root_message_id) return "飞书话题";
  return session.surface?.kind === "group" || session.surface?.kind === "chat" ? "群聊主会话" : null;
}

export function SessionsListForTest({
  sessions,
  query,
  loading,
  error,
}: {
  readonly sessions: readonly DashboardSession[];
  readonly query: string;
  readonly loading: boolean;
  readonly error: unknown;
}) {
  return (
    <SessionsList
      sessions={sessions}
      query={query}
      setQuery={() => {}}
      loading={loading}
      error={error}

    />
  );
}

function SessionTitle({ session }: { readonly session: DashboardSession }) {
  const title =
    session.displayTitle ||
    session.latest_message_preview ||
    session.id;
  const surface = surfaceSummary(session, title);
  return (
    <>
      {title}
      {session.threadAnchorPreview ? (
        <span className="text-xs font-normal text-muted-foreground">
          {" "}
          锚点：{session.threadAnchorPreview}
        </span>
      ) : null}
      {surface ? (
        <span className="text-xs font-normal text-muted-foreground">
          {" "}
          · {surface}
        </span>
      ) : null}
    </>
  );
}

function surfaceSummary(
  session: DashboardSession,
  title: string,
): string | null {
  const surface = session.surface;
  if (!surface) {
    return null;
  }
  if (surface.kind === "p2p") {
    return null;
  }
  const displayName = surface.displayName?.trim() ?? "";
  if (displayName.length > 0) {
    if (sameDisplayText(displayName, title)) {
      return null;
    }
    return `${surface.kind}: ${displayName}`;
  }
  return surface.externalId.length > 0
    ? `${surface.kind}: ${surface.externalId}`
    : null;
}

function sameDisplayText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
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

function latestMessagePreviewContent(
  session: DashboardSession,
): ReactNode | null {
  if (!session.latest_message_preview) {
    return null;
  }
  const latestSender = identityForCanonicalUser(session.latestSenderUser);
  if (!latestSender) {
    return session.latest_message_preview;
  }
  return (
    <>
      <IdentityLink
        className="align-baseline text-xs"
        identity={latestSender}
        showIcon={false}
        showKind={false}
      />
      <span>{`: ${session.latest_message_preview}`}</span>
    </>
  );
}

function filterSessions(
  sessions: readonly DashboardSession[],
  query: string,
): DashboardSession[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...sessions];
  }
  return sessions.filter((session) => {
    const haystack = [
      session.id,
      session.title ?? "",
      session.displayTitle ?? "",
      session.surface?.displayName ?? "",
      session.surface?.externalId ?? "",
      session.surface?.kind ?? "",
      feishuSessionKind(session) ?? "",
      session.channel_type,
      session.channel_id,
      session.group_id ?? "",
      session.latestSenderUser?.displayName ?? "",
      session.latestSenderUserId ?? "",
      session.thread_anchor_preview ?? "",
      session.threadAnchorPreview ?? "",
      session.latest_message_preview ?? "",
      ...session.linked_tasks.map((taskBadge) => taskBadge.title),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function identityForCanonicalUser(
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

function canonicalUserIdentityKind(kind: string): DashboardIdentity["identityKind"] {
  switch (kind) {
    case "bot":
    case "service":
      return "bot";
    case "system":
      return "system";
    case "human":
    default:
      return "user";
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
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
