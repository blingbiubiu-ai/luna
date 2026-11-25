import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import type { WorkerReleaseManifest } from "./bind-worker-dialog";

export interface UpgradeableWorker {
  workerId: string;
  local: boolean;
  owned: boolean;
  health: {
    workerVersion?: string;
    managedBinary?: boolean;
    imageDigest?: string;
    imageRepoDigest?: string;
    imageRef?: string;
    imageVariant?: string;
  } | null;
}

function shortDigest(digest?: string): string {
  if (!digest) return "未知";
  return digest.startsWith("sha256:") ? digest.slice(0, 19) : digest.slice(0, 16);
}

export function UpgradeWorkerDialog({
  path,
  worker,
  release,
  hasNewWorkerVersion,
  isUpgrading,
  upgradingLabel,
}: {
  path: string;
  worker: UpgradeableWorker;
  release: WorkerReleaseManifest | undefined;
  hasNewWorkerVersion: boolean;
  isUpgrading: boolean;
  upgradingLabel: string;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);

  const defaultImage =
    worker.health?.imageRef
    ?? (worker.health?.imageVariant === "developer"
      ? release?.images.developer.image
      : worker.health?.imageVariant === "general"
        ? release?.images.general.image
        : release?.images.general.image)
    ?? "";

  const [upgradeWorker, setUpgradeWorker] = useState(true);
  const [upgradeImage, setUpgradeImage] = useState(true);
  const [imageRef, setImageRef] = useState(defaultImage);

  useEffect(() => {
    if (open) {
      setUpgradeWorker(Boolean(worker.health?.managedBinary !== false));
      setUpgradeImage(true);
      setImageRef(defaultImage);
    }
  }, [open, defaultImage, worker.health?.managedBinary]);

  const mutation = useMutation({
    mutationFn: () => {
      const trimmedImage = imageRef.trim();
      const body: { upgradeWorker: boolean; upgradeImage: boolean; imageRef?: string } = {
        upgradeWorker,
        upgradeImage: upgradeImage && Boolean(trimmedImage),
        ...(upgradeImage && trimmedImage ? { imageRef: trimmedImage } : {}),
      };
      return apiFetch(`${path}/${encodeURIComponent(worker.workerId)}/upgrade`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [path] });
      setOpen(false);
    },
  });

  const currentVersion = worker.health?.workerVersion ?? "未知";
  const targetVersion = release?.worker.version ?? "未知";
  const managedBinary = worker.health?.managedBinary;
  const canSubmit = (upgradeWorker || (upgradeImage && imageRef.trim().length > 0)) && !mutation.isPending;

  return <Dialog open={open} onOpenChange={next => {
    if (!next && mutation.isPending) return;
    setOpen(next);
    if (!next) mutation.reset();
  }}>
    <DialogTrigger asChild>
      <Button
        size="sm"
        variant={hasNewWorkerVersion ? "default" : "outline"}
        disabled={isUpgrading}
      >
        {isUpgrading ? upgradingLabel : "一键升级"}
      </Button>
    </DialogTrigger>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>升级 Worker</DialogTitle>
        <DialogDescription>
          确认目标版本后将在后台拉取并切换，正在运行中的任务不会被中断。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 text-sm">
        <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Worker 程序</span>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={upgradeWorker}
                disabled={managedBinary === false}
                onChange={e => setUpgradeWorker(e.target.checked)}
              />
              同步升级程序
            </label>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            当前版本：{currentVersion} → 目标版本：{targetVersion}
            {hasNewWorkerVersion
              ? "（有更新）"
              : currentVersion !== "未知" && currentVersion === targetVersion
                ? "（已是最新）"
                : ""}
          </p>
          {managedBinary === false && (
            <p className="text-xs text-muted-foreground">
              该节点非一键部署托管安装（如 systemd 手动部署），本次仅支持在线升级容器镜像。
            </p>
          )}
        </div>

        <div className="rounded-md border p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">容器镜像</span>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={upgradeImage}
                onChange={e => setUpgradeImage(e.target.checked)}
              />
              拉取并切换镜像
            </label>
          </div>
          <div className="space-y-0.5 font-mono text-xs text-muted-foreground">
            <p>当前镜像：{worker.health?.imageRef ?? "未记录（将按下方目标镜像拉取）"}</p>
            <p>当前 Digest：{shortDigest(worker.health?.imageRepoDigest ?? worker.health?.imageDigest)}</p>
            {(() => {
              const targetDigest =
                imageRef === release?.images.developer.image
                  ? release?.images.developer.digest
                  : imageRef === release?.images.general.image
                    ? release?.images.general.digest
                    : null;
              return targetDigest ? <p>目标 Digest：{shortDigest(targetDigest)}</p> : null;
            })()}
          </div>

          {upgradeImage && (
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap gap-2">
                {release?.images.general && (
                  <Button
                    type="button"
                    size="sm"
                    variant={imageRef === release.images.general.image ? "default" : "outline"}
                    onClick={() => setImageRef(release.images.general.image)}
                  >
                    通用版 (General)
                  </Button>
                )}
                {release?.images.developer && (
                  <Button
                    type="button"
                    size="sm"
                    variant={imageRef === release.images.developer.image ? "default" : "outline"}
                    onClick={() => setImageRef(release.images.developer.image)}
                  >
                    开发版 (Developer)
                  </Button>
                )}
              </div>
              <div className="space-y-1">
                <label htmlFor={`upgrade-image-${worker.workerId}`} className="text-xs text-muted-foreground">
                  目标镜像地址
                </label>
                <Input
                  id={`upgrade-image-${worker.workerId}`}
                  value={imageRef}
                  onChange={e => setImageRef(e.target.value)}
                  placeholder="hub.byted.org/wukong_devbox/luna-runner:latest"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>

        {mutation.error && (
          <p role="alert" className="text-xs text-destructive">
            触发升级失败：{mutation.error.message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "正在下发…" : "确认升级"}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
