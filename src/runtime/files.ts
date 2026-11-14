import {ExecutionError} from "@luna/execution-store";
import { FileRequest } from "@luna/runner-protocol";
import type { RuntimeScheduler } from "./scheduler";



/** No file-operation ledger: requests execute synchronously on the owning Worker. */
export class RuntimeFiles {
  private readonly active = new Map<string, { shadowId: string; count: number }>();
  constructor(private readonly scheduler: RuntimeScheduler) {
    scheduler.isContextFileBusy = contextId => this.active.has(contextId);
  }
  isBusy(shadowId: string): boolean {
    return [...this.active.values()].some(operation => operation.shadowId === shadowId);
  }
  async execute(input: unknown): Promise<unknown> {
    const request = FileRequest.parse(input);
    this.scheduler.mode.requireAdmission();
    const prepared=this.scheduler.preparation.cached(request.contextId),inputScope=this.scheduler.preparation.input(request.contextId);
    if(!prepared || !inputScope)throw new ExecutionError(409,"context_preparation_required");
    if(inputScope.scopeKey!==request.scopeKey || inputScope.projectId!==request.projectId)throw new ExecutionError(409,"context_preparation_mismatch");
    this.scheduler.placements.require(prepared.scope,prepared.workerId,prepared.scope.placementGeneration,request.contextId);
    const route=this.scheduler.placements.bindContext(prepared.scope,request.contextId,request.scopeKey,
      this.scheduler.allowedWorkers?.(prepared.scope, {includePaused: true})??[],request.projectId,request.operation.kind!=="provision");
    // Worker context preparation already created these directories. Provision is
    // a path lookup; the Job reservation owns container creation/resource changes.
    if(request.operation.kind==="provision")return {home:prepared.home,cwd:prepared.cwd};
    const active = this.active.get(request.contextId) ?? { shadowId: prepared.scope.shadowId, count: 0 };
    active.count++;
    this.active.set(request.contextId, active);
    try {
      return await this.scheduler.workers.client(route.workerId).call("POST", "/v1/files", {
        ...request, spec: { protocolVersion:2,scope:prepared.scope,resourceSelection:prepared.resources,environmentId: this.scheduler.config.environmentId, scopeKey: request.scopeKey,
          mode: this.scheduler.config.mode, imageDigest: this.scheduler.workers.imageDigest(route.workerId),
          callbackRuntimeId: this.scheduler.config.runtimeId, resources: this.scheduler.config.resources },
      });
    } finally {
      if (--active.count === 0) this.active.delete(request.contextId);
    }
  }
}
