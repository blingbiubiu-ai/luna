import { useState } from "react";
import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useWorkspaceDirectory, type WorkspaceDirectoryEntry } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

export function KnowledgeDirectoryBrowser({ agentId, selectedPath, onSelectPath }: {
  agentId: string; selectedPath: string | null; onSelectPath: (path: string) => void;
}) {
  return <DirectoryContents agentId={agentId} path="" selectedPath={selectedPath} onSelectPath={onSelectPath} />;
}

function DirectoryContents({ agentId, path, selectedPath, onSelectPath }: {
  agentId: string; path: string; selectedPath: string | null; onSelectPath: (path: string) => void;
}) {
  const query = useWorkspaceDirectory(agentId, "knowledge", path);
  const { t } = useTranslation();
  if (query.isLoading) return <p role="status" className="p-2 text-sm">{t("Loading")}</p>;
  if (query.error) return <div className="p-2 text-sm">
    <p role="alert" className="text-destructive">{t("Failed to load files")}: {query.error.message}</p>
    <button type="button" className="mt-1 underline" onClick={() => void query.refetch()}>{t("Retry")}</button>
  </div>;
  if (!query.data?.entries.length) return <p className="p-2 text-sm text-muted-foreground">{t("No files found.")}</p>;
  return <>{query.data.entries.map(entry => <DirectoryEntry key={entry.path} agentId={agentId} entry={entry} selectedPath={selectedPath} onSelectPath={onSelectPath} />)}</>;
}

function DirectoryEntry({ agentId, entry, selectedPath, onSelectPath }: {
  agentId: string; entry: WorkspaceDirectoryEntry; selectedPath: string | null; onSelectPath: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entry.type === "file") return <button type="button" title={entry.path}
    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${selectedPath === entry.path ? "bg-accent" : ""}`}
    onClick={() => onSelectPath(entry.path)}>
    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    <span className="shrink-0 text-xs text-muted-foreground">{entry.sizeBytes < 1024 ? `${entry.sizeBytes} B` : `${(entry.sizeBytes / 1024).toFixed(1)} KB`}</span>
  </button>;
  return <div className="py-1">
    <button type="button" title={entry.path} aria-expanded={expanded} aria-label={entry.path}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-accent"
      onClick={() => setExpanded(value => !value)}>
      <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`} />
      <FolderIcon className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{entry.name}</span>
    </button>
    {expanded && <div className="ml-4 border-l pl-2"><DirectoryContents agentId={agentId} path={entry.path} selectedPath={selectedPath} onSelectPath={onSelectPath} /></div>}
  </div>;
}
