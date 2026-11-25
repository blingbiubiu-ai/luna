import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api/client";

interface BindingCode {
  code: string;
  expiresAt: number;
}

export interface WorkerReleaseManifest {
  worker: {
    available: boolean;
    version: string | null;
    sha256: string | null;
    size: number;
    downloadPath: string;
  };
  images: {
    general: { variant: "general"; label: string; image: string };
    developer: { variant: "developer"; label: string; image: string };
  };
}

interface PlatformSettingsSnippet {
  platform?: { general?: { publicBaseUrl?: string } };
  feishuAuth?: { publicBaseUrl?: string };
}

type Variant = "general" | "developer";

function resolveServiceOrigin(settings?: PlatformSettingsSnippet): { origin: string; fromPlatform: boolean } {
  const configured = settings?.platform?.general?.publicBaseUrl?.trim()
    || settings?.feishuAuth?.publicBaseUrl?.trim()
    || "";
  if (configured) {
    return { origin: configured.replace(/\/+$/, ""), fromPlatform: true };
  }
  const fallback = location.protocol === "https:" || ["127.0.0.1", "localhost"].includes(location.hostname)
    ? location.origin
    : "";
  return { origin: fallback, fromPlatform: false };
}

export function BindWorkerDialog({ path, agentName, disabled }: {
  path: string; agentName: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<Variant>("general");
  const [binding, setBinding] = useState<(BindingCode & { origin: string; variant: Variant }) | undefined>();
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(Date.now);

  const releaseQuery = useQuery({
    queryKey: ["/worker/release/manifest.json"],
    queryFn: ({ signal }) => apiFetch<WorkerReleaseManifest>("/worker/release/manifest.json", { signal }),
    enabled: open,
    staleTime: 30_000,
  });

  const platformQuery = useQuery({
    queryKey: ["/platform-settings"],
    queryFn: ({ signal }) => apiFetch<PlatformSettingsSnippet>("/platform-settings", { signal }),
    enabled: open,
    staleTime: 30_000,
  });

  const { origin: resolvedOrigin, fromPlatform } = resolveServiceOrigin(platformQuery.data);

  const generate = useMutation({
    mutationFn: async () => {
      if (!resolvedOrigin) {
        throw new Error("平台尚未配置对外访问地址，请先在「平台设置」中配置对外访问地址（HTTPS）。");
      }
      const origin = new URL(resolvedOrigin);
      const local = ["127.0.0.1", "localhost"].includes(origin.hostname);
      if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(origin.host) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
        (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) {
        throw new Error("平台对外访问地址无效，请在「平台设置」中配置合法的 HTTPS 根地址。");
      }
      const code = await apiFetch<BindingCode>(`${path}/binding-code`, { method: "POST" });
      return { ...code, origin: origin.origin, variant };
    },
    onSuccess: code => {
      setNow(Date.now());
      setBinding(code);
    },
  });

  useEffect(() => {
    if (!open || !binding) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, binding]);

  function copy(value: string, label: string) {
    void navigator.clipboard.writeText(value).then(() => setCopied(`已复制${label}`))
      .catch(() => setCopied("复制失败，请手动选中复制。"));
  }

  const activeCode = binding && binding.expiresAt > now ? binding : undefined;
  const title = "接入我的 Worker";
  const selectedImage = releaseQuery.data?.images[variant]?.image;
  const oneClickCommand = activeCode
    ? `curl -fsSL ${activeCode.origin}/api/worker/install.sh | bash -s -- --service ${activeCode.origin} --code ${activeCode.code} --variant ${activeCode.variant}`
    : "";

  return <Dialog open={open} onOpenChange={next => {
    if (!next && generate.isPending) return;
    setOpen(next);
    if (!next) {
      setBinding(undefined);
      setCopied("");
      generate.reset();
    }
  }}>
    <DialogTrigger asChild><Button disabled={disabled}>{title}</Button></DialogTrigger>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{`部署并绑定后自动分配给「${agentName}」。`}</DialogDescription>
      </DialogHeader>
      {!activeCode ? <form className="space-y-4" onSubmit={event => {
        event.preventDefault();
        generate.mutate();
      }}>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Luna 服务地址</p>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
            {platformQuery.isLoading
              ? "正在读取平台地址…"
              : resolvedOrigin || "未配置（请前往「平台设置」配置对外访问地址）"}
          </div>
          <p className="text-xs text-muted-foreground">
            {fromPlatform
              ? "自动使用平台设置的对外访问地址，不可在此修改。"
              : "当前平台未单独配置对外访问地址，自动使用当前访问地址。如需固定地址请在「平台设置」中配置。"}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">运行镜像版本</p>
          <div className="grid grid-cols-2 gap-2">
            {(["general", "developer"] as const).map(key => {
              const info = releaseQuery.data?.images[key];
              const active = variant === key;
              return <button
                key={key}
                type="button"
                onClick={() => setVariant(key)}
                className={`rounded-md border p-3 text-left transition-colors ${active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
              >
                <p className="text-sm font-medium">{info?.label ?? (key === "general" ? "通用版 (General)" : "开发版 (Developer)")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {key === "general" ? "轻量通用运行环境" : "含 JDK / Android SDK / NDK 开发工具链"}
                </p>
              </button>;
            })}
          </div>
          {selectedImage && <p className="break-all font-mono text-xs text-muted-foreground">镜像：{selectedImage}</p>}
        </div>

        {binding && <p className="text-sm text-muted-foreground">绑定码已过期，请重新生成。</p>}
        {generate.error && <p role="alert" className="text-sm text-destructive">{generate.error.message}</p>}
        <Button type="submit" disabled={generate.isPending || platformQuery.isLoading || !resolvedOrigin}>
          生成一键部署命令
        </Button>
      </form> : <div className="space-y-4 text-sm">
        <div className="space-y-2">
          <p className="font-medium">一键部署（推荐，新机器直接运行）</p>
          <p className="text-xs text-muted-foreground">
            自动检查 Docker / 安装 Bun、拉取镜像、下载 Worker、完成初始化与绑定并注册后台自启服务。
          </p>
          <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5">
            <code className="min-w-0 flex-1 break-all text-xs leading-relaxed">{oneClickCommand}</code>
            <Button size="sm" onClick={() => copy(oneClickCommand, "一键部署命令")}>复制命令</Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          绑定码仅可使用一次，有效期至 {new Date(activeCode.expiresAt).toLocaleTimeString()}。
        </p>

        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            已有 Worker？展开手动绑定命令
          </summary>
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 rounded-md border p-2">
              <code className="min-w-0 flex-1 break-all text-xs">{`luna worker bind --service ${activeCode.origin}`}</code>
              <Button size="sm" variant="outline" onClick={() => copy(`luna worker bind --service ${activeCode.origin}`, "绑定命令")}>复制命令</Button>
            </div>
            <div className="flex items-center gap-2 rounded-md border p-2">
              <code className="min-w-0 flex-1 break-all text-xs">{activeCode.code}</code>
              <Button size="sm" variant="outline" onClick={() => copy(activeCode.code, "绑定码")}>复制绑定码</Button>
            </div>
            <p className="text-xs text-muted-foreground">已接入的 Worker 再次运行绑定命令即可分配给当前 Agent，无需重启。</p>
          </div>
        </details>

        {copied && <p role="status" className="text-xs text-muted-foreground">{copied}</p>}
      </div>}
    </DialogContent>
  </Dialog>;
}
