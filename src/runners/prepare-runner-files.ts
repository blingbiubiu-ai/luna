import { ShadowRootAccessStore } from "@/agents/shadow-root-access-store";
import {InvocationStore} from "./invocation-store";
import {InvocationResources} from "./invocation-resources";
import {resolveInvocationScope} from "./invocation-scope";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionError } from "@luna/execution-store";
import { getKernel } from "@/server/routes/kernel";
import { config } from "@/shared";
import type { RunnerContextFile } from "./runner-context-file";
import { writeRunnerContextFile } from "./runner-context-file";
import { ensureRunnerWorkspaceInstructionFiles } from "./workspace-instruction-files";

/** Worker owns filesystem rendering; the local fallback supports non-runtime test adapters. */
export async function prepareRunnerFiles(input: {
  id: string; runner_root_path: string; runner_type: string; instruction_fingerprint: string | null;
}, context?: RunnerContextFile, signal?: AbortSignal, invocationId?:string) {
  const runtime = getKernel().executionRuntime;
  if (runtime) {
    while (true) {
      signal?.throwIfAborted();
      try {
        if(!invocationId)throw new ExecutionError(409,"invocation_required_for_preparation");
        const db=getKernel().database.db,invocation=new InvocationStore(db).require(invocationId);
        if(invocation.state!=="active" || invocation.settledAt!==null || invocation.runnerContextId!==input.id || invocation.runnerKind!==(context?.runnerKind??"main"))throw new ExecutionError(409,"invocation_preparation_mismatch");
        resolveInvocationScope(db,invocation);
        const resources=new InvocationResources(db,config.paths.home).read(invocationId);
        const prepared = await runtime.prepareContext({
          protocolVersion:2,invocationId,scope:{agentId:invocation.agentId,shadowId:invocation.shadowId},resources:resources.selection,
          contextId: input.id, runnerId: input.id,
          scopeKey: context?.runnerKind === "task" ? `task:${context.owner.id}:${input.runner_type}` : `session:${input.id}`,
          runnerKind: context?.runnerKind ?? "main", ...(context ? { context: { ...context } } : {}),
          ...(runtime.sharedProject ? { projectId: runtime.sharedProject.projectId } : {}),
          ...(config.git ? { git: config.git } : {}),
          ...(new ShadowRootAccessStore(db).enabled(invocation.shadowId) ? { rootAccess: true } : {}),
        }, signal);
        const current=new InvocationStore(db).require(invocationId);
        if(current.state!=="active" || current.settledAt!==null)throw new ExecutionError(409,"invocation_preparation_mismatch");
        resolveInvocationScope(db,current);
        return { instructionFingerprint: prepared.instructionFingerprint, changed: prepared.instructionFingerprint !== input.instruction_fingerprint };
      } catch (error) {
        if (!(error instanceof ExecutionError) || !["worker_not_ready", "no_worker_available", "worker_disconnected", "shadow_worker_unavailable",
          "worker_delivery_failed", "shadow_resources_pending", "shadow_preparation_busy", "context_busy", "runtime_draining"].includes(error.code)) throw error;
        await delay(1000, undefined, signal ? { signal } : {});
      }
    }
  }
  const result = ensureRunnerWorkspaceInstructionFiles({ runnerKind: context?.runnerKind ?? "main", runnerRootPath: input.runner_root_path, previousFingerprint: input.instruction_fingerprint });
  if (context) writeRunnerContextFile(input.runner_root_path, context);
  return result;
}
