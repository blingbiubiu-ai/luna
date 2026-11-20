import { MessageSquare, TerminalSquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ShadowPicker, useShadowScope } from "@/components/shadow-picker";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAgentBasePath, useRouteAgent } from "@/lib/agent-route";
import {
  apiFetch,
  useSession,
  useSessions,
  useSessionTimeline,
  type DashboardSession,
  type DashboardSessionTimelineItem,
} from "@/lib/api";
import { appHistory } from "@/lib/app-history";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { SessionComposer } from "./session-composer";
import { sessionHasContext, SessionDetailView } from "./session-detail-view";
import { SessionListeningSwitch } from "./session-listening-switch";
import { SessionMoreMenu } from "./session-more-menu";
import { SessionsList } from "./sessions-list";

/** Older pages loaded at most while looking for a linked entry. */
const FOCUS_PAGE_LIMIT = 50;

/** Preserves sidebar search/shadow state across `/sessions` <-> `/sessions/$sessionId` transitions. */
const workspaceUiMemory = new Map<string, { query: string; shadowId: string }>();

function timelineEntryIds(item: DashboardSessionTimelineItem): string[] {
  switch (item.type) {
    case "turn":
      return item.messages.flatMap((message) =>
        message.entryId ? [message.entryId] : [],
      );
    case "message":
      return item.message.entryId ? [item.message.entryId] : [];
    case "event":
      return [item.event.entryId];
  }
}

export function SessionsWorkspace({
  routeSessionId,
  focusEntryId,
}: {
  readonly routeSessionId?: string | undefined;
  readonly focusEntryId?: string | undefined;
}) {
  const agent = useRouteAgent();
  const base = useAgentBasePath();
  const selection = useShadowScope(false);
  const remembered = workspaceUiMemory.get(agent.id);
  const [query, setQueryState] = useState(remembered?.query ?? "");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  useEffect(() => {
    if (remembered?.shadowId && !selection.shadow) {
      selection.chooseShadow(remembered.shadowId);
    }
    // Restore remembered shadow selection on route transition mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const setQuery = (nextQuery: string) => {
    setQueryState(nextQuery);
    workspaceUiMemory.set(agent.id, {
      query: nextQuery,
      shadowId: selection.shadow?.id ?? "",
    });
  };

  useEffect(() => {
    workspaceUiMemory.set(agent.id, {
      query,
      shadowId: selection.shadow?.id ?? "",
    });
  }, [agent.id, query, selection.shadow?.id]);

  const sessionsQuery = useSessions(selection.scope);

  const allSessions = sessionsQuery.data ?? [];

  const defaultDesktopSessionId = useMemo(() => {
    const active = allSessions.filter((s) => s.bindingStatus !== "retired");
    if (active.length === 0) return undefined;
    // Pick the newest root conversation on desktop when /sessions is opened without an ID.
    const roots = active.filter(
      (s) => !(s.parentSessionId ?? s.parent_session_id) || s.kind === "work",
    );
    const pool = roots.length > 0 ? roots : active;
    return [...pool].sort(
      (a, b) =>
        (b.latest_message_at ?? b.updated_at) -
        (a.latest_message_at ?? a.updated_at),
    )[0]?.id;
  }, [allSessions]);

  const effectiveSessionId = routeSessionId ?? defaultDesktopSessionId;
  const mobileShowingDetail = Boolean(routeSessionId);

  async function createLocalConversation() {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await apiFetch<{ sessionId: string }>("/sessions/dashboard", {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.id,
          shadowId: selection.shadow?.id ?? agent.defaultShadowId,
        }),
      });
      appHistory.push(`${base}/sessions/${encodeURIComponent(result.sessionId)}`);
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      data-view={mobileShowingDetail ? "detail" : "list"}
      className="@container flex h-full min-h-0 flex-1 overflow-hidden border-t border-border bg-card"
    >
      <div className="grid h-full min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] overflow-hidden @max-[680px]:grid-cols-1 max-[760px]:grid-cols-1">
        <SessionsList
          sessions={allSessions}
          query={query}
          setQuery={setQuery}
          selectedSessionId={effectiveSessionId}
          loading={sessionsQuery.isLoading || selection.loading}
          error={createError ?? sessionsQuery.error ?? selection.error}
          onCreate={() => void createLocalConversation()}
          creating={creating}
          createDisabled={selection.loading || Boolean(selection.error)}
          createScope={
            selection.availableShadows.length > 1 ? (
              <ShadowPicker selection={selection} disabled={creating} size="sm" />
            ) : null
          }
          className={cn(
            mobileShowingDetail && "@max-[680px]:hidden max-[760px]:hidden",
          )}
        />

        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
            !mobileShowingDetail && "@max-[680px]:hidden max-[760px]:hidden",
          )}
        >
          {effectiveSessionId ? (
            <SessionDetailPane
              key={effectiveSessionId}
              agentId={agent.id}
              sessionId={effectiveSessionId}
              focusEntryId={routeSessionId ? focusEntryId : undefined}
              allSessions={allSessions}
            />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquare />
                </EmptyMedia>
                <EmptyTitle>选择一个会话</EmptyTitle>
                <EmptyDescription>
                  从左侧选择群聊、话题或私聊查看消息，或点击「新建对话」在 Dashboard 直接对话。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>
      </div>
    </div>
  );
}

function SessionDetailPane({
  agentId,
  sessionId,
  focusEntryId,
  allSessions,
}: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly focusEntryId?: string | undefined;
  readonly allSessions: readonly DashboardSession[];
}) {
  const { t } = useTranslation();
  const base = useAgentBasePath();
  const [contextOpenSignal, setContextOpenSignal] = useState(0);

  const {
    data: session,
    error: sessionsError,
    isError: sessionsIsError,
    isLoading: sessionsLoading,
  } = useSession(sessionId, agentId);

  const {
    data: timeline,
    error: timelineError,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading: timelineLoading,
  } = useSessionTimeline(sessionId, agentId);

  const items = timeline?.pages.slice().reverse().flatMap((page) => page.items);
  const focusLoaded =
    focusEntryId !== undefined &&
    (items ?? []).some((item) => timelineEntryIds(item).includes(focusEntryId));
  const focusPages = useRef(0);

  // Page back through older history until the linked entry is on the page.
  useEffect(() => {
    if (
      !focusEntryId ||
      focusLoaded ||
      timeline === undefined ||
      !hasNextPage ||
      isFetching ||
      isFetchNextPageError
    ) {
      return;
    }
    if (focusPages.current >= FOCUS_PAGE_LIMIT) return;
    focusPages.current += 1;
    void fetchNextPage({ cancelRefetch: false });
  }, [
    focusEntryId,
    focusLoaded,
    timeline,
    hasNextPage,
    isFetching,
    isFetchNextPageError,
    fetchNextPage,
  ]);

  const focusMissing =
    focusEntryId !== undefined &&
    timeline !== undefined &&
    !focusLoaded &&
    !hasNextPage &&
    !isFetching;

  const listFallback = allSessions.find((s) => s.id === sessionId);
  const mergedSession = session ?? listFallback;
  const parentId =
    mergedSession?.parentSessionId ?? mergedSession?.parent_session_id ?? null;
  const parentFromList = parentId
    ? allSessions.find((s) => s.id === parentId)
    : undefined;

  const isTopic = Boolean(
    mergedSession &&
      mergedSession.kind !== "work" &&
      (mergedSession.parentSession ||
        parentId ||
        (Boolean(mergedSession.thread_id || mergedSession.root_message_id) &&
          mergedSession.surface?.kind !== "p2p")),
  );
  const groupName =
    mergedSession?.parentSession?.displayTitle ??
    parentFromList?.displayTitle ??
    mergedSession?.surface?.displayName ??
    mergedSession?.displayTitle ??
    null;

  const showNotFound = !sessionsLoading && !sessionsIsError && !mergedSession;

  return (
    <SessionDetailView
      embeddedInSplit
      contextOpenSignal={contextOpenSignal}
      parentSessionOverride={parentFromList}
      actions={
        mergedSession ? (
          <>
            <SessionListeningSwitch
              agentId={agentId}
              sessionId={sessionId}
              isTopic={isTopic}
              groupName={groupName}
            />
            <a
              href={`${base}/terminals?sessionId=${encodeURIComponent(sessionId)}`}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-border bg-card px-2.5 text-[13px] text-foreground shadow-2xs transition-colors hover:bg-accent hover:no-underline"
            >
              <TerminalSquareIcon className="size-3.5" />
              {t("Open TUI")}
            </a>
            <SessionMoreMenu
              agentId={agentId}
              sessionId={sessionId}
              hasContext={sessionHasContext(mergedSession)}
              onOpenContext={() => setContextOpenSignal((n) => n + 1)}
              onDeleted={() => {
                const fallbackTarget = parentId
                  ? `${base}/sessions/${encodeURIComponent(parentId)}`
                  : `${base}/sessions`;
                appHistory.push(fallbackTarget);
              }}
            />
          </>
        ) : null
      }
      composer={
        <SessionComposer
          key={sessionId}
          agentId={agentId}
          sessionId={sessionId}
          disabled={!mergedSession || mergedSession.status !== "active" || sessionsIsError}
        />
      }
      sessionId={sessionId}
      session={mergedSession}
      timeline={items}
      focusEntryId={focusEntryId}
      focusMissing={focusMissing}
      history={{
        hasOlder: hasNextPage,
        loading: isFetchingNextPage,
        failed: isFetchNextPageError,
        load: () => {
          if (!isFetching) void fetchNextPage({ cancelRefetch: false });
        },
      }}
      loading={timelineLoading}
      error={
        sessionsIsError || (timelineError && timeline === undefined)
          ? sessionsError ?? timelineError
          : null
      }
      showNotFound={showNotFound}
    />
  );
}
