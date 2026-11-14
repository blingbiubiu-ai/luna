import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";

interface BindingCode {
  code: string;
  expiresAt: number;
}

export function BindWorkerDialog({ path, agentName, disabled }: {
  path: string; agentName: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const defaultAddress = location.protocol === "https:" || ["127.0.0.1", "localhost"].includes(location.hostname)
    ? location.origin : "";
  const [address, setAddress] = useState(defaultAddress);
  const [binding, setBinding] = useState<(BindingCode & { origin: string }) | undefined>();
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(Date.now);
  const generate = useMutation({
    mutationFn: async () => {
      const origin = new URL(address.trim());
      const local = ["127.0.0.1", "localhost"].includes(origin.hostname);
      if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(origin.host) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
        (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) {
        throw new Error("请输入 Luna 服务的 HTTPS 地址。本机接入可使用本机 HTTP 地址。");
      }
      const code = await apiFetch<BindingCode>(`${path}/binding-code`, { method: "POST" });
      return { ...code, origin: origin.origin };
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
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{`绑定后自动分配给「${agentName}」。`}</DialogDescription>
      </DialogHeader>
      {!activeCode ? <form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        generate.mutate();
      }}>
        <label htmlFor="worker-service-address" className="text-sm font-medium">Luna 服务地址</label>
        <Input id="worker-service-address" type="url" required value={address}
          onChange={event => setAddress(event.target.value)} placeholder="https://luna.example.com" />
        <p className="text-sm text-muted-foreground">填 Worker 机器能访问的地址。127.0.0.1 和 localhost 仅适用于同一台机器。</p>
        {binding && <p className="text-sm text-muted-foreground">绑定码已过期，请重新生成。</p>}
        {generate.error && <p role="alert" className="text-destructive">{generate.error.message}</p>}
        <Button type="submit" disabled={generate.isPending}>生成绑定码</Button>
      </form> : <div className="space-y-3 text-sm">
        <p>在 Worker 机器上运行命令，按提示输入绑定码。</p>
        <div className="flex items-center gap-2 rounded-md border p-2">
          <code className="min-w-0 flex-1 break-all">{`luna worker bind --service ${activeCode.origin}`}</code>
          <Button size="sm" variant="outline" onClick={() => copy(`luna worker bind --service ${activeCode.origin}`, "命令")}>复制命令</Button>
        </div>
        <div className="flex items-center gap-2 rounded-md border p-2">
          <code className="min-w-0 flex-1 break-all">{activeCode.code}</code>
          <Button size="sm" variant="outline" onClick={() => copy(activeCode.code, "绑定码")}>复制绑定码</Button>
        </div>
        <p className="text-muted-foreground">绑定码仅可使用一次，有效期至 {new Date(activeCode.expiresAt).toLocaleTimeString()}。</p>
        <p>首次绑定后运行 <code>luna worker start</code>。</p>
        <p className="text-muted-foreground">已接入的 Worker 可再次运行上面的绑定命令，将它分配给当前 Agent。运行中的 Worker 无需重启。</p>
        <p role="status" className="text-muted-foreground">{copied}</p>
      </div>}
    </DialogContent>
  </Dialog>;
}
