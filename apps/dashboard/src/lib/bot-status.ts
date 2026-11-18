import type { DashboardRuntimeChannelStatus } from "@/lib/api/hooks";

/**
 * A channel bot's status, kept apart from its Shadow's own status: the bot is the chat
 * connection (on/off switch plus the live connection), the Shadow is the Agent persona.
 */
export interface BotStatus {
  label: string;
  tone: "ok" | "pending" | "warn" | "error" | "off";
  /** The one action that resolves this state, if any. */
  action?: "enable" | "retry" | "resecret";
  detail?: string;
}

export function botStatus(input: {
  enabled: boolean;
  /** Whether the Shadow and its Agent are active; an inactive Shadow takes its bot offline. */
  shadowActive: boolean;
  runtime: DashboardRuntimeChannelStatus | undefined;
}): BotStatus {
  if (!input.enabled) return { label: "机器人已停用", tone: "off", action: "enable", detail: "机器人开关已关闭，不收发飞书消息" };
  if (!input.shadowActive) return { label: "机器人未连接", tone: "off", detail: "分身已停用，机器人随之离线；恢复分身后自动连接" };
  const inbound = input.runtime?.inbound;
  const error = inbound?.lastError;
  switch (inbound?.state) {
    case "connected": return { label: "机器人已连接", tone: "ok", detail: "已连接飞书，可以收发消息" };
    case "reconnecting": return { label: `机器人重连中${inbound.reconnectAttempts ? `（第 ${inbound.reconnectAttempts} 次）` : ""}`, tone: "warn", ...(error ? { detail: error } : {}) };
    case "failed": return { label: "机器人连接失败", tone: "error", action: "retry", detail: error ?? "飞书拒绝了连接" };
    case "credentials_invalid": return { label: "机器人凭据无效", tone: "error", action: "resecret", detail: "已保存的 App Secret 无法解密，请重新填写" };
    case "idle": case "connecting": case "unknown": return { label: "机器人连接中", tone: "pending" };
    default: return { label: "机器人未连接", tone: "pending", detail: "服务尚未加载此机器人" };
  }
}
