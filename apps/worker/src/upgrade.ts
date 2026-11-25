import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ExecutionError, readPrivateJson, writePrivateJson } from "@luna/execution-store";
import { WorkerLocalConfig, type WorkerConfig } from "./config";
import { extractImageRepoDigestFromInspect } from "./docker-driver";

const execFileAsync = promisify(execFile);

export interface WorkerUpgradeStatus {
  state: "idle" | "pulling_image" | "downloading_worker" | "restarting" | "succeeded" | "failed";
  targetVersion?: string | undefined;
  targetImage?: string | undefined;
  message?: string | undefined;
  updatedAt: number;
}

export const WorkerUpgradeInput = z.object({
  upgradeWorker: z.boolean().optional(),
  upgradeImage: z.boolean().optional(),
  imageRef: z.string().min(1).max(512).optional(),
}).strict();
export type WorkerUpgradeInput = z.infer<typeof WorkerUpgradeInput>;

interface ReleaseManifest {
  worker?: {
    available?: boolean;
    version?: string | null;
    sha256?: string | null;
    downloadPath?: string;
  };
  images?: Record<string, { image?: string }>;
}

export interface WorkerUpgradeManagerOptions {
  onStatusChange?: () => void;
  onRestart?: () => void;
  onImageRepoDigest?: (repoDigest: string | undefined) => void;
  configFile?: string;
  scriptPath?: string;
  fetchFn?: typeof fetch;
  execDocker?: (args: string[]) => Promise<string>;
  restartDelayMs?: number;
}

function detectScriptHash(scriptPath?: string): { sha256: string; version: string } | undefined {
  if (!scriptPath) return undefined;
  try {
    if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) return undefined;
    const sha256 = createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
    return { sha256, version: sha256.slice(0, 12) };
  } catch {
    return undefined;
  }
}

function hasManagedBinary(dataRoot: string): boolean {
  try {
    return lstatSync(join(dataRoot, "bin", "current")).isSymbolicLink();
  } catch {
    return false;
  }
}

function atomicSymlink(target: string, linkPath: string): void {
  const tmp = `${linkPath}.tmp-${randomBytes(6).toString("hex")}`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, linkPath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

export class WorkerUpgradeManager {
  readonly workerSha256: string | undefined;
  readonly workerVersion: string | undefined;
  private running = false;
  private currentStatus: WorkerUpgradeStatus = { state: "idle", updatedAt: Date.now() };
  private readonly configFile: string;
  private readonly fetchFn: typeof fetch;
  private readonly execDocker: (args: string[]) => Promise<string>;
  private readonly onStatusChange: () => void;
  private readonly onRestart: () => void;
  private readonly onImageRepoDigest: (repoDigest: string | undefined) => void;
  private readonly restartDelayMs: number;

  constructor(private readonly config: WorkerConfig, options: WorkerUpgradeManagerOptions = {}) {
    const hash = detectScriptHash(options.scriptPath ?? process.argv[1]);
    this.workerSha256 = hash?.sha256;
    this.workerVersion = hash?.version;
    this.configFile = options.configFile ?? join(config.dataRoot, "worker.json");
    this.fetchFn = options.fetchFn ?? fetch;
    this.execDocker = options.execDocker ?? (async (args: string[]) => {
      const { stdout } = await execFileAsync("docker", args, {
        encoding: "utf8",
        timeout: 15 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    });
    this.onStatusChange = options.onStatusChange ?? (() => {});
    this.onRestart = options.onRestart ?? (() => {});
    this.onImageRepoDigest = options.onImageRepoDigest ?? (() => {});
    this.restartDelayMs = options.restartDelayMs ?? 500;
  }

  get managedBinary(): boolean {
    return hasManagedBinary(this.config.dataRoot);
  }

  get status(): WorkerUpgradeStatus {
    return { ...this.currentStatus };
  }

  private setStatus(next: Omit<WorkerUpgradeStatus, "updatedAt">): void {
    this.currentStatus = { ...next, updatedAt: Date.now() };
    this.onStatusChange();
  }

  startUpgrade(rawInput?: unknown): { accepted: true; status: WorkerUpgradeStatus } {
    if (this.running) throw new ExecutionError(409, "upgrade_in_progress");
    const input = rawInput === undefined ? {} : WorkerUpgradeInput.parse(rawInput);
    this.running = true;
    this.setStatus({ state: "pulling_image", message: "正在准备升级…" });
    void this.run(input).finally(() => {
      this.running = false;
    });
    return { accepted: true, status: this.status };
  }

  private async fetchManifest(): Promise<ReleaseManifest | undefined> {
    if (!this.config.serviceUrl) return undefined;
    const response = await this.fetchFn(new URL("/api/worker/release/manifest.json", this.config.serviceUrl), {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`获取发布清单失败 (${response.status})`);
    return (await response.json()) as ReleaseManifest;
  }

  private async run(input: WorkerUpgradeInput): Promise<void> {
    try {
      const wantImage = input.upgradeImage !== false;
      const wantWorker = input.upgradeWorker !== false;
      const manifest = this.config.serviceUrl ? await this.fetchManifest() : undefined;

      let imageUpdated = false;
      const targetImage = input.imageRef
        ?? this.config.imageRef
        ?? (this.config.imageVariant ? manifest?.images?.[this.config.imageVariant]?.image : undefined);

      if (wantImage && targetImage) {
        this.setStatus({ state: "pulling_image", targetImage, message: `正在拉取镜像 ${targetImage}` });
        await this.execDocker(["pull", targetImage]);
        const inspected = (await this.execDocker(["image", "inspect", targetImage, "--format", "{{.Id}}"])).trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(inspected)) {
          throw new Error(`镜像 digest 格式无效: ${inspected}`);
        }
        try {
          const fullInspect = await this.execDocker(["image", "inspect", targetImage]);
          this.onImageRepoDigest(extractImageRepoDigestFromInspect(fullInspect));
        } catch {
          // optional repo digest refresh
        }
        if (inspected !== this.config.imageDigest || targetImage !== this.config.imageRef) {
          if (existsSync(this.configFile)) {
            const local = WorkerLocalConfig.parse(readPrivateJson(this.configFile));
            writePrivateJson(this.configFile, { ...local, imageDigest: inspected, imageRef: targetImage });
          }
          this.config.imageDigest = inspected;
          this.config.imageRef = targetImage;
          imageUpdated = true;
        }
      }

      let workerSkippedReason: string | undefined;
      if (wantWorker && this.config.serviceUrl && manifest?.worker?.available && manifest.worker.sha256 && manifest.worker.version) {
        const remoteSha = manifest.worker.sha256;
        const remoteVersion = manifest.worker.version;
        if (remoteSha !== this.workerSha256) {
          if (!this.managedBinary) {
            workerSkippedReason = "当前 Worker 非托管安装，请手动更新程序";
          } else {
            this.setStatus({
              state: "downloading_worker",
              targetVersion: remoteVersion,
              targetImage,
              message: `正在下载 Worker ${remoteVersion}`,
            });
            const downloadPath = manifest.worker.downloadPath || "/api/worker/release/luna-worker.js";
            const res = await this.fetchFn(new URL(downloadPath, this.config.serviceUrl), {
              redirect: "error",
              signal: AbortSignal.timeout(60000),
            });
            if (!res.ok) throw new Error(`下载 Worker 失败 (${res.status})`);
            const bytes = Buffer.from(await res.arrayBuffer());
            const actualSha = createHash("sha256").update(bytes).digest("hex");
            if (actualSha !== remoteSha) {
              throw new Error("Worker 产物 SHA-256 校验失败");
            }
            const binDir = join(this.config.dataRoot, "bin");
            const releaseDir = join(binDir, "releases", remoteVersion);
            const targetFile = join(releaseDir, "luna-worker.js");
            mkdirSync(releaseDir, { recursive: true, mode: 0o755 });
            const staging = join(binDir, `.staging-${randomBytes(6).toString("hex")}.js`);
            writeFileSync(staging, bytes, { mode: 0o755 });
            chmodSync(staging, 0o755);
            renameSync(staging, targetFile);

            const currentLink = join(binDir, "current");
            const previousLink = join(binDir, "previous");
            try {
              const prevTarget = readlinkSync(currentLink);
              if (prevTarget !== `releases/${remoteVersion}`) {
                atomicSymlink(prevTarget, previousLink);
              }
            } catch {
              // ignore if no previous symlink
            }
            atomicSymlink(`releases/${remoteVersion}`, currentLink);

            this.setStatus({
              state: "restarting",
              targetVersion: remoteVersion,
              targetImage,
              message: imageUpdated
                ? `镜像与 Worker (${remoteVersion}) 已更新，正在重启…`
                : `Worker (${remoteVersion}) 已下载，正在重启…`,
            });
            setTimeout(() => this.onRestart(), this.restartDelayMs);
            return;
          }
        }
      }

      const message = imageUpdated
        ? workerSkippedReason
          ? `镜像已更新；${workerSkippedReason}`
          : "镜像已更新，空闲容器将在下次任务时自动切换"
        : workerSkippedReason
          ? `镜像已是最新；${workerSkippedReason}`
          : "Worker 与镜像均已是最新版本";
      this.setStatus({ state: "succeeded", targetVersion: this.workerVersion, targetImage, message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "升级失败";
      this.setStatus({ state: "failed", message: message.slice(0, 400) });
    }
  }
}
