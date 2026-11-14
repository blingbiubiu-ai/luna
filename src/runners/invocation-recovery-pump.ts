import type {DrizzleDB} from "@/data";
import type {ExecutionRuntime} from "@/runtime/execution-runtime";
import {createLogger} from "@/shared";
import {InvocationStore} from "./invocation-store";
import {JobReconciler} from "./job-reconciler";

/** Drives cancellation outside occupied session lanes, then settles through the lane owner. */
export class InvocationRecoveryPump {
  private requests: Promise<void> | undefined;
  private recovery: Promise<void> | undefined;
  private readonly store: InvocationStore;
  constructor(private readonly db: DrizzleDB, private readonly runtime: ExecutionRuntime, private readonly detach: AbortSignal) {
    this.store = new InvocationStore(db);
  }

  tick(): void {
    if (this.detach.aborted) return;
    // A live stream may hold its lane until terminal. Cancellation must not wait for that lane.
    if (!this.requests) {
      const jobs = this.store.pending().filter(invocation => invocation.state === "revoked")
        .flatMap(invocation => this.store.jobsFor(invocation.id))
        .filter(job => !["terminal", "settled"].includes(job.state));
      this.requests = Promise.allSettled(jobs.map(job => this.runtime.cancelIntent(job.request, this.detach)))
        .then(results => {
          for (const result of results) if (result.status === "rejected" && !this.detach.aborted) {
            createLogger("runtime-transport").warn({error: result.reason}, "Runtime cancellation request remains pending");
          }
        }).finally(() => { this.requests = undefined; });
    }
    // Only durable terminal evidence permits settlement. Failures remain pending for the next tick.
    this.recovery ??= new JobReconciler(this.db, this.runtime, this.detach).recover()
      .catch(error => createLogger("runtime-transport").warn({error}, "Runtime cancellation recovery remains pending"))
      .finally(() => { this.recovery = undefined; });
  }

  async wait(): Promise<void> {
    await Promise.all([this.requests, this.recovery]);
  }
}
