import { useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardPasteIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LockIcon,
  MaximizeIcon,
  MinimizeIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { primaryContainer, type ContainerList, type ContainerRow } from "@/lib/containers";
import { randomId } from "@/lib/random-id";

export interface LivePtySessionItem {
  readonly workerId: string;
  readonly environmentId: string;
  readonly shadowId: string;
  readonly shadowName: string | null;
  readonly contextId: string;
  readonly runnerType: "claude" | "codex";
  readonly model?: string;
  readonly sessionId?: string;
  readonly busy: boolean;
  readonly privileged: boolean;
  readonly pid: number;
  readonly startedAt: number;
  readonly lastActiveAt: number;
  readonly ownerType: "session" | "task" | "unknown";
  readonly ownerId: string | null;
  readonly runnerKind: "main" | "work" | "task";
  readonly title: string | null;
  readonly channelType: string | null;
}

export interface DormantPtyContextItem {
  readonly contextId: string;
  readonly shadowId: string;
  readonly shadowName: string | null;
  readonly runnerType: string;
  readonly sessionId: string | null;
  readonly updatedAt: number;
  readonly ownerType: "session" | "task" | "unknown";
  readonly ownerId: string | null;
  readonly runnerKind: "main" | "work" | "task";
  readonly title: string | null;
  readonly channelType: string | null;
}

export interface PtySessionsResponse {
  readonly sessions: LivePtySessionItem[];
  readonly dormantContexts: DormantPtyContextItem[];
}

export type WorkbenchTabTarget =
  | {
      readonly kind: "pty";
      readonly key: string;
      readonly workerId: string;
      readonly environmentId: string;
      readonly contextId: string;
      readonly label: string;
      readonly subtitle: string;
      readonly ownerType: "session" | "task" | "unknown";
      readonly ownerId: string | null;
    }
  | {
      readonly kind: "shell";
      readonly key: string;
      readonly user: "runner" | "root";
      readonly workerId: string;
      readonly environmentId: string;
      readonly shadowId: string;
      readonly label: string;
      readonly subtitle: string;
    };

const closeReasons: Record<string, string> = {
  client_closed: "已关闭",
  pty_session_not_found: "该伪终端会话当前未在运行（可能已空闲回收）",
  pty_session_closed: "伪终端会话已关闭",
  idle_timeout: "伪终端空闲超时已自动回收",
  worker_disconnected: "Worker 连接已断开",
  worker_revoked: "Worker 已撤销",
  worker_stream_timeout: "Worker 响应超时",
  worker_streams_unsupported: "该 Worker 版本不支持伪终端流，请重启或升级 Worker",
  environment_draining: "容器正在重建或回收，请稍后再试",
  system_disk_reset: "容器系统盘已重置",
  backpressure: "终端输出速率过高，连接已断开",
  stream_limit: "同时打开的终端数量已达上限",
};

function describeCloseReason(reason: string): string {
  if (reason.startsWith("exited:")) return `进程已退出（退出码 ${reason.slice(7)}）`;
  return closeReasons[reason] ?? (reason ? `连接已断开：${reason}` : "连接已断开");
}

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

function runnerKindBadge(kind: "main" | "work" | "task"): string {
  if (kind === "task") return "Task";
  if (kind === "work") return "Work";
  return "Main";
}

function buildWsUrl(
  agentId: string,
  tab: WorkbenchTabTarget,
  size: { cols: number; rows: number },
  writable: boolean,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    cols: String(size.cols),
    rows: String(size.rows),
  });
  if (tab.kind === "pty") {
    params.set("kind", "pty");
    params.set("user", "runner");
    params.set("contextId", tab.contextId);
    params.set("writable", writable ? "1" : "0");
  } else {
    params.set("kind", "terminal");
    params.set("user", tab.user);
  }
  return `${protocol}//${window.location.host}/api/agents/${encodeURIComponent(agentId)}/containers/${encodeURIComponent(tab.workerId)}/${encodeURIComponent(tab.environmentId)}/stream?${params}`;
}

function ownerPath(agentId: string, ownerType: "session" | "task" | "unknown", ownerId: string | null): string | null {
  if (!ownerId) return null;
  if (ownerType === "session") return `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(ownerId)}`;
  if (ownerType === "task") return `/agent/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(ownerId)}`;
  return null;
}

const QUICK_KEYS: ReadonlyArray<{ readonly label: string; readonly title: string; readonly seq: string }> = [
  { label: "Esc", title: "发送 Esc（中断当前回合或取消弹窗）", seq: "\x1b" },
  { label: "Ctrl+C", title: "发送 Ctrl+C", seq: "\x03" },
  { label: "Shift+Tab", title: "切换 CLI 模式（如权限/计划模式）", seq: "\x1b[Z" },
  { label: "Tab", title: "发送 Tab 补全", seq: "\t" },
  { label: "↑", title: "上方向键", seq: "\x1b[A" },
  { label: "↓", title: "下方向键", seq: "\x1b[B" },
  { label: "←", title: "左方向键", seq: "\x1b[D" },
  { label: "→", title: "右方向键", seq: "\x1b[C" },
  { label: "Enter", title: "发送回车提交", seq: "\r" },
];

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
  const containersPath = `/agents/${encodeURIComponent(agentId)}/containers`;

  const ptyQuery = useQuery({
    queryKey: [ptyPath],
    queryFn: ({ signal }) => apiFetch<PtySessionsResponse>(ptyPath, { signal }),
    refetchInterval: 3000,
  });

  const containersQuery = useQuery({
    queryKey: [containersPath],
    queryFn: ({ signal }) => apiFetch<ContainerList>(containersPath, { signal }),
    refetchInterval: 8000,
  });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [showDormant, setShowDormant] = useState(false);
  const [tabs, setTabs] = useState<WorkbenchTabTarget[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [writableMap, setWritableMap] = useState<Record<string, boolean>>({});
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [generations, setGenerations] = useState<Record<string, number>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const sendInputHandlers = useRef<Map<string, (data: string) => void>>(new Map());
  const autoFocusedRef = useRef<string | null>(null);

  useEffect(() => {
    const onFsChange = () => setFullscreen(document.fullscreenElement === workspaceRef.current);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const openPtyTab = (item: LivePtySessionItem) => {
    const existing = tabs.find(t => t.kind === "pty" && t.contextId === item.contextId);
    if (existing) {
      setActiveKey(existing.key);
      return;
    }
    const label = item.title || `${item.runnerType} · ${item.contextId.slice(0, 8)}`;
    const subtitle = [
      runnerKindBadge(item.runnerKind),
      item.runnerType,
      item.model,
      item.shadowName,
    ].filter(Boolean).join(" · ");
    const key = `pty:${item.contextId}`;
    const next: WorkbenchTabTarget = {
      kind: "pty",
      key,
      workerId: item.workerId,
      environmentId: item.environmentId,
      contextId: item.contextId,
      label,
      subtitle,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
    };
    setTabs(prev => [...prev, next]);
    setWritableMap(prev => ({ ...prev, [key]: false }));
    setActiveKey(key);
  };

  const openShellOnContainer = (row: ContainerRow, user: "runner" | "root") => {
    const key = `shell:${user}:${row.environmentId}:${randomId().slice(0, 6)}`;
    const shadowTitle = row.shadowName ?? row.shadowId.slice(0, 8);
    const next: WorkbenchTabTarget = {
      kind: "shell",
      key,
      user,
      workerId: row.workerId,
      environmentId: row.environmentId,
      shadowId: row.shadowId,
      label: `${shadowTitle} · ${user === "root" ? "Root Shell" : "Shell"}`,
      subtitle: `${row.workerId} · bash -l`,
    };
    setTabs(prev => [...prev, next]);
    setWritableMap(prev => ({ ...prev, [key]: true }));
    setActiveKey(key);
  };

  const provisionShadow = useMutation({
    mutationFn: (input: { shadowId: string; user: "runner" | "root" }) =>
      apiFetch<{ container: ContainerRow }>(containersPath, {
        method: "POST",
        body: JSON.stringify({ shadowId: input.shadowId }),
      }),
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: [containersPath] });
      openShellOnContainer(data.container, variables.user);
    },
  });

  const openShadowShell = (shadowId: string, user: "runner" | "root") => {
    const row = primaryContainer(containersQuery.data?.containers ?? [], shadowId);
    if (row?.running) openShellOnContainer(row, user);
    else provisionShadow.mutate({ shadowId, user });
  };

  // Auto-open deep-linked session/task/context once live sessions load.
  useEffect(() => {
    const live = ptyQuery.data?.sessions ?? [];
    if (live.length === 0) return;
    const targetToken = focusContextId || focusSessionId || focusTaskId || "";
    if (!targetToken) {
      if (autoFocusedRef.current === null && tabs.length === 0 && live[0]) {
        autoFocusedRef.current = "__first__";
        openPtyTab(live[0]);
      }
      return;
    }
    if (autoFocusedRef.current === targetToken) return;
    const matched = live.find((item) => {
      if (focusContextId && item.contextId === focusContextId) return true;
      if (focusSessionId && item.ownerType === "session" && item.ownerId === focusSessionId) return true;
      if (focusTaskId && item.ownerType === "task" && item.ownerId === focusTaskId) return true;
      return false;
    });
    if (matched) {
      autoFocusedRef.current = targetToken;
      openPtyTab(matched);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyQuery.data?.sessions, focusContextId, focusSessionId, focusTaskId]);

  const closeTab = (key: string) => {
    sendInputHandlers.current.delete(key);
    setTabs(prev => {
      const idx = prev.findIndex(item => item.key === key);
      const rest = prev.filter(item => item.key !== key);
      if (activeKey === key) {
        setActiveKey(rest[Math.min(idx, rest.length - 1)]?.key ?? null);
      }
      return rest;
    });
  };

  const liveSessions = ptyQuery.data?.sessions ?? [];
  const dormantContexts = ptyQuery.data?.dormantContexts ?? [];
  const shadows = containersQuery.data?.shadows ?? [];
  const containers = containersQuery.data?.containers ?? [];

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

  const activeTab = tabs.find(t => t.key === activeKey) ?? null;
  const activeWritable = activeTab ? (activeTab.kind === "shell" ? true : Boolean(writableMap[activeTab.key])) : false;
  const activeStatus = activeTab ? (statusMap[activeTab.key] ?? "正在连接…") : "";
  const activeEnded = activeTab ? !["已连接", "正在连接…"].includes(activeStatus) : false;
  const activeLiveMeta = activeTab?.kind === "pty"
    ? liveSessions.find(s => s.contextId === activeTab.contextId)
    : undefined;
  const activeOwnerHref = activeTab?.kind === "pty"
    ? ownerPath(agentId, activeTab.ownerType, activeTab.ownerId)
    : null;

  const missingFocusedSession = useMemo(() => {
    if (!ptyQuery.data) return null;
    if (focusSessionId && !liveSessions.some(s => s.ownerType === "session" && s.ownerId === focusSessionId)) {
      return dormantContexts.find(d => d.ownerType === "session" && d.ownerId === focusSessionId) ?? { title: `会话 ${focusSessionId.slice(0, 8)}` };
    }
    if (focusTaskId && !liveSessions.some(s => s.ownerType === "task" && s.ownerId === focusTaskId)) {
      return dormantContexts.find(d => d.ownerType === "task" && d.ownerId === focusTaskId) ?? { title: `任务 ${focusTaskId.slice(0, 8)}` };
    }
    return null;
  }, [ptyQuery.data, liveSessions, dormantContexts, focusSessionId, focusTaskId]);

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-4">
      {sidebarOpen && !fullscreen && (
        <aside
          aria-label="伪终端会话列表"
          className="flex w-80 shrink-0 flex-col overflow-hidden rounded-xl border bg-background shadow-xs"
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
                  void queryClient.invalidateQueries({ queryKey: [containersPath] });
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
                onChange={e => setSearch(e.target.value)}
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
                  当前没有常驻中的 AI 伪终端进程。将模型配置切换为「交互式伪终端（pty）」并发送一条消息后，CLI 会话将出现在此处。
                </div>
              ) : (
                filteredLive.map(item => {
                  const tabKey = `pty:${item.contextId}`;
                  const selected = activeKey === tabKey;
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
                        onClick={() => openPtyTab(item)}
                        className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={`size-2 shrink-0 rounded-full ${
                              item.busy ? "animate-pulse bg-amber-500" : "bg-emerald-500"
                            }`}
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
                          <span>{item.busy ? "执行中" : "空闲常驻"}</span>
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

            {/* Section 2: Shadow Container Shells */}
            {shadows.length > 0 && (
              <section className="space-y-1.5">
                <div className="px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  分身容器 Shell
                </div>
                {shadows.map(shadow => {
                  const row = primaryContainer(containers, shadow.shadowId);
                  const rootBlocked = row?.root?.hostAllowed === false;
                  return (
                    <div
                      key={shadow.shadowId}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-muted/15 px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          <span
                            aria-hidden="true"
                            className={`size-1.5 rounded-full ${row?.running ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                          />
                          <span className="truncate">{shadow.shadowName}</span>
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {row?.running ? "容器运行中" : "按需启动容器"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={provisionShadow.isPending}
                          onClick={() => openShadowShell(shadow.shadowId, "runner")}
                        >
                          <TerminalIcon className="size-3" />
                          Shell
                        </Button>
                        {!rootBlocked && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={provisionShadow.isPending}
                            title="以容器 root 身份打开交互式 bash"
                            onClick={() => openShadowShell(shadow.shadowId, "root")}
                          >
                            Root
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {/* Section 3: Dormant resumable contexts */}
            {filteredDormant.length > 0 && (
              <section className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => setShowDormant(v => !v)}
                  className="flex w-full items-center justify-between px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
                >
                  <span>已休眠上下文（发消息唤醒）</span>
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
                            去唤醒
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

      {/* Right Multi-Tab Terminal Pane */}
      <section
        ref={workspaceRef}
        aria-label="实时伪终端工作区"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-xs"
      >
        <header className="flex items-center gap-1.5 border-b bg-muted/35 px-2.5 py-1.5">
          {!sidebarOpen && !fullscreen && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="展开会话列表"
              aria-label="展开会话列表"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpenIcon className="size-4" />
            </Button>
          )}

          <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map(tab => {
              const selected = tab.key === activeKey;
              const status = statusMap[tab.key] ?? "正在连接…";
              const connected = status === "已连接";
              const liveItem = tab.kind === "pty" ? liveSessions.find(s => s.contextId === tab.contextId) : undefined;
              return (
                <div
                  key={tab.key}
                  className={`flex shrink-0 items-center rounded-md border text-xs transition-colors ${
                    selected
                      ? "bg-background font-medium shadow-2xs"
                      : "border-transparent text-muted-foreground hover:bg-background/60"
                  }`}
                >
                  <button
                    role="tab"
                    type="button"
                    aria-selected={selected}
                    onClick={() => setActiveKey(tab.key)}
                    title={`${tab.label} (${status})`}
                    className="flex items-center gap-1.5 py-1 pr-1.5 pl-2.5"
                  >
                    <span
                      aria-hidden="true"
                      className={`size-1.5 rounded-full ${
                        !connected
                          ? "bg-muted-foreground/40"
                          : liveItem?.busy
                            ? "animate-pulse bg-amber-500"
                            : "bg-emerald-500"
                      }`}
                    />
                    <span className="max-w-44 truncate">{tab.label}</span>
                    {tab.kind === "pty" && (
                      <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground">TUI</span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭 ${tab.label}`}
                    onClick={() => closeTab(tab.key)}
                    className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>

          {activeTab && (
            <div className="flex shrink-0 items-center gap-1.5 pl-2">
              <span className="hidden max-w-52 truncate text-xs text-muted-foreground xl:inline">
                {activeLiveMeta?.busy ? "AI 正在执行回合…" : activeStatus}
              </span>

              {activeTab.kind === "pty" && (
                <Button
                  size="xs"
                  variant={activeWritable ? "default" : "outline"}
                  onClick={() => {
                    setWritableMap(prev => ({ ...prev, [activeTab.key]: !activeWritable }));
                  }}
                  title={
                    activeWritable
                      ? "释放键盘控制权，切回安全的只读观察模式"
                      : "接管终端键盘输入，直接在浏览器中操作 Claude Code / Codex TUI"
                  }
                >
                  {activeWritable ? (
                    <>
                      <KeyboardIcon className="size-3.5" />
                      释放输入
                    </>
                  ) : (
                    <>
                      <LockIcon className="size-3.5" />
                      接管输入
                    </>
                  )}
                </Button>
              )}

              {activeOwnerHref && (
                <Button size="xs" variant="outline" asChild>
                  <a href={activeOwnerHref}>
                    <ExternalLinkIcon className="size-3.5" />
                    {activeTab?.kind === "pty" && activeTab.ownerType === "task" ? "任务详情" : "回到对话"}
                  </a>
                </Button>
              )}

              {activeEnded && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setStatusMap(prev => ({ ...prev, [activeTab.key]: "正在连接…" }));
                    setGenerations(prev => ({ ...prev, [activeTab.key]: (prev[activeTab.key] ?? 0) + 1 }));
                  }}
                >
                  重新连接
                </Button>
              )}

              <Button
                size="icon-sm"
                variant="ghost"
                title={fullscreen ? "退出全屏" : "全屏显示终端"}
                aria-label={fullscreen ? "退出全屏" : "全屏显示终端"}
                onClick={() =>
                  fullscreen
                    ? void document.exitFullscreen()
                    : void workspaceRef.current?.requestFullscreen()
                }
              >
                {fullscreen ? <MinimizeIcon className="size-3.5" /> : <MaximizeIcon className="size-3.5" />}
              </Button>
            </div>
          )}
        </header>

        {/* Status / Mode Sub-banner */}
        {activeTab && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-1 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span>{activeTab.subtitle}</span>
              {activeTab.kind === "pty" && (
                <span
                  className={`rounded px-1.5 py-0.2 text-[11px] font-medium ${
                    activeWritable
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {activeWritable ? "可交互接管模式 · 按键直达 CLI 伪终端" : "只读观察模式 · 点击右上角「接管输入」可按键操作"}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Quick Key Bar when writable */}
        {activeTab && activeWritable && !activeEnded && (
          <QuickKeyToolbar
            onSend={(seq) => {
              sendInputHandlers.current.get(activeTab.key)?.(seq);
            }}
          />
        )}

        {/* Terminal Viewport Stack */}
        <div className="relative min-h-0 flex-1 bg-[#0b0b0c]">
          {tabs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-zinc-400">
              <TerminalSquareIcon className="size-10 text-zinc-600" />
              {missingFocusedSession ? (
                <>
                  <p className="text-sm font-medium text-zinc-200">
                    「{missingFocusedSession.title ?? "目标会话"}」当前没有活跃的伪终端进程
                  </p>
                  <p className="max-w-md text-xs text-zinc-400">
                    该会话可能尚未启动、已空闲超时回收，或当前模型配置使用的是标准管道（stdio）。在对话中发送一条新消息即可唤醒伪终端。
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-zinc-200">选择左侧的活跃 AI 伪终端或分身 Shell</p>
                  <p className="max-w-md text-xs text-zinc-400">
                    默认以安全的「只读观察」模式实时同步 Claude Code / Codex TUI 画面；需要手动干预、查看 /status 或按键确认时，可随时一键「接管输入」。
                  </p>
                </>
              )}
            </div>
          ) : (
            tabs.map(tab => {
              const selected = tab.key === activeKey;
              const writable = tab.kind === "shell" ? true : Boolean(writableMap[tab.key]);
              const generation = generations[tab.key] ?? 0;
              return (
                <div
                  key={tab.key}
                  role="tabpanel"
                  aria-label={tab.label}
                  className={`absolute inset-0 flex flex-col ${selected ? "" : "invisible pointer-events-none"}`}
                >
                  <AttachedXtermPane
                    key={generation}
                    agentId={agentId}
                    tab={tab}
                    active={selected}
                    writable={writable}
                    onStatus={status => setStatusMap(prev => ({ ...prev, [tab.key]: status }))}
                    registerSender={sender => {
                      if (sender) sendInputHandlers.current.set(tab.key, sender);
                      else sendInputHandlers.current.delete(tab.key);
                    }}
                  />
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function QuickKeyToolbar({ onSend }: { readonly onSend: (seq: string) => void }) {
  const [pasteText, setPasteText] = useState("");
  const sendBracketedPaste = () => {
    if (!pasteText) return;
    onSend(`\x1b[200~${pasteText}\x1b[201~`);
    setPasteText("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {QUICK_KEYS.map(item => (
          <button
            key={item.label}
            type="button"
            title={item.title}
            onClick={() => onSend(item.seq)}
            className="rounded border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground shadow-2xs hover:bg-muted active:translate-y-px"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="ml-auto flex min-w-52 items-center gap-1">
        <Input
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendBracketedPaste();
            }
          }}
          placeholder="缓冲输入中文或长文本（上屏不直接回车）…"
          aria-label="缓冲粘贴到伪终端"
          className="h-6 text-xs"
        />
        <Button size="xs" variant="secondary" disabled={!pasteText} onClick={sendBracketedPaste}>
          <ClipboardPasteIcon className="size-3" />
          上屏
        </Button>
      </div>
    </div>
  );
}

function AttachedXtermPane({
  agentId,
  tab,
  active,
  writable,
  onStatus,
  registerSender,
}: {
  readonly agentId: string;
  readonly tab: WorkbenchTabTarget;
  readonly active: boolean;
  readonly writable: boolean;
  readonly onStatus: (status: string) => void;
  readonly registerSender: (sender: ((data: string) => void) | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const writableRef = useRef(writable);
  writableRef.current = writable;

  useEffect(() => {
    if (active && writable) {
      terminalRef.current?.focus();
    }
  }, [active, writable]);

  // Synchronize read-only <-> writable mode dynamically without reconnecting WebSocket.
  useEffect(() => {
    const socket = socketRef.current;
    const term = terminalRef.current;
    if (term) {
      term.options.disableStdin = !writable;
      term.options.cursorBlink = writable;
    }
    if (socket && socket.readyState === WebSocket.OPEN && tab.kind === "pty") {
      socket.send(JSON.stringify({ type: "mode", writable }));
      if (writable && term) {
        fitRef.current?.fit();
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        term.focus();
      }
    }
  }, [writable, tab.kind]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const terminal = new Terminal({
      cursorBlink: writableRef.current,
      disableStdin: !writableRef.current,
      scrollback: 3000,
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
      theme: {
        background: "#0b0b0c",
        foreground: "#e4e4e7",
        cursor: "#f4f4f5",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const refit = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        fit.fit();
      }
    };
    refit();

    const socket = new WebSocket(
      buildWsUrl(agentId, tab, { cols: terminal.cols || 120, rows: terminal.rows || 36 }, writableRef.current),
    );
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const encoder = new TextEncoder();

    registerSender((seq: string) => {
      if (!writableRef.current) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(seq));
        terminal.focus();
      }
    });

    socket.onopen = () => {
      onStatus("已连接");
      if (writableRef.current) {
        socket.send(JSON.stringify({ type: "mode", writable: true }));
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        terminal.focus();
      }
    };

    socket.onmessage = (event) => {
      terminal.write(new Uint8Array(event.data as ArrayBuffer));
    };

    socket.onclose = (event) => {
      const msg = describeCloseReason(event.reason || (event.code === 1006 ? "" : String(event.code)));
      onStatus(msg);
      terminal.write(`\r\n\x1b[2m[${msg}]\x1b[0m\r\n`);
    };

    const onDataSub = terminal.onData((data) => {
      if (!writableRef.current) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(data));
      }
    });

    const onResizeSub = terminal.onResize(({ cols, rows }) => {
      if (!writableRef.current) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(element);

    return () => {
      registerSender(null);
      resizeObserver.disconnect();
      onDataSub.dispose();
      onResizeSub.dispose();
      socket.close();
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="min-h-0 flex-1 p-2" />;
}
