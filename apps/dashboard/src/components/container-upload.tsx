import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import type { ContainerRow } from "@/lib/containers";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** The Service link carries at most 16 MB a message; pieces stay well below it. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPLOAD_DIR = "~/uploads";

interface UploadState { name: string; sent: number; size: number; path?: string; error?: string; }

/**
 * Send one file into the Shadow's HOME in pieces. Returns its path, which is the same inside
 * the container. `onProgress` gets the bytes sent so far.
 */
export async function uploadFile(agentId: string, row: ContainerRow, file: Blob & { name: string }, dir: string,
  onProgress: (sent: number) => void, fetchPiece: typeof apiFetch = apiFetch): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("单个文件不能超过 100 MB");
  const uploadId = randomId();
  const base = `/agents/${encodeURIComponent(agentId)}/containers/${encodeURIComponent(row.workerId)}/${encodeURIComponent(row.environmentId)}/upload`;
  let offset = 0;
  do {
    const piece = file.slice(offset, offset + UPLOAD_CHUNK_BYTES);
    const final = offset + piece.size >= file.size;
    const params = new URLSearchParams({ shadowId: row.shadowId, uploadId, dir, name: file.name, offset: String(offset), final: final ? "1" : "0" });
    const result = await fetchPiece<{ done: boolean; path?: string }>(`${base}?${params}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: piece,
    });
    offset += piece.size;
    onProgress(offset);
    if (final) {
      if (!result.done || !result.path) throw new Error("上传未完成，请重试");
      return result.path;
    }
  } while (true);
}

/** Pick files (or receive dropped ones) and upload them into the Shadow's HOME. */
export function UploadDialog({ agentId, row, open, onOpenChange, initialFiles }: {
  agentId: string; row: ContainerRow; open: boolean; onOpenChange: (open: boolean) => void; initialFiles?: File[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dir, setDir] = useState(DEFAULT_UPLOAD_DIR);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const started = useRef<File[] | undefined>(undefined);

  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    const start = uploads.length;
    setUploads(list => [...list, ...files.map(file => ({ name: file.name, sent: 0, size: file.size }))]);
    const update = (index: number, change: Partial<UploadState>) =>
      setUploads(list => list.map((item, at) => at === start + index ? { ...item, ...change } : item));
    for (const [index, file] of files.entries()) {
      try { update(index, { path: await uploadFile(agentId, row, file, dir.trim() || DEFAULT_UPLOAD_DIR, sent => update(index, { sent })) }); }
      catch (error) { update(index, { error: error instanceof Error ? error.message : String(error) }); }
    }
    setBusy(false);
  };
  // Files dropped on the console start uploading when the dialog opens with them.
  useEffect(() => {
    if (!open || !initialFiles?.length || started.current === initialFiles) return;
    started.current = initialFiles;
    void run(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFiles]);
  const copy = (path: string) => { void navigator.clipboard?.writeText(path); setCopied(path); setTimeout(() => setCopied(null), 1500); };

  return <Dialog open={open} onOpenChange={next => { if (!busy) { onOpenChange(next); if (!next) setUploads([]); } }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>上传文件到「{row.shadowName ?? row.shadowId}」</DialogTitle>
        <DialogDescription>文件写入分身的 HOME，容器内路径相同，重置系统盘和升级镜像后都保留。单个文件不超过 100 MB，同名文件不会被覆盖。</DialogDescription>
      </DialogHeader>
      <label className="space-y-1 text-sm">
        <span className="font-medium">目标目录</span>
        <Input value={dir} disabled={busy} onChange={event => setDir(event.target.value)} placeholder={DEFAULT_UPLOAD_DIR} />
        <span className="block text-xs text-muted-foreground">相对 HOME，例如 ~/uploads 或 ~/work/data；不存在会自动创建。</span>
      </label>
      <input ref={input} type="file" multiple hidden aria-label="选择要上传的文件"
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void run(files); }} />
      <Button disabled={busy} onClick={() => input.current?.click()}><UploadIcon className="size-4" />{busy ? "正在上传…" : "选择文件"}</Button>
      {uploads.length > 0 && <ul className="max-h-64 space-y-2 overflow-y-auto text-sm" aria-label="上传结果">
        {uploads.map((item, index) => <li key={index} className="space-y-1 rounded-md border p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium" title={item.name}>{item.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{item.error ? "失败" : item.path ? "完成" : `${Math.floor(item.size ? item.sent * 100 / item.size : 0)}%`}</span>
          </div>
          {!item.path && !item.error && <div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${item.size ? item.sent * 100 / item.size : 0}%` }} /></div>}
          {item.error && <p role="alert" className="text-xs text-destructive">{item.error}</p>}
          {item.path && <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate text-xs" title={item.path}>{item.path}</code>
            <Button size="icon-sm" variant="ghost" aria-label={`复制路径 ${item.path}`} onClick={() => copy(item.path!)}>
              {copied === item.path ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>}
        </li>)}
      </ul>}
    </DialogContent>
  </Dialog>;
}
