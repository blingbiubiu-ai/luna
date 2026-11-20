import { createFileRoute } from "@tanstack/react-router";

import { SessionsWorkspace } from "./sessions-workspace";

export const Route = createFileRoute("/$agentId/sessions/$sessionId")({
  /** `entry` opens the session at one timeline entry, such as where a memory was written. */
  validateSearch: (search: Record<string, unknown>): { entry?: string } =>
    typeof search.entry === "string" && search.entry ? { entry: search.entry } : {},
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { sessionId } = Route.useParams();
  const { entry } = Route.useSearch();
  return <SessionsWorkspace routeSessionId={sessionId} focusEntryId={entry} />;
}
