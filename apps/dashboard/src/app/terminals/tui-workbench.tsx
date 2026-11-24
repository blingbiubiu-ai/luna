import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLinkIcon,
  PanelLeftCloseIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useContainerConsoles, Workspace } from "@/components/container-console";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import {
  ownerPath,
  runnerKindBadge,
  type DormantPtyContextItem,
  type LivePtySessionItem,
  type PtySessionsResponse,
} from "@/lib/containers";

export type { DormantPtyContextItem, LivePtySessionItem, PtySessionsResponse };

function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 10) return "刚刚";
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return `${Math.floor(diffHr / 24)} 天前`;
}

export function TuiWorkbench({
  agentId,
  focusContextId,
  focusSessionId,
  focusTaskId,
}: {
  readonly agentId: string;
  readonly focusContextId?: string | undefined;
  readonly focusSessionId?: string | undefined;
  readonly focusTaskId?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const ptyPath = `/agents/${encodeURIComponent(agentId)}/pty-sessions`;
  const consoles = useContainerConsoles(agentId);

  const ptyQuery = useQuery({
    queryKey: [ptyPath],
    queryFn: ({ signal }) => apiFetch<PtySessionsResponse>(ptyPath, { signal }),
    refetchInterval: 3000,
  });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [showDormant, setShowDormant] = useState(false);
  const autoFocusedRef = useRef<string | null>(null);

  const liveSessions = ptyQuery.data?.sessions ?? [];
  const dormantContexts = ptyQuery.data?.dormantContexts ?? [];

  const liveByContextId = useMemo(
    () => new Map(liveSessions.map(item => [item.contextId, item])),
    [liveSessions],
  );

  // Auto-open deep-linked session/task/context once live sessions load.
  useEffect(() => {
    if (liveSessions.length === 0) return;
    const targetToken = focusContextId || focusSessionId || focusTaskId || "";
    if (!targetToken) {
      if (autoFocusedRef.current === null && consoles.consoles.length === 0 && liveSessions[0]) {
        autoFocusedRef.current = "__first__";
        consoles.openPty(liveSessions[0]);
      }
      return;
    }
    if (autoFocusedRef.current === targetToken) return;
    const matched = liveSessions.find(item => {
      if (focusContextId && item.contextId === focusContextId) return true;
      if (focusSessionId && item.ownerType === "session" && item.ownerId === focusSessionId) return true;
      if (focusTaskId && item.ownerType === "task" && item.ownerId === focusTaskId) return true;
      return false;
    });
    if (matched) {
      autoFocusedRef.current = targetToken;
      consoles.openPty(matched);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessions, focusContextId, focusSessionId, focusTaskId]);

  const q = search.trim().toLowerCase();
  const filteredLive = useMemo(() => {
    if (!q) return liveSessions;
    return liveSessions.filter(s =>
      `${s.title ?? ""} ${s.runnerType} ${s.model ?? ""} ${s.shadowName ?? ""} ${s.contextId} ${s.sessionId ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [liveSessions, q]);

  const filteredDormant = useMemo(() => {
    if (!q) return dormantContexts;
    return dormantContexts.filter(d =>
      `${d.title ?? ""} ${d.runnerType} ${d.shadowName ?? ""} ${d.contextId} ${d.sessionId ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [dormantContexts, q]);

  const missingFocusedTarget = useMemo(() => {
    if (!ptyQuery.data) return null;
    if (focusSessionId && !liveSessions.some(s => s.ownerType === "session" && s.ownerId === focusSessionId)) {
      const dormant = dormantContexts.find(d => d.ownerType === "session" && d.ownerId === focusSessionId);
      return {
        kind: "session" as const,
        title: dormant?.title ?? `会话 ${focusSessionId.slice(0, 8)}`,
        href: ownerPath(agentId, "session", focusSessionId),
      };
    }
    if (focusTaskId && !liveSessions.some(s => s.ownerType === "task" && s.ownerId === focusTaskId)) {
      const dormant = dormantContexts.find(d => d.ownerType === "task" && d.ownerId === focusTaskId);
      return {
        kind: "task" as const,
        title: dormant?.title ?? `任务 ${focusTaskId.slice(0, 8)}`,
        href: ownerPath(agentId, "task", focusTaskId),
      };
    }
    return null;
  }, [ptyQuery.data, liveSessions, dormantContexts, focusSessionId, focusTaskId, agentId]);

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      {sidebarOpen && (
        <aside
          aria-label="伪终端会话列表"
          className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border bg-background"
        >
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <div className="flex items-center gap-2">
              <TerminalSquareIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">TUI 驾驶舱</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {liveSessions.length} 在线
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                title="刷新伪终端状态"
                aria-label="刷新伪终端状态"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: [ptyPath] });
                  void consoles.query.refetch();
                }}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="收起列表"
                aria-label="收起列表"
                onClick={() => setSidebarOpen(false)}
              >
                <PanelLeftCloseIcon className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="border-b p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="搜索会话、任务、模型或 ID…"
                aria-label="搜索伪终端会话"
                className="h-7 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
            {/* Section 1: Live AI PTY Sessions */}
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                <span>活跃 AI 伪终端（PTY）</span>
                <span>{filteredLive.length}</span>
              </div>
              {ptyQuery.isLoading ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">正在查询容器内活跃伪终端…</p>
              ) : filteredLive.length === 0 ? (
                <div className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                  当前没有常驻中的 AI 伪终端进程。将模型配置切换为「交互式伪终端（pty）」并触发对话或任务后，CLI 会话将出现在此处。
                </div>
              ) : (
                filteredLive.map(item => {
                  const selected = consoles.active === `pty:${item.contextId}`;
                  const href = ownerPath(agentId, item.ownerType, item.ownerId);
                  return (
                    <div
                      key={item.contextId}
                      className={`group flex items-start gap-2 rounded-lg border p-2.5 transition-colors ${
                        selected
                          ? "border-foreground/25 bg-muted/60 shadow-2xs"
                          : "border-transparent hover:border-border hover:bg-muted/30"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => consoles.openPty(item)}
                        className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-emerald-500"
                          />
                          <span className="truncate text-xs font-medium">
                            {item.title || `${item.runnerType} · ${item.contextId.slice(0, 8)}`}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          <span className="rounded bg-muted px-1.5 py-0.2 font-medium text-foreground/80">
                            {runnerKindBadge(item.runnerKind)}
                          </span>
                          <span>{item.runnerType}</span>
                          {item.model && <span className="truncate">· {item.model}</span>}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          {item.busy ? (
                            <span className="animate-pulse rounded bg-amber-500/15 px-1.5 py-0.2 font-medium text-amber-700 dark:text-amber-300">
                              执行中
                            </span>
                          ) : (
                            <span>空闲常驻</span>
                          )}
                          {item.shadowName && <span>· {item.shadowName}</span>}
                          <span>· {formatRelativeTime(item.lastActiveAt)}</span>
                        </div>
                      </button>
                      {href && (
                        <a
                          href={href}
                          title={item.ownerType === "task" ? "打开对应任务详情" : "打开对应聊天会话"}
                          aria-label={item.ownerType === "task" ? "打开对应任务详情" : "打开对应聊天会话"}
                          className="rounded p-1 text-muted-foreground opacity-70 hover:bg-background hover:text-foreground group-hover:opacity-100"
                        >
                          <ExternalLinkIcon className="size-3.5" />
                        </a>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            {/* Section 2: Dormant resumable contexts */}
            {filteredDormant.length > 0 && (
              <section className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => setShowDormant(v => !v)}
                  className="flex w-full items-center justify-between px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
                >
                  <span>已休眠上下文</span>
                  <span>{showDormant ? "收起" : `${filteredDormant.length} 项`}</span>
                </button>
                {(showDormant || q.length > 0) &&
                  filteredDormant.map(item => {
                    const href = ownerPath(agentId, item.ownerType, item.ownerId);
                    return (
                      <div
                        key={item.contextId}
                        className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/30"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground/80">
                            {item.title || item.contextId.slice(0, 8)}
                          </p>
                          <p className="truncate text-[11px]">
                            {runnerKindBadge(item.runnerKind)} · {item.runnerType} · {formatRelativeTime(item.updatedAt)}
                          </p>
                        </div>
                        {href && (
                          <a
                            href={href}
                            className="shrink-0 rounded border px-2 py-0.5 text-[11px] text-foreground hover:bg-background"
                          >
                            {item.ownerType === "task" ? "查看任务" : "去唤醒"}
                          </a>
                        )}
                      </div>
                    );
                  })}
              </section>
            )}
          </div>
        </aside>
      )}

      <Workspace
        agentId={agentId}
        consoles={consoles.consoles}
        active={consoles.active}
        onActivate={consoles.setActive}
        onClose={consoles.close}
        listOpen={sidebarOpen}
        onOpenList={() => setSidebarOpen(true)}
        openListLabel="展开会话列表"
        onStopDesktop={async item => {
          await consoles.stopDesktop.mutateAsync(item.row);
          consoles.close(item.key);
        }}
        stoppingDesktop={consoles.stopDesktop.isPending}
        livePtyByContextId={liveByContextId}
        emptyState={
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-zinc-400">
            <TerminalSquareIcon className="size-10 text-zinc-600" />
            {missingFocusedTarget ? (
              <>
                <p className="text-sm font-medium text-zinc-200">
                  「{missingFocusedTarget.title}」当前没有活跃的伪终端进程
                </p>
                <p className="max-w-md text-xs text-zinc-400">
                  {missingFocusedTarget.kind === "task"
                    ? "该任务可能已执行完毕并空闲回收，或运行期间使用的是标准管道（stdio）。当任务触发新一轮执行时，伪终端会自动在此上线。"
                    : "该会话可能尚未启动、已空闲超时回收，或当前模型配置使用的是标准管道（stdio）。在对话中发送一条新消息即可唤醒伪终端。"}
                </p>
                {missingFocusedTarget.href && (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={missingFocusedTarget.href}>
                      {missingFocusedTarget.kind === "task" ? "返回任务详情" : "返回对话"}
                    </a>
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-zinc-200">选择左侧的活跃 AI 伪终端</p>
                <p className="max-w-md text-xs text-zinc-400">
                  默认以安全的「只读观察」模式实时同步 Claude Code / Codex TUI 画面；需要手动干预、查看 /status 或按键确认时，可随时一键「接管输入」。
                </p>
              </>
            )}
          </div>
        }
      />
    </div>
  );
}
