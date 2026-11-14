import { ExecutionError } from "@luna/execution-store";

/** Business rejections are not evidence that a host is unreachable. */
export function retryableDelivery(error: unknown): boolean {
  return !(error instanceof ExecutionError) || error.status >= 500 || error.status === 429;
}

export const CONTEXT_RESET_NOTICE = "[执行环境已重建] 本次执行已切换 Worker。请根据对话和任务检查当前项目，原 Worker 的本地文件和会话状态可能无法访问。\n\n";
