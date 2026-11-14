import type { DrizzleDB } from "@/data";
import type { MainRunnerRunInput } from "@/main-runner/main-runner";

export interface WorkRunnerInvocation {
  readonly sessionId: string;
  readonly runnerContextId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

const workRegistries = new WeakMap<DrizzleDB, Map<string, WorkRunnerInvocation>>();

export function workInvocations(db: DrizzleDB): Map<string, WorkRunnerInvocation> {
  let registry = workRegistries.get(db);
  if (!registry) {
    registry = new Map();
    workRegistries.set(db, registry);
  }
  return registry;
}

export function taskResultMessageOrigin(taskRunId: string, sessionId: string): string {
  return `task-result:${taskRunId}:${sessionId}`;
}

export function mainMessageOrigin(input: MainRunnerRunInput): string {
  if (input.input.type === "task_result") {
    return taskResultMessageOrigin(input.input.result.taskRunId, input.input.context.sessionId);
  }
  return input.turnId ?? input.invocationId!;
}

/** Process-scoped capabilities fail closed on restart and after cancellation. */
const registries = new WeakMap<DrizzleDB, Map<string, MainRunnerRunInput>>();
export function mainInvocations(db: DrizzleDB): Map<string, MainRunnerRunInput> {
  let registry = registries.get(db);
  if (!registry) { registry = new Map(); registries.set(db, registry); }
  return registry;
}
