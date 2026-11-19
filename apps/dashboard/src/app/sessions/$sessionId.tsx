import { useAgentBasePath } from "@/lib/agent-route";
import { DeleteRecordButton } from "@/components/delete-record-button";
import { SessionComposer } from "./session-composer";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  useSessionTimeline,
  useSession,
  type DashboardSessionTimelineItem,
} from "@/lib/api";

import { SessionDetailView } from "./session-detail-view";

export const Route = createFileRoute("/$agentId/sessions/$sessionId")({
  /** `entry` opens the session at one timeline entry, such as where a memory was written. */
  validateSearch: (search: Record<string, unknown>): { entry?: string } =>
    typeof search.entry === "string" && search.entry ? { entry: search.entry } : {},
  component: SessionDetailPage,
});

/** Older pages loaded at most while looking for a linked entry. */
const FOCUS_PAGE_LIMIT = 50;

function timelineEntryIds(item: DashboardSessionTimelineItem): string[] {
  switch (item.type) {
    case "turn": return item.messages.flatMap((message) => message.entryId ? [message.entryId] : []);
    case "message": return item.message.entryId ? [item.message.entryId] : [];
    case "event": return [item.event.entryId];
  }
}

function SessionDetailPage() {
  const { agentId, sessionId } = Route.useParams();
  const { entry: focusEntryId } = Route.useSearch();
  const base = useAgentBasePath();
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
  const focusLoaded = focusEntryId !== undefined && (items ?? []).some((item) => timelineEntryIds(item).includes(focusEntryId));
  const focusPages = useRef(0);
  // Page back through older history until the linked entry is on the page.
  useEffect(() => {
    if (!focusEntryId || focusLoaded || timeline === undefined || !hasNextPage || isFetching || isFetchNextPageError) return;
    if (focusPages.current >= FOCUS_PAGE_LIMIT) return;
    focusPages.current += 1;
    void fetchNextPage({ cancelRefetch: false });
  }, [focusEntryId, focusLoaded, timeline, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  const focusMissing = focusEntryId !== undefined && timeline !== undefined && !focusLoaded && !hasNextPage && !isFetching;
  const showNotFound =
    !sessionsLoading &&
    !sessionsIsError &&
    !session;

  return (
    <SessionDetailView
      actions={session ? <DeleteRecordButton kind="sessions" id={sessionId} path={`/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}`} name={session.displayTitle || session.title || sessionId} onDeleted={() => { window.location.assign(`${base}/sessions`); }} /> : null}
      key={sessionId}
      composer={<SessionComposer key={sessionId} agentId={agentId} sessionId={sessionId} disabled={!session || session.status !== "active" || sessionsIsError} />}
      sessionId={sessionId}
      session={session}
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
