import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { KnowledgeDashboard } from "@/app/knowledge/knowledge-dashboard";
import {
  useWorkspaceFile,
  useWorkspaceGitDiff,
  useWorkspaceGitStatus,
  useWorkspaceGlob,
  useWorkspaceGrep,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/knowledge/")({
  component: KnowledgePageRoute,
});

function KnowledgePageRoute() {
  const { agentId } = Route.useParams();
  return <AgentKnowledge key={agentId} agentId={agentId} />;
}

function AgentKnowledge({ agentId }: { agentId: string }) {
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setSearchQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query, composing]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const glob = useWorkspaceGlob(agentId, "knowledge", "**/*");
  const grep = useWorkspaceGrep(agentId, "knowledge", searchQuery, "**/*");
  const file = useWorkspaceFile(agentId, "knowledge", selectedPath);
  const gitStatus = useWorkspaceGitStatus(agentId, "knowledge");
  const gitDiff = useWorkspaceGitDiff(agentId, "knowledge");
  const entries = glob.data?.entries ?? [];

  useEffect(() => {
    if (selectedPath === null && entries.length > 0) {
      setSelectedPath(entries[0]?.path ?? null);
    }
  }, [entries, selectedPath]);

  return (
    <KnowledgeDashboard
      entries={entries}
      gitDiff={gitDiff.data?.diff}
      gitStatus={gitStatus.data}
      grepMatches={grep.data?.matches ?? []}
      loading={glob.isLoading}
      loadError={glob.error?.message}
      onQueryChange={setQuery}
      onCompositionChange={setComposing}
      onSearch={() => {
        if (composing) return;
        if (searchQuery === query.trim() && searchQuery) void grep.refetch();
        else setSearchQuery(query.trim());
      }}
      searching={!!query.trim() && (grep.isFetching || searchQuery !== query.trim() || composing)}
      searchError={grep.error?.message}
      searchQuery={searchQuery}
      skippedFiles={grep.data?.skippedFiles ?? 0}
      truncated={grep.data?.truncated ?? false}
      onSelectPath={setSelectedPath}
      query={query}
      selectedFile={file.data}
    />
  );
}
