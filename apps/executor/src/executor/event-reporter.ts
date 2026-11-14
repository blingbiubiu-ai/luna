import { ExecutionClient } from "@luna/execution-transport";
import { contentHash, ExecutionError } from "@luna/execution-store";
import { ExecutorStore } from "./store";

/** Send live observations once. Runtime queries the Job if its terminal update was lost. */
export class ExecutorEventReporter {
  private client: ExecutionClient | undefined;
  private readonly inflight = new Map<string, AbortSignal>();
  private credentialHash: string | undefined;
  private abort = new AbortController();
  private authenticationFailed = false;
  private lastError: string | null = null;

  constructor(private readonly store: ExecutorStore, private readonly runtimeEndpoint: string) {}

  configure(token: string): void {
    const hash = contentHash(token);
    if (this.client && this.credentialHash === hash) return;
    this.abort.abort();
    this.abort = new AbortController();
    this.inflight.clear();
    this.client = new ExecutionClient(this.runtimeEndpoint, token);
    this.credentialHash = hash;
    this.authenticationFailed = false;
    this.lastError = null;
  }

  ready(): boolean { return this.client !== undefined; }
  status() { return { configured: this.ready(), authenticationFailed: this.authenticationFailed, lastError: this.lastError }; }

  async tick(): Promise<void> {
    const batches = this.store.takeLiveEvents();
    const client = this.client;
    if (!client || this.authenticationFailed) return;
    const signal = this.abort.signal;
    await Promise.all([...batches].map(async ([id, events]) => {
      if (this.inflight.has(id)) return;
      const snapshot = this.store.snapshot(id);
      const batch = { version: 1, assignmentId: snapshot.assignmentId, instanceId: snapshot.instanceId, streamId: snapshot.streamId, events };
      while (events.length > 1 && Buffer.byteLength(JSON.stringify(batch)) > 16 * 1024 * 1024) events.shift();
      this.inflight.set(id, signal);
      try {
        await client.call("POST", `/v1/ingest/jobs/${encodeURIComponent(id)}/events`, batch, AbortSignal.any([signal, AbortSignal.timeout(2000)]));
        if (!signal.aborted) this.lastError = null;
      } catch (error) {
        if (signal.aborted) return;
        this.lastError = error instanceof ExecutionError ? error.code : "event_report_unavailable";
        if (error instanceof ExecutionError && [401, 403].includes(error.status)) this.authenticationFailed = true;
      } finally {
        if (this.inflight.get(id) === signal) this.inflight.delete(id);
      }
    }));
  }

  stop(): void { this.abort.abort(); this.client = undefined; }
}
