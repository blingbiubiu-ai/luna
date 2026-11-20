import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
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

export function SessionComposer({
  agentId,
  sessionId,
  disabled,
}: {
  agentId: string;
  sessionId: string;
  disabled: boolean;
}) {
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
    queryFn: ({ signal }) =>
      apiFetch<{ status: string; error: string | null }>(
        `${sessionPath}/messages/${encodeURIComponent(messageId!)}/status?${agentQuery}`,
        { signal },
      ),
    enabled: !!messageId,
    refetchInterval: (query) =>
      ["pending", "claimed"].includes(query.state.data?.status ?? "pending") ? 2000 : false,
  });
  const mutation = useMutation({
    mutationFn: (value: { text: string; key: string }) =>
      apiFetch<{ messageId: string | null }>(`${sessionPath}/messages?${agentQuery}`, {
        method: "POST",
        headers: { "Idempotency-Key": value.key },
        body: JSON.stringify({ text: value.text }),
      }),
  });

  async function send() {
    const value = text.trim();
    if (!value || disabled || sending.current) return;
    sending.current = true;
    try {
      if (request.current?.text !== value) {
        request.current = { text: value, key: randomId() };
      }
      const result = await mutation.mutateAsync(request.current!);
      setMessageId(result.messageId ?? undefined);
      setText("");
      request.current = null;
      void client.invalidateQueries({ queryKey: ["luna", "sessions", sessionId] });
      void client.invalidateQueries({ queryKey: ["luna", "sessions", "list"] });
    } catch {
      /* Keep the draft and idempotency key for a safe retry. */
    } finally {
      sending.current = false;
      input.current?.focus();
    }
  }

  const status = message.data?.status;
  const failed = status && ["failed", "unknown", "skipped", "cancelled"].includes(status);

  return (
    <form
      className="shrink-0 border-t border-border bg-card px-[18px] pt-3 pb-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="space-y-2">
        <div className="grid gap-2 rounded-[10px] border border-border bg-background px-2.5 py-2 transition-colors focus-within:border-ring">
          <Textarea
            ref={input}
            id="session-message"
            aria-label="发送给此会话的消息"
            aria-describedby="session-message-hint"
            placeholder={disabled ? "此会话不可发送消息" : "以你的身份在这个会话里发消息…"}
            rows={2}
            className="max-h-40 min-h-[42px] resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-6 shadow-none focus-visible:ring-0 disabled:opacity-60 dark:bg-transparent"
            maxLength={20000}
            value={text}
            disabled={disabled || mutation.isPending}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
            <p
              id="session-message-hint"
              aria-live="polite"
              className="flex min-w-0 items-center gap-1.5"
            >
              {status === "pending" || status === "claimed" ? (
                <>
                  <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
                  <span>{status === "pending" ? "等待 AI 处理" : "AI 正在处理…"}</span>
                </>
              ) : (
                <span>Enter 发送 · Shift+Enter 换行</span>
              )}
            </p>
            <button
              type="submit"
              aria-label={mutation.isPending ? "发送中" : "发送"}
              disabled={disabled || mutation.isPending || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-[7px] bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  <span>发送中</span>
                </>
              ) : (
                "发送"
              )}
            </button>
          </div>
        </div>
        {mutation.isError ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            发送失败：{mutation.error.message}。消息已保留，可重试。
          </p>
        ) : null}
        {message.isError ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            无法查询消息处理状态：{message.error.message}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            AI 处理未完成：{executionFailure(message.data?.error, status)}
          </p>
        ) : null}
      </div>
    </form>
  );
}
