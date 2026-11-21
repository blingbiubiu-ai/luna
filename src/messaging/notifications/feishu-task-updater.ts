import type { NormalizedInboundMessage } from "@/channels";
import type { OutboundChannelOperation, ReplyChannel } from "@/channels/outbound";
import { WAITING_FOR_INPUT, type TaskSubscription, type TaskView } from "@/tasks/types";

export interface TaskStatusCardStepEvent {
  readonly id?: string;
  readonly type: string;
  readonly summary: string;
  readonly data?: unknown;
}

export function buildTaskStatusCardSteps(input: {
  readonly timelineEvents?: readonly TaskStatusCardStepEvent[];
  readonly latestEvent?: TaskStatusCardStepEvent;
}): string[] | undefined {
  const events = input.timelineEvents ?? [];
  const steps: string[] = [];
  let currentRunIndex: number | null = null;
  for (const event of events) {
    const summary = event.summary.trim();
    if (!summary) {
      continue;
    }
    if (!_isUserVisibleStepEvent(event.type)) {
      continue;
    }
    const runMetadata = _timelineRunMetadata(event.data);
    if (
      runMetadata.runIndex !== null &&
      runMetadata.runIndex !== currentRunIndex
    ) {
      currentRunIndex = runMetadata.runIndex;
      steps.push(`第 ${runMetadata.runIndex} 轮执行`);
    }
    if (event.type === "runner.cancelled" && runMetadata.runIndex !== null) {
      steps.push(`已取消第 ${runMetadata.runIndex} 轮执行`);
      continue;
    }
    if (event.type.startsWith("runner.")) {
      steps.push(summary);
    }
  }

  const runnerEvents = steps.filter(Boolean);
  if (runnerEvents.length > 0) {
    return runnerEvents;
  }

  const latestEvent = input.latestEvent;
  if (
    latestEvent !== undefined &&
    _isUserVisibleStepEvent(latestEvent.type) &&
    latestEvent.summary.trim()
  ) {
    return [latestEvent.summary.trim()];
  }
  return undefined;
}

/**
 * Coordinates task status card responsibilities through the generic channel
 * reply contract. Provider-specific rendering stays inside the channel adapter.
 */
export class TaskStatusCardUpdater {
  constructor(
    private readonly _channel: ReplyChannel,
    private readonly _inbound: NormalizedInboundMessage,
  ) {}

  async createStatusCard(
    subscription: TaskSubscription,
    taskView: TaskView,
    idempotencyKey?: string,
  ): Promise<OutboundChannelOperation> {
    return this._channel.send(this._inbound, this.statusCardOperation(subscription, taskView, idempotencyKey));
  }

  statusCardOperation(subscription: TaskSubscription, taskView: TaskView, idempotencyKey?: string): Omit<OutboundChannelOperation, "id" | "channelId"> {
    return {
      replyMode: subscription.thread_key ? "reply_in_thread" : "channel_message",
      targetMessageId: this._inbound.thread?.rootMessageExternalId ?? this._inbound.thread?.externalId ?? this._inbound.id,
      sessionId: subscription.session_id,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      statusCardStyle: subscription.status_card_style ?? "card",
      nativeProgress: nativeProgressEntries(taskView.timelineEvents ?? []),
      statusCardState: this._statusCardState(taskView.persistentTask.status),
      statusCard: this._statusCardMetadata(taskView),
      ...this._statusCardStepsInput(taskView),
      content: this._renderStatusCard(subscription, taskView, {
        includeTerminalStatusText: true,
      }),
    };
  }

  async updateStatusCard(
    subscription: TaskSubscription,
    taskView: TaskView,
    idempotencyKey?: string,
  ): Promise<OutboundChannelOperation> {
    return await this._channel.send(this._inbound, {
      replyMode: "update_status_card",
      targetMessageId: this._inbound.id,
      sessionId: subscription.session_id,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      statusCardStyle: subscription.status_card_style ?? "card",
      nativeProgress: nativeProgressEntries(taskView.timelineEvents ?? []),
      statusCardState: this._statusCardState(taskView.persistentTask.status),
      statusCard: this._statusCardMetadata(taskView),
      ...this._statusCardStepsInput(taskView),
      content: this._renderStatusCard(subscription, taskView, {
        includeTerminalStatusText: false,
      }),
    });
  }

  async markStatusCardStale(input: {
    readonly subscription: TaskSubscription;
    readonly targetMessageId: string;
    readonly idempotencyKey?: string;
  }): Promise<OutboundChannelOperation> {
    return await this._channel.send(this._inbound, {
      replyMode: "update_status_card",
      targetMessageId: input.targetMessageId,
      sessionId: input.subscription.session_id,
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
      statusCardState: "terminal",
      content: "此任务已在新的状态卡片中继续，请关注最新状态卡片。",
    });
  }

  private _statusCardMetadata(taskView: TaskView) {
    return {
      taskId: taskView.persistentTask.id,
      title: taskView.persistentTask.title,
      ...(taskView.persistentTask.summary !== null
        ? { summary: taskView.persistentTask.summary }
        : {}),
      status: taskView.persistentTask.status,
    };
  }

  private _renderStatusCard(
    subscription: TaskSubscription,
    taskView: TaskView,
    options: { readonly includeTerminalStatusText: boolean },
  ): string {
    const persistentTask = taskView.persistentTask;
    if (this._statusCardState(persistentTask.status) === "terminal") {
      if (!options.includeTerminalStatusText) return "";
      return persistentTask.status === "completed" && persistentTask.block_reason === WAITING_FOR_INPUT
        ? "等待答复。"
        : this._statusLabel(persistentTask.status);
    }

    if (subscription.visibility === "summary") {
      return `已关联到已有${this._workflowLabel(persistentTask.type)}，会在这里同步关键进展。`;
    }

    if (persistentTask.status === "new") {
      return `已收到，正在准备${this._workflowLabel(persistentTask.type)}。`;
    }

    if (persistentTask.status === "running") {
      return "";
    }

    return this._statusLabel(persistentTask.status);
  }

  private _workflowLabel(type: string): string {
    switch (type) {
      case "task":
        return "任务";
      case "question":
        return "问题";
      case "approval":
        return "审批";
      case "handoff":
        return "人工接管";
      default:
        return "事项";
    }
  }

  private _statusLabel(status: string): string {
    switch (status) {
      case "running":
        return "正在执行。";
      case "completed":
        return "处理完成。";
      case "cancelled":
        return "已取消。";
      case "failed":
        return "执行失败。";
      case "new":
      default:
        return "已收到，正在处理。";
    }
  }

  private _statusCardState(status: string): "active" | "terminal" {
    return ["completed", "failed", "cancelled"].includes(status)
      ? "terminal"
      : "active";
  }

  private _statusCardSteps(taskView: TaskView): string[] | undefined {
    return buildTaskStatusCardSteps({
      ...(taskView.timelineEvents !== undefined
        ? { timelineEvents: taskView.timelineEvents }
        : {}),
      ...(taskView.latestEvent !== undefined
        ? { latestEvent: taskView.latestEvent }
        : {}),
    });
  }

  private _statusCardStepsInput(
    taskView: TaskView,
  ): { readonly statusCardSteps: readonly string[] } | object {
    const steps = this._statusCardSteps(taskView);
    return steps !== undefined ? { statusCardSteps: steps } : {};
  }
}

export { TaskStatusCardUpdater as FeishuTaskUpdater };

function _isUserVisibleStepEvent(type: string): boolean {
  return ["runner.step", "runner.cancelled", "runner.failed"].includes(type);
}

function _timelineRunMetadata(data: unknown): {
  readonly runIndex: number | null;
} {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { runIndex: null };
  }
  const record = data as Record<string, unknown>;
  return {
    runIndex: typeof record.runIndex === "number" ? record.runIndex : null,
  };
}

export function nativeProgressEntries(events: readonly TaskStatusCardStepEvent[]): import("@/channels/outbound").NativeProgressEntry[] {
  return events.flatMap(event => {
    const data = event.data as {publicProgress?: boolean; toolName?: string; toolCallId?: string; toolTitle?: string; toolPhase?: "start" | "result"} | undefined;
    const id = (event as {id?: string}).id;
    if (!id || !data?.publicProgress || event.type !== "runner.step") return [];
    return [{id: data.toolCallId ? `${data.toolCallId}:${data.toolPhase ?? "start"}` : id, text: event.summary.slice(0, 800),
      ...(data.toolName ? {toolName: data.toolName.slice(0, 80)} : {}),
      ...(data.toolCallId ? {toolCallId: data.toolCallId} : {}),
      ...(data.toolTitle ? {toolTitle: data.toolTitle.slice(0, 120)} : {}),
      ...(data.toolPhase ? {toolPhase: data.toolPhase} : {})}];
  });
}
