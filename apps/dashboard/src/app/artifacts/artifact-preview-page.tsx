import { ArrowUpRight, FileText, MoonStar } from "lucide-react";
import type { ReactNode } from "react";

import { LanguageToggle } from "@/components/language-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type ArtifactPreviewData,
  useArtifactPreview,
} from "@/lib/api/hooks";
import { ApiFetchError } from "@/lib/api/client";
import { UiText, useTranslation } from "@/lib/i18n";

export function ArtifactPreviewPage() {
  const { t } = useTranslation();
  const artifactId = artifactIdFromPath(window.location.pathname);
  const preview = useArtifactPreview(artifactId, window.location.search);

  if (artifactId === undefined) {
    return (
      <ArtifactPreviewShell title={t("Artifact not found")}>
        <PreviewEmptyState message="The artifact preview URL is invalid." />
      </ArtifactPreviewShell>
    );
  }

  if (preview.isLoading) {
    return (
      <ArtifactPreviewShell title={t("Loading artifact")}>
        <PreviewEmptyState message="Loading preview..." />
      </ArtifactPreviewShell>
    );
  }

  if (preview.isError || preview.data === undefined) {
    const errorState = previewErrorState(preview.error);
    return (
      <ArtifactPreviewShell title={t(errorState.title)}>
        <PreviewEmptyState message={errorState.message} />
      </ArtifactPreviewShell>
    );
  }

  const artifact = preview.data.artifact;
  return (
    <ArtifactPreviewShell artifact={artifact} title={artifact.name}>
      <ArtifactPreviewBody artifact={artifact} />
    </ArtifactPreviewShell>
  );
}

function ArtifactPreviewShell({
  artifact,
  children,
  title,
}: {
  readonly artifact?: ArtifactPreviewData;
  readonly children: ReactNode;
  readonly title: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="luna-shell min-h-svh text-foreground">
      <header className="luna-header flex items-center justify-between gap-3 border-b">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-linear-to-br from-amber-100 via-emerald-100 to-sky-300 text-slate-700 shadow-xs ring-1 ring-black/5">
            <MoonStar aria-hidden="true" className="size-5" strokeWidth={1.6} />
          </span>
          <span className="truncate text-sm font-semibold">{t("Luna Artifact")}</span>
        </div>
        <div className="luna-header-actions shrink-0">
          <TooltipProvider>
            <LanguageToggle />
            <ThemeToggle />
          </TooltipProvider>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-7 sm:py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
              {title}
            </h1>
            {artifact && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary"><UiText>{artifact.kind}</UiText></Badge>
                <span className="font-mono [overflow-wrap:anywhere]">{artifact.mimeType}</span>
              </div>
            )}
          </div>
          {artifact && (
            <Button asChild variant="outline">
              <a
                href={artifact.downloadUrl}
                rel="noreferrer"
                target="_blank"
              >
                {t("Open original")}
                <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
        <section className="overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs">
          {children}
        </section>
      </main>
    </div>
  );
}

function ArtifactPreviewBody({
  artifact,
}: {
  readonly artifact: ArtifactPreviewData;
}) {
  switch (artifact.renderMode) {
    case "markdown":
      return (
        <MarkdownPreview content={artifact.content ?? ""} />
      );
    case "html":
      return (
        <iframe
          className="block h-[75vh] w-full bg-white"
          data-testid="artifact-preview-html"
          sandbox=""
          srcDoc={artifact.content ?? ""}
          title={artifact.name}
        />
      );
    case "json":
      return (
        <pre
          className="max-h-[75vh] overflow-auto p-4 text-sm leading-6 sm:p-6"
          data-testid="artifact-preview-json"
        >
          {prettyJson(artifact.content ?? "")}
        </pre>
      );
    case "text":
      return (
        <pre
          className="max-h-[75vh] overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 [overflow-wrap:anywhere] sm:p-6"
          data-testid="artifact-preview-text"
        >
          {artifact.content ?? ""}
        </pre>
      );
    case "image":
      return (
        <div className="grid min-h-[50vh] place-items-center bg-muted/40 p-4 sm:p-6">
          <img
            alt={artifact.name}
            className="max-h-[75vh] max-w-full object-contain"
            data-testid="artifact-preview-image"
            src={artifact.downloadUrl}
          />
        </div>
      );
    case "pdf":
      return (
        <iframe
          className="block h-[75vh] w-full bg-muted"
          data-testid="artifact-preview-pdf"
          src={artifact.downloadUrl}
          title={artifact.name}
        />
      );
    case "binary":
      return (
        <PreviewEmptyState message="This artifact type does not have an inline preview." />
      );
  }
}

function MarkdownPreview({ content }: { readonly content: string }) {
  return (
    <article
      className="mx-auto max-w-[82ch] p-5 text-sm leading-7 [overflow-wrap:anywhere] sm:px-8 sm:py-7"
      data-testid="artifact-preview-markdown"
    >
      {renderMarkdownBlocks(stripInlineHtml(content))}
    </article>
  );
}

function renderMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence !== null) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(
        <pre
          className="my-3 overflow-auto rounded-md bg-muted p-3 text-xs"
          key={`code:${index}`}
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const text = (heading[2] ?? "").trim();
      const className = level <= 2
        ? "mb-2 mt-5 text-lg font-semibold"
        : "mb-2 mt-4 text-base font-semibold";
      blocks.push(
        <h2 className={className} key={`heading:${index}`}>
          {renderMarkdownInline(text)}
        </h2>,
      );
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? "")) {
        items.push(
          <li key={`li:${index}`}>
            {renderMarkdownInline((lines[index] ?? "").replace(/^\s*[-*+]\s+/, ""))}
          </li>,
        );
        index += 1;
      }
      blocks.push(
        <ul className="my-3 list-disc space-y-1 pl-5" key={`ul:${index}`}>
          {items}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        items.push(
          <li key={`oli:${index}`}>
            {renderMarkdownInline((lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""))}
          </li>,
        );
        index += 1;
      }
      blocks.push(
        <ol className="my-3 list-decimal space-y-1 pl-5" key={`ol:${index}`}>
          {items}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[index] ?? "") &&
      !/^```/.test(lines[index] ?? "") &&
      !/^\s*[-*+]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(
      <p className="my-3 whitespace-pre-wrap" key={`p:${index}`}>
        {renderMarkdownInline(paragraph.join("\n"))}
      </p>,
    );
  }

  return blocks;
}

function renderMarkdownInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let offset = 0;
  const tokenPattern = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`\n]+)`)|(\*\*([^*]+)\*\*)/g;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > offset) {
      nodes.push(text.slice(offset, match.index));
    }
    if (match[1] !== undefined && match[3] !== undefined) {
      const src = safePreviewUrl(match[3]);
      nodes.push(
        src === undefined
          ? match[0]
          : (
              <img
                alt={match[2] || "image"}
                className="my-3 max-h-[70vh] max-w-full rounded-md border border-border object-contain"
                key={`image:${match.index}`}
                loading="lazy"
                src={src}
              />
            ),
      );
    } else if (match[4] !== undefined && match[6] !== undefined) {
      const href = safePreviewUrl(match[6]);
      nodes.push(
        href === undefined
          ? match[5]
          : (
              <a
                className="font-medium text-primary hover:underline"
                href={href}
                key={`link:${match.index}`}
                rel="noreferrer"
                target="_blank"
              >
                {match[5]}
              </a>
            ),
      );
    } else if (match[7] !== undefined && match[8] !== undefined) {
      nodes.push(
        <code
          className="rounded bg-muted px-1 py-0.5 text-[0.92em]"
          key={`code:${match.index}`}
        >
          {match[8]}
        </code>,
      );
    } else if (match[9] !== undefined && match[10] !== undefined) {
      nodes.push(<strong key={`strong:${match.index}`}>{match[10]}</strong>);
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) {
    nodes.push(text.slice(offset));
  }
  return nodes;
}

function stripInlineHtml(content: string): string {
  return content.replace(/<\/?(?:font|b|strong|i|em|u|s|br)[^>]*>/gi, "");
}

function safePreviewUrl(url: string): string | undefined {
  if (
    url.startsWith("/") ||
    url.startsWith("#") ||
    /^https?:\/\//i.test(url)
  ) {
    return url;
  }
  return undefined;
}

function PreviewEmptyState({ message }: { readonly message: string }) {
  return (
    <div className="grid min-h-48 place-content-center justify-items-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <span className="grid size-10 place-items-center rounded-xl bg-muted">
        <FileText aria-hidden="true" className="size-5" />
      </span>
      <UiText>{message}</UiText>
    </div>
  );
}

function previewErrorState(error: unknown): {
  readonly title: string;
  readonly message: string;
} {
  if (error instanceof ApiFetchError) {
    if (error.status === 404) {
      return {
        title: "Artifact not found",
        message: "The artifact does not exist or its backing file is missing.",
      };
    }
    if (error.status === 403) {
      return {
        title: "Artifact link expired",
        message: "This artifact link has expired or you do not have access.",
      };
    }
  }
  return {
    title: "Preview unavailable",
    message: "The artifact preview could not be loaded.",
  };
}

function artifactIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/artifacts\/([^/]+)\/preview$/);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
