import type { DrizzleDB } from "@/data";

export interface ResumeWaitingTaskInput {
  readonly taskId: string;
  readonly operationId: string;
  readonly summary: string;
  readonly quiet?: boolean | undefined;
}

export type TaskResumeHandler = (input: ResumeWaitingTaskInput) => void;

const handlers = new WeakMap<DrizzleDB, TaskResumeHandler>();

export function registerTaskResumeHandler(
  db: DrizzleDB,
  handler: TaskResumeHandler,
): void {
  handlers.set(db, handler);
}

export function resumeWaitingTaskIfIdle(
  db: DrizzleDB,
  input: ResumeWaitingTaskInput,
): boolean {
  const handler = handlers.get(db);
  if (!handler) return false;
  handler(input);
  return true;
}
