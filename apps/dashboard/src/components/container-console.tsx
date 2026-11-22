import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ClipboardIcon,
  ClipboardPasteIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LockIcon,
  MaximizeIcon,
  MinimizeIcon,
  PanelLeftOpenIcon,
  PowerOffIcon,
  TerminalIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import RFB from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import { UploadDialog } from "@/components/container-upload";
import {
  consoleLabels,
  consoleTitle,
  ownerPath,
  primaryContainer,
  runnerKindBadge,
  type ConsoleKind,
  type ContainerList,
  type ContainerRow,
  type LivePtySessionItem,
  type OpenConsole,
} from "@/lib/containers";

export { consoleTitle };

/** Close reasons sent by Service/Worker, shown when a console or PTY stream ends. */
const closeReasons: Record<string, string> = {
  client_closed: "已关闭",
  pty_session_not_found: "该伪终端会话当前未在运行（可能已空闲回收）",
  pty_session_closed: "伪终端会话已关闭",
  idle_timeout: "伪终端空闲超时已自动回收",
  worker_disconnected: "Worker 连接已断开",
  worker_revoked: "Worker 已撤销",
  worker_stream_timeout: "Worker 未响应",
  worker_streams_unsupported: "该 Worker 版本不支持容器终端，请升级 Worker",
  environment_draining: "容器正在重建或回收，请稍后再试",
  system_disk_reset: "系统盘已重置，连接已断开",
  environment_agent_mismatch: "容器不属于当前 Agent",
  home_requires_nosuid: "Worker 主机上分身 HOME 未以 nosuid 挂载，禁止开启 Root 终端",
  unsupported_host: "当前 Worker 主机平台不支持容器 Root",
  desktop_unavailable: "当前镜像不包含桌面组件，请升级 Runner 镜像",
  desktop_start_failed: "桌面启动失败",
  backpressure: "网络或输出过快，连接已断开",
  worker_stopping: "Worker 正在停止",
  service_stopping: "Service 正在停止",
  stream_limit: "打开的终端过多",
};

const QUICK_KEYS: ReadonlyArray<{ readonly label: string; readonly title: string; readonly seq: string }> = [
  { label: "Ctrl+T", title: "展开/关闭 Codex 完整执行记录（Transcript）", seq: "\x14" },
  { label: "Ctrl+O", title: "展开/折叠 Claude Code 工具输出详情", seq: "\x0f" },
  { label: "PgUp", title: "向上翻页（在 Transcript 视图中翻看历史命令输出）", seq: "\x1b[5~" },
  { label: "PgDn", title: "向下翻页", seq: "\x1b[6~" },
  { label: "Esc", title: "发送 Esc（退出详情视图、取消弹窗或中断当前回合）", seq: "\x1b" },
  { label: "Ctrl+C", title: "发送 Ctrl+C", seq: "\x03" },
  { label: "Shift+Tab", title: "切换 CLI 模式（如权限/计划模式）", seq: "\x1b[Z" },
  { label: "Tab", title: "发送 Tab 补全", seq: "\t" },
  { label: "↑", title: "上方向键", seq: "\x1b[A" },
  { label: "↓", title: "下方向键", seq: "\x1b[B" },
  { label: "←", title: "左方向键", seq: "\x1b[D" },
  { label: "→", title: "右方向键", seq: "\x1b[C" },
  { label: "Enter", title: "发送回车提交", seq: "\r" },
];

function describeClose(reason: string): string {
  if (reason.startsWith("exited:")) return `会话已结束（退出码 ${reason.slice(7)}）`;
  return closeReasons[reason] ?? (reason ? `连接已断开：${reason}` : "连接已断开");
}

function fallbackPtyContainerRow(session: LivePtySessionItem): ContainerRow {
  return {
    workerId: session.workerId,
    environmentId: session.environmentId,
    shadowId: session.shadowId,
    shadowName: session.shadowName,
    mode: "shared",
    state: "running",
    running: true,
    activeJobs: session.busy ? 1 : 0,
    resources: { memory: "", cpus: 0, pidsLimit: 0 },
    supported: true,
    uploadSupported: true,
  };
}

function buildPtyMeta(session: LivePtySessionItem) {
  return {
    contextId: session.contextId,
    label: session.title || `${session.runnerType} · ${session.contextId.slice(0, 8)}`,
    subtitle: [
      runnerKindBadge(session.runnerKind),
      session.runnerType,
      session.model,
      session.shadowName,
    ].filter(Boolean).join(" · "),
    ownerType: session.ownerType,
    ownerId: session.ownerId,
    busy: session.busy,
  };
}

/**
 * A Shadow's containers and the unified console/TUI tabs opened on them. Opening a stopped or
 * not-yet-created container provisions it first, which also moves it to the current resource snapshot.
 */
export function useContainerConsoles(agentId: string) {
  const path = `/agents/${encodeURIComponent(agentId)}/containers`;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => apiFetch<ContainerList>(path, { signal }),
    refetchInterval: 5000,
  });
  const [rawConsoles, setConsoles] = useState<OpenConsole[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const open = (row: ContainerRow, kind: ConsoleKind) => {
    const key = randomId();
    setConsoles(list => [...list, { key, row, kind }]);
    setActive(key);
  };

  const openPty = (session: LivePtySessionItem) => {
    const key = `pty:${session.contextId}`;
    const matchedRow = query.data?.containers.find(
      row => row.workerId === session.workerId && row.environmentId === session.environmentId,
    );
    const pty = buildPtyMeta(session);
    setConsoles(list => {
      const existingIndex = list.findIndex(item => item.key === key);
      if (existingIndex >= 0) {
        return list.map((item, idx) =>
          idx === existingIndex
            ? { ...item, row: matchedRow ?? item.row, pty }
            : item,
        );
      }
      return [...list, { key, row: matchedRow ?? fallbackPtyContainerRow(session), kind: "pty", pty }];
    });
    setActive(key);
  };

  const consoles = useMemo(() => {
    const liveContainers = query.data?.containers;
    if (!liveContainers?.length) return rawConsoles;
    return rawConsoles.map(item => {
      const fresh = liveContainers.find(
        row => row.workerId === item.row.workerId && row.environmentId === item.row.environmentId,
      );
      return fresh ? { ...item, row: fresh } : item;
    });
  }, [rawConsoles, query.data?.containers]);

  const reset = useMutation({
    mutationFn: (row: ContainerRow) =>
      apiFetch(`${path}/${encodeURIComponent(row.workerId)}/${encodeURIComponent(row.environmentId)}/reset`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: [path] }),
  });
  const provision = useMutation({
    mutationFn: (input: { shadowId: string; openKind?: ConsoleKind }) =>
      apiFetch<{ container: ContainerRow }>(path, { method: "POST", body: JSON.stringify({ shadowId: input.shadowId }) }),
    onSuccess: (data, variables) => {
      void client.invalidateQueries({ queryKey: [path] });
      if (variables.openKind) open(data.container, variables.openKind);
    },
  });
  const stopDesktop = useMutation({
    mutationFn: (row: ContainerRow) =>
      apiFetch(`${path}/${encodeURIComponent(row.workerId)}/${encodeURIComponent(row.environmentId)}/desktop/stop`, { method: "POST" }),
  });
  const close = (key: string) => setConsoles(list => {
    const index = list.findIndex(item => item.key === key);
    const rest = list.filter(item => item.key !== key);
    if (key === active) setActive(rest[Math.min(index, rest.length - 1)]?.key ?? null);
    return rest;
  });
  /** Open a console on a Shadow: its running container directly, otherwise through provisioning. */
  const openShadow = (shadowId: string, kind: ConsoleKind) => {
    const row = primaryContainer(query.data?.containers ?? [], shadowId);
    if (row?.running) open(row, kind);
    else provision.mutate({ shadowId, openKind: kind });
  };
  const confirmReset = (row: ContainerRow, name: string) => {
    if (confirm(`重置「${name}」的系统盘？\n\n容器会被删除并在下次使用时从镜像重新创建：apt 等安装在系统目录的软件和改动会丢失，HOME 中的文件、登录状态和浏览器数据保留。已打开的终端和桌面会断开。`)) reset.mutate(row);
  };
  const workers = query.data?.workers ?? [];
  const hasSupportedWorker = workers.some(worker => worker.supported && !worker.error);
  const coldHint = hasSupportedWorker ? undefined
    : query.data && workers.length === 0 ? "请先在 Worker 页面为当前 Agent 绑定在线 Worker" : "当前没有支持容器控制台的在线 Worker";
  return {
    query,
    consoles,
    active,
    setActive,
    close,
    openShadow,
    openPty,
    reset,
    confirmReset,
    provision,
    stopDesktop,
    hasSupportedWorker,
    coldHint,
  };
}

/**
 * Unified multi-tab console workspace shared by both「数字分身」and「TUI 终端」.
 * Supports AI PTY streams (read-only observation + one-click input takeover), Shadow shells,
 * Root shells, VNC desktop + clipboard, quick-key/paste toolbar, and HOME file drag-and-drop upload.
 */
export function Workspace({
  agentId,
  consoles,
  active,
  onActivate,
  onClose,
  listOpen,
  onOpenList,
  openListLabel = "展开分身列表",
  onStopDesktop,
  stoppingDesktop,
  livePtyByContextId,
  emptyState,
}: {
  agentId: string;
  consoles: OpenConsole[];
  active: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  listOpen: boolean;
  onOpenList: () => void;
  openListLabel?: string;
  onStopDesktop: (item: OpenConsole) => Promise<void>;
  stoppingDesktop: boolean;
  livePtyByContextId?: ReadonlyMap<string, LivePtySessionItem>;
  emptyState?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [generations, setGenerations] = useState<Record<string, number>>({});
  const [writableMap, setWritableMap] = useState<Record<string, boolean>>({});
  const [quickKeysPref, setQuickKeysPref] = useState<Record<string, boolean>>({});
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | undefined>();
  const [dragging, setDragging] = useState(false);
  const sendInputHandlers = useRef<Map<string, (data: string) => void>>(new Map());

  // The dialog renders outside the console, so it would be hidden behind a fullscreen console.
  const openUpload = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setUploadOpen(true);
  };

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const current = consoles.find(item => item.key === active);
  const status = (key: string) => statuses[key] ?? "正在连接…";
  const ended = current ? !["已连接", "正在连接…"].includes(status(current.key)) : false;
  const isWritable = (item: OpenConsole) =>
    item.kind === "pty" ? Boolean(writableMap[item.key]) : item.kind !== "vnc";
  const currentWritable = current ? isWritable(current) : false;
  const currentLivePty = current?.kind === "pty" && current.pty
    ? livePtyByContextId?.get(current.pty.contextId)
    : undefined;
  const currentBusy = currentLivePty?.busy ?? current?.pty?.busy ?? false;
  const currentOwnerHref = current?.kind === "pty" && current.pty
    ? ownerPath(agentId, current.pty.ownerType, current.pty.ownerId)
    : null;
  const quickKeysOpen = current && current.kind !== "vnc" && currentWritable && !ended
    ? (current.kind === "pty" ? quickKeysPref[current.key] !== false : quickKeysPref[current.key] === true)
    : false;

  const handleClose = (key: string) => {
    sendInputHandlers.current.delete(key);
    onClose(key);
  };

  return (
    <section
      ref={ref}
      aria-label="控制台"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background"
    >
      <header className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
        {!listOpen && !fullscreen && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={openListLabel}
            title={openListLabel}
            onClick={onOpenList}
          >
            <PanelLeftOpenIcon />
          </Button>
        )}
        <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {consoles.map(item => {
            const selected = item.key === active;
            const itemStatus = status(item.key);
            const connected = itemStatus === "已连接";
            const itemBusy = item.kind === "pty" && item.pty
              ? (livePtyByContextId?.get(item.pty.contextId)?.busy ?? item.pty.busy ?? false)
              : false;
            const label = consoleTitle(item);
            return (
              <div
                key={item.key}
                className={`flex shrink-0 items-center rounded-md border text-sm ${
                  selected
                    ? "bg-background shadow-sm"
                    : "border-transparent text-muted-foreground hover:bg-background/60"
                }`}
              >
                <button
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  className="flex items-center gap-1.5 py-1 pr-1.5 pl-2.5"
                  onClick={() => onActivate(item.key)}
                  title={`${label}（${itemStatus}）`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${
                      connected ? "bg-emerald-500" : "bg-muted-foreground/50"
                    }`}
                  />
                  <span className="max-w-48 truncate">{label}</span>
                  {item.kind === "pty" && (
                    <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground">TUI</span>
                  )}
                  {item.kind === "pty" && itemBusy && (
                    <span className="animate-pulse rounded bg-amber-500/15 px-1.5 py-0.2 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      执行中
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${label}`}
                  className="mr-1 rounded p-0.5 hover:bg-muted"
                  onClick={() => handleClose(item.key)}
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        {current && (
          <div className="flex shrink-0 items-center gap-1 pl-2">
            <span className="hidden max-w-56 truncate text-xs text-muted-foreground xl:inline">
              {currentBusy && status(current.key) === "已连接" ? "AI 正在执行回合…" : status(current.key)}
            </span>

            {current.kind === "pty" && (
              <Button
                size="xs"
                variant={currentWritable ? "default" : "outline"}
                onClick={() => setWritableMap(prev => ({ ...prev, [current.key]: !currentWritable }))}
                title={
                  currentWritable
                    ? "释放键盘控制权，切回安全的只读观察模式"
                    : "接管终端键盘输入，直接在浏览器中操作 Claude Code / Codex TUI"
                }
              >
                {currentWritable ? (
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

            {currentOwnerHref && (
              <Button size="xs" variant="outline" asChild>
                <a href={currentOwnerHref}>
                  <ExternalLinkIcon className="size-3.5" />
                  {current.pty?.ownerType === "task" ? "任务详情" : "回到对话"}
                </a>
              </Button>
            )}

            {current.kind !== "vnc" && currentWritable && !ended && (
              <Button
                size="xs"
                variant={quickKeysOpen ? "secondary" : "outline"}
                onClick={() => setQuickKeysPref(prev => ({ ...prev, [current.key]: !quickKeysOpen }))}
                title="展开或收起悬浮快捷按键栏（不改变终端高度）"
              >
                <TerminalIcon className="size-3.5" />
                快捷栏
              </Button>
            )}

            <Button
              size="xs"
              variant="outline"
              disabled={current.row.uploadSupported !== true}
              title={
                current.row.uploadSupported
                  ? "上传文件到分身的 HOME（也可以把文件拖到控制台上）"
                  : "该 Worker 版本不支持上传文件，请升级 Worker"
              }
              onClick={() => {
                setDroppedFiles(undefined);
                openUpload();
              }}
            >
              <UploadIcon className="size-3.5" />
              上传文件
            </Button>

            {current.kind === "vnc" && (
              <>
                <Button
                  size="xs"
                  variant={clipboardOpen ? "secondary" : "outline"}
                  onClick={() => setClipboardOpen(open => !open)}
                  title="向远程桌面发送密码、网址或中文到剪贴板，或查看桌面复制的内容"
                >
                  <ClipboardIcon className="size-3.5" />
                  剪贴板
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={stoppingDesktop}
                  title="停止容器内的桌面与 Chrome 后台进程，释放内存及浏览器配置锁以便任务复用"
                  onClick={() => void onStopDesktop(current)}
                >
                  <PowerOffIcon className="size-3.5" />
                  关闭桌面后台
                </Button>
              </>
            )}

            {ended && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setStatuses(map => ({ ...map, [current.key]: "正在连接…" }));
                  setGenerations(map => ({ ...map, [current.key]: (map[current.key] ?? 0) + 1 }));
                }}
              >
                重新连接
              </Button>
            )}

            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={fullscreen ? "退出全屏" : "全屏"}
              title={fullscreen ? "退出全屏 (Esc)" : "全屏"}
              onClick={() =>
                fullscreen ? void document.exitFullscreen() : void ref.current?.requestFullscreen()
              }
            >
              {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
            </Button>
          </div>
        )}
      </header>

      {current && current.kind === "pty" && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
          {current.pty?.subtitle && <span>{current.pty.subtitle}</span>}
          <span
            className={`rounded px-1.5 py-0.2 text-[11px] font-medium ${
              currentWritable
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {currentWritable
              ? "可交互接管模式 · 按键直达 CLI 伪终端"
              : "只读观察模式 · 点击右上角「接管输入」可按键操作"}
          </span>
        </div>
      )}

      {current && (current.kind === "terminal" || current.kind === "root") && (
        <p className="border-b bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
          系统盘改动（如 apt 安装的软件）保留到镜像升级或「重置系统盘」为止；HOME 中的文件永久保留。
        </p>
      )}

      {current && current.kind === "vnc" && (
        <p className="border-b bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
          登录完成后请关闭桌面内的 Chrome 窗口（或点击右上角「关闭桌面后台」），释放浏览器配置锁以便分身任务直接复用登录态。
        </p>
      )}

      <div
        className="relative min-h-0 flex-1 bg-[#0b0b0c]"
        onDragOver={event => {
          if (current?.row.uploadSupported && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={event => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={event => {
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (!current?.row.uploadSupported || !files.length) return;
          event.preventDefault();
          setDroppedFiles(files);
          openUpload();
        }}
      >
        {current && quickKeysOpen && (
          <QuickKeyToolbar
            onClose={() => setQuickKeysPref(prev => ({ ...prev, [current.key]: false }))}
            onSend={seq => {
              sendInputHandlers.current.get(current.key)?.(seq);
            }}
          />
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/70 text-sm font-medium">
            松开以上传到分身的 HOME
          </div>
        )}
        {consoles.length === 0 ? (
          emptyState ?? null
        ) : (
          consoles.map(item => {
            const onStatus = (value: string) => setStatuses(map => ({ ...map, [item.key]: value }));
            const generation = generations[item.key] ?? 0;
            const selected = item.key === active;
            const writable = isWritable(item);
            return (
              <div
                key={item.key}
                role="tabpanel"
                aria-label={consoleTitle(item)}
                className={`absolute inset-0 flex flex-col ${selected ? "" : "invisible pointer-events-none"}`}
              >
                {item.kind === "vnc" ? (
                  <DesktopView
                    key={generation}
                    url={streamUrl(agentId, item)}
                    onStatus={onStatus}
                    clipboardOpen={clipboardOpen && selected}
                  />
                ) : (
                  <TerminalView
                    key={generation}
                    active={selected}
                    kind={item.kind}
                    writable={writable}
                    url={(size, initialWritable) => streamUrl(agentId, item, size, initialWritable)}
                    onStatus={onStatus}
                    registerSender={sender => {
                      if (sender) sendInputHandlers.current.set(item.key, sender);
                      else sendInputHandlers.current.delete(item.key);
                    }}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {current && (
        <UploadDialog
          agentId={agentId}
          row={current.row}
          open={uploadOpen}
          initialFiles={droppedFiles}
          onOpenChange={next => {
            setUploadOpen(next);
            if (!next) setDroppedFiles(undefined);
          }}
        />
      )}
    </section>
  );
}

function streamUrl(
  agentId: string,
  item: OpenConsole,
  size?: { cols: number; rows: number },
  writable?: boolean,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  if (item.kind === "pty") {
    params.set("kind", "pty");
    params.set("user", "runner");
    if (item.pty?.contextId) params.set("contextId", item.pty.contextId);
    params.set("writable", writable ? "1" : "0");
  } else {
    params.set("kind", item.kind === "vnc" ? "vnc" : "terminal");
    params.set("user", item.kind === "root" ? "root" : "runner");
  }
  if (size) {
    params.set("cols", String(size.cols));
    params.set("rows", String(size.rows));
  }
  return `${protocol}//${window.location.host}/api/agents/${encodeURIComponent(agentId)}/containers/${encodeURIComponent(item.row.workerId)}/${encodeURIComponent(item.row.environmentId)}/stream?${params}`;
}

function QuickKeyToolbar({
  onClose,
  onSend,
}: {
  readonly onClose: () => void;
  readonly onSend: (seq: string) => void;
}) {
  const [pasteText, setPasteText] = useState("");
  const sendBracketedPaste = () => {
    if (!pasteText) return;
    onSend(`\x1b[200~${pasteText}\x1b[201~`);
    setPasteText("");
  };
  return (
    <div
      aria-label="悬浮快捷按键栏"
      className="pointer-events-auto absolute top-2 right-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900/90 px-2.5 py-1.5 text-zinc-100 shadow-lg backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-center gap-1">
        {QUICK_KEYS.map(item => (
          <button
            key={item.label}
            type="button"
            title={item.title}
            onClick={() => onSend(item.seq)}
            className="rounded border border-zinc-700 bg-zinc-800/90 px-2 py-0.5 font-mono text-[11px] text-zinc-100 hover:bg-zinc-700 active:translate-y-px"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="flex min-w-48 items-center gap-1">
        <Input
          value={pasteText}
          onChange={event => setPasteText(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              sendBracketedPaste();
            }
          }}
          placeholder="缓冲输入中文或长文本…"
          aria-label="缓冲粘贴到终端"
          className="h-6 border-zinc-700 bg-zinc-950/80 text-xs text-zinc-100 placeholder:text-zinc-400"
        />
        <Button size="xs" variant="secondary" disabled={!pasteText} onClick={sendBracketedPaste}>
          <ClipboardPasteIcon className="size-3" />
          上屏
        </Button>
        <button
          type="button"
          title="收起快捷栏"
          aria-label="收起快捷栏"
          onClick={onClose}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function TerminalView({
  url,
  kind,
  writable,
  onStatus,
  active,
  registerSender,
}: {
  url: (size: { cols: number; rows: number }, writable: boolean) => string;
  kind: Exclude<OpenConsole["kind"], "vnc">;
  writable: boolean;
  onStatus: (status: string) => void;
  active: boolean;
  registerSender: (sender: ((data: string) => void) | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const writableRef = useRef(writable);
  writableRef.current = writable;

  useEffect(() => {
    if (!active) return;
    const element = ref.current;
    if (element && element.clientWidth > 0 && element.clientHeight > 0) {
      fitRef.current?.fit();
    }
    if (writableRef.current) terminalRef.current?.focus();
  }, [active]);

  // Dynamically toggle read-only <-> writable mode on PTY streams without resizing or reconnecting.
  useEffect(() => {
    const socket = socketRef.current;
    const term = terminalRef.current;
    if (term) {
      term.options.disableStdin = !writable;
      term.options.cursorBlink = writable;
    }
    if (kind === "pty" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "mode", writable }));
      if (writable) {
        term?.focus();
      }
    }
  }, [writable, kind]);

  useEffect(() => {
    const element = ref.current;
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

    // Hidden tabs have no size; fitting them would shrink the remote PTY.
    const refit = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    };
    refit();

    let lastSentCols = 0;
    let lastSentRows = 0;
    const socket = new WebSocket(
      url({ cols: terminal.cols || 120, rows: terminal.rows || 36 }, writableRef.current),
    );
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const encoder = new TextEncoder();

    const sendResizeIfChanged = (cols: number, rows: number) => {
      if (socket.readyState !== WebSocket.OPEN || cols <= 0 || rows <= 0) return;
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    };

    registerSender((seq: string) => {
      if (!writableRef.current) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(seq));
        terminal.focus();
      }
    });

    socket.onopen = () => {
      onStatus("已连接");
      refit();
      sendResizeIfChanged(terminal.cols, terminal.rows);
      if (writableRef.current) {
        if (kind === "pty") {
          socket.send(JSON.stringify({ type: "mode", writable: true }));
        }
        terminal.focus();
      }
    };
    socket.onmessage = event => terminal.write(new Uint8Array(event.data as ArrayBuffer));
    socket.onclose = event => {
      const message = describeClose(event.reason || (event.code === 1006 ? "" : String(event.code)));
      onStatus(message);
      terminal.write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
    };

    const input = terminal.onData(data => {
      if (!writableRef.current) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      sendResizeIfChanged(cols, rows);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedRefit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refit, 120);
    };
    const observer = new ResizeObserver(debouncedRefit);
    observer.observe(element);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      registerSender(null);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket.close();
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
    };
    // The URL builder is stable for one console; reconnecting remounts this view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className="min-h-0 flex-1 bg-[#0b0b0c] p-2" />;
}

function DesktopView({ url, onStatus, clipboardOpen }: { url: string; onStatus: (status: string) => void; clipboardOpen: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [outgoing, setOutgoing] = useState("");
  const [incoming, setIncoming] = useState("");
  const [sentHint, setSentHint] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rfb = new RFB(element, url, { shared: true });
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.addEventListener("connect", () => onStatus("已连接"));
    rfb.addEventListener("clipboard", event => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === "string") setIncoming(text);
    });
    rfb.addEventListener("disconnect", event => {
      const clean = (event as CustomEvent<{ clean: boolean }>).detail?.clean;
      onStatus(clean ? "已断开" : "连接已断开，可能是镜像不包含桌面组件或容器正在重建");
    });
    return () => {
      rfbRef.current = null;
      rfb.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendClipboard = () => {
    if (!outgoing || !rfbRef.current) return;
    rfbRef.current.clipboardPasteFrom(outgoing);
    rfbRef.current.focus();
    setSentHint(true);
    setTimeout(() => setSentHint(false), 2000);
  };

  return (
    <>
      {clipboardOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
          <Input
            aria-label="发送到桌面剪贴板"
            value={outgoing}
            onChange={event => setOutgoing(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                sendClipboard();
              }
            }}
            placeholder="输入或粘贴密码、网址、中文文本，点击发送后在桌面内按 Ctrl+V 粘贴…"
            className="h-7 min-w-56 flex-1 text-xs"
          />
          <Button size="xs" variant="secondary" disabled={!outgoing} onClick={sendClipboard}>
            {sentHint ? "已发送，请按 Ctrl+V" : "发送到桌面"}
          </Button>
          {incoming && (
            <div className="flex max-w-sm items-center gap-1.5 border-l pl-2 text-muted-foreground">
              <span className="truncate" title={incoming}>
                桌面复制：{incoming}
              </span>
              <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard?.writeText(incoming)}>
                复制
              </Button>
            </div>
          )}
        </div>
      )}
      <div ref={ref} className="min-h-0 flex-1 bg-black" />
    </>
  );
}
