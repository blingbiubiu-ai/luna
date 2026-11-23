import { ChevronDown, Hash, MessageSquare, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { IdentityLink, type DashboardIdentity } from "@/components/identity-link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentBasePath } from "@/lib/agent-route";
import type {
  DashboardCanonicalUser,
  DashboardSession,
  SessionAttentionState,
} from "@/lib/api";
import { appHistory } from "@/lib/app-history";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import {
  resolveSessionKindCategory,
  resolveTopicTitle,
  SessionAvatar,
} from "./session-avatar";

type SideFilter = "all" | "group" | "direct" | "listening" | "routine";

function isSelfRoutineSession(session: DashboardSession): boolean {
  return (
    session.channel_type === "dashboard" &&
    !session.group_id &&
    (session.title === "心跳" || session.title === "记忆整理")
  );
}

const FIRST_TOPICS = 3;
const TOPIC_STEP = 10;

const ATTENTION_RANK: Record<SessionAttentionState, number> = {
  run: 0,
  wait: 1,
  fail: 2,
  idle: 3,
};

const ATTENTION_SHORT: Partial<Record<SessionAttentionState, { label: string; className: string }>> = {
  run: { label: "进行中", className: "text-[#b07d4f] dark:text-[#d1a273]" },
  wait: { label: "待回答", className: "text-[#5c7c99] dark:text-[#86a3be]" },
  fail: { label: "失败", className: "text-destructive" },
};

interface GroupedConversation {
  readonly root: DashboardSession;
  readonly kind: "group" | "direct" | "local";
  readonly threads: readonly DashboardSession[];
  readonly sortTs: number;
}

export function SessionsList({
  sessions,
  query,
  setQuery,
  loading,
  error,
  selectedSessionId,
  onCreate,
  creating = false,
  createDisabled = false,
  createScope,
  className,
}: {
  readonly sessions: readonly DashboardSession[];
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly loading: boolean;
  readonly error: unknown;
  readonly selectedSessionId?: string | undefined;
  readonly onCreate?: () => void;
  readonly creating?: boolean;
  readonly createDisabled?: boolean;
  readonly createScope?: ReactNode;
  readonly className?: string;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  const [showHistory, setShowHistory] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [topicLimits, setTopicLimits] = useState<Record<string, number>>({});

  const historyCount = sessions.filter((s) => s.bindingStatus === "retired").length;
  const scopedSessions = useMemo(
    () => sessions.filter((s) => (s.bindingStatus === "retired") === showHistory),
    [sessions, showHistory],
  );

  const grouped = useMemo(
    () => buildGroupedConversations(scopedSessions),
    [scopedSessions],
  );

  // Auto-open the parent group whenever the route selects one of its topics.
  useEffect(() => {
    if (!selectedSessionId) return;
    const parent = grouped.find((g) =>
      g.threads.some((th) => th.id === selectedSessionId),
    );
    if (parent) {
      setOpenGroups((prev) =>
        prev[parent.root.id] ? prev : { ...prev, [parent.root.id]: true },
      );
    }
  }, [selectedSessionId, grouped]);

  const normalizedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    return grouped
      .filter((item) => {
        if (sideFilter === "group") return item.kind === "group";
        if (sideFilter === "direct") return item.kind === "direct";
        if (sideFilter === "listening") return item.root.listening === true;
        if (sideFilter === "routine") return isSelfRoutineSession(item.root);
        return true;
      })
      .filter((item) => {
        if (!normalizedQuery) return true;
        return (
          matchesSessionQuery(item.root, normalizedQuery) ||
          item.threads.some((th) => matchesSessionQuery(th, normalizedQuery))
        );
      })
      .sort((left, right) => right.sortTs - left.sortTs);
  }, [grouped, sideFilter, normalizedQuery]);

  const totalCount = scopedSessions.length;

  return (
    <aside
      aria-label="会话边栏"
      className={cn(
        "flex min-h-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <div className="grid gap-2.5 border-b border-border p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h1 className="m-0 text-[15px] font-semibold tracking-normal text-foreground">
              会话
            </h1>
            <span className="text-xs tabular-nums text-muted-foreground">
              {totalCount} 个会话
            </span>
          </div>
          {onCreate ? (
            <div className="flex items-center gap-1.5">
              {createScope}
              <button
                type="button"
                onClick={onCreate}
                disabled={creating || createDisabled}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[7px] border border-border bg-card px-2 text-xs text-foreground shadow-2xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus className="size-3.5 text-muted-foreground" />
                {creating ? "创建中…" : "新建"}
              </button>
            </div>
          ) : null}
        </div>

        {historyCount > 0 ? (
          <div
            role="group"
            aria-label="会话范围"
            className="flex gap-0.5 rounded-[7px] bg-muted p-0.5 text-xs"
          >
            <button
              type="button"
              aria-pressed={!showHistory}
              onClick={() => setShowHistory(false)}
              className={cn(
                "flex-1 rounded-[5px] px-2 py-1 transition-colors",
                !showHistory
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              当前会话
            </button>
            <button
              type="button"
              aria-pressed={showHistory}
              onClick={() => setShowHistory(true)}
              className={cn(
                "flex-1 rounded-[5px] px-2 py-1 transition-colors",
                showHistory
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              历史绑定 ({historyCount})
            </button>
          </div>
        ) : null}

        <label className="flex items-center gap-2 rounded-[7px] border border-border bg-card px-2.5 py-1.5 text-muted-foreground focus-within:border-ring">
          <Search className="size-3.5 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(readInputValue(event))}
            placeholder="搜索群、话题或私聊"
            aria-label={t("Search sessions")}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>

        <div
          role="group"
          aria-label="会话筛选"
          className="flex gap-0.5 rounded-[7px] bg-muted p-0.5"
        >
          {(
            [
              ["all", "全部"],
              ["group", "群聊"],
              ["direct", "私聊"],
              ["listening", "旁听中"],
              ["routine", "自驱"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={sideFilter === key}
              onClick={() => setSideFilter(key)}
              className={cn(
                "flex-1 rounded-[5px] px-1.5 py-1 text-xs transition-colors",
                sideFilter === key
                  ? "bg-card font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <nav
        aria-label="会话列表"
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1.5 pb-3"
      >
        {error ? (
          <DashboardErrorState title={t("Sessions failed to load")} error={error} />
        ) : loading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 7 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : visibleGroups.length === 0 ? (
          <Empty className="h-full py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquare />
              </EmptyMedia>
              <EmptyTitle>
                {normalizedQuery
                  ? "没有匹配的会话"
                  : showHistory
                    ? "暂无历史绑定会话"
                    : sideFilter === "listening"
                      ? "暂无开启旁听的群聊"
                      : sideFilter === "routine"
                        ? "暂无自驱会话（心跳或记忆整理触发后自动生成）"
                        : t("No sessions")}
              </EmptyTitle>
              {!normalizedQuery && !showHistory && sideFilter === "all" ? (
                <EmptyDescription>
                  {t("Luna sessions will appear here after messages arrive.")}
                </EmptyDescription>
              ) : null}
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-0.5">
            {visibleGroups.map(({ root, kind, threads }) => {
              const isRootCurrent = selectedSessionId === root.id;
              const rootTitle = conversationDisplayTitle(root);
              const rootHref = `${base}/sessions/${encodeURIComponent(root.id)}`;
              const orderedThreads = orderTopics(threads);
              const isOpen = Boolean(openGroups[root.id]) || Boolean(normalizedQuery);
              const limit = topicLimits[root.id] ?? FIRST_TOPICS;
              const rootMatches = matchesSessionQuery(root, normalizedQuery);
              let shownThreads = normalizedQuery
                ? orderedThreads.filter(
                    (th) => rootMatches || matchesSessionQuery(th, normalizedQuery),
                  )
                : orderedThreads.slice(0, limit);
              const activeThread = orderedThreads.find(
                (th) => th.id === selectedSessionId,
              );
              if (
                !normalizedQuery &&
                activeThread &&
                !shownThreads.some((th) => th.id === activeThread.id)
              ) {
                shownThreads = [...shownThreads, activeThread];
              }
              const busyCount = threads.filter(
                (th) => (th.attentionState ?? "idle") !== "idle",
              ).length;
              const restCount =
                orderedThreads.length - Math.min(limit, orderedThreads.length);

              return (
                <div key={root.id} className="grid">
                  <div
                    aria-current={isRootCurrent ? "true" : undefined}
                    onClick={(event) => {
                      const target = event.target as HTMLElement | null;
                      if (target?.closest("a,button")) return;
                      appHistory.push(rootHref);
                    }}
                    className={cn(
                      "group/conv grid cursor-pointer grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent",
                      isRootCurrent && "bg-sidebar-accent",
                    )}
                  >
                    <SessionAvatar
                      name={rootTitle}
                      avatarUrl={root.avatarUrl ?? root.surface?.avatarUrl}
                      colorKey={root.group_id ?? root.id}
                      kind={kind}
                      className="row-span-2"
                    />
                    <div className="flex min-w-0 items-center gap-1.5 text-[14px] text-foreground">
                      <a
                        href={rootHref}
                        className={cn(
                          "min-w-0 truncate hover:no-underline",
                          isRootCurrent && "font-semibold",
                        )}
                      >
                        <StandaloneSessionTitle session={root} title={rootTitle} />
                      </a>
                      {root.listening ? (
                        <span className="shrink-0 rounded-[4px] bg-[#5b8a72]/16 px-[5px] text-[10.5px] leading-[17px] font-medium text-[#5b8a72] dark:text-[#7fb096]">
                          旁听
                        </span>
                      ) : null}
                      {sideFilter === "all" && kind === "direct" ? (
                        <span className="shrink-0 rounded-[4px] bg-[#5c7c99]/14 px-[5px] text-[10.5px] leading-[17px] font-medium text-[#5c7c99] dark:text-[#86a3be]">
                          私聊
                        </span>
                      ) : null}
                      {root.kind === "work" ? (
                        <span className="shrink-0 rounded-[4px] bg-[#7d6b91]/16 px-[5px] text-[10.5px] leading-[17px] font-medium text-[#7d6b91] dark:text-[#b2a1c7]">
                          工作
                        </span>
                      ) : null}
                      {isSelfRoutineSession(root) ? (
                        <span className="shrink-0 rounded-[4px] bg-amber-500/18 px-[5px] text-[10.5px] leading-[17px] font-medium text-amber-700 dark:text-amber-300">
                          自驱
                        </span>
                      ) : null}
                    </div>
                    <span className="self-start pt-0.5 text-[11.5px] tabular-nums text-muted-foreground">
                      {formatSidebarTime(root.latest_message_at ?? root.updated_at)}
                    </span>
                    <div className="col-start-2 col-end-4 min-w-0 truncate text-[12.5px] text-muted-foreground">
                      {latestMessagePreviewContent(root) ?? (
                        <span className="opacity-60">暂无消息</span>
                      )}
                    </div>
                  </div>

                  {threads.length > 0 ? (
                    <div className="ml-[50px] grid gap-0.5 pb-1">
                      {isOpen
                        ? shownThreads.map((topic) => (
                            <TopicTreeRow
                              key={topic.id}
                              base={base}
                              topic={topic}
                              parentTitle={rootTitle}
                              isCurrent={selectedSessionId === topic.id}
                            />
                          ))
                        : activeThread ? (
                            <TopicTreeRow
                              base={base}
                              topic={activeThread}
                              parentTitle={rootTitle}
                              isCurrent
                            />
                          ) : null}

                      {!normalizedQuery ? (
                        <div className="flex flex-nowrap items-center gap-1">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => {
                              const nextOpen = !isOpen;
                              setOpenGroups((prev) => ({
                                ...prev,
                                [root.id]: nextOpen,
                              }));
                              if (!nextOpen) {
                                setTopicLimits((prev) => ({
                                  ...prev,
                                  [root.id]: FIRST_TOPICS,
                                }));
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                          >
                            <span>
                              {isOpen
                                ? "收起"
                                : `${threads.length} 个话题${busyCount > 0 ? ` · ${busyCount} 个需关注` : ""}`}
                            </span>
                            <ChevronDown
                              className={cn(
                                "size-3 transition-transform duration-150",
                                isOpen && "rotate-180",
                              )}
                            />
                          </button>
                          {isOpen && restCount > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setTopicLimits((prev) => ({
                                  ...prev,
                                  [root.id]: (prev[root.id] ?? FIRST_TOPICS) + TOPIC_STEP,
                                }))
                              }
                              className="inline-flex items-center rounded-[6px] px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                            >
                              再显示 {Math.min(TOPIC_STEP, restCount)} 个（共{" "}
                              {orderedThreads.length}）
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </nav>
    </aside>
  );
}

function TopicTreeRow({
  base,
  topic,
  parentTitle,
  isCurrent,
}: {
  readonly base: string;
  readonly topic: DashboardSession;
  readonly parentTitle: string;
  readonly isCurrent: boolean;
}) {
  const title = resolveTopicTitle(topic, parentTitle);
  const anchor = (topic.threadAnchorPreview ?? topic.thread_anchor_preview)?.trim();
  const stateMeta = ATTENTION_SHORT[topic.attentionState ?? "idle"];

  return (
    <a
      href={`${base}/sessions/${encodeURIComponent(topic.id)}`}
      aria-current={isCurrent ? "true" : undefined}
      title={anchor && anchor !== title ? `${title} · 锚点：${anchor}` : title}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:no-underline",
        isCurrent && "bg-sidebar-accent font-medium text-foreground",
      )}
    >
      <Hash className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {title}
        {anchor && anchor !== title ? (
          <span className="sr-only"> 锚点：{anchor}</span>
        ) : null}
      </span>
      {stateMeta ? (
        <span className={cn("shrink-0 text-[11px] whitespace-nowrap", stateMeta.className)}>
          {stateMeta.label}
        </span>
      ) : null}
    </a>
  );
}

function StandaloneSessionTitle({
  session,
  title,
}: {
  readonly session: DashboardSession;
  readonly title: string;
}) {
  const anchor = session.threadAnchorPreview ?? session.thread_anchor_preview;
  return (
    <>
      {title}
      {anchor && anchor !== title ? (
        <span className="text-xs font-normal text-muted-foreground">
          {" "}
          锚点：{anchor}
        </span>
      ) : null}
    </>
  );
}

function conversationDisplayTitle(session: DashboardSession): string {
  return (
    session.displayTitle ||
    session.display_title ||
    session.title ||
    session.latest_message_preview ||
    session.id
  );
}

function sessionActivityTs(session: DashboardSession): number {
  return session.latest_message_at ?? session.latestMessageAt ?? session.updated_at;
}

function buildGroupedConversations(
  sessions: readonly DashboardSession[],
): GroupedConversation[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const childrenByParent = new Map<string, DashboardSession[]>();
  const roots: DashboardSession[] = [];

  for (const session of sessions) {
    const parentId = session.parentSessionId ?? session.parent_session_id ?? null;
    if (parentId && parentId !== session.id && byId.has(parentId) && session.kind !== "work") {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(session);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(session);
    }
  }

  return roots.map((root) => {
    const threads = childrenByParent.get(root.id) ?? [];
    const sortTs = Math.max(
      sessionActivityTs(root),
      ...threads.map(sessionActivityTs),
    );
    return {
      root,
      kind: resolveSessionKindCategory(root),
      threads,
      sortTs,
    };
  });
}

function orderTopics(threads: readonly DashboardSession[]): DashboardSession[] {
  return [...threads].sort((left, right) => {
    const rankDiff =
      ATTENTION_RANK[left.attentionState ?? "idle"] -
      ATTENTION_RANK[right.attentionState ?? "idle"];
    if (rankDiff !== 0) return rankDiff;
    return sessionActivityTs(right) - sessionActivityTs(left);
  });
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

function DashboardErrorState({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3">
      <h2 className="text-xs font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {error instanceof Error ? error.message : t("Unknown error")}
      </p>
    </div>
  );
}

function latestMessagePreviewContent(session: DashboardSession): ReactNode | null {
  const preview = session.latest_message_preview ?? session.latestMessagePreview;
  if (!preview) {
    return null;
  }
  const latestSender = identityForCanonicalUser(session.latestSenderUser);
  if (!latestSender) {
    return preview;
  }
  return (
    <>
      <IdentityLink
        className="relative z-10 align-baseline text-[12.5px] text-muted-foreground hover:text-foreground"
        identity={latestSender}
        showIcon={false}
        showKind={false}
      />
      <span>{`: ${preview}`}</span>
    </>
  );
}

function matchesSessionQuery(session: DashboardSession, normalized: string): boolean {
  if (!normalized) return true;
  const haystack = [
    session.id,
    session.title ?? "",
    session.displayTitle ?? "",
    session.display_title ?? "",
    session.surface?.displayName ?? "",
    session.surface?.externalId ?? "",
    session.surface?.kind ?? "",
    session.channel_type,
    session.channel_id,
    session.group_id ?? "",
    session.latestSenderUser?.displayName ?? "",
    session.latestSenderUserId ?? "",
    session.thread_anchor_preview ?? "",
    session.threadAnchorPreview ?? "",
    session.latest_message_preview ?? "",
    session.latestMessagePreview ?? "",
    ...(session.linked_tasks ?? []).map((taskBadge) => taskBadge.title),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalized);
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
    case "shadow":
      return "bot";
    case "system":
      return "system";
    case "human":
    default:
      return "user";
  }
}

function formatSidebarTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);

  if (dayDiff === 0) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  if (dayDiff === 1) {
    return "昨天";
  }
  if (dayDiff > 1 && dayDiff < 7) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]!;
  }
  if (sameYear) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${m}/${d}`;
  }
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}`;
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
