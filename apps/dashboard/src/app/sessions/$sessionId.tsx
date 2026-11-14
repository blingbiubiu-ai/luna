import { useAgentBasePath } from "@/lib/agent-route";
import { DeleteRecordButton } from "@/components/delete-record-button";
import { SessionComposer } from "./session-composer";
import { createFileRoute } from "@tanstack/react-router";

import {
  useSessionTimeline,
  useSession,
} from "@/lib/api";

import { SessionDetailView } from "./session-detail-view";

export const Route = createFileRoute("/$agentId/sessions/$sessionId")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { agentId, sessionId } = Route.useParams();
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
      timeline={timeline?.pages.slice().reverse().flatMap((page) => page.items)}
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
