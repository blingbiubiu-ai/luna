import type { ExecutionRuntime } from "../../src/runtime/execution-runtime";
import type { ScheduledJob } from "../../src/runtime/scheduler-store";

/** Business tests supply method-level failures/events, without a transport protocol. */
export function runtimeStub(overrides: Partial<ExecutionRuntime> = {}): ExecutionRuntime {
  return {
    runtimeId: "runtime", environmentId: "luna", sharedProject: undefined,
    async verify() {}, async submit() { return {} as ScheduledJob; },
    async query() { return { placementState: "terminal", lastSeq: 0 } as ScheduledJob & { lastSeq: number }; },
    async credentials() {}, async cancel() { throw new Error("Unexpected cancellation"); },
    async cancelIntent() { throw new Error("Unexpected cancellation intent"); },
    async delete() {}, async files<T>(): Promise<T> { throw new Error("Unexpected file operation"); },
    async *events() { throw new Error("Unexpected event subscription"); },
    ...overrides,
  };
}
