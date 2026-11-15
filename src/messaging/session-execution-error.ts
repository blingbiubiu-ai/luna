import type { DrizzleDB } from "@/data";
import type { WorkReplyChannel } from "@/work/types";
import { runnerAnswers } from "./runner-answer";
import { sessionCommandsFor } from "./session-command-service";

function failureText(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  switch (code) {
    case "shadow_model_not_validated":
    case "shadow_model_unavailable":
      return "消息已收到，但分身选择的模型配置不可用或未通过连接验证。请在模型配置中验证连接，或在分身设置中选择其他模型后重新发送。";
    case "bound_worker_access_denied":
      return "消息已收到，但分身绑定的 Worker 已暂停接单或未获得执行授权。请在 Workers 页面恢复接单或在分身设置中更换绑定 Worker 后重新发送。";
    case "bound_worker_unavailable":
      return "消息已收到，但分身绑定的 Worker 当前不可用。本轮不会自动切换到其他节点。请检查该 Worker，或修改分身的 Worker 分流规则后重新发送。";
    case "agent_worker_access_denied":
      return "消息已收到，但此会话绑定的 Worker 已暂停接单或未获得执行授权，本轮未能执行。请在 Workers 页面检查接单状态和授权，恢复后重新发送。";
    case "agent_workers_not_configured":
      return "消息已收到，但此 Agent 尚未配置可执行的 Worker。请在 Workers 页面分配 Worker 后重新发送。";
    case "no_worker_available":
    case "no_scoped_worker_available":
    case "shadow_worker_unavailable":
    case "worker_not_ready":
    case "worker_disconnected":
      return "消息已收到，但此会话的 Worker 当前不可用。请检查 Worker 的连接、执行环境和负载，恢复后重新发送。";
    case "docker_operation_failed":
    case "docker_object_missing":
    case "prepare_conflict":
    case "environment_configuration_conflict":
    case "environment_mount_pending":
    case "executor_ports_exhausted":
    case "execution_connection_failed":
      return "消息已收到，但 Worker 未能启动执行环境，本轮未能执行。请检查 Worker 的 Docker 状态和容器资源配置，恢复后重新发送。";
    case "agent_not_configured":
      return "消息已收到，但此 Agent 尚未启用模型。请在模型配置中测试连接并激活配置后重新发送。";
    case "runtime_draining":
    case "shadow_execution_pending":
      return "消息已收到，但运行环境正在排空，本轮未能执行。请等待当前作业结算后重新发送。";
    default:
      return "消息已收到，但本轮处理失败，未能生成回复。请稍后重试；若持续失败，请检查本轮执行记录。";
  }
}

/** A failed turn stays failed; its diagnostic is a normal durable session reply. */
export function reportSessionExecutionError(db: DrizzleDB, input: {
  sessionId: string; turnId: string; actorUserId: string; error: unknown;
  channelFor: (id: string) => WorkReplyChannel | undefined;
}): void {
  // Accepted replies own delivery even when the provider outcome is ambiguous.
  if (runnerAnswers(db, input.sessionId, input.turnId).length) return;
  sessionCommandsFor(db, input.channelFor).accept({
    userId: input.actorUserId, sourceSessionId: input.sessionId, originId: input.turnId,
  }, input.sessionId, "message.send", "service-execution-error", {
    content: failureText(input.error), purpose: "answer",
  });
}
