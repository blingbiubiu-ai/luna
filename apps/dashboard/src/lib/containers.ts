/** Shadow containers and live AI PTY sessions as the Dashboard sees them, plus shared helpers. */
export interface ContainerRow {
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
  /** The Worker writes Dashboard uploads into the Shadow's HOME. */
  uploadSupported?: boolean;
}

export interface ShadowItem {
  shadowId: string;
  shadowName: string;
}

export interface ContainerList {
  containers: ContainerRow[];
  workers: { workerId: string; supported: boolean; error?: string; imageDigest?: string }[];
  shadows?: ShadowItem[];
}

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

export interface PtyConsoleMeta {
  readonly contextId: string;
  readonly label: string;
  readonly subtitle: string;
  readonly ownerType: "session" | "task" | "unknown";
  readonly ownerId: string | null;
  readonly busy?: boolean;
}

export type ConsoleKind = "terminal" | "root" | "vnc";
export type OpenConsoleKind = ConsoleKind | "pty";

export interface OpenConsole {
  key: string;
  row: ContainerRow;
  kind: OpenConsoleKind;
  pty?: PtyConsoleMeta;
}

export const consoleLabels: Record<ConsoleKind, string> = { terminal: "终端", root: "Root 终端", vnc: "桌面" };

export function consoleTitle(item: OpenConsole): string {
  if (item.kind === "pty") {
    return item.pty?.label ?? `${item.row.shadowName ?? item.row.shadowId} · TUI`;
  }
  return `${item.row.shadowName ?? item.row.shadowId} · ${consoleLabels[item.kind]}`;
}

export function runnerKindBadge(kind: "main" | "work" | "task"): string {
  if (kind === "task") return "Task";
  if (kind === "work") return "Work";
  return "Main";
}

export function ownerPath(agentId: string, ownerType: "session" | "task" | "unknown", ownerId: string | null): string | null {
  if (!ownerId) return null;
  if (ownerType === "session") return `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(ownerId)}`;
  if (ownerType === "task") return `/agent/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(ownerId)}`;
  return null;
}

/** The container a Shadow's console opens: the running one, else any. Others are left over on other Workers. */
export function primaryContainer(containers: readonly ContainerRow[], shadowId: string): ContainerRow | undefined {
  const own = containers.filter(row => row.shadowId === shadowId);
  return own.find(row => row.running) ?? own[0];
}

/** Whether a container runs the image its Worker currently uses (unknown when the Worker did not say). */
export function imageCurrent(row: ContainerRow, workers: ContainerList["workers"]): boolean | undefined {
  const current = workers.find(worker => worker.workerId === row.workerId)?.imageDigest;
  return current && row.imageDigest ? current === row.imageDigest : undefined;
}

export const consoleKinds = ["terminal", "root", "vnc"] as const;
export const isBlocked = (row: ContainerRow) => !row.supported || row.state === "draining" || row.state === "reaping";
export const isKindBlocked = (row: ContainerRow, kind: ConsoleKind) => isBlocked(row) || (kind === "root" && row.root?.hostAllowed === false);
export const kindBlockedHint = (row: ContainerRow, kind: ConsoleKind) => {
  if (!row.supported) return "该 Worker 版本不支持，请升级 Worker";
  if (isBlocked(row)) return "容器正在重建或回收";
  if (kind === "root" && row.root?.hostAllowed === false) return rootReasons[row.root.reason ?? ""] ?? "当前 Worker 主机不允许使用容器 Root";
  return undefined;
};

export const rootReasons: Record<string, string> = {
  home_requires_nosuid: "Worker 主机上分身 HOME 所在的文件系统没有以 nosuid 挂载，为防止提权到主机，禁止使用容器 Root",
  unsupported_host: "当前 Worker 主机平台不支持 root",
};
