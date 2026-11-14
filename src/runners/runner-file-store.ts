import { setTimeout as delay } from "node:timers/promises";
import { contentHash, ExecutionError } from "@luna/execution-store";
import type { ExecutionRuntime } from "@/runtime/execution-runtime";

/** Resolve the prepared Worker paths before submitting a Runner Job. */
export class RunnerFileStore {
  constructor(private readonly runtime: ExecutionRuntime) {}
  async prepare(input: { contextId: string; scopeKey: string; invocationId: string; localRoot: string; projectId?: string }, signal?: AbortSignal): Promise<string> {
    const prepared = this.runtime.preparedContext?.(input.contextId);
    if (!prepared) throw new ExecutionError(409, "context_preparation_required");
    let index = 0;
    const operation = async <T>(value: unknown): Promise<T> => {
      const request = { contextId: input.contextId, scopeKey: input.scopeKey,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        operationId: `setup_${contentHash([input.invocationId, index++, value]).slice(0, 48)}`, operation: value };
      while (true) {
        signal?.throwIfAborted();
        try { return await this.runtime.files<T>(request, signal); }
        catch (error) {
          // Admission may pause while the local Worker is starting, full or drained.
          // Retry the same operation without replaying completed setup.
          if (!(error instanceof ExecutionError) || error.status !== 503 ||
              !["no_worker_available", "runtime_draining", "environment_mount_pending"].includes(error.code)) {
            throw error;
          }
        }
        await delay(1000, undefined, { signal });
      }
    };
    const { home, cwd } = await operation<{ home: string; cwd: string }>({ kind: "provision" });
    if (home !== prepared.home || cwd !== prepared.cwd) {
      throw new Error("Worker Runner paths differ from the Service configuration");
    }
    return cwd;
  }
}
