import type {ContextPreparation,PreparedContext} from "@luna/runner-protocol";
export type {ContextPreparation,PreparedContext} from "@luna/runner-protocol";
import type { Credentials, JobRequest, RuntimeEvent } from "@luna/runner-protocol";
import type { ScheduledJob } from "./scheduler-store";

/** Service's execution boundary, independent of transport and Runtime ownership. */
export interface ExecutionRuntime {
  readonly runtimeId: string;
  readonly environmentId: string;
  readonly sharedProject: { projectId: string } | undefined;
  prepareContext?(input: ContextPreparation, signal?: AbortSignal): Promise<PreparedContext>;
  preparedContext?(id: string): PreparedContext | undefined;
  verify(): Promise<void>;
  files<T>(input: { operationId: string; contextId: string; scopeKey: string; projectId?: string; cwd?: string; operation: unknown }, signal?: AbortSignal): Promise<T>;
  submit(job: JobRequest, signal?: AbortSignal): Promise<ScheduledJob>;
  query(id: string, signal?: AbortSignal): Promise<ScheduledJob & { lastSeq: number }>;
  credentials(id: string, credentials: Credentials): Promise<void>;
  cancel(id: string, signal?: AbortSignal): Promise<ScheduledJob>;
  cancelIntent(job: JobRequest, signal?: AbortSignal): Promise<ScheduledJob>;
  delete(id: string, signal?: AbortSignal): Promise<void>;
  events(id: string, after: number, detach: AbortSignal): AsyncIterable<RuntimeEvent>;
}
