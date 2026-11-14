import type {
  RunnerExecution,
  RunnerExecutionResult,
  RunnerPayload,
} from "@/runners/types";
import type { ArtifactStore } from "@/timeline/artifact-store";
import type { TimelineStore } from "@/timeline/timeline-store";

import type { SandboxRuntime } from "./types";

/**
 * Configuration options for execution fake sandbox runtime behavior in sandbox.
 */
export interface FakeSandboxRuntimeOptions {
  readonly timeline?: TimelineStore;
  readonly artifacts?: ArtifactStore;
}

/**
 * Executes sandbox commands against an in-memory fake runtime for tests.
 */
export class FakeSandboxRuntime implements SandboxRuntime {
  private readonly _timeline: TimelineStore | undefined;
  private readonly _artifacts: ArtifactStore | undefined;

  constructor(options: FakeSandboxRuntimeOptions = {}) {
    this._timeline = options.timeline;
    this._artifacts = options.artifacts;
  }

  async run<TPayload extends RunnerPayload>(
    execution: RunnerExecution<TPayload>,
  ): Promise<RunnerExecutionResult> {
    if (execution.execute === undefined) {
      throw new Error(
        `Runner ${execution.runnerType} cannot be executed by FakeSandboxRuntime.`,
      );
    }

    const result = await execution.execute();
    this._persistTimeline(execution, result);
    this._persistArtifacts(execution, result);
    return result;
  }

  private _persistTimeline(
    execution: RunnerExecution,
    result: RunnerExecutionResult,
  ): void {
    for (const event of result.events) {
      this._timeline?.append({
        taskId: execution.taskId,
        type: event.type,
        summary: event.summary,
        data: {
          runnerType: execution.runnerType,
          mode: execution.mode,
          ...(event.data ?? {}),
        },
      });
    }
  }

  private _persistArtifacts(
    execution: RunnerExecution,
    result: RunnerExecutionResult,
  ): void {
    for (const artifact of result.artifacts) {
      this._artifacts?.create({
        taskId: execution.taskId,
        type: artifact.type,
        name: artifact.name,
        path: artifact.path,
        ...(artifact.mimeType !== undefined
          ? { mimeType: artifact.mimeType }
          : {}),
        ...(artifact.status !== undefined ? { status: artifact.status } : {}),
        ...(artifact.content !== undefined ? { content: artifact.content } : {}),
        ...(artifact.metadata !== undefined
          ? { metadata: artifact.metadata }
          : {}),
      });
    }
  }
}
