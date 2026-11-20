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
import { shadowSoul } from "@/agents/shadow-soul";
import type { DrizzleDB } from "@/data";
import { runnerContexts } from "@/data/schema";
import { eq } from "drizzle-orm";

const LOCAL_SESSION_FINGERPRINT = "local-runner-session";

function soulField(db: DrizzleDB, scope: { agentId: string; shadowId: string }) {
  const soul = shadowSoul(db, scope);
  return soul ? { soul: { ...soul, owner: { ...soul.owner }, persona: [...soul.persona] } } : {};
}

/**
 * A context works in its owner's directory, `session-<id>` or `task-<id>`, so switching the
 * Runner (Codex to Claude) keeps the files. Only the CLI session stays per Runner.
 */
export function ownerDirectory(db: DrizzleDB, contextId: string): string {
  const row = db.select({ ownerType: runnerContexts.owner_type, ownerId: runnerContexts.owner_id }).from(runnerContexts)
    .where(eq(runnerContexts.id, contextId)).get();
  return row ? ownerDirectoryName(row.ownerType, row.ownerId, contextId) : contextId;
}

/** `<owner type>-<owner id>`, or the context ID when that is not a valid directory name. */
export function ownerDirectoryName(ownerType: string, ownerId: string, contextId: string): string {
  const name = `${ownerType}-${ownerId}`;
  return /^[A-Za-z0-9_-]{1,128}$/.test(name) ? name : contextId;
}

/** Worker owns filesystem rendering; the local fallback supports non-runtime test adapters. */
export async function prepareRunnerFiles(input: {
  id: string; runner_root_path: string; runner_type: string;
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
          contextId: input.id, runnerId: ownerDirectory(db, input.id),
          scopeKey: context?.runnerKind === "task" ? `task:${context.owner.id}:${input.runner_type}` : `session:${input.id}`,
          runnerKind: context?.runnerKind ?? "main", ...(context ? { context: { ...context } } : {}),
          ...(runtime.sharedProject ? { projectId: runtime.sharedProject.projectId } : {}),
          ...(config.git ? { git: config.git } : {}),
          ...(new ShadowRootAccessStore(db).enabled(invocation.shadowId) ? { rootAccess: true } : {}),
          ...soulField(db, invocation),
        }, signal);
        const current=new InvocationStore(db).require(invocationId);
        if(current.state!=="active" || current.settledAt!==null)throw new ExecutionError(409,"invocation_preparation_mismatch");
        resolveInvocationScope(db,current);
        return { instructionFingerprint: prepared.instructionFingerprint };
      } catch (error) {
        if (!(error instanceof ExecutionError) || !["worker_not_ready", "no_worker_available", "worker_disconnected", "shadow_worker_unavailable",
          "worker_delivery_failed", "shadow_resources_pending", "shadow_preparation_busy", "context_busy", "runtime_draining"].includes(error.code)) throw error;
        await delay(1000, undefined, signal ? { signal } : {});
      }
    }
  }
  ensureRunnerWorkspaceInstructionFiles({ runnerKind: context?.runnerKind ?? "main", runnerRootPath: input.runner_root_path });
  if (context) writeRunnerContextFile(input.runner_root_path, context);
  // Without a Worker there is no placement to move, so the provider session is always kept.
  return { instructionFingerprint: LOCAL_SESSION_FINGERPRINT };
}
