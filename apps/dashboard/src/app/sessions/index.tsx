import { createFileRoute } from "@tanstack/react-router";

import { SessionsWorkspace } from "./sessions-workspace";

export const Route = createFileRoute("/$agentId/sessions/")({
  component: SessionsPage,
});

function SessionsPage() {
  return <SessionsWorkspace />;
}
