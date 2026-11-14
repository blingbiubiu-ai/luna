import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useUsers } from "@/lib/api";

import { UsersList } from "./users-list";

export const Route = createFileRoute("/$agentId/users/")({ component: UsersPage });

function UsersPage() {
  const { agentId } = Route.useParams();
  const { data: users, error, isError, isLoading } = useUsers(agentId);
  const [query, setQuery] = useState("");

  return (
    <UsersList
      users={users ?? []}
      query={query}
      setQuery={setQuery}
      loading={isLoading}
      error={isError ? error : null}
    />
  );
}
