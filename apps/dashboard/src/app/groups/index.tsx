import { createFileRoute } from "@tanstack/react-router";

import { GroupsDashboard } from "@/app/groups/groups-dashboard";
import {
  useGroupCreateMutation,
  useGroups,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/groups/")({
  component: GroupsPage,
});

function GroupsPage() {
  const { agentId } = Route.useParams();
  const groups = useGroups(agentId);
  const createGroup = useGroupCreateMutation();

  return (
    <GroupsDashboard
      key={agentId}
      createError={createGroup.error}
      groups={groups.data?.groups ?? []}
      listError={groups.error}
      isCreatingGroup={createGroup.isPending}
      canCreateGroup={groups.data?.canManageGroups === true}
      onCreateGroup={(input) => createGroup.mutateAsync({ ...input, agentId })}
    />
  );
}
