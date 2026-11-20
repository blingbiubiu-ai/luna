import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api/client";
import { copyTextToClipboard } from "@/lib/clipboard";

export function SessionMoreMenu({
  agentId,
  sessionId,
  hasContext = false,
  onOpenContext,
  onDeleted,
}: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly hasContext?: boolean;
  readonly onOpenContext?: () => void;
  readonly onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      setOpen(false);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["luna"] });
      onDeleted();
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && wrapperRef.current && !wrapperRef.current.contains(target)) {
        if (!deleteMutation.isPending) {
          setOpen(false);
          setConfirming(false);
          deleteMutation.reset();
        }
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleteMutation.isPending) {
        setOpen(false);
        setConfirming(false);
        deleteMutation.reset();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, deleteMutation]);

  async function handleCopyId() {
    await copyTextToClipboard(sessionId);
    setCopied(true);
    setOpen(false);
    setConfirming(false);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={copied ? "已复制会话 ID" : "更多操作"}
        title={copied ? "已复制会话 ID" : "更多操作"}
        onClick={() => {
          setOpen((prev) => !prev);
          setConfirming(false);
          deleteMutation.reset();
        }}
        className="inline-flex h-[30px] items-center justify-center rounded-[7px] border border-border bg-card px-2 text-foreground shadow-2xs transition-colors hover:bg-accent"
      >
        {copied ? (
          <Check className="size-4 text-[#5b8a72] dark:text-[#7fb096]" />
        ) : (
          <MoreHorizontal className="size-4" />
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-[calc(100%+6px)] right-0 z-30 grid min-w-[196px] rounded-[8px] border border-border bg-card p-1 shadow-lg"
        >
          {confirming ? (
            <div className="grid gap-2 p-2 text-xs text-muted-foreground">
              <p className="leading-relaxed">
                删除后时间线和工作目录都会清除，不能恢复。
              </p>
              {deleteMutation.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {deleteMutation.error instanceof Error
                    ? deleteMutation.error.message
                    : "删除失败"}
                </p>
              ) : null}
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
                className="inline-flex items-center justify-center rounded-[7px] border border-destructive bg-destructive px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {deleteMutation.isPending ? "删除中…" : "删除会话"}
              </button>
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  setOpen(false);
                  setConfirming(false);
                  deleteMutation.reset();
                }}
                className="inline-flex items-center justify-center rounded-[7px] border border-border bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent"
              >
                取消
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleCopyId()}
                className="rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
              >
                复制会话 ID
              </button>
              {hasContext && onOpenContext ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenContext();
                  }}
                  className="rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
                >
                  查看 Runner 上下文
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirming(true)}
                className="rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-accent"
              >
                删除会话…
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
