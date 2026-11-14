import { randomUUID } from "node:crypto";
import { ExecutionError } from "@luna/execution-store";

export interface RpcClient { call<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>; }
export interface RpcRequest { id: string; method: string; path: string; body?: unknown; }
/** One connection owns its pending calls. Reconnection never replays uncertain writes. */
export class ReverseChannel implements RpcClient {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>();
  private closed = false;
  constructor(private send: (value: string) => void) {}
  call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ExecutionError(503, "worker_disconnected"));
    if (this.pending.size >= 256) return Promise.reject(new ExecutionError(503, "worker_channel_busy"));
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { this.pending.delete(id); cleanup(); reject(signal?.reason ?? new ExecutionError(503, "worker_request_timeout")); };
      const timer = setTimeout(abort, 45000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.send(JSON.stringify({ type: "request", id, method, path, body })); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  receive(input: { id: string; status: number; body?: unknown }): void {
    const pending = this.pending.get(input.id); if (!pending) return;
    this.pending.delete(input.id); pending.cleanup();
    if (input.status >= 300) {
      const body = input.body as { code?: string } | undefined;
      pending.reject(new ExecutionError(input.status, body?.code ?? "worker_operation_failed"));
    } else pending.resolve(input.body);
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new ExecutionError(503, "worker_disconnected")); }
    this.pending.clear();
  }
}
