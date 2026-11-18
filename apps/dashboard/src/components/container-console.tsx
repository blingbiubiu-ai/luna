import { useEffect, useRef, useState } from "react";
import { ClipboardIcon, MaximizeIcon, MinimizeIcon, PanelLeftOpenIcon, PowerOffIcon, XIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import RFB from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import { consoleLabels, primaryContainer, type ConsoleKind, type ContainerList, type ContainerRow, type OpenConsole } from "@/lib/containers";

/** Close reasons sent by Service/Worker, shown when a console ends. */
const closeReasons: Record<string, string> = {
  client_closed: "已关闭",
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
  backpressure: "网络过慢，连接已断开",
  worker_stopping: "Worker 正在停止",
  service_stopping: "Service 正在停止",
  stream_limit: "打开的终端过多",
};

function describeClose(reason: string): string {
  if (reason.startsWith("exited:")) return `会话已结束（退出码 ${reason.slice(7)}）`;
  return closeReasons[reason] ?? (reason ? `连接已断开：${reason}` : "连接已断开");
}

/**
 * A Shadow's containers and the console tabs opened on them. Opening a stopped or not-yet-created
 * container provisions it first, which also moves it to the current resource snapshot.
 */
export function useContainerConsoles(agentId: string) {
  const path = `/agents/${encodeURIComponent(agentId)}/containers`;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => apiFetch<ContainerList>(path, { signal }),
    refetchInterval: 5000,
  });
  const [consoles, setConsoles] = useState<OpenConsole[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const open = (row: ContainerRow, kind: ConsoleKind) => {
    const key = randomId();
    setConsoles(list => [...list, { key, row, kind }]);
    setActive(key);
  };
  const reset = useMutation({
    mutationFn: (row: ContainerRow) => apiFetch(`${path}/${encodeURIComponent(row.workerId)}/${encodeURIComponent(row.environmentId)}/reset`, { method: "POST" }),
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
  return { query, consoles, active, setActive, close, openShadow, reset, confirmReset, provision, stopDesktop, hasSupportedWorker, coldHint };
}

/** Open consoles as tabs; inactive ones stay mounted so their connections survive tab switches. */
export function Workspace({ agentId, consoles, active, onActivate, onClose, listOpen, onOpenList, onStopDesktop, stoppingDesktop }: {
  agentId: string; consoles: OpenConsole[]; active: string | null; onActivate: (key: string) => void; onClose: (key: string) => void;
  listOpen: boolean; onOpenList: () => void; onStopDesktop: (item: OpenConsole) => Promise<void>; stoppingDesktop: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [generations, setGenerations] = useState<Record<string, number>>({});
  const [clipboardOpen, setClipboardOpen] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const current = consoles.find(item => item.key === active);
  const status = (key: string) => statuses[key] ?? "正在连接…";
  const ended = current ? !["已连接", "正在连接…"].includes(status(current.key)) : false;
  const title = (item: OpenConsole) => `${item.row.shadowName ?? item.row.shadowId} · ${consoleLabels[item.kind]}`;

  return <section ref={ref} aria-label="控制台" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
    <header className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
      {!listOpen && !fullscreen && <Button size="icon-sm" variant="ghost" aria-label="展开分身列表" title="展开分身列表" onClick={onOpenList}>
        <PanelLeftOpenIcon />
      </Button>}
      <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {consoles.map(item => {
          const selected = item.key === active;
          const connected = status(item.key) === "已连接";
          return <div key={item.key} className={`flex shrink-0 items-center rounded-md border text-sm ${selected ? "bg-background shadow-sm" : "border-transparent text-muted-foreground hover:bg-background/60"}`}>
            <button role="tab" aria-selected={selected} className="flex items-center gap-1.5 py-1 pr-1 pl-2.5" onClick={() => onActivate(item.key)} title={status(item.key)}>
              <span aria-hidden="true" className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
              {title(item)}
            </button>
            <button aria-label={`关闭 ${title(item)}`} className="mr-1 rounded p-0.5 hover:bg-muted" onClick={() => onClose(item.key)}>
              <XIcon className="size-3.5" />
            </button>
          </div>;
        })}
      </div>
      {current && <div className="flex shrink-0 items-center gap-1 pl-2">
        <span className="hidden max-w-64 truncate text-xs text-muted-foreground lg:inline">{status(current.key)}</span>
        {current.kind === "vnc" && <>
          <Button size="xs" variant={clipboardOpen ? "secondary" : "outline"} onClick={() => setClipboardOpen(open => !open)}
            title="向远程桌面发送密码、网址或中文到剪贴板，或查看桌面复制的内容">
            <ClipboardIcon className="size-3.5" />
            剪贴板
          </Button>
          <Button size="xs" variant="outline" disabled={stoppingDesktop}
            title="停止容器内的桌面与 Chrome 后台进程，释放内存及浏览器配置锁以便任务复用"
            onClick={() => void onStopDesktop(current)}>
            <PowerOffIcon className="size-3.5" />
            关闭桌面后台
          </Button>
        </>}
        {ended && <Button size="sm" variant="outline" onClick={() => {
          setStatuses(map => ({ ...map, [current.key]: "正在连接…" }));
          setGenerations(map => ({ ...map, [current.key]: (map[current.key] ?? 0) + 1 }));
        }}>重新连接</Button>}
        <Button size="icon-sm" variant="ghost" aria-label={fullscreen ? "退出全屏" : "全屏"} title={fullscreen ? "退出全屏 (Esc)" : "全屏"}
          onClick={() => fullscreen ? void document.exitFullscreen() : void ref.current?.requestFullscreen()}>
          {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
        </Button>
      </div>}
    </header>
    {current && current.kind !== "vnc" && <p className="border-b bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
      系统盘改动（如 apt 安装的软件）保留到镜像升级或「重置系统盘」为止；HOME 中的文件永久保留。
    </p>}
    {current && current.kind === "vnc" && <p className="border-b bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
      登录完成后请关闭桌面内的 Chrome 窗口（或点击右上角「关闭桌面后台」），释放浏览器配置锁以便分身任务直接复用登录态。
    </p>}
    <div className="relative min-h-0 flex-1">
      {consoles.map(item => {
        const onStatus = (value: string) => setStatuses(map => ({ ...map, [item.key]: value }));
        const generation = generations[item.key] ?? 0;
        return <div key={item.key} role="tabpanel" aria-label={title(item)} className={`absolute inset-0 flex flex-col ${item.key === active ? "" : "invisible"}`}>
          {item.kind === "vnc"
            ? <DesktopView key={generation} url={streamUrl(agentId, item.row, item.kind)} onStatus={onStatus} clipboardOpen={clipboardOpen && item.key === active} />
            : <TerminalView key={generation} active={item.key === active} url={size => streamUrl(agentId, item.row, item.kind, size)} onStatus={onStatus} />}
        </div>;
      })}
    </div>
  </section>;
}

function streamUrl(agentId: string, row: ContainerRow, kind: ConsoleKind, size?: { cols: number; rows: number }): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ kind: kind === "vnc" ? "vnc" : "terminal", user: kind === "root" ? "root" : "runner" });
  if (size) { params.set("cols", String(size.cols)); params.set("rows", String(size.rows)); }
  return `${protocol}//${window.location.host}/api/agents/${encodeURIComponent(agentId)}/containers/${encodeURIComponent(row.workerId)}/${encodeURIComponent(row.environmentId)}/stream?${params}`;
}

function TerminalView({ url, onStatus, active }: { url: (size: { cols: number; rows: number }) => string; onStatus: (status: string) => void; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  useEffect(() => { if (active) terminalRef.current?.focus(); }, [active]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: { background: "#0b0b0c" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    // Hidden tabs have no size; fitting them would shrink the remote PTY.
    const refit = () => { if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); };
    refit();
    const socket = new WebSocket(url({ cols: terminal.cols, rows: terminal.rows }));
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    socket.onopen = () => { onStatus("已连接"); terminal.focus(); };
    socket.onmessage = event => terminal.write(new Uint8Array(event.data as ArrayBuffer));
    socket.onclose = event => {
      const message = describeClose(event.reason || (event.code === 1006 ? "" : String(event.code)));
      onStatus(message);
      terminal.write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
    };
    const input = terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data)); });
    const resize = terminal.onResize(({ cols, rows }) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows })); });
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    return () => { observer.disconnect(); input.dispose(); resize.dispose(); socket.close(); terminal.dispose(); };
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
    return () => { rfbRef.current = null; rfb.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendClipboard = () => {
    if (!outgoing || !rfbRef.current) return;
    rfbRef.current.clipboardPasteFrom(outgoing);
    rfbRef.current.focus();
    setSentHint(true);
    setTimeout(() => setSentHint(false), 2000);
  };

  return <>
    {clipboardOpen && <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
      <Input
        aria-label="发送到桌面剪贴板"
        value={outgoing}
        onChange={event => setOutgoing(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); sendClipboard(); } }}
        placeholder="输入或粘贴密码、网址、中文文本，点击发送后在桌面内按 Ctrl+V 粘贴…"
        className="h-7 min-w-56 flex-1 text-xs"
      />
      <Button size="xs" variant="secondary" disabled={!outgoing} onClick={sendClipboard}>
        {sentHint ? "已发送，请按 Ctrl+V" : "发送到桌面"}
      </Button>
      {incoming && <div className="flex max-w-sm items-center gap-1.5 border-l pl-2 text-muted-foreground">
        <span className="truncate" title={incoming}>桌面复制：{incoming}</span>
        <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard?.writeText(incoming)}>复制</Button>
      </div>}
    </div>}
    <div ref={ref} className="min-h-0 flex-1 bg-black" />
  </>;
}
