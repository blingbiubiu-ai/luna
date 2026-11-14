import type { OperationRequest } from "../../../src/runners/operation-contract";

type Payload<K extends OperationRequest["kind"]> = Extract<OperationRequest, {kind: K}>["payload"];
type TaskPlan = (
  | ({operation: "task.create"} & Payload<"task.create">)
  | ({operation: "task.update"} & Payload<"task.update">)
  | ({operation: "task.restart"} & Payload<"task.restart">)
) & {dispatchReply: string; reason: string};

/** Declarative test input: the harness executes domain commands before completion. */
export type TestMainPlan = {reason: string; ccSenderUserIds?: readonly string[]} & (
  | {operation: "completion"; followupReleased?: boolean}
  | {operation: "message.send" | "message.card" | "message.status" | "message.result";
      reply: string; taskId?: string; followUpSuggestions?: readonly string[]; cardSummary?: string}
  | ({operation: "session.clarify"; reply: string} & Omit<Payload<"session.clarify">, "question">)
  | TaskPlan
  | {operation: "commands.batch";
      reply: {title: string; content: string; coveredMessageIds: readonly string[]};
      taskActions: readonly ((TaskPlan | {operation: "message.status"; taskId: string; reply: string; reason: string}) & {messageIds: readonly string[]})[]}
);
