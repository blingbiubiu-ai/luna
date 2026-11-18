import { createFileRoute, redirect } from "@tanstack/react-router";

/** Containers are part of each Shadow now; the old address opens the Shadows page. */
export const Route = createFileRoute("/$agentId/settings/containers/")({
  beforeLoad: ({ params }) => { throw redirect({ to: `/${encodeURIComponent(params.agentId)}/settings/channels`, replace: true }); },
});
