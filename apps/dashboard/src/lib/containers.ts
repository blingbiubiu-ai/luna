/** Shadow containers as the Dashboard sees them, and the pure helpers shared by the console and the Shadow card. */
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

export type ConsoleKind = "terminal" | "root" | "vnc";
export interface OpenConsole { key: string; row: ContainerRow; kind: ConsoleKind }

export const consoleLabels: Record<ConsoleKind, string> = { terminal: "终端", root: "Root 终端", vnc: "桌面" };

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

