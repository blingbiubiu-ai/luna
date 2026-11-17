import { useEffect, useRef, useState } from "react";
import { ClipboardIcon, MaximizeIcon, MinimizeIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PowerOffIcon, XIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import RFB from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRouteAgent } from "@/lib/agent-route";
import { apiFetch } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";

export const Route = createFileRoute("/$agentId/settings/containers/")({ component: ContainersPage });

interface ContainerRow {
  workerId: string;
  environmentId: string;
  shadowId: string;
  shadowName: string | null;
  mode: string;
  state: string;
  running: boolean;
  activeJobs: number;
  activeStreams?: number;
  resources: { memory: string; cpus: number; pidsLimit: number };
  imageDigest?: string;
  root?: { requested: boolean; effective: boolean; hostAllowed?: boolean; reason?: string };
  supported: boolean;
}

interface ShadowItem {
  shadowId: string;
  shadowName: string;
}

interface ContainerList {
  containers: ContainerRow[];
  workers: { workerId: string; supported: boolean; error?: string }[];
  shadows?: ShadowItem[];
}

type ConsoleKind = "terminal" | "root" | "vnc";
interface OpenConsole { key: string; row: ContainerRow; kind: ConsoleKind }

const consoleLabels: Record<ConsoleKind, string> = { terminal: "终端", root: "Root 终端", vnc: "桌面" };

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

function ContainersPage() {
  const agent = useRouteAgent();
  return <AgentContainers key={agent.id} agentId={agent.id} agentName={agent.name} />;
}

function AgentContainers({ agentId, agentName }: { agentId: string; agentName: string }) {
  const path = `/agents/${encodeURIComponent(agentId)}/containers`;
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => apiFetch<ContainerList>(path, { signal }),
    refetchInterval: 5000,
  });
  const client = useQueryClient();
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
  const confirmReset = (row: ContainerRow) => {
    if (confirm(`重置「${row.shadowName ?? row.shadowId}」的系统盘？\n\n容器会被删除并在下次使用时从镜像重新创建：apt 等安装在系统目录的软件和改动会丢失，HOME 中的文件、登录状态和浏览器数据保留。已打开的终端和桌面会断开。`)) reset.mutate(row);
  };
  const [consoles, setConsoles] = useState<OpenConsole[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const open = (row: ContainerRow, kind: ConsoleKind) => {
    const key = randomId();
    setConsoles(list => [...list, { key, row, kind }]);
    setActive(key);
  };
  // A stopped container may hold a resource snapshot its Worker can no longer mount (an older
  // format, or one replaced since); provisioning brings it to the current snapshot and starts it.
  const openOrStart = (row: ContainerRow, kind: ConsoleKind) => {
    if (row.running) open(row, kind);
    else provision.mutate({ shadowId: row.shadowId, openKind: kind });
  };
  const close = (key: string) => setConsoles(list => {
    const index = list.findIndex(item => item.key === key);
    const rest = list.filter(item => item.key !== key);
    if (key === active) setActive(rest[Math.min(index, rest.length - 1)]?.key ?? null);
    return rest;
  });
  const unreachable = query.data?.workers.filter(worker => worker.error) ?? [];
  const hasSupportedWorker = query.data?.workers.some(worker => worker.supported && !worker.error) ?? false;
  const unprovisioned = (query.data?.shadows ?? []).filter(
    shadow => !query.data?.containers.some(container => container.shadowId === shadow.shadowId),
  );
  const coldHint = !hasSupportedWorker
    ? (query.data && query.data.workers.length === 0 ? "请先在 Worker 页面为当前 Agent 绑定在线 Worker" : "当前没有支持容器控制台的在线 Worker")
    : undefined;
  const alerts = <>
    {query.error && <p role="alert" className="text-destructive">无法加载容器。{query.error.message}</p>}
    {unreachable.length > 0 && <p role="alert" className="text-sm text-destructive">
      以下 Worker 暂时无法访问：{unreachable.map(worker => worker.workerId).join("、")}
    </p>}
    {query.isLoading && <p>正在加载…</p>}
    {reset.error && <p role="alert" className="text-sm text-destructive">无法重置系统盘。{reset.error.message}</p>}
    {provision.error && <p role="alert" className="text-sm text-destructive">无法启动容器。{provision.error.message}</p>}
    {stopDesktop.error && <p role="alert" className="text-sm text-destructive">无法关闭桌面后台。{stopDesktop.error.message}</p>}
  </>;

  if (consoles.length === 0) {
    const hasRows = (query.data?.containers.length ?? 0) > 0 || unprovisioned.length > 0;
    return <main className="mx-auto w-full min-w-0 max-w-7xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">容器</h1>
        <p className="text-muted-foreground">{agentName} 各分身的执行容器。打开终端或桌面时，未创建或已停止的容器会自动初始化并启动。</p>
      </div>
      {alerts}
      {query.data && (hasRows ? <div className="overflow-hidden rounded-lg border">
        <Table aria-label="分身容器">
          <TableHeader className="bg-muted/40">
            <TableRow>
              {["分身", "Worker", "状态", "进行中任务", "资源", "操作"].map(label =>
                <TableHead key={label} scope="col" className="px-3">{label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.containers.map(row => <TableRow key={`${row.workerId}/${row.environmentId}`}>
              <TableCell className="px-3 py-3">
                <p className="font-medium">{row.shadowName ?? row.shadowId}</p>
                <p className="text-xs text-muted-foreground">{row.mode === "shared" ? "共享环境" : row.mode}</p>
              </TableCell>
              <TableCell className="max-w-48 px-3 break-all font-mono text-xs whitespace-normal">{row.workerId}</TableCell>
              <TableCell className="px-3">
                <RunningState row={row} />
                {isBlocked(row) && row.supported && <p className="mt-1 text-xs text-muted-foreground">重建或回收中</p>}
                {!row.running && !isBlocked(row) && <p className="mt-1 text-xs text-muted-foreground">打开终端或桌面即自动启动</p>}
                {(row.activeStreams ?? 0) > 0 && <p className="mt-1 text-xs text-muted-foreground">{row.activeStreams} 个活跃控制台</p>}
              </TableCell>
              <TableCell className="px-3 tabular-nums">{row.activeJobs}</TableCell>
              <TableCell className="px-3 text-xs text-muted-foreground">
                {row.resources.cpus} CPU · {row.resources.memory}
                {row.imageDigest && <p className="font-mono" title={row.imageDigest}>镜像 {shortDigest(row.imageDigest)}</p>}
                <RootBadge row={row} />
              </TableCell>
              <TableCell className="space-x-2 px-3 whitespace-nowrap">
                {consoleKinds.map(kind => <Button key={kind} size="sm" variant="outline"
                  disabled={isKindBlocked(row, kind) || provision.isPending} title={kindBlockedHint(row, kind)}
                  onClick={() => openOrStart(row, kind)}>{consoleLabels[kind]}</Button>)}
                <Button size="sm" variant="ghost" className="text-destructive" disabled={isBlocked(row) || reset.isPending}
                  title="删除容器的系统盘改动（apt 安装的软件等），HOME 保留" onClick={() => confirmReset(row)}>重置系统盘</Button>
              </TableCell>
            </TableRow>)}
            {unprovisioned.map(shadow => <TableRow key={`cold/${shadow.shadowId}`}>
              <TableCell className="px-3 py-3">
                <p className="font-medium">{shadow.shadowName}</p>
                <p className="text-xs text-muted-foreground">共享环境</p>
              </TableCell>
              <TableCell className="px-3 text-xs text-muted-foreground">{hasSupportedWorker ? "首次启动时自动分配" : "未绑定可用 Worker"}</TableCell>
              <TableCell className="px-3">
                <span className="worker-presence shrink-0" data-online={false}>
                  <span className="worker-presence-dot" aria-hidden="true" />
                  未创建
                </span>
                <p className="mt-1 text-xs text-muted-foreground">{coldHint ?? "点击右侧按钮可直接初始化容器并预配环境"}</p>
              </TableCell>
              <TableCell className="px-3 tabular-nums text-muted-foreground">0</TableCell>
              <TableCell className="px-3 text-xs text-muted-foreground">按运行时默认配额创建</TableCell>
              <TableCell className="space-x-2 px-3 whitespace-nowrap">
                {consoleKinds.map(kind => <Button key={kind} size="sm" variant="outline"
                  disabled={!hasSupportedWorker || provision.isPending} title={coldHint}
                  onClick={() => provision.mutate({ shadowId: shadow.shadowId, openKind: kind })}>{consoleLabels[kind]}</Button>)}
                <Button size="sm" variant="ghost" disabled={!hasSupportedWorker || provision.isPending} title={coldHint ?? "仅创建并启动该分身容器"}
                  onClick={() => provision.mutate({ shadowId: shadow.shadowId })}>启动容器</Button>
              </TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div> : <p className="rounded-lg border p-4 text-sm text-muted-foreground">
        当前 Agent 还没有启用中的分身。
      </p>)}
    </main>;
  }

  return <main className="flex min-h-0 w-full min-w-0 flex-1 gap-3 p-3">
    {listOpen && <aside aria-label="分身容器" className="flex w-60 shrink-0 flex-col overflow-hidden rounded-lg border">
      <header className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
        <span className="text-sm font-medium">容器</span>
        <Button size="icon-xs" variant="ghost" aria-label="收起容器列表" title="收起容器列表" onClick={() => setListOpen(false)}>
          <PanelLeftCloseIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {alerts}
        {query.data?.containers.map(row => <div key={`${row.workerId}/${row.environmentId}`} className="rounded-md border p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium" title={row.shadowName ?? row.shadowId}>{row.shadowName ?? row.shadowId}</span>
            <RunningState row={row} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.activeJobs} 个任务 · {row.resources.cpus} CPU · {row.resources.memory}</p>
          <RootBadge row={row} />
          <div className="mt-2 flex flex-wrap gap-1">
            {consoleKinds.map(kind => <Button key={kind} size="xs" variant="outline"
              disabled={isKindBlocked(row, kind) || provision.isPending} title={kindBlockedHint(row, kind)}
              onClick={() => openOrStart(row, kind)}>{consoleLabels[kind]}</Button>)}
            <Button size="xs" variant="ghost" className="text-destructive" disabled={isBlocked(row) || reset.isPending}
              title="重置系统盘：apt 安装的软件等会丢失，HOME 保留" onClick={() => confirmReset(row)}>重置</Button>
          </div>
        </div>)}
        {unprovisioned.map(shadow => <div key={`cold/${shadow.shadowId}`} className="rounded-md border border-dashed p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium" title={shadow.shadowName}>{shadow.shadowName}</span>
            <span className="text-xs text-muted-foreground">未创建</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{coldHint ?? "点击打开即自动初始化"}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {consoleKinds.map(kind => <Button key={kind} size="xs" variant="outline"
              disabled={!hasSupportedWorker || provision.isPending} title={coldHint}
              onClick={() => provision.mutate({ shadowId: shadow.shadowId, openKind: kind })}>{consoleLabels[kind]}</Button>)}
          </div>
        </div>)}
      </div>
    </aside>}
    <Workspace agentId={agentId} consoles={consoles} active={active} onActivate={setActive} onClose={close}
      listOpen={listOpen} onOpenList={() => setListOpen(true)}
      onStopDesktop={async item => {
        await stopDesktop.mutateAsync(item.row);
        close(item.key);
      }}
      stoppingDesktop={stopDesktop.isPending} />
  </main>;
}

const consoleKinds = ["terminal", "root", "vnc"] as const;
const shortDigest = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
const isBlocked = (row: ContainerRow) => !row.supported || row.state === "draining" || row.state === "reaping";
const isKindBlocked = (row: ContainerRow, kind: ConsoleKind) => isBlocked(row) || (kind === "root" && row.root?.hostAllowed === false);
const kindBlockedHint = (row: ContainerRow, kind: ConsoleKind) => {
  if (!row.supported) return "该 Worker 版本不支持，请升级 Worker";
  if (isBlocked(row)) return "容器正在重建或回收";
  if (kind === "root" && row.root?.hostAllowed === false) return rootReasons[row.root.reason ?? ""] ?? "当前 Worker 主机不允许使用容器 Root";
  return undefined;
};

/** The container's root state: on, or requested/refused by the Worker host. */
function RootBadge({ row }: { row: ContainerRow }) {
  if (row.root?.hostAllowed === false) return <p className="mt-1 text-xs font-medium text-destructive"
    title={rootReasons[row.root.reason ?? ""] ?? row.root.reason}>{row.root.requested ? "root 未生效" : "主机禁用 root"}</p>;
  if (!row.root?.requested) return null;
  if (row.root.effective) return <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400"
    title="分身已开启 root：受信用户触发的任务可以在容器内使用 sudo">root 已开启</p>;
  return <p className="mt-1 text-xs font-medium text-destructive"
    title={rootReasons[row.root.reason ?? ""] ?? row.root.reason}>root 未生效</p>;
}
const rootReasons: Record<string, string> = {
  home_requires_nosuid: "Worker 主机上分身 HOME 所在的文件系统没有以 nosuid 挂载，为防止提权到主机，禁止使用容器 Root",
  unsupported_host: "当前 Worker 主机平台不支持 root",
};

function RunningState({ row }: { row: ContainerRow }) {
  return <span className="worker-presence shrink-0" data-online={row.running}>
    <span className="worker-presence-dot" aria-hidden="true" />
    {row.running ? "运行中" : "已停止"}
  </span>;
}

/** Open consoles as tabs; inactive ones stay mounted so their connections survive tab switches. */
function Workspace({ agentId, consoles, active, onActivate, onClose, listOpen, onOpenList, onStopDesktop, stoppingDesktop }: {
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
      {!listOpen && !fullscreen && <Button size="icon-sm" variant="ghost" aria-label="展开容器列表" title="展开容器列表" onClick={onOpenList}>
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
