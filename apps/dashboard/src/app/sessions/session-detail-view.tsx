import { useAgentBasePath } from "@/lib/agent-route";
import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { ContextPackList, SeedRecordList } from "@/components/context-pack-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { IdentityAvatar, IdentityLink } from "@/components/identity-link";
import type { DashboardIdentity } from "@/components/identity-link";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardCanonicalUser, DashboardSession, DashboardSessionMessage, DashboardSessionRunnerAttempt, DashboardSessionTimelineItem } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function SessionDetailView({
  sessionId,
  session,
  timeline,
  messages,
  history,
  loading,
  error,
  showNotFound,

  composer,
  actions,
  focusEntryId,
  focusMissing = false,
}: {
  /** A timeline entry to open the session at, such as where a memory was written. */
  focusEntryId?: string | undefined;
  /** The entry to open at is not in this session any more. */
  focusMissing?: boolean;
  composer?: ReactNode;
  actions?: ReactNode;
  sessionId: string;
  session: DashboardSession | undefined;
  timeline?: readonly DashboardSessionTimelineItem[] | undefined;
  messages?: readonly DashboardSessionMessage[] | undefined;
  turns?: unknown;
  history?: { hasOlder: boolean; loading: boolean; failed: boolean; load: () => void };
  loading: boolean;
  error: unknown;
  showNotFound: boolean;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const timelineItems = timeline ??
    (messages ?? []).map((message) => ({
      type: "message" as const,
      message,
    }));

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  const followLatest = useRef(true);
  const previousFirstRow = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const hasTimelineRows = !error && !showNotFound && !loading && timelineItems.length > 0;
  const focusedEntry = useRef<string | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!hasTimelineRows || !viewport || !content || typeof ResizeObserver === "undefined") return;

    // Images and other rich content can grow after the initial scroll to bottom.
    const observer = new ResizeObserver(() => {
      if (!followLatest.current) return;
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop.current = viewport.scrollTop;
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [hasTimelineRows]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const first = rowsRef.current?.firstElementChild as HTMLDivElement | null | undefined;
    if (!viewport || !first) return;
    const previous = previousFirstRow.current;
    if (!previous) {
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop.current = viewport.scrollTop;
    } else if (previous.element !== first && previous.element.isConnected) {
      // The old first row remains mounted when an older page is prepended.
      viewport.scrollTop += previous.element.offsetTop - previous.offset;
      lastScrollTop.current = viewport.scrollTop;
    }
    previousFirstRow.current = { element: first, offset: first.offsetTop };
  });

  // Runs after the scroll-to-latest above, so the linked message wins once it is on the page.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!focusEntryId || focusedEntry.current === focusEntryId || !viewport) return;
    const target = viewport.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focusEntryId)}"]`);
    if (!target) return;
    focusedEntry.current = focusEntryId;
    followLatest.current = false;
    target.dataset.focused = "true";
    target.scrollIntoView({ block: "center" });
    lastScrollTop.current = viewport.scrollTop;
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4">
        <Button variant="ghost" size="icon" asChild>
          <a href={`${base}/sessions`}>
            <ArrowLeft className="size-4" />
          </a>
        </Button>
        <MessageSquare className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {session?.displayTitle || session?.title || sessionId}
            {session?.threadAnchorPreview ? (
              <span className="text-xs font-normal text-muted-foreground">
                {" "}
                锚点：{session.threadAnchorPreview}
              </span>
            ) : null}
          </h1>
          <div className="truncate text-xs text-muted-foreground">
            {session
              ? session.channel_type === "dashboard"
                ? "本地会话"
                : `${session.channel_type}/${session.channel_id}`
              : sessionId}
            {session?.workerId !== undefined ? (
              <span title={session.workerId ?? undefined}>
                {" · "}{t("Worker binding")}{": "}{session.workerId ?? t("Unassigned Worker")}
              </span>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          {linkedTaskBadges(session).map((taskBadge) => (
            <Badge key={taskBadge.id} variant="outline" asChild>
              {taskBadge.status === "deleted" ? <span className="text-muted-foreground">该任务已删除</span> : <a href={`${base}/tasks/${encodeURIComponent(taskBadge.id)}`}>
                  {taskBadge.title}
                </a>}
            </Badge>
          ))}
        </div>
        {actions}
      </header>

      <div
        ref={viewportRef}
        aria-label={t("Session timeline")}
        role="region"
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          const scrollingUp = scrollTop < lastScrollTop.current;
          if (scrollTop !== lastScrollTop.current) {
            followLatest.current = scrollHeight - clientHeight - scrollTop <= 2;
          }
          lastScrollTop.current = scrollTop;
          if (
            history?.hasOlder && !history.loading && !history.failed &&
            scrollingUp && scrollTop <= 80
          ) {
            history.load();
          }
        }}
      >
        {error ? (
          <DashboardErrorState
            title={t("Session failed to load")}
            error={error}
          />
        ) : showNotFound ? (
          <DashboardErrorState
            title={t("Session not found")}
            error={new Error(sessionId)}
          />
        ) : loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div ref={contentRef} className="space-y-3 p-4">
            {sessionHasContext(session) ? (
              <SessionContextDetails session={session} />
            ) : null}
            {history?.hasOlder ? (
              <div className="flex justify-center">
                <Button variant="ghost" size="sm" disabled={history.loading} onClick={history.load}>
                  {history.loading ? t("Loading history…") : history.failed ? t("Retry loading history") : t("Load older messages")}
                </Button>
              </div>
            ) : null}
            {focusMissing ? (
              <div role="status" className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                要定位的那条消息已不在这个会话里，可能已被删除。
              </div>
            ) : null}
            {timelineItems.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t("No messages recorded.")}</div>
            ) : (
              <div ref={rowsRef} className="space-y-3">
                {timelineItems.map((item) => (
                  <div key={timelineItemKey(item)}>
                    {item.type === "turn" ? (
                      <TurnTimelineGroup item={item} />
                    ) : item.type === "event" ? (
                      <ConversationControlTimelineItem event={item.event} />
                    ) : (
                      <MessageTimelineItem message={item.message} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {composer}
    </div>
  );
}

function timelineItemKey(item: DashboardSessionTimelineItem): string {
  switch (item.type) {
    case "turn":
      return `turn:${item.messages[0]?.entryId ?? item.turn.id}`;
    case "message":
      return `message:${item.message.entryId ?? item.message.id}`;
    case "event":
      return `event:${item.event.entryId}`;
  }
}

function ConversationControlTimelineItem({
  event,
}: {
  readonly event: Extract<
    DashboardSessionTimelineItem,
    { type: "event" }
  >["event"];
}) {
  const { t } = useTranslation();
  return (
    <section
      className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
      data-testid={`session-event-${event.entryId}`}
    >
      <div className="font-medium text-foreground/80">{event.summary}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]">
        <span>{event.controlKind}</span>
        <span>{event.reasonKind}</span>
        <span title={event.turnId}>{t("turn")}{" "}{shortEntityId(event.turnId)}</span>
      </div>
    </section>
  );
}

function SessionContextDetails({
  session,
}: {
  readonly session: DashboardSession;
}) {
  const { t } = useTranslation();
  const launchPackIds = new Set(
    (session.launchContextPacks ?? []).map((pack) => pack.id),
  );
  const otherContextPacks = (session.contextPacks ?? []).filter(
    (pack) => !launchPackIds.has(pack.id),
  );

  return (
    <details className="rounded-md border bg-muted/20 p-3 text-sm">
      <summary className="cursor-pointer text-sm font-medium">{t("Context")}<span className="ml-2 text-xs font-normal text-muted-foreground">
          {(session.contextPacks ?? []).length}{t("packs /")}{" "}
          {(session.seedRecords ?? []).length}{t("seeds")}</span>
      </summary>
      <div className="mt-3 space-y-4">
        <ContextPackList
          defaultOpen={false}
          emptyText={t("No launch context packs recorded.")}
          packs={session.launchContextPacks ?? []}
          title={t("Launch Context Packs")}
        />
        {otherContextPacks.length > 0 ? (
          <ContextPackList
            defaultOpen={false}
            packs={otherContextPacks}
            title={t("Context Packs")}
          />
        ) : null}
        <SeedRecordList records={session.seedRecords ?? []} />
      </div>
    </details>
  );
}

function sessionHasContext(
  session: DashboardSession | undefined,
): session is DashboardSession {
  if (!session) {
    return false;
  }
  return (
    (session.contextPacks?.length ?? 0) > 0 ||
    (session.launchContextPacks?.length ?? 0) > 0 ||
    (session.seedRecords?.length ?? 0) > 0
  );
}

function TurnTimelineGroup({
  item,
}: {
  readonly item: Extract<DashboardSessionTimelineItem, { type: "turn" }>;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="group/turn relative"
      data-testid={`session-turn-group-${item.turn.id}`}
    >
      <div
        aria-label={turnDetailsText(item)}
        className="absolute -left-4 bottom-0 top-0 z-10 flex w-4 justify-start focus:outline-none"
        data-testid="turn-hover-rail"
        tabIndex={0}
      >
        <span className="h-full w-px bg-muted-foreground/20 transition-colors group-hover/turn:bg-muted-foreground/50 group-focus-within/turn:bg-muted-foreground/50" />
        <div
          className="pointer-events-none absolute -top-4 left-2 z-20 flex h-4 max-w-[calc(100vw-22rem)] items-center gap-x-2 overflow-hidden whitespace-nowrap rounded-sm border bg-popover px-1.5 text-[10px] text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 group-focus-within/turn:pointer-events-auto group-focus-within/turn:opacity-100"
          data-testid="turn-hover-details"
        >
          <span className="font-mono text-foreground" title={item.turn.id}>{t("turn")}{" "}{shortEntityId(item.turn.id)}
          </span>
          <span><UiText>{item.turn.status}</UiText></span>
          <span><UiText>{formatCount(item.turn.messageCount, "message")}</UiText></span>
          {item.turn.visibleMessageCount !== item.turn.messageCount ? (
            <span>{item.turn.visibleMessageCount}{t("visible")}</span>
          ) : null}
          <span title={item.turn.latestMessageId}>{t("latest")}{shortEntityId(item.turn.latestMessageId)}
          </span>
          <MessageHeaderTagList tags={turnHeaderTags(item)} />
        </div>
      </div>
      <div className="space-y-2">
        {item.messages.map((message) => (
          <MessageTimelineItem
            key={message.id}
            message={message}

            nested
          />
        ))}
        <TurnRunnerAttempts attempts={item.turn.runnerAttempts ?? []} />
      </div>
    </section>
  );
}

function TurnRunnerAttempts({
  attempts,
}: {
  readonly attempts: readonly DashboardSessionRunnerAttempt[];
}) {
  const { t } = useTranslation();
  if (attempts.length === 0) {
    return null;
  }
  return (
    <details
      className="ml-4 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs"
      data-testid="session-runner-attempts"
    >
      <summary className="cursor-pointer text-muted-foreground">{t("Main Runner Attempts")}</summary>
      <div className="mt-2 space-y-3">
        {attempts
          .slice()
          .sort((left, right) => left.attemptIndex - right.attemptIndex)
          .map((attempt) => (
            <section
              key={attempt.id}
              className="space-y-2 border-t border-border/60 pt-2 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">
                  {attempt.attemptKind === "primary"
                    ? t("Primary Attempt")
                    : t("Repair Attempt")}
                </span>
                <Badge variant="secondary" className="h-5 rounded-sm px-1.5">
                  <UiText>{attempt.status}</UiText>
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {attempt.runnerType}
                </span>
              </div>
              <AttemptCodeBlock title={t("Input Prompt")} value={attempt.inputPrompt} />
              <AttemptCodeBlock title={t("Raw Output")} value={attempt.rawOutput ?? ""} />
              {attempt.parseErrorJson !== null ? (
                <AttemptCodeBlock
                  title={t("Parse Error")}
                  value={formatAttemptJson(attempt.parseErrorJson)}
                />
              ) : null}
              {attempt.parsedActionJson !== null ? (
                <AttemptCodeBlock
                  title={t("Parsed Action")}
                  value={formatAttemptJson(attempt.parsedActionJson)}
                />
              ) : null}
            </section>
          ))}
      </div>
    </details>
  );
}

function AttemptCodeBlock({
  title,
  value,
}: {
  readonly title: string;
  readonly value: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase text-muted-foreground">
        {title}
      </div>
      <pre className="max-h-48 overflow-auto rounded-sm bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </div>
  );
}

function formatAttemptJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function MessageTimelineItem({
  message,

  nested = false,
}: {
  readonly message: DashboardSessionMessage;

  readonly nested?: boolean;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const fallbackKind = messageIdentityFallbackKind(message);
  const senderIdentity = messageDisplayIdentity(message);
  const timelineEntryId = messageTimelineEntryId(message);

  return (
    <article
      className="group/message grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md px-1 py-2 data-[focused=true]:bg-primary/5 data-[focused=true]:ring-2 data-[focused=true]:ring-primary/40"
      data-message-role={message.role}
      data-entry-id={timelineEntryId}
      data-nested={nested ? "true" : undefined}
      data-testid={`session-message-${message.id}`}
    >
      <div data-testid="message-avatar" className="pt-0.5">
        <IdentityAvatar
          className="size-8"
          fallbackKind={fallbackKind}
          identity={senderIdentity}
        />
      </div>
      <div className="min-w-0 max-w-[860px]">
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
          data-testid="message-header"
        >
          <IdentityLink
            className="max-w-64 text-sm text-foreground"
            fallbackKind={fallbackKind}
            identity={senderIdentity}
            showIcon={false}
            showKind={false}
          />
          <span className="text-[11px] text-muted-foreground">
            {formatTime(message.created_at)}
          </span>
          <span className="sr-only"><UiText>{message.role}</UiText>{t("message")}</span>
          <MessageHeaderTagList tags={messageHeaderTags(message, timelineEntryId, base)} />
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">
          {message.presentation?.kind === "task_final_answer" ? (
            <TaskFinalAnswerCard
              message={message}

            />
          ) : message.presentation?.kind === "status_card" ? (
            <StatusCard
              message={message}

            />
          ) : message.presentation?.kind === "rich_markdown_card" ? (
            <RichMarkdownMessageCard
              message={message}

            />
          ) : (
            renderMessageContent(message)
          )}
        </div>
      </div>
    </article>
  );
}

type MessageHeaderTagVisibility = "always" | "hover";
type MessageHeaderTagTone = "default" | "muted" | "secondary";

interface MessageHeaderTag {
  readonly id: string;
  readonly label: string;
  readonly visibility: MessageHeaderTagVisibility;
  readonly tone?: MessageHeaderTagTone;
  readonly href?: string;
  readonly title?: string;
  readonly copyText?: string;
  readonly copyLabel?: string;
  readonly testId?: string;
  readonly labelClassName?: string;
}

function MessageHeaderTagList({
  tags,
}: {
  readonly tags: readonly MessageHeaderTag[];
}) {
  const sortedTags = [...tags].sort((left, right) =>
    tagVisibilityOrder(left.visibility) - tagVisibilityOrder(right.visibility)
  );
  return (
    <>
      {sortedTags.map((tag) => (
        <MessageHeaderTagItem key={tag.id} tag={tag} />
      ))}
    </>
  );
}

function MessageHeaderTagItem({ tag }: { readonly tag: MessageHeaderTag }) {
  return (
    <span
      className={messageHeaderTagClassName(tag)}
      data-header-tag="true"
      data-tag-visibility={tag.visibility}
      data-testid={tag.testId}
      title={tag.title}
    >
      {messageHeaderTagContent(tag)}
    </span>
  );
}

function messageHeaderTagContent(tag: MessageHeaderTag): ReactNode {
  const label = (
    <span className={cn("truncate", tag.labelClassName)}>{tag.label}</span>
  );
  if (tag.copyText !== undefined) {
    return (
      <button
        aria-label={tag.copyLabel ?? `Copy ${tag.label}`}
        className="min-w-0 max-w-full truncate focus:outline-none"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void copyHeaderTagText(tag.copyText ?? "");
        }}
        title={tag.title}
        type="button"
      >
        {label}
      </button>
    );
  }
  if (tag.href) {
    return (
      <a className="min-w-0 max-w-full truncate" href={tag.href}>
        {label}
      </a>
    );
  }
  return label;
}

function messageHeaderTagClassName(tag: MessageHeaderTag): string {
  return cn(
    "inline-flex h-5 max-w-64 items-center overflow-hidden rounded-sm border px-1.5 text-[11px] font-normal shadow-none transition-opacity",
    tag.visibility === "hover" &&
      "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
    tag.tone === "secondary"
      ? "border-transparent bg-secondary text-secondary-foreground"
      : tag.tone === "muted"
        ? "border-transparent bg-muted/40 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground"
        : "border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
  );
}

function tagVisibilityOrder(visibility: MessageHeaderTagVisibility): number {
  return visibility === "always" ? 0 : 1;
}

async function copyHeaderTagText(text: string): Promise<void> {
  await copyTextToClipboard(text);
}

function messageHeaderTags(
  message: DashboardSessionMessage,
  timelineEntryId: string,
  base: string,
): MessageHeaderTag[] {
  return [
    ...visibleMessageHeaderTags(message, base),
    ...hoverMessageHeaderTags(message, timelineEntryId),
  ];
}

function visibleMessageHeaderTags(
  message: DashboardSessionMessage,
  base: string,
): MessageHeaderTag[] {
  const projectionTags: MessageHeaderTag[] = message.projection
    ? [{
        id: "projection",
        label: "引用",
        visibility: "always",
        title: projectionTitle(message),
      }]
    : [];
  const ingestTags: MessageHeaderTag[] = message.ingest?.mode === "history_backfill"
    ? [{
        id: "history-import",
        label: "History Import",
        visibility: "always",
        tone: "secondary",
        title: historyImportTitle(message),
      }]
    : [];
  const threadTags: MessageHeaderTag[] = message.thread
    ? [
        ...(message.thread.threadId
          ? [{
              id: "thread-message",
              label: "Thread",
              visibility: "always" as const,
              tone: "muted" as const,
              title: threadTitle(message),
            }]
          : []),
        ...(message.thread.hasReplies
          ? [{
              id: "thread-replies",
              label: "Has Replies",
              visibility: "always" as const,
              tone: "muted" as const,
              title: threadTitle(message),
            }]
          : []),
      ]
    : [];
  const taskTags = linkedMessageTaskBadges(message).map((taskBadge) => ({
    id: `task:${taskBadge.id}`,
    label: taskBadge.title,
    visibility: "always" as const,
    ...(taskBadge.status === "deleted" ? {} : { href: `${base}/tasks/${encodeURIComponent(taskBadge.id)}` }),
  }));
  return [...projectionTags, ...ingestTags, ...threadTags, ...taskTags];
}

function historyImportTitle(message: DashboardSessionMessage): string {
  const ingest = message.ingest;
  if (ingest?.mode !== "history_backfill") {
    return "History import";
  }
  return [
    "History import",
    `source: ${ingest.source}`,
    ingest.importedAt !== null
      ? `imported at: ${new Date(ingest.importedAt).toISOString()}`
      : null,
    ingest.joinEventId !== null ? `join event: ${ingest.joinEventId}` : null,
  ].filter(Boolean).join("\n");
}

function threadTitle(message: DashboardSessionMessage): string {
  const thread = message.thread;
  if (!thread) {
    return "Thread metadata unavailable";
  }
  return [
    thread.threadId !== null ? `thread id: ${thread.threadId}` : null,
    thread.rootMessageExternalId !== null
      ? `root message: ${thread.rootMessageExternalId}`
      : null,
    thread.parentMessageExternalId !== null
      ? `parent message: ${thread.parentMessageExternalId}`
      : null,
    thread.hasReplies ? "has thread replies" : null,
  ].filter(Boolean).join("\n");
}

function hoverMessageHeaderTags(
  message: DashboardSessionMessage,
  timelineEntryId: string,
): MessageHeaderTag[] {
  return [
    {
      id: "debug-entry",
      label: `entry ${shortMessageDebugId(timelineEntryId)}`,
      visibility: "hover",
      tone: "muted",
      title: `timeline entry id: ${timelineEntryId}\nmessage id: ${message.id}`,
      copyText: messageDebugCopyText(message, timelineEntryId),
      copyLabel: `Copy timeline entry id ${timelineEntryId}`,
      testId: "message-debug-id",
      labelClassName: "font-mono text-[10px]",
    },
  ];
}

function turnHeaderTags(
  item: Extract<DashboardSessionTimelineItem, { type: "turn" }>,
): MessageHeaderTag[] {
  const promptTag: MessageHeaderTag[] = item.turn.materializedPrompt
    ? [{
        id: `turn-prompt:${item.turn.id}`,
        label: "prompt",
        visibility: "always",
        tone: "muted",
        title: `Copy Main Runner prompt for turn ${item.turn.id}`,
        copyText: item.turn.materializedPrompt,
        copyLabel: `Copy Main Runner prompt ${item.turn.id}`,
        testId: "turn-prompt-badge",
      }]
    : [];
  return promptTag;
}

function StatusCard({
  message,
}: {
  readonly message: DashboardSessionMessage;
}) {
  const base = useAgentBasePath();
  const { t } = useTranslation();
  const presentation = message.presentation?.kind === "status_card"
    ? message.presentation
    : null;
  const content = statusCardContent(message);
  const title = presentation?.title ?? content.title ?? presentation?.task?.title ?? "Task";
  const titleLines = splitTitleLines(title);
  const primaryTitle = titleLines[0] ?? title;
  const subtitle = titleLines.slice(1).join("\n");
  const status = presentation?.status ?? content.status;
  const text = presentation?.text ?? content.text;
  const task = presentation?.task;
  const steps = content.steps;
  const stepsOpenByDefault = !text;

  return (
    <ChatRichCard
      kind="status_card"
      testId="status-card"
      tone="task"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium">
          {primaryTitle}
        </span>
        {status ? (
          <Badge
            className="h-5 rounded-sm px-1.5 text-[11px] font-normal"
            variant="secondary"
          >
            <UiText>{status}</UiText>
          </Badge>
        ) : null}
        {task ? (
          <Badge
            className="h-5 max-w-full rounded-sm px-1.5 text-[11px] font-normal"
            variant="outline"
            asChild
          >
            {task.status === "deleted" ? <span className="text-muted-foreground">该任务已删除</span> : <a href={`${base}/tasks/${encodeURIComponent(task.id)}`}>
                <span className="truncate">{task.title}</span>
              </a>}
          </Badge>
        ) : null}
      </div>
      {subtitle ? (
        <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {subtitle}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <details
          className="mt-2 rounded-[4px] border border-border/70 bg-background/50 px-3 py-2"
          data-testid="status-card-steps"
          {...(stepsOpenByDefault ? { open: true } : {})}
        >
          <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
            {steps.length === 1 ? t("1 step") : `${steps.length} steps`}
          </summary>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
            {steps.map((step, index) => (
              <li className="flex min-w-0 gap-2" key={`${index}:${step}`}>
                <span className="shrink-0 text-primary">•</span>
                <span className="min-w-0 break-words">
                  {renderMarkdownInlineText(step, message)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {text ? (
        <div className="mt-2 rounded-[4px] border border-border/70 bg-background/70 px-3 py-2 text-sm leading-6">
          {renderMarkdownInlineText(text, message)}
        </div>
      ) : null}
    </ChatRichCard>
  );
}

function TaskFinalAnswerCard({
  message,
}: {
  readonly message: DashboardSessionMessage;
}) {
  const base = useAgentBasePath();
  // Final answer notifications stay in the chat stream but get a task-aware surface.
  const task = message.presentation?.kind === "task_final_answer"
    ? message.presentation.task
    : null;

  return (
    <ChatRichCard
      kind="task_final_answer"
      testId="task-final-answer-card"
      tone="task"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-primary">任务结论</span>
        {task ? (
          <Badge
            className="h-5 max-w-full rounded-sm px-1.5 text-[11px] font-normal"
            variant="outline"
            asChild
          >
            {task.status === "deleted" ? <span className="text-muted-foreground">该任务已删除</span> : <a href={`${base}/tasks/${encodeURIComponent(task.id)}`}>
                <span className="truncate">{task.title}</span>
              </a>}
          </Badge>
        ) : null}
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
        {renderMessageContent(message)}
      </div>
    </ChatRichCard>
  );
}

function statusCardContent(message: DashboardSessionMessage): {
  readonly title: string | null;
  readonly text: string | null;
  readonly status: string | null;
  readonly steps: readonly string[];
} {
  const card = messageCardBlocks(message).find((block) =>
    block.cardKind === "status_card"
  );
  const payload = isRecord(card?.payload) ? card.payload : {};
  return {
    title: messageContentStringField(card ?? {}, "title") ?? null,
    text: messageContentStringField(card ?? {}, "text") ?? null,
    status: messageContentStringField(payload, "status") ?? null,
    steps: messageContentStringArrayField(card ?? {}, "steps"),
  };
}

function splitTitleLines(title: string): string[] {
  return title
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function messageCardBlocks(
  message: DashboardSessionMessage,
): Record<string, unknown>[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((part): part is Record<string, unknown> =>
    isRecord(part) && part.type === "card"
  );
}

function RichMarkdownMessageCard({
  message,
}: {
  readonly message: DashboardSessionMessage;
}) {
  return (
    <ChatRichCard kind="rich_markdown_card" tone="neutral">
      <div
        className="space-y-2 text-sm leading-6"
        data-testid="rich-markdown-card-content"
      >
        {renderRichMarkdownContent(message)}
      </div>
    </ChatRichCard>
  );
}

function ChatRichCard({
  children,
  kind,
  testId = "chat-rich-card",
  tone,
}: {
  readonly children: ReactNode;
  readonly kind: string;
  readonly testId?: string;
  readonly tone: "neutral" | "task";
}) {
  return (
    <div
      className={
        tone === "task"
          ? "max-w-[760px] rounded-md border border-primary/20 bg-primary/5 p-3 text-foreground"
          : "relative max-w-[760px] overflow-hidden rounded-md border border-border/80 bg-card/90 py-3 pl-4 pr-3 text-foreground shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary/30"
      }
      data-card-kind={kind}
      {...(tone === "neutral" ? { "data-rich-card-layout": "layered" } : {})}
      data-rich-card="true"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function DashboardErrorState({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : t("Unknown error")}
      </p>
    </div>
  );
}

function projectionTitle(message: DashboardSessionMessage): string {
  const projection = message.projection;
  if (!projection) {
    return "";
  }
  return `Referenced from ${projection.source_session_id} (${projection.relation})`;
}

function turnDetailsText(
  item: Extract<DashboardSessionTimelineItem, { type: "turn" }>,
): string {
  return [
    `turn ${item.turn.id}`,
    item.turn.status,
    formatCount(item.turn.messageCount, "message"),
    item.turn.visibleMessageCount !== item.turn.messageCount
      ? `${item.turn.visibleMessageCount} visible`
      : null,
    `latest ${item.turn.latestMessageId}`,
  ].filter(Boolean).join(" · ");
}

function messageDisplayIdentity(
  message: DashboardSessionMessage,
): DashboardIdentity | null {
  const senderIdentity = identityForCanonicalUser(message.senderUser);
  if (!senderIdentity || message.role !== "assistant") {
    return senderIdentity;
  }
  const displayName = senderIdentity.displayName?.trim();
  return {
    ...senderIdentity,
    identityKind: "bot",
    displayName:
      displayName && !displayName.toLowerCase().startsWith("unknown")
        ? displayName
        : "Bot",
  };
}

function messageIdentityFallbackKind(
  message: DashboardSessionMessage,
): "user" | "bot" | "system" | "unknown" {
  if (message.role === "assistant") {
    return "bot";
  }
  if (message.role === "system") {
    return "system";
  }
  if (message.role === "user") {
    return "user";
  }
  return "unknown";
}

function identityForCanonicalUser(
  user: DashboardCanonicalUser | null | undefined,
): DashboardIdentity | null {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    channel: { type: "luna", id: "canonical" },
    externalId: user.id,
    identityKind: canonicalUserIdentityKind(user.kind),
    displayName: user.displayName,
    status: user.status,
    avatarUrl: user.avatarUrl,
    providerIds: {},
  };
}

function canonicalUserIdentityKind(kind: string): DashboardIdentity["identityKind"] {
  switch (kind) {
    case "bot":
    case "service":
      return "bot";
    case "system":
      return "system";
    case "human":
    default:
      return "user";
  }
}

function renderMessageContent(
  message: DashboardSessionMessage,
): ReactNode {
  const text = messageText(message);
  const mentions = message.mentions ?? [];
  if (mentions.length === 0 || text.length === 0) {
    return renderMarkdownInlineText(text, message);
  }
  const parts = splitMentionText(text, mentions);
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return (
            <span key={`${index}:text`}>
              {renderMarkdownInlineText(part.value, message)}
            </span>
          );
        }
        return (
          <MentionLink
            key={`${index}:${part.value}`}
            mention={part.mention}
          />
        );
      })}
    </>
  );
}

function renderRichMarkdownContent(
  message: DashboardSessionMessage,
): ReactNode {
  const text = messageText(message);
  if (text.length === 0) {
    return "";
  }
  return splitRichMarkdownBlocks(text).map((block, index) =>
    renderRichMarkdownBlock({
      block,
      index,
      message,
    })
  );
}

function renderRichMarkdownBlock(input: {
  readonly block: string;
  readonly index: number;
  readonly message: DashboardSessionMessage;
}): ReactNode {
  const lines = input.block.split("\n").filter((line) => line.trim().length > 0);
  const sectionKind = richMarkdownSectionKind(input.block);
  return (
    <div
      className={richMarkdownSectionClassName(sectionKind)}
      data-rich-card-section={sectionKind}
      key={`${input.index}:${input.block}`}
    >
      {lines.map((line, lineIndex) => {
        const bullet = line.match(/^\s*-\s+(.*)$/);
        const content = bullet?.[1] ?? line;
        return (
          <div
            className={bullet ? "flex min-w-0 gap-2" : "min-w-0"}
            key={`${lineIndex}:${line}`}
          >
            {bullet ? <span className="shrink-0 text-primary">•</span> : null}
            <span className="min-w-0 break-words">
              {renderRichInlineText(input.message, content)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function splitRichMarkdownBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function richMarkdownSectionKind(block: string): "primary" | "body" | "media" {
  if (/^(!\[[^\]]*\]\([^)]+\)|\[(图片|视频)消息：)/.test(block)) {
    return "media";
  }
  if (/^\*\*[^*]+\*\*/.test(block)) {
    return "primary";
  }
  return "body";
}

function richMarkdownSectionClassName(
  kind: "primary" | "body" | "media",
): string {
  if (kind === "primary") {
    return "rounded-[4px] border-l-2 border-primary/40 bg-background/70 px-3 py-2 font-medium";
  }
  if (kind === "media") {
    return "rounded-[4px] border border-dashed border-border bg-muted/30 px-3 py-2 text-muted-foreground";
  }
  return "rounded-[4px] border-l border-border bg-background/55 px-3 py-2";
}

function renderRichInlineText(
  message: DashboardSessionMessage,
  text: string,
): ReactNode {
  const mentions = message.mentions ?? [];
  const parts = mentions.length === 0
    ? [{ type: "text" as const, value: text }]
    : splitMentionText(text, mentions);
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "mention") {
          return (
            <MentionLink
              key={`${index}:${part.value}`}
              mention={part.mention}
            />
          );
        }
        return (
          <span key={`${index}:text`}>
            {renderMarkdownInlineText(part.value, message)}
          </span>
        );
      })}
    </>
  );
}

function isDeletedTaskHref(href: string, message?: DashboardSessionMessage): boolean {
  if (!message) return false;
  try {
    const origin = (typeof window !== "undefined" && window.location?.origin) || "http://localhost";
    const url = new URL(href, origin);
    if (url.origin !== origin) return false;
    const match = /^\/(?:agent\/(?:[^/]+\/)?)?tasks\/([^/]+)\/?$/.exec(url.pathname);
    return !!match && linkedMessageTaskBadges(message).some(task => task.status === "deleted" && task.id === decodeURIComponent(match[1]!));
  } catch { return false; }
}

function renderMarkdownInlineText(
  text: string,
  message?: DashboardSessionMessage,
): ReactNode {
  const nodes: ReactNode[] = [];
  let offset = 0;
  const tokenPattern = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(((?:https?:\/\/|\/|#)[^)\s]+)\))/g;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > offset) {
      nodes.push(text.slice(offset, match.index));
    }
    if (match[1] !== undefined && match[3] !== undefined) {
      const imageSrc = markdownImageSrc(match[3]);
      const dimensions = imageDimensionsForUrl(message?.content, match[3]);
      const frameStyle = dimensions && {
        aspectRatio: `${dimensions.width} / ${dimensions.height}`,
        maxWidth: Math.min(dimensions.width, 426, 320 * dimensions.width / dimensions.height),
      };
      nodes.push(
        imageSrc === undefined
          ? match[0]
          : (
              <SessionImagePreview
                alt={match[2] || "image"}
                key={`image:${match.index}`}
                src={imageSrc}
                style={frameStyle}
              />
            ),
      );
    } else if (match[5] !== undefined) {
      nodes.push(<strong key={`strong:${match.index}`}>{match[5]}</strong>);
    } else if (match[7] !== undefined && match[8] !== undefined) {
      if (isDeletedTaskHref(match[8], message)) {
        nodes.push(<span key={`link:${match.index}`} className="text-muted-foreground">该任务已删除</span>);
        offset = match.index + match[0].length;
        continue;
      }
      nodes.push(
        <a
          className="font-medium text-primary hover:underline"
          href={match[8]}
          key={`link:${match.index}`}
          rel="noreferrer"
          target="_blank"
        >
          {match[7]}
        </a>,
      );
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) {
    nodes.push(text.slice(offset));
  }
  return nodes.length === 0 ? text : nodes;
}

function SessionImagePreview({
  alt,
  src,
  style,
}: {
  alt: string;
  src: string;
  style?: CSSProperties;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Enlarge image: ${alt}`}
          className="relative my-2 block aspect-[4/3] w-full max-w-[26.625rem] cursor-zoom-in overflow-hidden rounded-[4px] border border-border bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
          style={style}
        >
          <img
            alt={alt}
            className="absolute inset-0 size-full object-contain"
            loading="lazy"
            src={src}
          />
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="w-fit gap-0 px-3 pt-12 pb-3 sm:max-w-[calc(100%-2rem)]"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img alt={alt} className="max-h-[calc(100dvh-6rem)] max-w-full object-contain" src={src} />
      </DialogContent>
    </Dialog>
  );
}

function imageDimensionsForUrl(
  content: unknown,
  url: string,
): { width: number; height: number } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || part.type !== "image" || part.url !== url) continue;
    const { width, height } = part;
    if (Number.isSafeInteger(width) && width > 0 &&
        Number.isSafeInteger(height) && height > 0) {
      return { width, height };
    }
  }
  return undefined;
}

function markdownImageSrc(src: string): string | undefined {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return src;
  }
  if (src.startsWith("artifact:")) {
    return undefined;
  }
  return src;
}

function MentionLink({
  mention,
}: {
  mention: DashboardSessionMessage["mentions"][number] | undefined;
}) {
  const base = useAgentBasePath();
  if (mention === undefined) {
    return null;
  }
  const identityDisplayName = mention.targetIdentity?.displayName?.trim();
  const canonicalUser = mention.targetUser;
  const canonicalName = canonicalUser?.displayName?.trim();
  const label = canonicalName && canonicalUser?.displayNameSource !== "id" && !/^(ou_|on_|unknown)/i.test(canonicalName)
    ? identityMentionLabel(canonicalName)
    : identityDisplayName
    ? identityMentionLabel(identityDisplayName)
    : mention.label || mention.targetExternalId || mention.key;
  const targetUserId = canonicalUser?.id ?? mention.targetUserId ?? null;
  const className = "font-medium text-primary hover:underline";
  if (canonicalUser) {
    return (
      <IdentityLink
        className={className}
        identity={identityForCanonicalUser(canonicalUser)}
        label={label}
        showIcon={false}
        showKind={false}
      />
    );
  }
  if (mention.targetIdentity) {
    return <span className={className}>{label}</span>;
  }
  if (targetUserId === null) {
    return <span className="font-medium text-primary">{label}</span>;
  }
  return <a href={`${base}/users/${encodeURIComponent(targetUserId)}`}
      className={className}
    >
      {label}
    </a>;
}

function identityMentionLabel(displayName: string): string {
  return displayName.startsWith("@") ? displayName : `@${displayName}`;
}

function messageText(message: DashboardSessionMessage): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) {
        return "";
      }
      if (part.type === "text" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "image") {
        const src = messageContentStringField(part, "url")
          ?? messageContentStringField(part, "fileId");
        if (!src) {
          return "[image]";
        }
        const alt = messageContentStringField(part, "alt") ?? "image";
        return `![${alt}](${src})`;
      }
      if (part.type === "file") {
        return `[file] ${messageContentStringField(part, "name") ?? messageContentStringField(part, "fileId") ?? "file"}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageContentStringField(
  part: object,
  field: string,
): string | undefined {
  if (!(field in part)) {
    return undefined;
  }
  const value = (part as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageContentStringArrayField(
  part: object,
  field: string,
): readonly string[] {
  if (!(field in part)) {
    return [];
  }
  const value = (part as Record<string, unknown>)[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MentionTextPart =
  | { readonly type: "text"; readonly value: string }
  | {
      readonly type: "mention";
      readonly value: string;
      readonly mention: DashboardSessionMessage["mentions"][number];
    };

function splitMentionText(
  text: string,
  mentions: readonly DashboardSessionMessage["mentions"][number][],
): MentionTextPart[] {
  const mentionQueues = new Map<
    string,
    DashboardSessionMessage["mentions"][number][]
  >();
  for (const mention of mentions) {
    if (mention.label.length === 0) {
      continue;
    }
    const queue = mentionQueues.get(mention.label) ?? [];
    queue.push(mention);
    mentionQueues.set(mention.label, queue);
  }
  const sortedKeys = [...mentionQueues.keys()]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (sortedKeys.length === 0) {
    return [{ type: "text", value: text }];
  }

  const parts: MentionTextPart[] = [];
  let offset = 0;
  while (offset < text.length) {
    const match = sortedKeys
      .map((key) => ({ key, index: text.indexOf(key, offset) }))
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (match === undefined) {
      parts.push({ type: "text", value: text.slice(offset) });
      break;
    }
    if (match.index > offset) {
      parts.push({ type: "text", value: text.slice(offset, match.index) });
    }
    const mention = mentionQueues.get(match.key)?.shift();
    if (mention === undefined) {
      parts.push({ type: "text", value: match.key });
    } else {
      parts.push({ type: "mention", value: match.key, mention });
    }
    offset = match.index + match.key.length;
  }
  return parts;
}

function linkedTaskBadges(
  session: DashboardSession | undefined,
): DashboardSession["linked_tasks"] {
  return session?.linkedTasks ?? session?.linked_tasks ?? [];
}

function linkedMessageTaskBadges(
  message: DashboardSessionMessage,
): DashboardSessionMessage["linked_tasks"] {
  return message.linkedTasks ?? message.linked_tasks;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function shortEntityId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(id) ? id.slice(0, 8) : id;
}

function shortMessageDebugId(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f-]+$/i.test(id)) {
    return id.slice(0, 8);
  }
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 10)}...${id.slice(-5)}`;
}

function messageTimelineEntryId(message: DashboardSessionMessage): string {
  return typeof message.entryId === "string" && message.entryId.length > 0
    ? message.entryId
    : message.id;
}

function messageDebugCopyText(
  message: DashboardSessionMessage,
  timelineEntryId: string,
): string {
  return `timeline entry id: ${timelineEntryId}\nmessage id: ${message.id}`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
