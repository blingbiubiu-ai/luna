import type {
  RunnerExecution,
  RunnerExecutionResult,
  RunnerPayload,
} from "@/runners/types";

/**
 * Describes the Sandbox Command contract used by sandbox execution.
 */
export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Describes the Sandbox Runtime contract used by sandbox execution.
 */
export interface SandboxRuntime {
  run<TPayload extends RunnerPayload>(
    execution: RunnerExecution<TPayload>,
  ): Promise<RunnerExecutionResult>;
}
