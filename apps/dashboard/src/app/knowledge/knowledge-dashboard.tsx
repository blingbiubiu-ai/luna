import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import {
  BookOpenIcon,
  ChevronRightIcon,
  CopyIcon,
  FileCodeIcon,
  FileTextIcon,
  GitCommitIcon,
  SearchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  WorkspaceFileEntry,
  WorkspaceGrepMatch,
  WorkspaceGitStatus,
  WorkspaceReadFile,
} from "@/lib/api";

interface KnowledgeDashboardProps {
  readonly entries?: readonly WorkspaceFileEntry[];
  readonly fileBrowser?: ReactNode;
  readonly fileMatchesTruncated?: boolean;
  readonly grepMatches: readonly WorkspaceGrepMatch[];
  readonly selectedFile?: WorkspaceReadFile | undefined;
  readonly gitStatus?: WorkspaceGitStatus | undefined;
  readonly gitDiff?: string | undefined;
  readonly query?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly skippedFiles?: number;
  readonly truncated?: boolean;
  readonly loadError?: string | undefined;
  readonly searchQuery?: string;
  readonly searching?: boolean;
  readonly searchError?: string | undefined;
  readonly onSearch?: () => void;
  readonly onCompositionChange?: (composing: boolean) => void;
  readonly onQueryChange?: (query: string) => void;
  readonly onSelectPath?: (path: string) => void;
  readonly onCopy?: (text: string) => void;
}

export function KnowledgeDashboard({
  entries = [],
  fileBrowser,
  fileMatchesTruncated = false,
  grepMatches,
  selectedFile,
  gitStatus,
  gitDiff,
  query = "",
  loading = false,
  onQueryChange,
  searchQuery = query.trim(),
  searching = false,
  loadError,
  skippedFiles = 0,
  truncated = false,
  searchError,
  onSearch,
  onCompositionChange,
  onSelectPath,
  onCopy,
}: KnowledgeDashboardProps) {
  const { t } = useTranslation();
  const files = searchQuery ? entries.filter(entry => entry.path.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())) : entries;
  const breadcrumb = selectedFile?.path.split("/") ?? [];
  const selectedContent = selectedFile?.content ?? "";

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <BookOpenIcon className="size-4" />
          {t("Knowledge")}
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("Knowledge Workspace")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("Workspace browser")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={gitStatus?.clean === false ? "default" : "outline"}>
              {gitStatus?.clean === false ? t("Uncommitted changes") : t("Clean")}
            </Badge>
          </div>
        </div>
      </header>
      <section className="grid min-h-0 flex-1 content-start items-start gap-4 overflow-auto p-5 xl:grid-cols-[22rem_1fr]">
        <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
          <form className="flex min-w-0 gap-2" onSubmit={(event) => { event.preventDefault(); onSearch?.(); }}>
            <Input
              className="min-w-0 flex-1"
              aria-label={t("Search knowledge workspace")}
              onChange={(event) =>
                onQueryChange?.(readInputValue(event.currentTarget))
              }
              onCompositionStart={() => onCompositionChange?.(true)}
              onCompositionEnd={() => onCompositionChange?.(false)}
              placeholder={t("Search file names and contents")}
              value={query}
            />
            <Button aria-label={t("Search")} size="icon" variant="outline" type="submit" disabled={!query.trim() || searching}>
              <SearchIcon className="size-4" />
            </Button>
          </form>
          <section className="min-h-0 rounded-md border">
            <h2 className="border-b px-3 py-2 text-sm font-medium">{t("Files")}</h2>
            <div className="max-h-[28rem] overflow-auto p-2">
              {!searchQuery && fileBrowser ? fileBrowser : <>
                {loading || (searchQuery && searching) ? <p role="status" className="p-2 text-sm">{t("Loading")}</p> : null}
                {loadError || (searchQuery && searchError) ? <p role="alert" className="p-2 text-sm text-destructive">{t("Failed to load files")}: {loadError || searchError}</p> : null}
                {files.length === 0 && !loading && !searching && !loadError && !searchError ? <p className="p-2 text-sm text-muted-foreground">{t("No files found.")}</p> : null}
                {fileMatchesTruncated ? <p className="p-2 text-xs text-muted-foreground">{t("Showing the first 500 matches. Narrow your search.")}</p> : null}
                {files.map(file => <button key={file.path} type="button" title={file.path}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${selectedFile?.path === file.path ? "bg-accent" : ""}`}
                  onClick={() => onSelectPath?.(file.path)}>
                  <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{searchQuery ? file.path : file.path.split("/").at(-1)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                </button>)}
              </>}
            </div>
          </section>
          <section className="rounded-md border">
            <h2 className="border-b px-3 py-2 text-sm font-medium">{t("Search results")}</h2>
            <div className="max-h-72 overflow-auto p-2">
              {searching ? <p role="status" className="p-2 text-sm">{t("Searching…")}</p> : null}
              {!searching && searchError ? <p role="alert" className="p-2 text-sm text-destructive">{t("Search failed")}: {searchError}</p> : null}
              {!searching && !searchError && grepMatches.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">{searchQuery ? t("No content matches.") : t("Enter a keyword to search file names and contents.")}</p>
              ) : null}
              {!searching && skippedFiles > 0 ? <p className="p-2 text-xs text-muted-foreground">{t("Skipped binary or oversized files")}: {skippedFiles}</p> : null}
              {!searching && truncated ? <p role="status" className="p-2 text-xs text-muted-foreground">{t("Showing the first 500 matches. Narrow your search.")}</p> : null}
              {!searching && !searchError && grepMatches.map((match) => (
                <button
                  className="grid w-full gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                  key={`${match.path}:${match.line}:${match.column}`}
                  onClick={() => onSelectPath?.(match.path)}
                  type="button"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {match.path} · {t("Line")} {match.line}
                  </span>
                  <span className="line-clamp-2">{match.text}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>
        <article className="min-w-0 space-y-4">
          <section className="rounded-md border">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                {selectedFile?.kind === "markdown" ? (
                  <FileTextIcon className="size-4 shrink-0" />
                ) : (
                  <FileCodeIcon className="size-4 shrink-0" />
                )}
                <span className="truncate">
                  {selectedFile?.path ?? t("Select a file")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  disabled={!selectedFile}
                  onClick={() => selectedFile && copyText(onCopy, selectedFile.path)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <CopyIcon className="size-3.5" />
                  {t("Copy path")}
                </Button>
                <Button
                  disabled={!selectedFile}
                  onClick={() => copyText(onCopy, selectedContent)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <CopyIcon className="size-3.5" />
                  {t("Copy full text")}
                </Button>
              </div>
            </div>
            <div className="border-b px-3 py-2 text-xs text-muted-foreground">
              {breadcrumb.length > 0 ? (
                <Breadcrumb parts={breadcrumb} />
              ) : (
                t("knowledge workspace")
              )}
            </div>
            <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap p-4 font-mono text-sm leading-6">
              {selectedContent || t("No file selected.")}
            </pre>
          </section>
          <section className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-md border">
              <h2 className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                <GitCommitIcon className="size-4" />
                {t("Git status")}
              </h2>
              <div className="max-h-60 overflow-auto p-3 text-sm">
                {(gitStatus?.entries ?? []).length === 0 ? (
                  <p className="text-muted-foreground">{t("No workspace changes.")}</p>
                ) : null}
                {(gitStatus?.entries ?? []).map((entry) => (
                  <div className="flex gap-2 py-1" key={`${entry.status}:${entry.path}`}>
                    <Badge className="h-fit font-mono" variant="outline">
                      <UiText>{entry.status}</UiText>
                    </Badge>
                    <code className="break-all text-xs">{entry.path}</code>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-md border">
              <h2 className="border-b px-3 py-2 text-sm font-medium">{t("Git diff")}</h2>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs">
                {gitDiff || t("No diff.")}
              </pre>
            </div>
          </section>
        </article>
      </section>
    </main>
  );
}

export function KnowledgeDashboardForTest(props: KnowledgeDashboardProps) {
  return <KnowledgeDashboard {...props} />;
}

function Breadcrumb({ parts }: { readonly parts: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {parts.map((part, index) => (
        <span className="flex items-center gap-1" key={`${part}:${index}`}>
          {index > 0 ? <ChevronRightIcon className="size-3" /> : null}
          {part}
        </span>
      ))}
    </div>
  );
}

function copyText(onCopy: ((text: string) => void) | undefined, text: string): void {
  if (onCopy !== undefined) {
    onCopy(text);
    return;
  }
  const clipboard = (navigator as { clipboard?: { writeText?: (value: string) => Promise<void> } }).clipboard;
  void clipboard?.writeText?.(text);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
}

function readInputValue(target: EventTarget): string {
  return (target as { value?: string }).value ?? "";
}
