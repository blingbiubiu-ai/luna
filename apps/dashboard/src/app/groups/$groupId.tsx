import { createFileRoute } from "@tanstack/react-router";

import { GroupProfile } from "@/app/groups/group-profile";
import {
  useOperations,
  useOperationGrantBatchMutation,
  useOperationGrantDeleteMutation,
  useGroup,
  useGroupMemberDeleteMutation,
  useGroupMemberMutation,
  useUsers,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/groups/$groupId")({
  component: GroupDetailPage,
});

function GroupDetailPage() {
  const { agentId, groupId } = Route.useParams();
  const group = useGroup(groupId, agentId);
  const users = useUsers(agentId);
  const canManageGroups = group.data?.canManageGroups === true;
  const operations = useOperations(undefined, canManageGroups);
  const addMember = useGroupMemberMutation();
  const removeMember = useGroupMemberDeleteMutation();
  const grant = useOperationGrantBatchMutation(groupId);
  const deleteGrant = useOperationGrantDeleteMutation(groupId);

  return (
    <GroupProfile
      addMemberError={addMember.error}
      operations={operations.data ?? []}
      error={group.error}
      grantError={grant.error}
      group={group.data?.group ?? null}
      canManageGroup={canManageGroups}
      isAddingMember={addMember.isPending}
      isGrantingOperation={grant.isPending}
      isLoading={group.isLoading}
      isRemovingMember={removeMember.isPending}
      onAddMember={(input) =>
        addMember.mutateAsync({
          groupId,
          userId: input.userId,
          role: input.role,
        })
      }
      onGrantOperations={(input) =>
        grant.mutateAsync({
          items: input.rules.map((rule) => ({
            subjectType: "group",
            subjectId: groupId,
            ...rule,
          })),
        })
      }
      onRemoveMember={(userId) =>
        removeMember.mutateAsync({
          groupId,
          userId,
        })
      }
      onRemoveGrant={(grantId) => deleteGrant.mutateAsync(grantId)}
      users={users.data ?? []}
    />
  );
}
