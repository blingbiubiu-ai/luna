import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { randomId } from "@/lib/random-id";

function executionFailure(error: string | null | undefined, status: string): string {
  switch (error) {
    case "agent_worker_access_denied":
      return "此会话绑定的 Worker 已暂停接单或未获得执行授权。请在 Workers 页面检查。";
    case "No Agent profile is active. Configure one in Dashboard first.":
    case "agent_not_configured":
      return "此 Agent 尚未启用模型。请在模型配置中测试连接并激活配置。";
    case "no_worker_available":
    case "shadow_worker_unavailable":
    case "worker_not_ready":
    case "worker_disconnected":
      return "此分身的 Worker 当前不可用。请检查 Worker 是否在线且已授权给此 Agent。";
    case "shadow_resources_pending":
    case "shadow_preparation_busy":
    case "environment_mount_pending":
      return "分身资源正在准备或等待切换。准备完成后可重新发送。";
    case "runtime_draining":
    case "shadow_execution_pending":
      return "运行环境正在排空，请等待当前作业结算。";
    case "scope_disabled":
    case "scope_deleted":
      return "此 Agent 或分身已停止执行。";
    default:
      return error || status;
  }
}

export function SessionComposer({ agentId, sessionId, disabled }: { agentId: string; sessionId: string; disabled: boolean }) {
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState<string>();
  const request = useRef<{ text: string; key: string } | null>(null);
  const sending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const client = useQueryClient();
  const sessionPath = `/sessions/${encodeURIComponent(sessionId)}`;
  const agentQuery = `agentId=${encodeURIComponent(agentId)}`;
  const message = useQuery({
    queryKey: ["session-chat-message", agentId, sessionId, messageId],
    queryFn: ({ signal }) => apiFetch<{ status: string; error: string | null }>(`${sessionPath}/messages/${encodeURIComponent(messageId!)}/status?${agentQuery}`, { signal }),
    enabled: !!messageId,
    refetchInterval: query => ["pending", "claimed"].includes(query.state.data?.status ?? "pending") ? 2000 : false,
  });
  const mutation = useMutation({
    mutationFn: (value: { text: string; key: string }) => apiFetch<{ messageId: string | null }>(`${sessionPath}/messages?${agentQuery}`, {
      method: "POST", headers: { "Idempotency-Key": value.key }, body: JSON.stringify({ text: value.text }),
    }),
  });
  async function send() {
    const value = text.trim();
    if (!value || disabled || sending.current) return;
    sending.current = true;
    try {
      if (request.current?.text !== value) request.current = { text: value, key: randomId() };
      const result = await mutation.mutateAsync(request.current!);
      setMessageId(result.messageId ?? undefined);
      setText("");
      request.current = null;
      void client.invalidateQueries({ queryKey: ["luna", "sessions", sessionId] });
    } catch { /* Keep the draft and idempotency key for a safe retry. */ }
    finally { sending.current = false; input.current?.focus(); }
  }
  const status = message.data?.status;
  const failed = status && ["failed", "unknown", "skipped", "cancelled"].includes(status);
  return (
    <form className="shrink-0 bg-background pt-3 pr-5 pb-4 pl-16" onSubmit={event => { event.preventDefault(); void send(); }}>
      {/* Match message text: 16px timeline padding + 4px row padding + 32px avatar + 12px gap. */}
      <div className="w-full max-w-[860px] space-y-2">
        <div className="overflow-hidden rounded-[20px] border border-border/80 bg-muted/20 shadow-sm transition-[border-color,box-shadow] focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/10">
          <Textarea ref={input} id="session-message" aria-label="发送给此会话的消息" aria-describedby="session-message-hint" placeholder={disabled ? "此会话不可发送消息" : "发送消息，继续这个话题…"}
            className="max-h-48 min-h-20 resize-none rounded-none border-0 bg-transparent px-4 pt-4 pb-2 text-sm leading-6 shadow-none focus-visible:ring-0 disabled:opacity-60 dark:bg-transparent"
            maxLength={20000} value={text} disabled={disabled || mutation.isPending}
            onChange={event => setText(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); void send();
              }
            }} />
          <div className="flex items-center justify-between gap-3 px-3 pb-3">
            <p id="session-message-hint" aria-live="polite" className="flex min-w-0 items-center gap-1.5 pl-1 text-[11px] leading-4 text-muted-foreground/70">
              {status === "pending" || status === "claimed" ? <><Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" /><span>{status === "pending" ? "等待 AI 处理" : "AI 正在处理…"}</span></> : <span>Ctrl / ⌘ + Enter 发送 · Enter 换行</span>}
            </p>
            <Button type="submit" size="icon" aria-label={mutation.isPending ? "发送中" : "发送"} title="发送消息（Ctrl / ⌘ + Enter）"
              className="size-9 rounded-full bg-foreground text-background shadow-none hover:bg-foreground/85 disabled:bg-muted disabled:text-muted-foreground/50 disabled:opacity-100"
              disabled={disabled || mutation.isPending || !text.trim()}>
              {mutation.isPending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <ArrowUp aria-hidden="true" className="size-5" />}
            </Button>
          </div>
        </div>
        {mutation.isError ? <p role="alert" className="px-1 text-sm text-destructive">发送失败：{mutation.error.message}。消息已保留，可重试。</p> : null}
        {message.isError ? <p role="alert" className="px-1 text-sm text-destructive">无法查询消息处理状态：{message.error.message}</p> : null}
        {failed ? <p role="alert" className="px-1 text-sm text-destructive">AI 处理未完成：{executionFailure(message.data?.error, status)}</p> : null}
      </div>
    </form>
  );
}
