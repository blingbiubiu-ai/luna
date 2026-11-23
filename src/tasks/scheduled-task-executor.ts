import { eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { sessions, tasks } from "@/data/schema";
import { TaskScopeResolver } from "@/agents/task-scope";
import type { SessionCommand } from "@/messaging/session-command-service";
import { GatewayError } from "@/server/gateway-error";
import type { TaskRunSupervisor } from "./task-run-supervisor";
import { TaskSubscriptionStore } from "./task-subscription-store";

export interface ScheduledTaskRunResult {
  readonly taskId: string;
  readonly runId: string;
}

export function createScheduledTaskRunExecutor(
  db: DrizzleDB,
  supervisor: () => Pick<TaskRunSupervisor, "restartTaskRun">,
) {
  return async (
    command: SessionCommand,
    _signal: AbortSignal,
  ): Promise<ScheduledTaskRunResult> => {
    const taskId =
      typeof command.payload.taskId === "string"
        ? command.payload.taskId.trim()
        : "";
    if (!taskId) {
      throw new GatewayError(
        "invalid_task_schedule",
        "Scheduled task.run requires taskId",
        400,
      );
    }
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) {
      throw new GatewayError("task_not_found", "Scheduled Task not found", 404);
    }
    const target = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, command.sessionId))
      .get();
    if (!target || target.status !== "active") {
      throw new GatewayError(
        "session_unavailable",
        "Target session is unavailable",
        404,
      );
    }
    const scopes = new TaskScopeResolver(db);
    scopes.assertSame(scopes.session(target.id), scopes.task(task.id));

    // Ensure the target session subscribes to the Task's completion result; keep existing card preference or default to quiet background (`none`).
    const existingSub = db.query
      ? undefined
      : undefined;
    void existingSub;
    new TaskSubscriptionStore(db).resolve({
      taskId: task.id,
      sessionId: target.id,
      channelType: target.channel_type,
      channelId: target.channel_id,
      ...(target.group_id ? { groupId: target.group_id } : {}),
      ...(target.thread_key ? { threadId: target.thread_key } : {}),
      ...(target.root_message_key
        ? { rootMessageId: target.root_message_key }
        : {}),
      visibility: "full",
    });

    const instruction = String(command.payload.content ?? "").trim();
    const run = supervisor().restartTaskRun({
      taskId: task.id,
      operationId: command.id,
      updatedTaskSummary: task.summary ?? "",
      updateSummary: instruction || "Scheduled inspection run",
      inputSnapshot: {
        operation: "task.run",
        operationId: command.id,
        sessionId: target.id,
        quiet: true,
        requestedByIdentity: {
          provider: "local",
          externalUserId: command.actorUserId,
          canonicalUserId: command.actorUserId,
        },
      },
    });
    return { taskId: task.id, runId: run.id };
  };
}
