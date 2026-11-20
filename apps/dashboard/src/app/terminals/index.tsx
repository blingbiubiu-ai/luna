import { createFileRoute } from "@tanstack/react-router";
import { TuiWorkbench } from "./tui-workbench";

export const Route = createFileRoute("/$agentId/terminals/")({
  validateSearch: (search: Record<string, unknown>): {
    contextId?: string;
    sessionId?: string;
    taskId?: string;
  } => ({
    ...(typeof search.contextId === "string" && search.contextId ? { contextId: search.contextId } : {}),
    ...(typeof search.sessionId === "string" && search.sessionId ? { sessionId: search.sessionId } : {}),
    ...(typeof search.taskId === "string" && search.taskId ? { taskId: search.taskId } : {}),
  }),
  component: TerminalsPage,
});

function TerminalsPage() {
  const { agentId } = Route.useParams();
  const { contextId, sessionId, taskId } = Route.useSearch();
  return (
    <TuiWorkbench
      agentId={agentId}
      focusContextId={contextId}
      focusSessionId={sessionId}
      focusTaskId={taskId}
    />
  );
}
